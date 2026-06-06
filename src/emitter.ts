import {
  EmitContext,
  Model,
  ModelProperty,
  Scalar,
  Enum,
  Type,
  Interface,
  Namespace,
  Program,
  Union,
  StringLiteral,
  NumericLiteral,
  BooleanLiteral,
  getDoc,
  getFormat,
  isArrayModelType,
  isRecordModelType,
  isNullType,
  isVoidType,
  isNeverType,
  getNamespaceFullName,
  resolvePath,
  isErrorModel,
  isService,
  NoTarget,
} from "@typespec/compiler";
import {
  getAllHttpServices,
  HttpOperation,
  Visibility,
  isVisible,
  resolveRequestVisibility,
} from "@typespec/http";
import {
  getAllVersions,
  getAvailabilityMap,
  Availability,
  Version,
} from "@typespec/versioning";
import { parse, resolve } from "node:path";
import {
  createRenderer,
  Renderer,
  InterfaceView,
  PropertyView,
  EnumView,
  EnumMemberView,
  EndpointsView,
  EndpointMethodView,
  FileView,
  IndexView,
  TemplateOverrides,
} from "./renderer.js";
import { EmitterOptions, createDiagnostic } from "./lib.js";
import { getClientName } from "./decorators.js";

// ─── Entry point ────────────────────────────────────────────────────────────

export async function $onEmit(
  context: EmitContext<EmitterOptions>,
): Promise<void> {
  const { program, emitterOutputDir, options } = context;
  if (program.compilerOptions.noEmit) return;

  if (options["clean-output-dir"]) {
    const cleaned = await cleanOutputDir(program, emitterOutputDir);
    if (!cleaned) return;
  }

  const renderer = buildRenderer(program, options);

  const [services, diags] = getAllHttpServices(program);
  program.reportDiagnostics(diags);

  for (const service of services) {
    if (!isService(program, service.namespace)) continue;
    if (service.operations.length === 0) continue;
    await emitService(
      program,
      service.namespace,
      service.operations,
      emitterOutputDir,
      options,
      renderer,
    );
  }
}

// ─── Renderer factory ────────────────────────────────────────────────────────

function buildRenderer(program: Program, options: EmitterOptions): Renderer {
  const overrides = resolveTemplateOverrides(options.templates);
  try {
    return createRenderer(overrides);
  } catch (e) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "template-load-failed",
        target: NoTarget,
        format: { message: String(e) },
      }),
    );
    return createRenderer({});
  }
}

function resolveTemplateOverrides(
  templates?: TemplateOverrides,
): TemplateOverrides {
  if (!templates) return {};
  const result: TemplateOverrides = {};
  for (const [key, val] of Object.entries(templates)) {
    if (val)
      (result as Record<string, string>)[key] = resolve(process.cwd(), val);
  }
  return result;
}

// ─── File writing helper ─────────────────────────────────────────────────────

async function writeFile(
  program: Program,
  filePath: string,
  content: string,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) await program.host.mkdirp(dir);
  await program.host.writeFile(filePath, content);
}

// ─── Output directory cleanup ────────────────────────────────────────────────

/**
 * Deletes every entry inside `outputDir` before the emitter writes new files.
 * Silently succeeds when the directory does not exist (e.g. first run or
 * test environments with virtual file systems).
 */
async function cleanOutputDir(
  program: Program,
  outputDir: string,
): Promise<boolean> {
  const resolvedOutputDir = resolve(outputDir);
  const resolvedCwd = resolve(process.cwd());

  if (samePath(resolvedOutputDir, resolvedCwd)) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "unsafe-clean-output-dir",
        target: NoTarget,
        format: { outputDir, reason: "the current working directory" },
      }),
    );
    return false;
  }

  if (isFilesystemRootPath(resolvedOutputDir)) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "unsafe-clean-output-dir",
        target: NoTarget,
        format: { outputDir, reason: "a filesystem root" },
      }),
    );
    return false;
  }

  try {
    const realOutputDir = await program.host.realpath(outputDir);
    if (isFilesystemRootPath(realOutputDir)) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "unsafe-clean-output-dir",
          target: NoTarget,
          format: { outputDir: realOutputDir, reason: "a filesystem root" },
        }),
      );
      return false;
    }
    const realCwd = await program.host.realpath(process.cwd());
    if (samePath(realOutputDir, realCwd)) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "unsafe-clean-output-dir",
          target: NoTarget,
          format: {
            outputDir: realOutputDir,
            reason: "the current working directory",
          },
        }),
      );
      return false;
    }
  } catch {
    // Realpath checks are best-effort for virtual hosts.
  }

  let entries: string[];
  try {
    entries = await program.host.readDir(outputDir);
  } catch {
    return true;
  }

  try {
    await Promise.all(
      entries.map((entry) =>
        program.host.rm(resolvePath(outputDir, entry), { recursive: true }),
      ),
    );
    return true;
  } catch (e) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "clean-output-dir-failed",
        target: NoTarget,
        format: { outputDir, message: String(e) },
      }),
    );
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const normalizeForCompare = (value: string) =>
    value.replace(/[\\/]+$/g, "").toLowerCase();
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function isFilesystemRootPath(path: string): boolean {
  const parsed = parse(path);
  const root = parsed.root;
  if (!root) return false;
  const stripTrailingSeps = (p: string) => p.replace(/[\\/]+$/g, "") || p;
  return stripTrailingSeps(path) === stripTrailingSeps(root);
}

type ClientNameKind =
  | "model"
  | "enum"
  | "enum member"
  | "property"
  | "request type";

interface NameResolutionContext {
  declarationNames: Map<string, Type>;
  modelNames: WeakMap<Model, string>;
  enumNames: WeakMap<Enum, string>;
}

function createNameResolutionContext(): NameResolutionContext {
  return {
    declarationNames: new Map<string, Type>(),
    modelNames: new WeakMap<Model, string>(),
    enumNames: new WeakMap<Enum, string>(),
  };
}

const TS_RESERVED_WORDS = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function validateTsIdentifier(name: string): string | undefined {
  if (name.length === 0) return "name cannot be empty";
  if (!/^[$A-Z_a-z][$\w]*$/u.test(name)) {
    return "name must be a valid TypeScript identifier";
  }
  if (TS_RESERVED_WORDS.has(name)) {
    return "reserved words are not allowed";
  }
  return undefined;
}

function resolveOverrideIdentifier(
  program: Program,
  target: Type,
  kind: ClientNameKind,
  fallbackName: string,
): string {
  const override = getClientName(program, target);
  if (!override) return fallbackName;

  const reason = validateTsIdentifier(override);
  if (!reason) return override;

  program.reportDiagnostic(
    createDiagnostic({
      code: "invalid-client-name-override",
      target,
      format: { name: override, kind, reason },
    }),
  );
  return fallbackName;
}

function reserveDeclarationName(
  program: Program,
  names: Map<string, Type>,
  candidate: string,
  target: Type,
  kind: ClientNameKind,
  fallbackName: string,
): string {
  const existing = names.get(candidate);
  if (!existing || existing === target) {
    names.set(candidate, target);
    return candidate;
  }

  if (candidate !== fallbackName) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "client-name-collision",
        target,
        format: { name: candidate, kind, scope: "declaration" },
      }),
    );
    const fallbackExisting = names.get(fallbackName);
    if (!fallbackExisting || fallbackExisting === target) {
      names.set(fallbackName, target);
      return fallbackName;
    }
  }

  return candidate;
}

function resolveModelName(
  program: Program,
  model: Model,
  names: NameResolutionContext,
): string {
  const cached = names.modelNames.get(model);
  if (cached) return cached;

  const fallback = model.name ?? "unknown";
  const resolved = reserveDeclarationName(
    program,
    names.declarationNames,
    resolveOverrideIdentifier(program, model, "model", fallback),
    model,
    "model",
    fallback,
  );
  names.modelNames.set(model, resolved);
  return resolved;
}

function resolveEnumName(
  program: Program,
  e: Enum,
  names: NameResolutionContext,
): string {
  const cached = names.enumNames.get(e);
  if (cached) return cached;

  const fallback = e.name ?? "string";
  const resolved = reserveDeclarationName(
    program,
    names.declarationNames,
    resolveOverrideIdentifier(program, e, "enum", fallback),
    e,
    "enum",
    fallback,
  );
  names.enumNames.set(e, resolved);
  return resolved;
}

// ─── npm version derivation ───────────────────────────────────────────────────

/**
 * Attempts to parse a semver string from a TypeSpec version value.
 * Accepts an optional leading `v`/`V`, two-part (`1.2`) or three-part (`1.2.3`)
 * numeric versions, and preserves any pre-release suffix.
 */
export function tryParseSemver(value: string): string | undefined {
  const stripped = value.replace(/^[vV]/, "");
  const match = stripped.match(/^(\d+)\.(\d+)(?:\.(\d+))?([-+].+)?$/);
  if (!match) return undefined;
  const patch = match[3] ?? "0";
  const rest = match[4] ?? "";
  return `${match[1]}.${match[2]}.${patch}${rest}`;
}

/** Formats a date as a CalVer string (`YYYY.MM.DD`). */
export function toCalVer(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

/**
 * Derives the npm package version.
 *
 * Priority:
 * 1. `npm-version` option (explicit override)
 * 2. Semver parsed from the targeted TypeSpec API version
 * 3. CalVer (`YYYY.MM.DD`) fallback
 */
export function deriveNpmVersion(
  allVersions: Version[],
  options: EmitterOptions,
): string {
  if (options["npm-version"]) return options["npm-version"];

  let versionString: string | undefined;
  if (allVersions.length > 0) {
    if (options["target-version"] && options["all-versions"] !== true) {
      versionString = allVersions.find(
        (v) => v.value === options["target-version"],
      )?.value;
    }
    versionString ??= allVersions[allVersions.length - 1].value;
  }

  if (versionString) {
    const parsed = tryParseSemver(versionString);
    if (parsed) return parsed;
  }

  return toCalVer(new Date());
}

// ─── Version selection ───────────────────────────────────────────────────────

function resolveTargetVersions(
  program: Program,
  versions: Version[],
  options: EmitterOptions,
): Version[] | null {
  const targetValue = options["target-version"];

  if (options["all-versions"]) {
    return versions;
  }

  if (versions.length === 0) {
    if (targetValue) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "version-not-found",
          target: NoTarget,
          format: {
            version: targetValue,
            available: "none (API is not versioned)",
          },
        }),
      );
      return null;
    }
    return [];
  }

  if (targetValue) {
    const found = versions.find((v) => v.value === targetValue);
    if (!found) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "version-not-found",
          target: NoTarget,
          format: {
            version: targetValue,
            available: versions.map((v) => v.value).join(", "),
          },
        }),
      );
      return null;
    }
    return [found];
  }

  return [versions[versions.length - 1]];
}

// ─── Version filtering ───────────────────────────────────────────────────────

function isOpInVersion(
  program: Program,
  op: HttpOperation,
  version: Version,
): boolean {
  const avail = getAvailabilityMap(program, op.operation);
  if (!avail) return true;
  const a = avail.get(version.name);
  return a === Availability.Added || a === Availability.Available;
}

// ─── Visibility-filtered request types ──────────────────────────────────────

interface RequestType {
  name: string;
  doc: string | undefined;
  props: Map<string, ModelProperty>;
  baseModel: Model;
  suffix: string;
}

function requestTypeSuffix(verb: string): string {
  switch (verb) {
    case "post":
      return "Create";
    case "patch":
      return "Update";
    case "put":
      return "Replace";
    default:
      return capitalize(verb);
  }
}

const MERGE_PATCH_SUFFIXES = [
  "MergePatchUpdate",
  "MergePatchUpdateReplaceOnly",
  "MergePatchCreateOrUpdate",
];

function isSynthesizedMergePatchModel(model: Model): boolean {
  return model.name
    ? MERGE_PATCH_SUFFIXES.some((s) => model.name!.endsWith(s))
    : false;
}

function hasHiddenProperties(
  model: Model,
  visibility: Visibility,
  program: Program,
): boolean {
  for (const [, prop] of flattenProperties(model)) {
    if (!isVisible(program, prop, visibility)) return true;
  }
  return false;
}

function filterPropsForRequest(
  model: Model,
  visibility: Visibility,
  version: Version | undefined,
  program: Program,
): Map<string, ModelProperty> {
  const result = new Map<string, ModelProperty>();
  for (const [name, prop] of flattenProperties(model)) {
    if (version) {
      const avail = getAvailabilityMap(program, prop);
      if (avail) {
        const a = avail.get(version.name);
        if (a !== Availability.Added && a !== Availability.Available) continue;
      }
    }
    if (!isVisible(program, prop, visibility)) continue;
    result.set(name, prop);
  }
  return result;
}

// ─── Service-level orchestration ────────────────────────────────────────────

async function emitService(
  program: Program,
  serviceNs: Namespace,
  operations: HttpOperation[],
  outputDir: string,
  options: EmitterOptions,
  renderer: Renderer,
): Promise<void> {
  const nsFullName = getNamespaceFullName(serviceNs);
  const allVersions = getAllVersions(program, serviceNs) ?? [];
  const versionsToEmit = resolveTargetVersions(program, allVersions, options);
  if (versionsToEmit === null) return;

  const useVersionedFolders = options["all-versions"] === true;

  // Group operations by container (Interface or Namespace)
  const byContainer = new Map<
    string,
    { name: string; container: Interface | Namespace; ops: HttpOperation[] }
  >();
  for (const op of operations) {
    const c = op.container;
    const key =
      c.kind === "Interface" ? c.name : `__ns_${(c as Namespace).name}`;
    const name = c.kind === "Interface" ? c.name : serviceNs.name;
    if (!byContainer.has(key))
      byContainer.set(key, { name, container: c, ops: [] });
    byContainer.get(key)!.ops.push(op);
  }

  const prefixTemplate = options["route-prefix"] ?? "api/{version}";

  if (versionsToEmit.length > 0) {
    for (const version of versionsToEmit) {
      const vDir = useVersionedFolders
        ? resolvePath(outputDir, version.value)
        : outputDir;
      const routePrefix = resolveRoutePrefix(prefixTemplate, version.value);
      await emitVersion(
        program,
        nsFullName,
        byContainer,
        vDir,
        version,
        routePrefix,
        renderer,
      );
    }
  } else {
    const routePrefix = resolveRoutePrefix(prefixTemplate, undefined);
    await emitVersion(
      program,
      nsFullName,
      byContainer,
      outputDir,
      undefined,
      routePrefix,
      renderer,
    );
  }

  // Emit package.json and tsconfig.json once at the root output dir
  const packageJson = buildPackageJson(
    nsFullName,
    versionsToEmit,
    allVersions,
    options,
  );
  await writeFile(program, resolvePath(outputDir, "package.json"), packageJson);
  await writeFile(
    program,
    resolvePath(outputDir, "tsconfig.json"),
    buildTsConfig(),
  );
}

async function emitVersion(
  program: Program,
  nsFullName: string,
  byContainer: Map<
    string,
    { name: string; container: Interface | Namespace; ops: HttpOperation[] }
  >,
  vDir: string,
  version: Version | undefined,
  routePrefix: string,
  renderer: Renderer,
): Promise<void> {
  const models = new Map<string, Model>();
  const enums = new Map<string, Enum>();
  const requestTypes = new Map<string, RequestType>();
  const requestTypeBaseModels = new Set<string>();
  const names = createNameResolutionContext();

  // Determine which model names are needed for GET/HEAD responses BEFORE the
  // full collection pass. Models that only appear as write-operation bodies (and
  // never as read-operation responses) will be suppressed in favour of their
  // filtered request types. Models that appear in both contexts are kept.
  const readResponseModelNames = collectReadResponseModelNames(
    program,
    byContainer,
    version,
  );

  // First pass: collect all types and build request types
  for (const { ops } of byContainer.values()) {
    const vOps = version
      ? ops.filter((op) => isOpInVersion(program, op, version))
      : ops;
    for (const op of vOps) {
      collectTypesFromOp(op, program, models, enums, names);
      collectRequestType(
        op,
        program,
        models,
        enums,
        version,
        requestTypes,
        requestTypeBaseModels,
        names,
      );
    }
  }

  // Recursively collect enum/model types referenced inside model properties.
  // mapTsType for named models only adds the model itself without traversing its
  // properties, so types like enums first discovered via a property would be missed.
  deepCollectTypes(models, enums, program, names);

  // Emit endpoint files and collect their relative paths for the index
  const endpointExports: string[] = [];
  for (const { name, container, ops } of byContainer.values()) {
    const vOps = version
      ? ops.filter((op) => isOpInVersion(program, op, version))
      : ops;
    if (vOps.length === 0) continue;

    const doc = getDoc(program, container);
    const className = `${name}Endpoints`;
    const content = buildEndpointsFile(
      className,
      vOps,
      doc,
      routePrefix,
      renderer,
      program,
    );
    const relPath = `endpoints/${name}.ts`;
    await writeFile(program, resolvePath(vDir, relPath), content);
    endpointExports.push(`./endpoints/${name}.js`);
  }

  // Emit models.ts if there's anything to export
  const hasModels =
    [...models.values()].some((m) => isEmittable(m, nsFullName)) ||
    [...enums.values()].some((e) => isEmittableEnum(e, nsFullName)) ||
    requestTypes.size > 0;

  if (hasModels) {
    const content = buildModelsFile(
      nsFullName,
      models,
      enums,
      requestTypes,
      requestTypeBaseModels,
      readResponseModelNames,
      program,
      renderer,
      names,
    );
    await writeFile(program, resolvePath(vDir, "models.ts"), content);
  }

  // Emit index.ts
  const exports: string[] = [];
  if (hasModels) exports.push("./models.js");
  exports.push(...endpointExports);

  if (exports.length > 0) {
    const indexView: IndexView = { exports };
    const indexContent = renderer.renderIndex(indexView);
    await writeFile(program, resolvePath(vDir, "index.ts"), indexContent);
  }
}

// ─── Type collection (side-effecting mapType calls) ──────────────────────────

function collectTypesFromOp(
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  names: NameResolutionContext,
): void {
  for (const param of op.parameters.parameters) {
    mapTsType(param.param.type, program, models, enums, names);
  }
  if (op.parameters.body) {
    mapTsType(op.parameters.body.type, program, models, enums, names);
  }
  for (const resp of op.responses) {
    for (const content of resp.responses) {
      if (content.body) {
        mapTsType(content.body.type, program, models, enums, names);
      }
    }
  }
}

function collectRequestType(
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  requestTypeBaseModels: Set<string>,
  names: NameResolutionContext,
): void {
  if (!op.parameters.body) return;
  const body = op.parameters.body;
  if (body.bodyKind !== "single" || body.type.kind !== "Model") return;
  if (op.verb !== "post" && op.verb !== "patch" && op.verb !== "put") return;

  const bodyModel = body.type as Model;
  if (!bodyModel.name || isSynthesizedMergePatchModel(bodyModel)) return;

  const visibility = resolveRequestVisibility(program, op.operation, op.verb);
  if (!hasHiddenProperties(bodyModel, visibility, program)) return;

  const suffix = requestTypeSuffix(op.verb);
  const clientModelName = resolveModelName(program, bodyModel, names);
  const requestTypeName = `${clientModelName}${suffix}Request`;
  if (!requestTypes.has(requestTypeName)) {
    requestTypes.set(requestTypeName, {
      name: requestTypeName,
      doc: getDoc(program, bodyModel),
      props: filterPropsForRequest(bodyModel, visibility, version, program),
      baseModel: bodyModel,
      suffix,
    });
    requestTypeBaseModels.add(bodyModel.name);
  }

  // Register types from the filtered props too
  for (const [, prop] of requestTypes.get(requestTypeName)!.props) {
    mapTsType(prop.type, program, models, enums, names);
  }
}

// ─── Read-response model name collection ─────────────────────────────────────

function collectReadResponseModelNames(
  program: Program,
  byContainer: Map<
    string,
    { name: string; container: Interface | Namespace; ops: HttpOperation[] }
  >,
  version: Version | undefined,
): Set<string> {
  const tmpModels = new Map<string, Model>();
  const tmpEnums = new Map<string, Enum>();
  const names = createNameResolutionContext();
  for (const { ops } of byContainer.values()) {
    const vOps = version
      ? ops.filter((op) => isOpInVersion(program, op, version))
      : ops;
    for (const op of vOps) {
      if (op.verb !== "get" && op.verb !== "head") continue;
      for (const resp of op.responses) {
        for (const content of resp.responses) {
          if (content.body)
            mapTsType(content.body.type, program, tmpModels, tmpEnums, names);
        }
      }
    }
  }
  deepCollectTypes(tmpModels, tmpEnums, program, names);
  return new Set(tmpModels.keys());
}

// ─── Deep type collection ─────────────────────────────────────────────────────

function deepCollectTypes(
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  program: Program,
  names: NameResolutionContext,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const model of [...models.values()]) {
      for (const [, prop] of flattenProperties(model)) {
        const prevModels = models.size;
        const prevEnums = enums.size;
        mapTsType(prop.type, program, models, enums, names);
        if (models.size !== prevModels || enums.size !== prevEnums)
          changed = true;
      }
    }
  }
}

// ─── models.ts generation ────────────────────────────────────────────────────

function buildModelsFile(
  nsFullName: string,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  requestTypes: Map<string, RequestType>,
  requestTypeBaseModels: Set<string>,
  readResponseModelNames: Set<string>,
  program: Program,
  renderer: Renderer,
  names: NameResolutionContext,
): string {
  const parts: string[] = [];

  for (const [, e] of enums) {
    if (!isEmittableEnum(e, nsFullName)) continue;
    parts.push(renderer.renderEnum(buildEnumView(e, program, names)));
  }

  for (const [, model] of models) {
    if (!isEmittable(model, nsFullName)) continue;
    // Suppress models that have a request type and are NOT needed for any
    // GET/HEAD response — they'll appear only via their filtered request type.
    if (
      requestTypeBaseModels.has(model.name!) &&
      !readResponseModelNames.has(model.name!)
    )
      continue;
    parts.push(
      renderer.renderInterface(
        buildInterfaceView(model, program, models, enums, names),
      ),
    );
  }

  for (const [, rt] of requestTypes) {
    const resolvedRequestTypeName = reserveDeclarationName(
      program,
      names.declarationNames,
      rt.name,
      rt.baseModel,
      "request type",
      `${rt.baseModel.name}${rt.suffix}Request`,
    );
    parts.push(
      renderer.renderInterface(
        buildFilteredInterfaceView(
          resolvedRequestTypeName,
          rt.doc,
          rt.props,
          program,
          models,
          enums,
          names,
        ),
      ),
    );
  }

  const body = parts.join("\n\n");
  const fileView: FileView = { body, fileName: "models.ts" };
  return renderer.renderFile(fileView);
}

function buildInterfaceView(
  model: Model,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  names: NameResolutionContext,
): InterfaceView {
  const typeParams = collectTypeParams(model);
  const genericSuffix =
    typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
  const doc = getDoc(program, model);
  return {
    doc: doc ?? undefined,
    interfaceName: resolveModelName(program, model, names),
    genericSuffix,
    properties: buildPropertyViews(
      flattenProperties(model),
      program,
      models,
      enums,
      names,
    ),
  };
}

function buildFilteredInterfaceView(
  name: string,
  doc: string | undefined,
  props: Map<string, ModelProperty>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  names: NameResolutionContext,
): InterfaceView {
  return {
    doc: doc ?? undefined,
    interfaceName: name,
    genericSuffix: "",
    properties: buildPropertyViews(props, program, models, enums, names),
  };
}

function buildPropertyViews(
  props: Iterable<[string, ModelProperty]>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  names: NameResolutionContext,
): PropertyView[] {
  const result: PropertyView[] = [];
  const seenPropertyNames = new Set<string>();
  for (const [, prop] of props) {
    const doc = getDoc(program, prop);
    const tsType = mapTsType(prop.type, program, models, enums, names);
    let propName = resolveOverrideIdentifier(
      program,
      prop,
      "property",
      prop.name,
    );
    if (seenPropertyNames.has(propName) && propName !== prop.name) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "client-name-collision",
          target: prop,
          format: {
            name: propName,
            kind: "property",
            scope: "interface member",
          },
        }),
      );
      propName = prop.name;
    }
    seenPropertyNames.add(propName);
    result.push({
      doc: doc ?? undefined,
      name: propName,
      type: tsType,
      optional: prop.optional,
    });
  }
  return result;
}

function buildEnumView(
  e: Enum,
  program: Program,
  names: NameResolutionContext,
): EnumView {
  const doc = getDoc(program, e);
  const members: EnumMemberView[] = [];
  const seenMemberNames = new Set<string>();
  for (const [, member] of e.members) {
    const memberDoc = getDoc(program, member);
    const stringValue =
      typeof member.value === "string" ? member.value : member.name;
    let memberName = resolveOverrideIdentifier(
      program,
      member,
      "enum member",
      member.name,
    );
    if (seenMemberNames.has(memberName) && memberName !== member.name) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "client-name-collision",
          target: member,
          format: {
            name: memberName,
            kind: "enum member",
            scope: "enum member",
          },
        }),
      );
      memberName = member.name;
    }
    seenMemberNames.add(memberName);
    members.push({
      doc: memberDoc ?? undefined,
      name: memberName,
      memberValue: stringValue,
    });
  }
  return {
    doc: doc ?? undefined,
    enumName: resolveEnumName(program, e, names),
    members,
  };
}

// ─── endpoints/*.ts generation ────────────────────────────────────────────────

function buildEndpointsFile(
  className: string,
  ops: HttpOperation[],
  doc: string | undefined,
  routePrefix: string,
  renderer: Renderer,
  program: Program,
): string {
  const methods: EndpointMethodView[] = ops.map((op) =>
    buildEndpointMethodView(op, routePrefix, program),
  );
  const endpointsView: EndpointsView = {
    doc: doc ?? undefined,
    className,
    methods,
  };
  const body = renderer.renderEndpoints(endpointsView);
  const fileView: FileView = { body, fileName: `${className}.ts` };
  return renderer.renderFile(fileView);
}

function buildEndpointMethodView(
  op: HttpOperation,
  routePrefix: string,
  program: Program,
): EndpointMethodView {
  const pathParams = op.parameters.parameters
    .filter((p) => p.type === "path")
    .map((p) => p.param.name);

  const functionText = buildEndpointFunctionText(
    op.path,
    pathParams,
    routePrefix,
  );

  return {
    doc: getDoc(program, op.operation) ?? undefined,
    name: op.operation.name,
    functionText,
  };
}

/** Backtick character constant — avoids escape issues in template literals. */
const BT = "`";

/**
 * Resolves the route prefix by substituting the `{version}` token with the
 * actual version value. When no version is provided the token (and any
 * resulting trailing slash) is removed. Leading/trailing slashes are stripped
 * so the caller can safely prepend `/${prefix}${path}`.
 */
export function resolveRoutePrefix(
  prefix: string,
  versionValue: string | undefined,
): string {
  let resolved = prefix.replace("{version}", versionValue ?? "");
  // Collapse consecutive slashes then strip leading/trailing slashes.
  resolved = resolved.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return resolved;
}

function buildEndpointFunctionText(
  path: string,
  pathParamNames: string[],
  routePrefix: string,
): string {
  // Convert {param} to ${param} for JS template literals.
  // In replacement strings: $$ → $, $1 → first capture group.
  const fullPath = routePrefix ? `/${routePrefix}${path}` : path;
  const templatePath = fullPath.replace(/\{([^}]+)\}/g, "$${$1}");
  const pathExpr = BT + templatePath + BT;

  if (pathParamNames.length === 0) {
    return `() => ${pathExpr}`;
  }

  const params = pathParamNames.map((p) => `${p}: string`).join(", ");
  return `(${params}) => ${pathExpr}`;
}

// ─── package.json generation ─────────────────────────────────────────────────

function nsToPackageName(nsFullName: string): string {
  return nsFullName
    .split(".")
    .map((part) =>
      part
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
        .toLowerCase(),
    )
    .join("-");
}

function buildPackageJson(
  nsFullName: string,
  versionsToEmit: Version[],
  allVersions: Version[],
  options: EmitterOptions,
): string {
  const version = deriveNpmVersion(allVersions, options);
  const description =
    options["npm-description"] ?? `Client models for the ${nsFullName} API`;
  const useVersionedFolders = options["all-versions"] === true;

  const pkg: Record<string, unknown> = {};
  pkg.name = options["npm-package-name"] ?? nsToPackageName(nsFullName);
  pkg.version = version;
  pkg.description = description;
  pkg.type = "module";
  pkg.sideEffects = false;

  if (useVersionedFolders && versionsToEmit.length > 0) {
    const exports: Record<string, Record<string, string>> = {};
    for (const v of versionsToEmit) {
      exports[`./${v.value}`] = {
        import: `./dist/${v.value}/index.js`,
        types: `./dist/${v.value}/index.d.ts`,
      };
    }
    pkg.exports = exports;
  } else {
    pkg.exports = {
      ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
    };
    pkg.main = "./dist/index.js";
    pkg.types = "./dist/index.d.ts";
  }

  pkg.files = ["dist"];
  pkg.scripts = { build: "tsc" };
  pkg.devDependencies = { typescript: "latest" };

  return JSON.stringify(pkg, null, 2) + "\n";
}

function buildTsConfig(): string {
  const config = {
    compilerOptions: {
      target: "ES2020",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: "./dist",
      strict: true,
    },
    include: ["./**/*.ts"],
    exclude: ["dist", "node_modules"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

// ─── Type mapping ────────────────────────────────────────────────────────────

function mapTsType(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  names: NameResolutionContext,
): string {
  switch (type.kind) {
    case "Scalar":
      return mapScalar(type as Scalar, program);

    case "Model": {
      const m = type as Model;
      if (isArrayModelType(m)) {
        return `${mapTsType(m.indexer!.value, program, models, enums, names)}[]`;
      }
      if (isRecordModelType(m)) {
        return `Record<string, ${mapTsType(m.indexer!.value, program, models, enums, names)}>`;
      }
      if (isErrorModel(program, m)) {
        // Emit error models — just note them
      }
      if (!m.name) return "unknown";

      if (m.templateMapper?.args) {
        const args = m.templateMapper.args
          .filter(
            (a): a is Type =>
              (a as { entityKind?: string }).entityKind === "Type",
          )
          .map((a) => mapTsType(a, program, models, enums, names));
        if (m.name === "Array" && args.length === 1) return `${args[0]}[]`;
        const decl = m.namespace?.models.get(m.name);
        models.set(m.name, decl ?? m);
        const templateClientName = resolveModelName(program, decl ?? m, names);
        return args.length > 0
          ? `${templateClientName}<${args.join(", ")}>`
          : templateClientName;
      }

      models.set(m.name, m);
      return resolveModelName(program, m, names);
    }

    case "Enum": {
      const e = type as Enum;
      if (e.name) enums.set(e.name, e);
      return resolveEnumName(program, e, names);
    }

    case "Union": {
      const u = type as Union;
      const parts: string[] = [];
      for (const [, variant] of u.variants) {
        parts.push(mapTsType(variant.type, program, models, enums, names));
      }
      const unique = [...new Set(parts)].filter((p) => p !== "never");
      return unique.length > 0 ? unique.join(" | ") : "unknown";
    }

    case "String":
      return JSON.stringify((type as StringLiteral).value);

    case "Number":
      return String((type as NumericLiteral).numericValue);

    case "Boolean":
      return String((type as BooleanLiteral).value);

    case "Intrinsic":
      if (isVoidType(type)) return "void";
      if (isNullType(type)) return "null";
      if (isNeverType(type)) return "never";
      return "unknown";

    case "TemplateParameter":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (type as any).node?.id?.sv ?? "T";

    default:
      return "unknown";
  }
}

function mapScalar(scalar: Scalar, program: Program): string {
  const fmt = getFormat(program, scalar);
  if (fmt) return "string"; // all formats (uuid, uri, email, phone, etc.) → string

  const builtin = builtinScalarName(scalar);
  switch (builtin) {
    case "string":
    case "url":
      return "string";
    case "int8":
    case "int16":
    case "int32":
    case "int64":
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
    case "safeint":
    case "float32":
    case "float64":
    case "decimal":
    case "decimal128":
    case "numeric":
    case "integer":
    case "float":
      return "number";
    case "boolean":
      return "boolean";
    case "bytes":
      return "Uint8Array";
    case "utcDateTime":
    case "offsetDateTime":
      return "Date";
    case "plainDate":
    case "plainTime":
    case "duration":
      return "string";
    default:
      return "string";
  }
}

const BUILTIN_SCALARS = new Set([
  "string",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "safeint",
  "integer",
  "float",
  "float32",
  "float64",
  "decimal",
  "decimal128",
  "numeric",
  "boolean",
  "bytes",
  "utcDateTime",
  "offsetDateTime",
  "plainDate",
  "plainTime",
  "duration",
  "url",
]);

function builtinScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (BUILTIN_SCALARS.has(current.name)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

// ─── Emission filters ────────────────────────────────────────────────────────

function isEmittable(model: Model, serviceNsName: string): boolean {
  if (!model.name) return false;
  const ns = model.namespace ? getNamespaceFullName(model.namespace) : "";
  return (
    ns === serviceNsName || ns.startsWith(`${serviceNsName}.`) || ns === ""
  );
}

function isEmittableEnum(e: Enum, serviceNsName: string): boolean {
  if (!e.name) return false;
  const ns = e.namespace ? getNamespaceFullName(e.namespace) : "";
  return (
    ns === serviceNsName || ns.startsWith(`${serviceNsName}.`) || ns === ""
  );
}

// ─── Model helpers ───────────────────────────────────────────────────────────

function flattenProperties(model: Model): Map<string, ModelProperty> {
  const props = new Map<string, ModelProperty>();
  if (model.baseModel) {
    for (const [name, prop] of flattenProperties(model.baseModel)) {
      props.set(name, prop);
    }
  }
  for (const [name, prop] of model.properties) {
    props.set(name, prop);
  }
  return props;
}

function collectTypeParams(model: Model): string[] {
  const params: string[] = [];
  for (const [, prop] of model.properties) {
    gatherTemplateParams(prop.type, params);
  }
  return [...new Set(params)];
}

function gatherTemplateParams(
  type: Type,
  out: string[],
  visited: Set<Type> = new Set(),
): void {
  if (visited.has(type)) return;
  visited.add(type);

  if (type.kind === "TemplateParameter") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.push((type as any).node?.id?.sv ?? "T");
  } else if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) gatherTemplateParams(m.indexer.value, out, visited);
    if (m.templateMapper?.args) {
      for (const arg of m.templateMapper.args) {
        if ((arg as { entityKind?: string }).entityKind === "Type") {
          gatherTemplateParams(arg as Type, out, visited);
        }
      }
    }
    for (const [, p] of m.properties)
      gatherTemplateParams(p.type, out, visited);
  }
}

// ─── Misc helpers ────────────────────────────────────────────────────────────

function sanitizeVersionForPath(version: string): string {
  return version.replace(/\./g, "_").replace(/^v/i, "v");
}

// Exported for use in tests
export { sanitizeVersionForPath };

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

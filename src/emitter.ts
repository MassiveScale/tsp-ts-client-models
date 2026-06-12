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
  getTags,
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
  HttpStatusCodeRange,
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
import { resolve } from "node:path";
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
  ClientView,
  TemplateOverrides,
} from "./renderer.js";
import { EmitterOptions, createDiagnostic, reportDiagnostic } from "./lib.js";

// ─── Entry point ────────────────────────────────────────────────────────────

export async function $onEmit(
  context: EmitContext<EmitterOptions>,
): Promise<void> {
  const { program, emitterOutputDir, options } = context;
  if (program.compilerOptions.noEmit) return;

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
  sourceOp: HttpOperation;
}

function requestTypeSuffix(verb: string): string {
  return capitalize(verb);
}

// TypeSpec synthesizes these model name suffixes internally for PATCH/MergePatch bodies.
// They are never valid output names — all detected models are renamed to {Base}PatchRequest.
const TYPESPEC_MERGE_PATCH_INTERNAL_SUFFIXES = [
  "MergePatchUpdate",
  "MergePatchUpdateReplaceOnly",
  "MergePatchCreateOrUpdate",
];

function getMergePatchBaseName(modelName: string): string | undefined {
  for (const suffix of TYPESPEC_MERGE_PATCH_INTERNAL_SUFFIXES) {
    if (modelName.endsWith(suffix)) return modelName.slice(0, -suffix.length);
  }
  return undefined;
}

function isSynthesizedMergePatchModel(model: Model): boolean {
  return model.name ? getMergePatchBaseName(model.name) !== undefined : false;
}

// Build a rename map for all synthesized MergePatch model names found in the
// collected models. Each synthesized name maps to:
//   - "{Base}PatchRequest" when the base model has its own endpoint (appears in
//     requestTypeBaseModels), meaning it already has a generated request type.
//   - "{Base}" (the plain model name) when the base is a complex value type with
//     no endpoint (e.g. Tag), so we simply reference the original model.
function buildMergePatchRenameMap(
  models: Map<string, Model>,
  requestTypeBaseModels: Set<string>,
): Map<string, string> {
  const renameMap = new Map<string, string>();
  for (const [name] of models) {
    const base = getMergePatchBaseName(name);
    if (base === undefined) continue;
    renameMap.set(
      name,
      requestTypeBaseModels.has(base) ? `${base}PatchRequest` : base,
    );
  }
  return renameMap;
}

function propsHaveSameKeys(
  a: Map<string, ModelProperty>,
  b: Map<string, ModelProperty>,
): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
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
        options,
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
      options,
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
  options: EmitterOptions,
  renderer: Renderer,
): Promise<void> {
  const models = new Map<string, Model>();
  const enums = new Map<string, Enum>();
  const requestTypes = new Map<string, RequestType>();
  const requestTypeBaseModels = new Set<string>();

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
      collectTypesFromOp(op, program, models, enums);
      collectRequestType(
        op,
        program,
        models,
        enums,
        version,
        requestTypes,
        requestTypeBaseModels,
      );
    }
  }

  // Recursively collect enum/model types referenced inside model properties.
  // mapTsType for named models only adds the model itself without traversing its
  // properties, so types like enums first discovered via a property would be missed.
  deepCollectTypes(models, enums, program);

  // Build a rename map so synthesized MergePatch type names are rewritten to
  // their canonical output names during rendering (e.g. PetMergePatchUpdateReplaceOnly
  // → PetPatchRequest, TagMergePatchUpdateReplaceOnly → Tag).
  const mergePatchRenameMap = buildMergePatchRenameMap(
    models,
    requestTypeBaseModels,
  );

  const generateClient = options["generate-http-client"] !== false;

  // Emit endpoint files and (optionally) client files; collect exports for index
  const endpointExports: string[] = [];
  const clientExports: string[] = [];

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

    if (generateClient) {
      const clientContent = buildClientFile(
        name,
        vOps,
        requestTypes,
        program,
        models,
        enums,
        renderer,
        mergePatchRenameMap,
      );
      await writeFile(
        program,
        resolvePath(vDir, `client/${name}Client.ts`),
        clientContent,
      );
      clientExports.push(`./client/${name}Client.js`);
    }
  }

  // Emit the static base client infrastructure
  if (generateClient && clientExports.length > 0) {
    const fileContent = `// AUTO-GENERATED. Do not edit this file directly.\n\n${API_CLIENT_CONTENT}`;
    await writeFile(
      program,
      resolvePath(vDir, "client/ApiClient.ts"),
      fileContent,
    );
    clientExports.unshift("./client/ApiClient.js");
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
      mergePatchRenameMap,
    );
    await writeFile(program, resolvePath(vDir, "models.ts"), content);
  }

  // Emit index.ts
  const exports: string[] = [];
  if (hasModels) exports.push("./models.js");
  exports.push(...endpointExports);
  exports.push(...clientExports);

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
): void {
  for (const param of op.parameters.parameters) {
    mapTsType(param.param.type, program, models, enums);
  }
  if (op.parameters.body) {
    mapTsType(op.parameters.body.type, program, models, enums);
  }
  for (const resp of op.responses) {
    for (const content of resp.responses) {
      if (content.body) {
        mapTsType(content.body.type, program, models, enums);
      }
    }
  }
}

function storeRequestType(
  requestTypeName: string,
  baseName: string,
  newEntry: RequestType,
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  requestTypes: Map<string, RequestType>,
  requestTypeBaseModels: Set<string>,
): void {
  if (requestTypes.has(requestTypeName)) {
    const existing = requestTypes.get(requestTypeName)!;
    if (!propsHaveSameKeys(existing.props, newEntry.props)) {
      // Collision: same name, different shapes — rename both with their @tag prefix.
      const existingTags = getTags(program, existing.sourceOp.operation);
      const newTags = getTags(program, op.operation);
      if (!existingTags.length || !newTags.length) {
        reportDiagnostic(program, {
          code: "request-type-collision",
          messageId: !existingTags.length ? "missingTag" : "default",
          format: { name: requestTypeName, op: op.operation.name },
          target: op.operation,
        });
        return;
      }
      const existingPrefix = capitalize(existingTags[0]);
      const newPrefix = capitalize(newTags[0]);
      requestTypes.delete(requestTypeName);
      requestTypeBaseModels.delete(baseName);
      requestTypes.set(`${existingPrefix}${requestTypeName}`, {
        ...existing,
        name: `${existingPrefix}${requestTypeName}`,
      });
      requestTypeBaseModels.add(`${existingPrefix}${baseName}`);
      requestTypes.set(`${newPrefix}${requestTypeName}`, {
        ...newEntry,
        name: `${newPrefix}${requestTypeName}`,
      });
      requestTypeBaseModels.add(`${newPrefix}${baseName}`);
      for (const [, prop] of newEntry.props) {
        mapTsType(prop.type, program, models, enums);
      }
    }
    // Identical shape — deduplicate silently.
    return;
  }

  requestTypes.set(requestTypeName, newEntry);
  requestTypeBaseModels.add(baseName);
  for (const [, prop] of newEntry.props) {
    mapTsType(prop.type, program, models, enums);
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
): void {
  if (!op.parameters.body) return;
  const body = op.parameters.body;
  if (body.bodyKind !== "single" || body.type.kind !== "Model") return;
  if (op.verb !== "post" && op.verb !== "patch" && op.verb !== "put") return;

  const bodyModel = body.type as Model;
  if (!bodyModel.name) return;

  const mergePatchBase = getMergePatchBaseName(bodyModel.name);

  if (mergePatchBase !== undefined) {
    // MergePatch body: emit {BaseName}PatchRequest using the synthesized model's
    // properties directly — they are already correctly nullable for partial updates.
    const requestTypeName = `${mergePatchBase}PatchRequest`;
    storeRequestType(
      requestTypeName,
      mergePatchBase,
      {
        name: requestTypeName,
        doc: getDoc(program, bodyModel),
        props: new Map(bodyModel.properties),
        sourceOp: op,
      },
      op,
      program,
      models,
      enums,
      requestTypes,
      requestTypeBaseModels,
    );
    return;
  }

  const visibility = resolveRequestVisibility(program, op.operation, op.verb);
  if (!hasHiddenProperties(bodyModel, visibility, program)) return;

  const suffix = requestTypeSuffix(op.verb);
  const requestTypeName = `${bodyModel.name}${suffix}Request`;
  const newProps = filterPropsForRequest(
    bodyModel,
    visibility,
    version,
    program,
  );

  storeRequestType(
    requestTypeName,
    bodyModel.name,
    {
      name: requestTypeName,
      doc: getDoc(program, bodyModel),
      props: newProps,
      sourceOp: op,
    },
    op,
    program,
    models,
    enums,
    requestTypes,
    requestTypeBaseModels,
  );
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
  for (const { ops } of byContainer.values()) {
    const vOps = version
      ? ops.filter((op) => isOpInVersion(program, op, version))
      : ops;
    for (const op of vOps) {
      if (op.verb !== "get" && op.verb !== "head") continue;
      for (const resp of op.responses) {
        for (const content of resp.responses) {
          if (content.body)
            mapTsType(content.body.type, program, tmpModels, tmpEnums);
        }
      }
    }
  }
  deepCollectTypes(tmpModels, tmpEnums, program);
  return new Set(tmpModels.keys());
}

// ─── Deep type collection ─────────────────────────────────────────────────────

function deepCollectTypes(
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  program: Program,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const model of [...models.values()]) {
      for (const [, prop] of flattenProperties(model)) {
        const prevModels = models.size;
        const prevEnums = enums.size;
        mapTsType(prop.type, program, models, enums);
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
  renameMap: Map<string, string>,
): string {
  const parts: string[] = [];

  for (const [, e] of enums) {
    if (!isEmittableEnum(e, nsFullName)) continue;
    parts.push(renderer.renderEnum(buildEnumView(e, program)));
  }

  for (const [, model] of models) {
    if (!isEmittable(model, nsFullName)) continue;
    // Never emit synthesized MergePatch types — they are replaced by *PatchRequest
    // types or by references to the plain base model.
    if (isSynthesizedMergePatchModel(model)) continue;
    // Suppress models that have a request type and are NOT needed for any
    // GET/HEAD response — they'll appear only via their filtered request type.
    if (
      requestTypeBaseModels.has(model.name!) &&
      !readResponseModelNames.has(model.name!)
    )
      continue;
    parts.push(
      renderer.renderInterface(
        buildInterfaceView(model, program, models, enums, renameMap),
      ),
    );
  }

  for (const [, rt] of requestTypes) {
    parts.push(
      renderer.renderInterface(
        buildFilteredInterfaceView(
          rt.name,
          rt.doc,
          rt.props,
          program,
          models,
          enums,
          renameMap,
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
  renameMap?: Map<string, string>,
): InterfaceView {
  const typeParams = collectTypeParams(model);
  const genericSuffix =
    typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
  const doc = getDoc(program, model);
  return {
    doc: doc ?? undefined,
    interfaceName: model.name!,
    genericSuffix,
    properties: buildPropertyViews(
      flattenProperties(model),
      program,
      models,
      enums,
      renameMap,
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
  renameMap?: Map<string, string>,
): InterfaceView {
  return {
    doc: doc ?? undefined,
    interfaceName: name,
    genericSuffix: "",
    properties: buildPropertyViews(props, program, models, enums, renameMap),
  };
}

function buildPropertyViews(
  props: Iterable<[string, ModelProperty]>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renameMap?: Map<string, string>,
): PropertyView[] {
  const result: PropertyView[] = [];
  for (const [, prop] of props) {
    const doc = getDoc(program, prop);
    const tsType = mapTsType(prop.type, program, models, enums, renameMap);
    result.push({
      doc: doc ?? undefined,
      name: prop.name,
      type: tsType,
      optional: prop.optional,
    });
  }
  return result;
}

function buildEnumView(e: Enum, program: Program): EnumView {
  const doc = getDoc(program, e);
  const members: EnumMemberView[] = [];
  for (const [, member] of e.members) {
    const memberDoc = getDoc(program, member);
    const stringValue =
      typeof member.value === "string" ? member.value : member.name;
    members.push({
      doc: memberDoc ?? undefined,
      name: member.name,
      memberValue: stringValue,
    });
  }
  return { doc: doc ?? undefined, enumName: e.name, members };
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

// ─── client/ApiClient.ts — static base infrastructure ────────────────────────

const API_CLIENT_CONTENT = `export interface RetryConfig {
  /** Maximum number of attempts before giving up. Default: 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff. Default: 1000. */
  baseDelayMs?: number;
  /** HTTP status codes that trigger a retry. Default: [429, 503]. */
  retryOn?: number[];
}

export interface ClientConfig {
  /** Base URL of the API, e.g. "https://api.example.com". Trailing slash is trimmed automatically. */
  baseUrl: string;
  /** Headers merged into every request. */
  defaultHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (passed as AbortSignal). */
  timeout?: number;
  /** Retry configuration. */
  retry?: RetryConfig;
}

export interface RequestOptions {
  /** Per-request headers merged on top of defaultHeaders. */
  headers?: Record<string, string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body?: unknown,
  ) {
    super(\`HTTP \${status}: \${statusText}\`);
    this.name = "ApiError";
  }
}

export class RateLimitError extends ApiError {
  constructor(public readonly retryAfterMs?: number) {
    super(429, "Too Many Requests");
    this.name = "RateLimitError";
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor() {
    super(503, "Service Unavailable");
    this.name = "ServiceUnavailableError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient {
  constructor(protected readonly config: ClientConfig) {}

  protected async request<T>(
    method: string,
    path: string,
    options?: RequestOptions & {
      body?: unknown;
      query?: Record<string, unknown>;
    },
  ): Promise<T> {
    const { maxAttempts = 3, baseDelayMs = 1000, retryOn = [429, 503] } =
      this.config.retry ?? {};

    let url = \`\${this.config.baseUrl.replace(/\\/$/, "")}\${path}\`;
    if (options?.query) {
      const qs = new URLSearchParams(
        Object.entries(options.query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      if (qs) url = \`\${url}?\${qs}\`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.config.defaultHeaders,
      ...options?.headers,
    };

    let signal = options?.signal;
    if (this.config.timeout && !signal) {
      signal = AbortSignal.timeout(this.config.timeout);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await delay(baseDelayMs * Math.pow(2, attempt - 1));
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body:
            options?.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
          signal,
        });
        if (!resp.ok) {
          if (retryOn.includes(resp.status) && attempt < maxAttempts - 1) {
            if (resp.status === 429) {
              const after = resp.headers.get("Retry-After");
              if (after) await delay(parseFloat(after) * 1000);
            }
            lastError = new ApiError(resp.status, resp.statusText);
            continue;
          }
          const body = await resp.json().catch(() => undefined);
          throw new ApiError(resp.status, resp.statusText, body);
        }
        if (resp.status === 204) return undefined as T;
        return resp.json() as Promise<T>;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new ApiError(0, "Unknown error");
  }

  protected get<T>(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  protected post<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  protected put<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  protected patch<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  protected delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  protected head(path: string, options?: RequestOptions): Promise<void> {
    return this.request<void>("HEAD", path, options);
  }
}
`;

// ─── client/{Name}Client.ts generation ───────────────────────────────────────

function buildClientFile(
  name: string,
  ops: HttpOperation[],
  requestTypes: Map<string, RequestType>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renderer: Renderer,
  renameMap: Map<string, string>,
): string {
  const endpointsClassName = `${name}Endpoints`;
  const modelImportSet = new Set<string>();
  const methods: import("./renderer.js").ClientMethodView[] = ops.map((op) =>
    buildClientMethodView(
      op,
      endpointsClassName,
      requestTypes,
      program,
      models,
      enums,
      modelImportSet,
      renameMap,
    ),
  );

  const clientView: ClientView = {
    className: `${name}Client`,
    endpointsClassName,
    methods,
    modelImports: [...modelImportSet],
  };
  return renderer.renderClient(clientView);
}

function buildClientMethodView(
  op: HttpOperation,
  endpointsClassName: string,
  requestTypes: Map<string, RequestType>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  modelImportSet: Set<string>,
  renameMap: Map<string, string>,
): import("./renderer.js").ClientMethodView {
  const pathParams = op.parameters.parameters
    .filter((p) => p.type === "path")
    .map((p) => ({ name: p.param.name, tsType: "string" }));

  const queryParams = op.parameters.parameters
    .filter((p) => p.type === "query")
    .map((p) => ({
      name: p.param.name,
      tsType: mapTsType(p.param.type, program, models, enums),
      optional: p.param.optional,
    }));

  // Determine request body type
  let bodyType: string | null = null;
  if (
    op.parameters.body?.bodyKind === "single" &&
    op.parameters.body.type.kind === "Model"
  ) {
    const bodyModel = op.parameters.body.type as Model;
    if (bodyModel.name) {
      const mergePatchBase = getMergePatchBaseName(bodyModel.name);
      const baseName = mergePatchBase ?? bodyModel.name;
      const suffix = requestTypeSuffix(op.verb);
      const requestTypeName = `${baseName}${suffix}Request`;
      if (requestTypes.has(requestTypeName)) {
        bodyType = requestTypeName;
        modelImportSet.add(requestTypeName);
      } else if (bodyModel.name && !isSynthesizedMergePatchModel(bodyModel)) {
        bodyType = bodyModel.name;
        modelImportSet.add(bodyModel.name);
      }
    }
  }

  // Determine response type from first 2xx response body
  const responseType = resolveResponseType(
    op,
    program,
    models,
    enums,
    modelImportSet,
    renameMap,
  );

  // Build method parameters string
  const paramParts: string[] = [];
  for (const { name, tsType } of pathParams) {
    paramParts.push(`${name}: ${tsType}`);
  }
  if (bodyType) {
    paramParts.push(`body: ${bodyType}`);
  }
  if (queryParams.length > 0) {
    const queryFields = queryParams
      .map((q) => `${q.name}${q.optional ? "?" : ""}: ${q.tsType}`)
      .join("; ");
    paramParts.push(`query?: { ${queryFields} }`);
  }
  paramParts.push(`options?: RequestOptions`);
  const methodParams = paramParts.join(", ");

  // Build endpoint call expression
  const pathParamArgs = pathParams.map((p) => p.name).join(", ");
  const endpointCall = `${endpointsClassName}.${op.operation.name}(${pathParamArgs})`;

  // Build method body
  const httpMethod = op.verb.toLowerCase();
  let methodBody: string;
  if (op.verb === "get" || op.verb === "head" || op.verb === "delete") {
    if (queryParams.length > 0) {
      methodBody = `return this.${httpMethod}<${responseType}>(${endpointCall}, { ...options, query });`;
    } else {
      methodBody = `return this.${httpMethod}<${responseType}>(${endpointCall}, options);`;
    }
  } else {
    methodBody = `return this.${httpMethod}<${responseType}>(${endpointCall}, ${bodyType ? "body" : "undefined"}, options);`;
  }

  return {
    doc: getDoc(program, op.operation) ?? undefined,
    name: op.operation.name,
    methodParams,
    methodBody,
    responseType,
  };
}

function is2xxStatusCode(code: HttpStatusCodeRange | number | "*"): boolean {
  if (code === "*") return true;
  if (typeof code === "number") return code >= 200 && code < 300;
  // HttpStatusCodeRange: { start, end }
  return code.start >= 200 && code.start < 300;
}

function resolveResponseType(
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  modelImportSet: Set<string>,
  renameMap: Map<string, string>,
): string {
  for (const resp of op.responses) {
    if (!is2xxStatusCode(resp.statusCodes)) continue;
    for (const content of resp.responses) {
      if (content.body) {
        const tsType = mapTsType(
          content.body.type,
          program,
          models,
          enums,
          renameMap,
        );
        if (tsType !== "void" && tsType !== "unknown") {
          collectModelNamesFromType(content.body.type, modelImportSet);
          return tsType;
        }
      }
    }
  }
  return "void";
}

function collectModelNamesFromType(type: Type, into: Set<string>): void {
  if (type.kind === "Model") {
    const m = type as Model;
    if (isArrayModelType(m) && m.indexer) {
      collectModelNamesFromType(m.indexer.value, into);
      return;
    }
    if (isRecordModelType(m) && m.indexer) {
      collectModelNamesFromType(m.indexer.value, into);
      return;
    }
    if (m.name && !m.templateMapper?.args) {
      into.add(m.name);
    } else if (m.name && m.templateMapper?.args) {
      into.add(m.name);
      for (const arg of m.templateMapper.args) {
        if ((arg as { entityKind?: string }).entityKind === "Type") {
          collectModelNamesFromType(arg as Type, into);
        }
      }
    }
  } else if (type.kind === "Union") {
    const u = type as Union;
    for (const [, variant] of u.variants) {
      collectModelNamesFromType(variant.type, into);
    }
  }
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
  renameMap?: Map<string, string>,
): string {
  switch (type.kind) {
    case "Scalar":
      return mapScalar(type as Scalar, program);

    case "Model": {
      const m = type as Model;
      if (isArrayModelType(m)) {
        return `${mapTsType(m.indexer!.value, program, models, enums, renameMap)}[]`;
      }
      if (isRecordModelType(m)) {
        return `Record<string, ${mapTsType(m.indexer!.value, program, models, enums, renameMap)}>`;
      }
      if (isErrorModel(program, m)) {
        // Emit error models — just note them
      }
      if (!m.name) return "unknown";

      // During the rendering phase, synthesized MergePatch model names are
      // rewritten to their canonical output names (e.g. PetPatchRequest or Tag).
      const renamed = renameMap?.get(m.name);
      if (renamed !== undefined) return renamed;

      if (m.templateMapper?.args) {
        const args = m.templateMapper.args
          .filter(
            (a): a is Type =>
              (a as { entityKind?: string }).entityKind === "Type",
          )
          .map((a) => mapTsType(a, program, models, enums, renameMap));
        if (m.name === "Array" && args.length === 1) return `${args[0]}[]`;
        const decl = m.namespace?.models.get(m.name);
        models.set(m.name, decl ?? m);
        return args.length > 0 ? `${m.name}<${args.join(", ")}>` : m.name;
      }

      models.set(m.name, m);
      return m.name;
    }

    case "Enum": {
      const e = type as Enum;
      if (e.name) enums.set(e.name, e);
      return e.name || "string";
    }

    case "Union": {
      const u = type as Union;
      const parts: string[] = [];
      for (const [, variant] of u.variants) {
        parts.push(mapTsType(variant.type, program, models, enums, renameMap));
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

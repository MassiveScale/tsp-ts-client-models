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
  EnumMember,
  Discriminator,
  getDoc,
  getEncode,
  getFormat,
  getTags,
  getDiscriminator,
  getDiscriminatedUnionFromInheritance,
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
  resolveRequestVisibility,
} from "@typespec/http";
import { getAllVersions, Version } from "@typespec/versioning";
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
  UnionView,
  TemplateOverrides,
  TemplateName,
} from "./renderer.js";
import { EmitterOptions, createDiagnostic, reportDiagnostic } from "./lib.js";
import {
  capitalize,
  discriminatedVariantShapesMatch,
  filterPropsForRequest,
  flattenProperties,
  getMergePatchBaseName,
  hasHiddenProperties,
  isOpInVersion,
  propsHaveSameKeys,
  requestTypeSuffix,
} from "./request-types.js";

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
    if (val) result[key as TemplateName] = resolve(process.cwd(), val);
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

/**
 * Resolves which versions should be emitted based on options.
 *
 * Returns:
 * - All versions if `all-versions` is true
 * - The specific version if `target-version` is set and found
 * - The latest version if versions exist and no target is specified
 * - Empty array if no versions are declared and no target is specified
 * - null if an error occurs (version not found)
 */
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

// ─── Visibility-filtered request types ──────────────────────────────────────

interface RequestType {
  name: string;
  doc: string | undefined;
  props: Map<string, ModelProperty>;
  sourceOp: HttpOperation;
}

function isSynthesizedMergePatchModel(model: Model): boolean {
  return model.name ? getMergePatchBaseName(model.name) !== undefined : false;
}

// Build a rename map for all synthesized MergePatch model names found in the
// collected models. Each synthesized name maps to:
//   - "{Base}PatchRequest" only when that patch request type is actually emitted
//     (the base has its own MergePatch/PATCH operation, so `{Base}PatchRequest`
//     exists as a request type or discriminated request union).
//   - "{Base}" (the plain model name) otherwise — e.g. a complex value type with
//     no endpoint (Tag), or a model that is only *transitively* reached through
//     another patch body (e.g. `Store.pets: Pet[]` in a version where `Pet` has a
//     POST but no PATCH). Referencing `{Base}PatchRequest` there would dangle
//     because that type is never emitted for this version.
function buildMergePatchRenameMap(
  models: Map<string, Model>,
  requestTypes: Map<string, RequestType>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
): Map<string, string> {
  const renameMap = new Map<string, string>();
  for (const [name] of models) {
    const base = getMergePatchBaseName(name);
    if (base === undefined) continue;
    const patchTypeName = `${base}PatchRequest`;
    const patchTypeEmitted =
      requestTypes.has(patchTypeName) ||
      discriminatedRequestUnions.has(patchTypeName);
    renameMap.set(name, patchTypeEmitted ? patchTypeName : base);
  }
  return renameMap;
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
    const entry = byContainer.get(key);
    if (entry) entry.ops.push(op);
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
  const discriminatedRequestUnions = new Map<
    string,
    DiscriminatedRequestUnion
  >();

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
        discriminatedRequestUnions,
      );
    }
  }

  // Recursively collect enum/model types referenced inside model properties, and
  // resolve @discriminator base models to their concrete leaf variants so those
  // derived models (which are never referenced directly by an operation) are
  // still discovered and emitted.
  const discriminatedUnions = new Map<string, string[]>();
  deepCollectTypes(models, enums, program, discriminatedUnions);

  // Build a rename map so synthesized MergePatch type names are rewritten to
  // their canonical output names during rendering (e.g. PetMergePatchUpdateReplaceOnly
  // → PetPatchRequest, TagMergePatchUpdateReplaceOnly → Tag).
  const mergePatchRenameMap = buildMergePatchRenameMap(
    models,
    requestTypes,
    discriminatedRequestUnions,
  );

  const generateClient = options["generate-http-client"] !== false;
  const clientStyle = options["client-style"] ?? "promise";
  const emitPromiseClient = clientStyle === "promise" || clientStyle === "both";
  const emitObservableClient =
    clientStyle === "observable" || clientStyle === "both";

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
    const relPath = `endpoints/${name}Endpoints.ts`;
    await writeFile(program, resolvePath(vDir, relPath), content);
    endpointExports.push(`./endpoints/${name}Endpoints.js`);

    if (generateClient && emitPromiseClient) {
      const view = buildClientView(
        name,
        `${name}Client`,
        vOps,
        requestTypes,
        discriminatedRequestUnions,
        program,
        models,
        enums,
        mergePatchRenameMap,
      );
      await writeFile(
        program,
        resolvePath(vDir, `client/${name}Client.ts`),
        renderer.renderClient(view),
      );
      clientExports.push(`./client/${name}Client.js`);
    }

    if (generateClient && emitObservableClient) {
      const view = buildClientView(
        name,
        `${name}ObservableClient`,
        vOps,
        requestTypes,
        discriminatedRequestUnions,
        program,
        models,
        enums,
        mergePatchRenameMap,
      );
      await writeFile(
        program,
        resolvePath(vDir, `client/${name}ObservableClient.ts`),
        renderer.renderObservableClient(view),
      );
      clientExports.push(`./client/${name}ObservableClient.js`);
    }
  }

  // Emit the static base client infrastructure. ApiClient.ts is always required
  // when any client flavor is emitted (RxHttpClient extends HttpClient and
  // reuses its transport, error classes, and config). ApiClientRx.ts is emitted
  // only for the Observable flavor.
  if (generateClient && clientExports.length > 0) {
    const apiClientContent = `// AUTO-GENERATED. Do not edit this file directly.\n\n${API_CLIENT_CONTENT}`;
    await writeFile(
      program,
      resolvePath(vDir, "client/ApiClient.ts"),
      apiClientContent,
    );
    if (emitObservableClient) {
      const rxContent = `// AUTO-GENERATED. Do not edit this file directly.\n\n${RX_API_CLIENT_CONTENT}`;
      await writeFile(
        program,
        resolvePath(vDir, "client/ApiClientRx.ts"),
        rxContent,
      );
      clientExports.unshift("./client/ApiClientRx.js");
    }
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
      discriminatedUnions,
      discriminatedRequestUnions,
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
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
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

  // A discriminated base model can't be filtered as a single flat interface —
  // each concrete variant carries its own fields (e.g. Dog's isBarker), so a
  // flat {Base}{Verb}Request would silently drop them. Instead, filter each
  // variant individually and expose the write body as a union of the results,
  // mirroring how the plain model itself is exposed as a union of variants.
  const discriminator = getDiscriminator(program, bodyModel);
  if (discriminator) {
    collectDiscriminatedRequestType(
      bodyModel,
      discriminator,
      visibility,
      version,
      suffix,
      op,
      program,
      models,
      enums,
      requestTypes,
      requestTypeBaseModels,
      discriminatedRequestUnions,
    );
    return;
  }

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

/** View of a discriminated write body's request type: a union of its
 * per-variant filtered request types (e.g. `PetPostRequest = DogPostRequest |
 * CatPostRequest`). */
interface DiscriminatedRequestUnion {
  /** Ordered, deduplicated request-type names of the concrete variants. */
  memberNames: string[];
  /** Filtered props per variant model name, kept so a later operation on the
   * same discriminated base model + verb can be checked for a shape collision
   * (e.g. a different `@parameterVisibility`) before registering anything. */
  variantProps: Map<string, Map<string, ModelProperty>>;
  /** The operation that produced this registration — its `@tag` resolves a
   * collision against a later conflicting operation. */
  sourceOp: HttpOperation;
}

/**
 * Registers the write-body request types for a discriminator-annotated body
 * model: a filtered `{Variant}{Verb}Request` for every concrete variant
 * (keeping its own fields and its discriminator narrowed to its literal wire
 * value), exposed together as a `{Base}{Verb}Request` union.
 *
 * If a different operation already registered a differently-shaped union
 * under the same name (e.g. two operations on the same discriminated body
 * with different `@parameterVisibility`), the collision is resolved with the
 * same `@tag`-prefix convention {@link storeRequestType} uses — renaming the
 * union *and* every member consistently for both operations, so the union
 * never references a name that isn't actually registered.
 */
function collectDiscriminatedRequestType(
  bodyModel: Model,
  discriminator: Discriminator,
  visibility: Visibility,
  version: Version | undefined,
  suffix: string,
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  requestTypes: Map<string, RequestType>,
  requestTypeBaseModels: Set<string>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
): void {
  const [union] = getDiscriminatedUnionFromInheritance(
    bodyModel,
    discriminator,
  );
  const variants: Model[] = [];
  const seen = new Set<Model>();
  for (const variant of union.variants.values()) {
    if (seen.has(variant) || !variant.name) continue;
    seen.add(variant);
    variants.push(variant);
  }

  const variantProps = new Map<string, Map<string, ModelProperty>>();
  for (const variant of variants) {
    variantProps.set(
      variant.name!,
      filterPropsForRequest(variant, visibility, version, program),
    );
  }

  const requestTypeName = `${bodyModel.name}${suffix}Request`;
  const existing = discriminatedRequestUnions.get(requestTypeName);

  if (existing) {
    if (discriminatedVariantShapesMatch(existing.variantProps, variantProps)) {
      // Identical shape — deduplicate silently.
      return;
    }

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

    discriminatedRequestUnions.delete(requestTypeName);
    requestTypeBaseModels.delete(bodyModel.name);
    // The original (unprefixed) per-variant entries from the first
    // registration are being replaced by tag-prefixed ones below — drop them
    // so they don't linger in requestTypes as unreferenced dead interfaces.
    for (const variant of variants) {
      requestTypes.delete(`${variant.name}${suffix}Request`);
    }

    registerDiscriminatedRequestUnion(
      bodyModel,
      variants,
      existing.variantProps,
      existing.sourceOp,
      suffix,
      capitalize(existingTags[0]),
      program,
      models,
      enums,
      requestTypes,
      requestTypeBaseModels,
      discriminatedRequestUnions,
    );
    registerDiscriminatedRequestUnion(
      bodyModel,
      variants,
      variantProps,
      op,
      suffix,
      capitalize(newTags[0]),
      program,
      models,
      enums,
      requestTypes,
      requestTypeBaseModels,
      discriminatedRequestUnions,
    );
    return;
  }

  registerDiscriminatedRequestUnion(
    bodyModel,
    variants,
    variantProps,
    op,
    suffix,
    "",
    program,
    models,
    enums,
    requestTypes,
    requestTypeBaseModels,
    discriminatedRequestUnions,
  );
}

/**
 * Stores the `{prefix}{Variant}{Verb}Request` interface for every variant
 * under a single, already-resolved name prefix (empty when there is no
 * collision) and records the resulting `{prefix}{Base}{Verb}Request` union —
 * so the union's member names always match what's actually registered.
 */
function registerDiscriminatedRequestUnion(
  bodyModel: Model,
  variants: Model[],
  variantProps: Map<string, Map<string, ModelProperty>>,
  op: HttpOperation,
  suffix: string,
  prefix: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  requestTypes: Map<string, RequestType>,
  requestTypeBaseModels: Set<string>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
): void {
  const memberNames: string[] = [];
  for (const variant of variants) {
    const props = variantProps.get(variant.name!)!;
    const variantRequestTypeName = `${prefix}${variant.name}${suffix}Request`;
    memberNames.push(variantRequestTypeName);
    requestTypes.set(variantRequestTypeName, {
      name: variantRequestTypeName,
      doc: getDoc(program, variant),
      props,
      sourceOp: op,
    });
    for (const [, prop] of props) {
      mapTsType(prop.type, program, models, enums);
    }
  }

  requestTypeBaseModels.add(`${prefix}${bodyModel.name}`);
  discriminatedRequestUnions.set(`${prefix}${bodyModel.name}${suffix}Request`, {
    memberNames,
    variantProps,
    sourceOp: op,
  });
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
  deepCollectTypes(tmpModels, tmpEnums, program, new Map());
  return new Set(tmpModels.keys());
}

// ─── Discriminated union collection ──────────────────────────────────────────

/**
 * Resolves the concrete (leaf) derived models for a `@discriminator`-annotated
 * base model, registering any not already present in `models` so they get
 * their own emitted interface. Returns the ordered, deduplicated variant names
 * used to build the base model's union type alias.
 */
function collectDiscriminatedVariants(
  model: Model,
  discriminator: Discriminator,
  models: Map<string, Model>,
): string[] {
  const [union] = getDiscriminatedUnionFromInheritance(model, discriminator);
  const variantNames: string[] = [];
  const seen = new Set<Model>();
  for (const variant of union.variants.values()) {
    if (seen.has(variant) || !variant.name) continue;
    seen.add(variant);
    if (!models.has(variant.name)) models.set(variant.name, variant);
    variantNames.push(variant.name);
  }
  return variantNames;
}

// ─── Deep type collection ─────────────────────────────────────────────────────

function deepCollectTypes(
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  program: Program,
  discriminatedUnions: Map<string, string[]>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const model of [...models.values()]) {
      if (model.name && !discriminatedUnions.has(model.name)) {
        const discriminator = getDiscriminator(program, model);
        if (discriminator) {
          discriminatedUnions.set(
            model.name,
            collectDiscriminatedVariants(model, discriminator, models),
          );
          changed = true;
        }
      }
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
  discriminatedUnions: Map<string, string[]>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
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
    // A @discriminator base model is emitted as a union type alias of its
    // concrete variants instead of a plain interface, so every reference to it
    // resolves to the precise discriminated union (e.g. `Dog | Cat`). Checked
    // before the request-type suppression below: a discriminated base is
    // never rendered as a plain interface, so whether it separately "has a
    // request type" (e.g. a filtered write-body union) must not skip its
    // union alias — the base's own response-type references still need it.
    const variantNames = discriminatedUnions.get(model.name!);
    if (variantNames) {
      const unionView: UnionView = {
        doc: getDoc(program, model) ?? undefined,
        unionName: model.name!,
        memberNames: variantNames,
      };
      parts.push(renderer.renderUnion(unionView));
      continue;
    }
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

  // A discriminated write body is exposed as a union of its per-variant
  // filtered request types (e.g. `PetPostRequest = DogPostRequest | CatPostRequest`)
  // instead of a single flat interface, so callers must supply a variant's
  // own fields alongside its narrowed discriminator value.
  for (const [unionName, { memberNames }] of discriminatedRequestUnions) {
    const unionView: UnionView = { unionName, memberNames };
    parts.push(renderer.renderUnion(unionView));
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

/**
 * Maps a model property to its TypeScript type, honoring `@encode(string)` on
 * boolean targets (TypeSpec 1.14.0). The generated client uses native `fetch`
 * with `JSON.stringify`/`response.json()` and performs no per-field transform,
 * so a boolean carried on the wire as the string `"true"`/`"false"` is typed as
 * `string` — matching what `response.json()` actually yields — rather than the
 * logical `boolean`, which would be a runtime type mismatch. All other property
 * types (and all other encodings) fall through to the normal type mapping.
 */
function mapPropertyTsType(
  prop: ModelProperty,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renameMap?: Map<string, string>,
): string {
  if (prop.type.kind === "Scalar") {
    const scalar = prop.type as Scalar;
    if (builtinScalarName(scalar) === "boolean") {
      const encode = getEncode(program, prop) ?? getEncode(program, scalar);
      if (encode && builtinScalarName(encode.type) === "string") {
        return "string";
      }
    }
  }
  return mapTsType(prop.type, program, models, enums, renameMap);
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
    const tsType = mapPropertyTsType(prop, program, models, enums, renameMap);
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

  protected httpGet<T>(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  protected httpPost<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  protected httpPut<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  protected httpPatch<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  protected httpDelete<T>(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  protected httpHead(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Promise<void> {
    return this.request<void>("HEAD", path, options);
  }
}
`;

// ─── client/ApiClientRx.ts — RxJS Observable transport ───────────────────────

const RX_API_CLIENT_CONTENT = `import { Observable } from "rxjs";
import { HttpClient, type RequestOptions } from "./ApiClient.js";

/**
 * RxJS-flavored HTTP client base. Extends {@link HttpClient} and exposes
 * \`$\`-suffixed verb helpers that return cold \`Observable\`s wrapping the same
 * fetch transport, retry, and error handling as the Promise-based helpers.
 *
 * Semantics:
 * - **Cold:** the underlying request fires on \`subscribe\`, not on creation.
 *   Each subscription triggers its own request; use \`shareReplay\`/\`share\` (or
 *   Angular's \`async\` pipe with a single subscription) to share one result.
 * - **Cancellation:** unsubscribing aborts the in-flight request via
 *   \`AbortController\`. A caller-supplied \`options.signal\` also aborts it.
 * - **Errors:** \`ApiError\` (and its subclasses) are delivered via
 *   \`subscriber.error\`, so \`catchError\` sees the same types as the Promise API.
 */
export class RxHttpClient extends HttpClient {
  /**
   * Wraps a Promise-returning transport call in a cold Observable, wiring
   * unsubscribe (and any configured request timeout / outer signal) to an
   * AbortController passed into the underlying request.
   */
  protected observe<T>(
    run: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (outerSignal) {
        if (outerSignal.aborted) controller.abort();
        else outerSignal.addEventListener("abort", onAbort, { once: true });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (this.config.timeout) {
        timer = setTimeout(() => controller.abort(), this.config.timeout);
      }
      run(controller.signal).then(
        (value) => {
          subscriber.next(value);
          subscriber.complete();
        },
        (err) => subscriber.error(err),
      );
      return () => {
        if (timer) clearTimeout(timer);
        if (outerSignal) outerSignal.removeEventListener("abort", onAbort);
        controller.abort();
      };
    });
  }

  protected httpGet$<T>(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpGet<T>(path, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpPost$<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpPost<T>(path, body, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpPut$<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpPut<T>(path, body, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpPatch$<T>(
    path: string,
    body?: unknown,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpPatch<T>(path, body, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpDelete$<T>(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpDelete<T>(path, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpHead$(
    path: string,
    options?: RequestOptions & { query?: Record<string, unknown> },
  ): Observable<void> {
    return this.observe<void>(
      (signal) => this.httpHead(path, { ...options, signal }),
      options?.signal,
    );
  }
}
`;

// ─── client/{Name}Client.ts generation ───────────────────────────────────────

/**
 * Builds the shared per-interface client view (method list + model imports).
 * The Promise and Observable client flavors differ only in `className` and the
 * template used, so this view is computed once and reused for both.
 */
function buildClientView(
  name: string,
  className: string,
  ops: HttpOperation[],
  requestTypes: Map<string, RequestType>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renameMap: Map<string, string>,
): ClientView {
  const endpointsClassName = `${name}Endpoints`;
  const modelImportSet = new Set<string>();
  const methods: import("./renderer.js").ClientMethodView[] = ops.map((op) =>
    buildClientMethodView(
      op,
      endpointsClassName,
      requestTypes,
      discriminatedRequestUnions,
      program,
      models,
      enums,
      modelImportSet,
      renameMap,
    ),
  );

  return {
    className,
    endpointsClassName,
    methods,
    modelImports: [...modelImportSet],
  };
}

function buildClientMethodView(
  op: HttpOperation,
  endpointsClassName: string,
  requestTypes: Map<string, RequestType>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
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
      let resolvedRequestTypeName: string | undefined;
      if (
        requestTypes.has(requestTypeName) ||
        discriminatedRequestUnions.has(requestTypeName)
      ) {
        resolvedRequestTypeName = requestTypeName;
      } else {
        // A name collision may have forced this request type to be renamed
        // under its operation's own @tag prefix (see storeRequestType /
        // collectDiscriminatedRequestType) — retry under that name before
        // falling back to the unfiltered base model.
        const tags = getTags(program, op.operation);
        if (tags.length) {
          const prefixedRequestTypeName = `${capitalize(tags[0])}${requestTypeName}`;
          if (
            requestTypes.has(prefixedRequestTypeName) ||
            discriminatedRequestUnions.has(prefixedRequestTypeName)
          ) {
            resolvedRequestTypeName = prefixedRequestTypeName;
          }
        }
      }
      if (resolvedRequestTypeName) {
        bodyType = resolvedRequestTypeName;
        modelImportSet.add(resolvedRequestTypeName);
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
  // A `query` parameter is always available — regardless of HTTP verb or
  // whether the TypeSpec operation declares any query params — so callers can
  // pass ad-hoc custom query parameters on any call. Declared query params keep
  // their specific types; the index signature allows any additional keys.
  const queryFields = queryParams
    .map((q) => `${q.name}${q.optional ? "?" : ""}: ${q.tsType}`)
    .join("; ");
  const queryType = queryFields
    ? `{ ${queryFields}; [key: string]: unknown }`
    : `Record<string, unknown>`;
  paramParts.push(`query?: ${queryType}`);
  paramParts.push(`options?: RequestOptions`);
  const methodParams = paramParts.join(", ");

  // Build endpoint call expression
  const pathParamArgs = pathParams.map((p) => p.name).join(", ");
  const endpointCall = `${endpointsClassName}.${op.operation.name}(${pathParamArgs})`;

  // Build method body. The Promise flavor calls the base verb helpers
  // (`this.get`, `this.post`, …); the Observable flavor calls the `$`-suffixed
  // helpers on RxHttpClient (`this.get$`, `this.post$`, …). Both share the same
  // unwrapped `responseType` — the wrapping `Promise<…>` / `Observable<…>` is
  // applied by the respective template.
  // The base transport helpers are prefixed (`httpGet`, `httpPost`, …) so that a
  // TypeSpec operation named after an HTTP verb (e.g. `delete`) does not shadow —
  // and clash with the signature of — the inherited helper it delegates to.
  const httpMethod = op.verb.toLowerCase();
  const helper = `http${capitalize(httpMethod)}`;
  let methodBody: string;
  let methodBodyObservable: string;
  if (op.verb === "get" || op.verb === "head" || op.verb === "delete") {
    methodBody = `return this.${helper}<${responseType}>(${endpointCall}, { ...options, query });`;
    methodBodyObservable = `return this.${helper}$<${responseType}>(${endpointCall}, { ...options, query });`;
  } else {
    const bodyArg = bodyType ? "body" : "undefined";
    methodBody = `return this.${helper}<${responseType}>(${endpointCall}, ${bodyArg}, { ...options, query });`;
    methodBodyObservable = `return this.${helper}$<${responseType}>(${endpointCall}, ${bodyArg}, { ...options, query });`;
  }

  return {
    doc: getDoc(program, op.operation) ?? undefined,
    name: op.operation.name,
    methodParams,
    methodBody,
    methodBodyObservable,
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

  // The Observable client flavor imports from `rxjs`. Declare it as an optional
  // peer dependency so consumers who only use the Promise client are never
  // forced to install it, while those using the Observable client resolve their
  // own rxjs version. Also list it as a devDependency so the generated package
  // type-checks and builds standalone (`npm install && npm run build`) — npm
  // does not auto-install *optional* peer dependencies.
  const clientStyle = options["client-style"] ?? "promise";
  if (clientStyle === "observable" || clientStyle === "both") {
    const rxjsRange = "^7.0.0 || ^8.0.0";
    pkg.peerDependencies = { rxjs: rxjsRange };
    pkg.peerDependenciesMeta = { rxjs: { optional: true } };
    pkg.devDependencies = {
      ...(pkg.devDependencies as Record<string, string>),
      rxjs: rxjsRange,
    };
  }

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

    case "EnumMember": {
      // A property typed to a specific member (e.g. `petKind: PetKind.Dog`) is
      // narrowed to that member's wire literal value — critical for discriminated
      // union variants to type-narrow correctly (e.g. `petKind: "dog"`).
      const em = type as EnumMember;
      const value = em.value ?? em.name;
      return typeof value === "string" ? JSON.stringify(value) : String(value);
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
    ns === serviceNsName ||
    ns.startsWith(`${serviceNsName}.`) ||
    ns === "" ||
    serviceNsName.startsWith(`${ns}.`)
  );
}

function isEmittableEnum(e: Enum, serviceNsName: string): boolean {
  if (!e.name) return false;
  const ns = e.namespace ? getNamespaceFullName(e.namespace) : "";
  return (
    ns === serviceNsName ||
    ns.startsWith(`${serviceNsName}.`) ||
    ns === "" ||
    serviceNsName.startsWith(`${ns}.`)
  );
}

// ─── Model helpers ───────────────────────────────────────────────────────────

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

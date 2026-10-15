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
  Tuple,
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
  resolveEncodedName,
  resolvePath,
  isService,
  NoTarget,
} from "@typespec/compiler";
import {
  unsafe_MutatorWithNamespace,
  unsafe_mutateSubgraphWithNamespace,
} from "@typespec/compiler/experimental";
import {
  getAllHttpServices,
  getHttpService,
  HttpOperationParameter,
  HttpOperationPathParameter,
  isMetadata,
  HttpOperation,
  HttpStatusCodeRange,
  Visibility,
  resolveRequestVisibility,
} from "@typespec/http";
import {
  getAllVersions,
  getVersioningMutators,
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
  IndexBindingView,
  IndexNamedExportView,
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

  const emittable = services.filter(
    (s) => isService(program, s.namespace) && s.operations.length > 0,
  );

  // Every service writes models.ts, index.ts and package.json at the root of
  // its output folder, so two services sharing one folder would overwrite each
  // other. Each gets a subfolder — and a package — of its own instead.
  const multiple = emittable.length > 1;
  if (multiple) {
    const folders = emittable.map((s) =>
      serviceFolderName(getNamespaceFullName(s.namespace)),
    );
    reportDiagnostic(program, {
      code: "multiple-services",
      messageId: options["npm-package-name"] ? "packageNameIgnored" : "default",
      format: {
        count: String(emittable.length),
        folders: folders.join(", "),
      },
      target: NoTarget,
    });
  }

  for (const service of emittable) {
    const outputDir = multiple
      ? resolvePath(
          emitterOutputDir,
          serviceFolderName(getNamespaceFullName(service.namespace)),
        )
      : emitterOutputDir;
    await emitService(
      program,
      service.namespace,
      service.operations,
      outputDir,
      multiple ? { ...options, "npm-package-name": undefined } : options,
      renderer,
    );
  }
}

/**
 * Subfolder a service is emitted to when a project declares more than one:
 * its namespace in kebab case, the same as its default package name.
 */
function serviceFolderName(nsFullName: string): string {
  return nsToPackageName(nsFullName);
}

// ─── Renderer factory ────────────────────────────────────────────────────────

function buildRenderer(program: Program, options: EmitterOptions): Renderer {
  const overrides = resolveTemplateOverrides(
    options.templates,
    program.projectRoot,
  );
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

/**
 * Resolves template override paths to absolute paths.
 *
 * Relative paths are resolved against the TypeSpec project root (the directory
 * holding `tspconfig.yaml`, or the entrypoint's directory when there is none),
 * not the process working directory, so `tsp compile path/to/project` run from
 * elsewhere finds the same templates as running it from inside the project.
 */
export function resolveTemplateOverrides(
  templates: TemplateOverrides | undefined,
  projectRoot: string,
): TemplateOverrides {
  if (!templates) return {};
  const result: TemplateOverrides = {};
  for (const [key, val] of Object.entries(templates)) {
    if (val) result[key as TemplateName] = resolve(projectRoot, val);
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
 *
 * Accepts an optional leading `v`/`V`, two-part (`1.2`) or three-part
 * (`1.2.3`) numeric versions, and preserves any pre-release or build suffix.
 * Leading zeros are stripped from every numeric part (`v1.02` → `1.2.0`),
 * since npm rejects them as invalid semver.
 */
export function tryParseSemver(value: string): string | undefined {
  const stripped = value.replace(/^[vV]/, "");
  const match = stripped.match(
    /^(\d+)\.(\d+)(?:\.(\d+))?([-+][0-9A-Za-z.+-]+)?$/,
  );
  if (!match) return undefined;
  const part = (digits: string | undefined) => String(Number(digits ?? "0"));
  return `${part(match[1])}.${part(match[2])}.${part(match[3])}${match[4] ?? ""}`;
}

/**
 * Formats a date as a CalVer string (`YYYY.M.D`).
 *
 * Month and day are deliberately not zero-padded: `2026.01.05` is not valid
 * semver, and npm refuses to install or publish a package with that version.
 */
export function toCalVer(date: Date): string {
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
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
  const prefixTemplate = options["route-prefix"] ?? "api/{version}";
  const mutators = getVersioningMutators(program, serviceNs);

  if (versionsToEmit.length > 0) {
    for (const version of versionsToEmit) {
      const vDir = useVersionedFolders
        ? resolvePath(outputDir, version.value)
        : outputDir;
      const routePrefix = resolveRoutePrefix(prefixTemplate, version.value);
      const snapshot =
        mutators?.kind === "versioned"
          ? mutators.snapshots.find((s) => s.version.name === version.name)
          : undefined;
      const versionOps = snapshot
        ? projectOperations(program, serviceNs, snapshot.mutator)
        : operations;
      await emitVersion(
        program,
        nsFullName,
        groupOperationsByContainer(serviceNs, versionOps),
        vDir,
        version,
        routePrefix,
        options,
        renderer,
      );
    }
  } else {
    // A service that is not itself versioned can still pin a version of a
    // versioned library it uses (`@useDependency`), which needs projecting too.
    const unversionedOps =
      mutators?.kind === "transient"
        ? projectOperations(program, serviceNs, mutators.mutator)
        : operations;
    const routePrefix = resolveRoutePrefix(prefixTemplate, undefined);
    await emitVersion(
      program,
      nsFullName,
      groupOperationsByContainer(serviceNs, unversionedOps),
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

/** Operations grouped by the interface or namespace that declares them. */
type ContainerGroups = Map<
  string,
  { name: string; container: Interface | Namespace; ops: HttpOperation[] }
>;

/**
 * Projects the service to one API version and returns its HTTP operations.
 *
 * The versioning mutator clones the service's type graph as it exists in that
 * version: `@added`/`@removed` types, properties, enum members, operations and
 * parameters appear or disappear, `@renamedFrom` and `@typeChangedFrom` take
 * effect, and `@madeOptional`/`@madeRequired` change optionality. Everything
 * downstream then reads a plain, version-free graph.
 */
function projectOperations(
  program: Program,
  serviceNs: Namespace,
  mutator: unsafe_MutatorWithNamespace,
): HttpOperation[] {
  const projected = unsafe_mutateSubgraphWithNamespace(
    program,
    [mutator],
    serviceNs,
  ).type as Namespace;
  // Diagnostics were already reported for the unprojected service; the
  // projection would only repeat them.
  const [service] = getHttpService(program, projected);
  return service.operations;
}

/**
 * Groups operations by the interface or namespace that declares them, and
 * names each group — the name its `*Endpoints` object and `*Client` class are
 * built from.
 *
 * Each group is named after its own interface or namespace; operations
 * declared directly in the service namespace take the service's name. Names
 * that two groups would share (`Pets.Ops` and `Stores.Ops`, or two
 * sub-namespaces both called `Admin`) are qualified with their namespace path
 * relative to the service (`PetsOps`, `StoresOps`), so no group's endpoints
 * file can overwrite another's.
 */
function groupOperationsByContainer(
  serviceNs: Namespace,
  operations: HttpOperation[],
): ContainerGroups {
  const serviceName = getNamespaceFullName(serviceNs);
  const groups = new Map<
    string,
    { path: string[]; container: Interface | Namespace; ops: HttpOperation[] }
  >();
  for (const op of operations) {
    const c = op.container;
    const nsName = getNamespaceFullName(
      c.kind === "Interface" ? c.namespace! : c,
    );
    const key = c.kind === "Interface" ? `${nsName}.${c.name}` : nsName;
    let group = groups.get(key);
    if (!group) {
      const relative = nsName.startsWith(`${serviceName}.`)
        ? nsName.slice(serviceName.length + 1).split(".")
        : [];
      const path =
        c.kind === "Interface"
          ? [...relative, c.name]
          : relative.length > 0
            ? relative
            : [serviceNs.name];
      group = { path, container: c, ops: [] };
      groups.set(key, group);
    }
    group.ops.push(op);
  }

  const shortNameCounts = new Map<string, number>();
  for (const { path } of groups.values()) {
    const short = path[path.length - 1];
    shortNameCounts.set(short, (shortNameCounts.get(short) ?? 0) + 1);
  }
  const taken = new Set<string>();
  const byContainer: ContainerGroups = new Map();
  for (const [key, { path, container, ops }] of groups) {
    const short = path[path.length - 1];
    const preferred =
      (shortNameCounts.get(short) ?? 0) > 1
        ? path.map(capitalize).join("")
        : short;
    const name = uniqueName(preferred, taken);
    taken.add(name);
    byContainer.set(key, { name, container, ops });
  }
  return byContainer;
}

async function emitVersion(
  program: Program,
  nsFullName: string,
  byContainer: ContainerGroups,
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

  // A model whose only use is as a write body is replaced by its filtered
  // request type and not emitted itself — unless something that is emitted
  // still names it. Computed after the request types exist, since their
  // properties are among those references.
  const referencedModelNames = collectReferencedModelNames(
    program,
    byContainer,
    version,
    requestTypes,
    requestTypeBaseModels,
  );

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

  // models.ts is rendered up front — before any client — because a generated
  // client class must be allocated around the type names it exports. A client
  // class named after a model would both import and declare that name. The
  // collection passes above are what discover types, so rendering here sees
  // exactly what rendering later would.
  const hasModels =
    [...models.values()].some((m) => isEmittable(m)) ||
    [...enums.values()].some((e) => isEmittable(e)) ||
    requestTypes.size > 0;

  let modelsContent: string | undefined;
  let generatedTypeNames: ReadonlySet<string> = new Set<string>();
  if (hasModels) {
    modelsContent = buildModelsFile(
      nsFullName,
      models,
      enums,
      requestTypes,
      requestTypeBaseModels,
      referencedModelNames,
      discriminatedUnions,
      discriminatedRequestUnions,
      program,
      renderer,
      mergePatchRenameMap,
    );
    // Read back from the emitted text rather than recomputing the name set, so
    // the collision checks can never disagree with what models.ts exports.
    generatedTypeNames = collectExportedNames(modelsContent);

    // A generated type named after a global that scalars map to shadows it
    // inside this very file. Re-render with those scalar references pointed at
    // an alias instead. Rendering is pure, so a second pass is safe — and it
    // only happens for the rare spec that triggers it.
    const shadowed = resolveShadowedScalarGlobals(generatedTypeNames);
    if (shadowed.aliases.size > 0) {
      for (const [global, alias] of shadowed.aliases) {
        reportDiagnostic(program, {
          code: "shadowed-global-type",
          format: { name: global, alias },
          target: NoTarget,
        });
      }
      modelsContent = buildModelsFile(
        nsFullName,
        models,
        enums,
        requestTypes,
        requestTypeBaseModels,
        referencedModelNames,
        discriminatedUnions,
        discriminatedRequestUnions,
        program,
        renderer,
        new Map([
          ...mergePatchRenameMap,
          ...[...shadowed.aliases].map(
            ([global, alias]) => [`scalar:${global}`, alias] as const,
          ),
        ]),
        shadowed.declarations,
      );
    }
  }

  // Emit endpoint files and (optionally) client files; collect exports for index
  const endpointExports: string[] = [];
  const clientExports: string[] = [];
  // Per-interface modules the barrel re-exports, in emit order. They outrank
  // the static client infrastructure but yield to declared TypeSpec types.
  const generatedModules: BarrelModule[] = [];
  // One shared pool for every generated client module name, so the two flavors
  // cannot claim the same file as each other, as the static infrastructure, or
  // as a declared type.
  const takenClientNames = new Set<string>([
    ...INFRASTRUCTURE_MODULE_NAMES,
    ...generatedTypeNames,
  ]);

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
    generatedModules.push({
      path: `./endpoints/${name}Endpoints.js`,
      exports: [{ name: className, isType: false }],
    });

    // Which names are off-limits depends on which base class the generated
    // client extends, so a Promise-only build does not reserve RxHttpClient's
    // members.
    const reservedMembers = reservedClientMembers(emitObservableClient);

    if (generateClient) {
      reportReservedClientMethodNames(program, vOps, reservedMembers);
    }

    if (generateClient && emitPromiseClient) {
      const clientClassName = allocateClientModuleName(
        program,
        `${name}Client`,
        container,
        takenClientNames,
      );
      const view = buildClientView(
        name,
        clientClassName,
        vOps,
        requestTypes,
        discriminatedRequestUnions,
        program,
        models,
        enums,
        mergePatchRenameMap,
        reservedMembers,
      );
      await writeFile(
        program,
        resolvePath(vDir, `client/${clientClassName}.ts`),
        renderer.renderClient(view),
      );
      clientExports.push(`./client/${clientClassName}.js`);
      generatedModules.push({
        path: `./client/${clientClassName}.js`,
        exports: [{ name: clientClassName, isType: false }],
      });
    }

    if (generateClient && emitObservableClient) {
      const observableClassName = allocateClientModuleName(
        program,
        `${name}ObservableClient`,
        container,
        takenClientNames,
      );
      const view = buildClientView(
        name,
        observableClassName,
        vOps,
        requestTypes,
        discriminatedRequestUnions,
        program,
        models,
        enums,
        mergePatchRenameMap,
        reservedMembers,
      );
      await writeFile(
        program,
        resolvePath(vDir, `client/${observableClassName}.ts`),
        renderer.renderObservableClient(view),
      );
      clientExports.push(`./client/${observableClassName}.js`);
      generatedModules.push({
        path: `./client/${observableClassName}.js`,
        exports: [{ name: observableClassName, isType: false }],
      });
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

  if (modelsContent !== undefined) {
    await writeFile(program, resolvePath(vDir, "models.ts"), modelsContent);
  }

  // Emit index.ts
  const exports: string[] = [];
  if (hasModels) exports.push("./models.js");
  exports.push(...endpointExports);
  exports.push(...clientExports);

  // Two modules exporting the same name make the barrel's star export
  // ambiguous (TS2308). Resolve in priority order — declared TypeSpec types,
  // then per-interface generated modules, then the static infrastructure — so
  // the name a consumer is most likely to reach for stays unaliased. A module
  // that has to alias switches to an explicit re-export; the rest keep their
  // `export *` line.
  const claimed = new Set<string>(generatedTypeNames);
  const namedExports: IndexNamedExportView[] = [];
  const infrastructureModules: BarrelModule[] = [
    { path: "./client/ApiClient.js", exports: API_CLIENT_EXPORTS },
    { path: "./client/ApiClientRx.js", exports: RX_API_CLIENT_EXPORTS },
  ];
  for (const module of [...generatedModules, ...infrastructureModules]) {
    if (!exports.includes(module.path)) continue;
    const named = resolveBarrelModule(program, module, claimed);
    if (!named) continue;
    exports.splice(exports.indexOf(module.path), 1);
    namedExports.push(named);
  }

  if (exports.length > 0 || namedExports.length > 0) {
    const indexView: IndexView = { exports };
    if (namedExports.length > 0) indexView.namedExports = namedExports;
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

/**
 * Names of the models that emitted code references directly, so they must be
 * declared in models.ts even when they also have a filtered request type:
 *
 * - any operation's response body, whatever the verb or status — a `POST`
 *   that returns the created `Widget` needs `Widget`;
 * - path, query, and header parameter types;
 * - request bodies the client passes through unfiltered: inline models,
 *   arrays, and named models with no request type of their own;
 * - the properties of every synthesized request type, since only the top
 *   level of a write body is visibility-filtered.
 *
 * Collection is transitive: a model those reference by property is needed too.
 */
function collectReferencedModelNames(
  program: Program,
  byContainer: ContainerGroups,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  requestTypeBaseModels: Set<string>,
): Set<string> {
  const tmpModels = new Map<string, Model>();
  const tmpEnums = new Map<string, Enum>();
  const reference = (type: Type) =>
    mapTsType(type, program, tmpModels, tmpEnums);
  for (const { ops } of byContainer.values()) {
    const vOps = version
      ? ops.filter((op) => isOpInVersion(program, op, version))
      : ops;
    for (const op of vOps) {
      for (const resp of op.responses) {
        for (const content of resp.responses) {
          if (content.body) reference(content.body.type);
        }
      }
      for (const param of op.parameters.parameters) {
        reference(param.param.type);
      }
      const body = op.parameters.body?.type;
      if (body && !isRequestTypedBody(body, requestTypeBaseModels)) {
        reference(body);
      }
    }
  }
  for (const { props } of requestTypes.values()) {
    for (const prop of props.values()) reference(prop.type);
  }
  deepCollectTypes(tmpModels, tmpEnums, program, new Map());
  return new Set(tmpModels.keys());
}

/**
 * Whether the client sends this body as a synthesized request type instead
 * of naming the model itself.
 */
function isRequestTypedBody(
  body: Type,
  requestTypeBaseModels: Set<string>,
): boolean {
  if (body.kind !== "Model" || !body.name) return false;
  if (isArrayModelType(body) || isRecordModelType(body)) return false;
  return requestTypeBaseModels.has(
    getMergePatchBaseName(body.name) ?? body.name,
  );
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
  referencedModelNames: Set<string>,
  discriminatedUnions: Map<string, string[]>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
  program: Program,
  renderer: Renderer,
  renameMap: Map<string, string>,
  prelude: string[] = [],
): string {
  const parts: string[] = [...prelude];

  for (const [, e] of enums) {
    if (!isEmittable(e)) continue;
    parts.push(renderer.renderEnum(buildEnumView(e, program)));
  }

  for (const [, model] of models) {
    if (!isEmittable(model)) continue;
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
    // Suppress models that have a request type and that nothing emitted
    // references — they appear only via their filtered request type.
    if (
      requestTypeBaseModels.has(model.name!) &&
      !referencedModelNames.has(model.name!)
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
      key: formatPropertyKey(jsonPropertyName(program, prop)),
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
    // A member with no explicit value is serialized as its name, so a
    // numeric enum is only one whose values are actually numbers.
    const value = member.value ?? member.name;
    members.push({
      doc: memberDoc ?? undefined,
      name: member.name,
      key: formatPropertyKey(member.name),
      memberValue: String(value),
      valueLiteral:
        typeof value === "number" ? String(value) : singleQuoted(value),
    });
  }
  return { doc: doc ?? undefined, enumName: e.name, members };
}

/**
 * The property's name in JSON: its `@encodedName("application/json", …)`
 * when it has one, otherwise its declared name. The client sends and receives
 * plain objects, so the TypeScript key must be the name on the wire.
 */
function jsonPropertyName(program: Program, prop: ModelProperty): string {
  return resolveEncodedName(program, prop, "application/json");
}

/** Renders a string as a single-quoted TypeScript literal, escaping as needed. */
function singleQuoted(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `'${escaped}'`;
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
  return {
    doc: getDoc(program, op.operation) ?? undefined,
    name: op.operation.name,
    functionText: buildEndpointFunctionText(
      op.path,
      resolvePathArgs(op),
      routePrefix,
    ),
  };
}

/** A path parameter as the generated endpoint function and client see it. */
interface PathArg {
  /** Name of the `{token}` in the route, e.g. `widget-id`. */
  wireName: string;
  /** JavaScript parameter name, e.g. `widgetId`. */
  argName: string;
  /** Whether the parameter may be omitted. */
  optional: boolean;
  /** RFC 6570 expansion style. */
  style: HttpOperationPathParameter["style"];
  /** Whether reserved characters such as `/` are left unencoded. */
  allowReserved: boolean;
}

/**
 * Parameter names a generated client method declares itself. Path arguments
 * precede them in the same parameter list, so they must not reuse these.
 */
const CLIENT_METHOD_PARAMETER_NAMES: readonly string[] = [
  "body",
  "query",
  "headers",
  "options",
];

/**
 * Resolves each path parameter's route token and argument name, required
 * arguments first — TypeScript rejects a required parameter after an optional
 * one. The endpoint function and the client method share this order.
 */
function resolvePathArgs(op: HttpOperation): PathArg[] {
  const taken = new Set(CLIENT_METHOD_PARAMETER_NAMES);
  const args = op.parameters.parameters
    .filter((p): p is HttpOperationPathParameter => p.type === "path")
    .map((p) => ({
      wireName: p.name,
      argName: toIdentifier(p.param.name, taken),
      optional: p.param.optional,
      style: p.style,
      allowReserved: p.allowReserved,
    }));
  return [
    ...args.filter((a) => !a.optional),
    ...args.filter((a) => a.optional),
  ];
}

/**
 * Text a path parameter's style places before its value (RFC 6570). The route
 * TypeSpec produces leaves it out of the path, since an omitted optional
 * parameter must omit its prefix too. `matrix` is handled separately because
 * its prefix includes the parameter name.
 */
const PATH_STYLE_PREFIX: Record<string, string> = {
  simple: "",
  label: ".",
  path: "/",
  fragment: "#",
};

/**
 * JavaScript expression that renders one path parameter into the route. The
 * value is percent-encoded so that an id such as `a/b` or `50%` cannot change
 * which route is called; `allowReserved` keeps reserved characters such as `/`
 * intact, as RFC 6570's `{+x}` does.
 */
function pathArgExpression(arg: PathArg): string {
  const encoder = arg.allowReserved ? "encodeURI" : "encodeURIComponent";
  const prefix =
    arg.style === "matrix"
      ? `;${arg.wireName}=`
      : (PATH_STYLE_PREFIX[arg.style] ?? "");
  const value = `${encoder}(String(${arg.argName}))`;
  const expr = prefix ? `${JSON.stringify(prefix)} + ${value}` : value;
  return arg.optional ? `${arg.argName} === undefined ? "" : ${expr}` : expr;
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
  pathArgs: PathArg[],
  routePrefix: string,
): string {
  const fullPath = routePrefix ? `/${routePrefix}${path}` : path;
  const byWireName = new Map(pathArgs.map((a) => [a.wireName, a]));
  const templatePath = fullPath.replace(
    /\{([^}]+)\}/g,
    (token, name: string) => {
      const arg = byWireName.get(name);
      return arg ? "${" + pathArgExpression(arg) + "}" : token;
    },
  );
  const pathExpr = BT + templatePath + BT;
  const params = pathArgs
    .map((a) => `${a.argName}${a.optional ? "?" : ""}: string`)
    .join(", ");
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

/**
 * A \`fetch\`-compatible transport: anything that takes a \`Request\` and resolves
 * to a \`Response\`. The global \`fetch\` satisfies this type, as does a wrapper
 * around \`axios\`, Angular's \`HttpClient\`, or a stub used in tests.
 */
export type FetchFunction = (request: Request) => Promise<Response>;

/** Invokes the remainder of the middleware chain. */
export type HttpNext = (request: Request) => Promise<Response>;

/**
 * Onion-style middleware. Receives the outgoing \`Request\` plus a \`next\`
 * callback representing the rest of the chain, and returns the \`Response\`.
 *
 * Middleware runs once per retry attempt, so a layer that refreshes an expired
 * token sees every attempt. Layers listed earlier in
 * {@link ClientConfig.middleware} wrap the ones listed later.
 *
 * A \`Request\` body may only be read once — call \`request.clone()\` before
 * inspecting it, and build a modified request with \`new Request(request, …)\`
 * so the original \`AbortSignal\` is preserved.
 */
export type HttpMiddleware = (
  request: Request,
  next: HttpNext,
) => Promise<Response>;

/** Identifies the call a hook is observing. */
export interface RequestContext {
  /** HTTP method of the request, e.g. \`"GET"\`. */
  readonly method: string;
  /** Fully-resolved request URL, including any query string. */
  readonly url: string;
  /** Zero-based retry attempt; \`0\` is the first try. */
  readonly attempt: number;
}

/**
 * Called with the outgoing request before any middleware runs. Return a
 * replacement \`Request\` to substitute it, or nothing to keep the original.
 */
export type RequestHook = (
  request: Request,
  context: RequestContext,
) => Request | void | Promise<Request | void>;

/**
 * Called with the response after all middleware has returned, including
 * non-2xx responses. Return a replacement \`Response\` to substitute it, or
 * nothing to keep the original.
 */
export type ResponseHook = (
  response: Response,
  context: RequestContext,
) => Response | void | Promise<Response | void>;

/**
 * Called once per logical call when it ultimately fails — after every retry
 * attempt has been exhausted, not per attempt. Return a replacement error to
 * throw it instead, throw to substitute your own, or return nothing to let the
 * original error propagate.
 */
export type ErrorHook = (
  error: unknown,
  context: RequestContext,
) => unknown | Promise<unknown>;

export interface ClientConfig {
  /** Base URL of the API, e.g. "https://api.example.com". Trailing slash is trimmed automatically. */
  baseUrl: string;
  /** Headers merged into every request. */
  defaultHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (passed as AbortSignal). */
  timeout?: number;
  /** Retry configuration. */
  retry?: RetryConfig;
  /** Transport used to send every request. Default: the global \`fetch\`. */
  fetch?: FetchFunction;
  /**
   * Middleware applied to every request, outermost first. Each layer runs once
   * per retry attempt. Further layers can be appended later with
   * {@link HttpClient.useMiddleware}.
   */
  middleware?: HttpMiddleware[];
  /** Runs before any middleware, once per retry attempt. */
  onRequest?: RequestHook;
  /** Runs after all middleware, once per retry attempt. */
  onResponse?: ResponseHook;
  /** Runs once when a call ultimately fails, after retries are exhausted. */
  onError?: ErrorHook;
}

export interface RequestOptions {
  /** Per-request headers merged on top of defaultHeaders. */
  headers?: Record<string, string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Options the protected verb helpers accept. Generated client methods build
 * these from their typed arguments; consumers normally pass
 * {@link RequestOptions} instead.
 */
export interface TransportOptions extends Omit<RequestOptions, "headers"> {
  /**
   * Request headers keyed by wire name. \`undefined\` and \`null\` values are
   * skipped, a \`Date\` is sent in HTTP-date form, and an array is joined with
   * commas. Names are matched case-insensitively; later entries win.
   */
  headers?: Record<string, unknown>;
  /**
   * Query parameters keyed by wire name. \`undefined\` and \`null\` values are
   * skipped, a \`Date\` is sent as an ISO 8601 string, and an array is joined
   * with commas unless its key is listed in {@link TransportOptions.explode}.
   */
  query?: Record<string, unknown>;
  /** Query keys whose array values are sent as repeated \`key=value\` pairs. */
  explode?: readonly string[];
  /**
   * Media type of the request body. JSON types (the default) are serialized
   * with \`JSON.stringify\`; any other body is sent as-is.
   */
  contentType?: string;
  /**
   * How to read a success body: parsed as JSON (the default), as text, or as
   * raw bytes. An empty JSON body resolves to \`undefined\`.
   */
  responseFormat?: "json" | "text" | "binary";
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body?: unknown,
    /** The originating response. Its body is already consumed. */
    public readonly response?: Response,
  ) {
    super(\`HTTP \${status}: \${statusText}\`);
    this.name = "ApiError";
  }
}

export class RateLimitError extends ApiError {
  constructor(
    public readonly retryAfterMs?: number,
    body?: unknown,
    response?: Response,
  ) {
    super(429, "Too Many Requests", body, response);
    this.name = "RateLimitError";
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(body?: unknown, response?: Response) {
    super(503, "Service Unavailable", body, response);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Largest delay a timer can actually represent (2^31 - 1 ms, about 24.8 days).
 * Node silently wraps anything larger to roughly 1ms — firing a "wait a
 * century" retry almost immediately — and browsers clamp it the same way, so a
 * header asking for more than this is treated as unusable rather than honored.
 */
const MAX_TIMER_DELAY_MS = 2147483647;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a \`Retry-After\` header value into milliseconds.
 *
 * Only the RFC 9110 \`delta-seconds\` form is honored, and the *entire* value
 * must be a non-negative number that still lands within
 * {@link MAX_TIMER_DELAY_MS} once converted to milliseconds. An HTTP-date, a
 * trailing unit (\`"2seconds"\`), a negative value, \`"Infinity"\`, or a delay
 * too large for a timer all yield \`undefined\`, so the caller falls back to its
 * own exponential backoff.
 */
function retryAfterMs(response: Response): number | undefined {
  const after = response.headers.get("Retry-After")?.trim();
  if (!after || !/^\\d+(\\.\\d+)?$/.test(after)) return undefined;
  // Range-checked after the multiplication: a value can be perfectly ordinary
  // in seconds and unusable as a millisecond timer.
  const ms = Number(after) * 1000;
  return ms <= MAX_TIMER_DELAY_MS ? ms : undefined;
}

/** Builds the most specific {@link ApiError} subclass for a failed response. */
function toApiError(response: Response, body?: unknown): ApiError {
  if (response.status === 429) {
    return new RateLimitError(retryAfterMs(response), body, response);
  }
  if (response.status === 503) {
    return new ServiceUnavailableError(body, response);
  }
  return new ApiError(response.status, response.statusText, body, response);
}

/** Formats a query value; a \`Date\` becomes an ISO 8601 string. */
function formatQueryValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Formats a header value; a \`Date\` becomes an HTTP-date (RFC 9110). */
function formatHeaderValue(value: unknown): string {
  if (value instanceof Date) return value.toUTCString();
  if (Array.isArray(value)) return value.map(formatHeaderValue).join(",");
  return String(value);
}

/** Copies headers into \`target\`, skipping \`undefined\` and \`null\` values. */
function setHeaders(
  target: Headers,
  source: Record<string, unknown> | undefined,
): void {
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value !== undefined && value !== null) {
      target.set(name, formatHeaderValue(value));
    }
  }
}

/** Whether a media type is JSON (\`application/json\`, \`application/*+json\`). */
function isJsonContentType(contentType: string): boolean {
  return /^[^;]*[/+]json\\s*(;|$)/i.test(contentType);
}

/**
 * Whether \`fetch\` must choose the \`Content-Type\` itself: a \`FormData\` body
 * needs a generated multipart boundary, and \`URLSearchParams\` is labelled
 * automatically.
 */
function hasImplicitContentType(body: unknown): boolean {
  return (
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
  );
}

/**
 * Whether a body is already in a form \`fetch\` sends as-is — a form, binary
 * data, or a stream — and so must never go through \`JSON.stringify\`.
 */
function isRawBody(body: unknown): body is BodyInit {
  return (
    hasImplicitContentType(body) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

/**
 * Reads a success body in the format the operation declares. An empty JSON
 * body — a \`201\` with no content, or a \`200\` from an operation that returns
 * nothing — resolves to \`undefined\` rather than failing to parse.
 */
async function readBody(
  response: Response,
  format: TransportOptions["responseFormat"] = "json",
): Promise<unknown> {
  if (format === "binary") return new Uint8Array(await response.arrayBuffer());
  const text = await response.text();
  if (format === "text") return text;
  return text.trim() === "" ? undefined : JSON.parse(text);
}

/**
 * Folds a middleware list into a single dispatch function, with the first
 * entry as the outermost layer and \`transport\` at the center.
 */
function composeMiddleware(
  middleware: readonly HttpMiddleware[],
  transport: FetchFunction,
): HttpNext {
  return middleware.reduceRight<HttpNext>(
    (next, layer) => (request) => layer(request, next),
    (request) => transport(request),
  );
}

export class HttpClient {
  /** Middleware layers registered for this client. */
  private readonly middleware: HttpMiddleware[];

  constructor(protected readonly config: ClientConfig) {
    this.middleware = [...(config.middleware ?? [])];
  }

  /**
   * Appends a middleware layer, inside any already registered. Returns the
   * client so registrations can be chained.
   *
   * Named \`useMiddleware\` rather than \`use\` so that an API operation called
   * \`use\` does not shadow it. Operation names that would still collide with an
   * inherited member are renamed at generation time.
   */
  useMiddleware(middleware: HttpMiddleware): this {
    this.middleware.push(middleware);
    return this;
  }

  /**
   * Joins the base URL, path, and serialized query string. Array values are
   * comma-joined, or repeated once per item when their key is in \`explode\`.
   */
  protected buildUrl(
    path: string,
    query?: Record<string, unknown>,
    explode?: readonly string[],
  ): string {
    const url = \`\${this.config.baseUrl.replace(/\\/$/, "")}\${path}\`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        params.append(key, formatQueryValue(value));
      } else if (explode?.includes(key)) {
        for (const item of value) params.append(key, formatQueryValue(item));
      } else {
        params.append(key, value.map(formatQueryValue).join(","));
      }
    }
    const qs = params.toString();
    return qs ? \`\${url}?\${qs}\` : url;
  }

  protected async request<T>(
    method: string,
    path: string,
    options?: TransportOptions & { body?: unknown },
  ): Promise<T> {
    const { maxAttempts = 3, baseDelayMs = 1000, retryOn = [429, 503] } =
      this.config.retry ?? {};

    // Resolved without the query string up front so the error context always
    // carries a URL, even if building the real one throws below.
    let url = this.buildUrl(path);
    let attempt = 0;
    let lastError: unknown;
    try {
      url = this.buildUrl(path, options?.query, options?.explode);

      // A Headers object matches names case-insensitively, so a per-request
      // \`content-type\` replaces the default instead of being sent alongside it.
      const headers = new Headers({ Accept: "application/json" });
      setHeaders(headers, this.config.defaultHeaders);
      setHeaders(headers, options?.headers);

      let signal = options?.signal;
      if (this.config.timeout && !signal) {
        signal = AbortSignal.timeout(this.config.timeout);
      }

      // Serialized inside the try so that an unserializable body (a circular
      // reference, a BigInt) reaches onError like any other failure. Only a
      // request that actually has a body gets a Content-Type: on a GET it would
      // force a CORS preflight for no reason.
      const contentType = options?.contentType ?? "application/json";
      let body: BodyInit | undefined;
      if (options?.body !== undefined) {
        body =
          isRawBody(options.body) || !isJsonContentType(contentType)
            ? (options.body as BodyInit)
            : JSON.stringify(options.body);
        if (!headers.has("Content-Type") && !hasImplicitContentType(body)) {
          headers.set("Content-Type", contentType);
        }
      }
      const dispatch = composeMiddleware(
        this.middleware,
        this.config.fetch ?? ((request) => fetch(request)),
      );

      let succeeded: Response | undefined;
      for (; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await delay(baseDelayMs * Math.pow(2, attempt - 1));
        const context: RequestContext = { method, url, attempt };
        try {
          let request = new Request(url, { method, headers, body, signal });
          if (this.config.onRequest) {
            request = (await this.config.onRequest(request, context)) ?? request;
          }
          let resp = await dispatch(request);
          if (this.config.onResponse) {
            resp = (await this.config.onResponse(resp, context)) ?? resp;
          }
          if (resp.ok) {
            succeeded = resp;
            break;
          }
          if (retryOn.includes(resp.status) && attempt < maxAttempts - 1) {
            if (resp.status === 429) {
              const after = retryAfterMs(resp);
              if (after !== undefined) await delay(after);
            }
            lastError = toApiError(resp);
            continue;
          }
          const errorBody = await resp.json().catch(() => undefined);
          throw toApiError(resp, errorBody);
        } catch (err) {
          if (err instanceof ApiError) throw err;
          lastError = err;
        }
      }
      if (!succeeded) throw lastError ?? new ApiError(0, "Unknown error");
      // Parsed outside the retry loop so a malformed success body is surfaced
      // rather than retried.
      if (method === "HEAD" || succeeded.status === 204 || succeeded.status === 205) {
        return undefined as T;
      }
      return (await readBody(succeeded, options?.responseFormat)) as T;
    } catch (err) {
      throw await this.applyErrorHook(err, {
        method,
        url,
        attempt: Math.min(attempt, maxAttempts - 1),
      });
    }
  }

  /** Runs {@link ClientConfig.onError}, resolving the error actually thrown. */
  private async applyErrorHook(
    error: unknown,
    context: RequestContext,
  ): Promise<unknown> {
    if (!this.config.onError) return error;
    const replacement = await this.config.onError(error, context);
    return replacement === undefined ? error : replacement;
  }

  protected httpGet<T>(
    path: string,
    options?: TransportOptions,
  ): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  protected httpPost<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  protected httpPut<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  protected httpPatch<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  protected httpDelete<T>(
    path: string,
    options?: TransportOptions,
  ): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /**
   * Generic like the other verb helpers — a generated client renders
   * \`this.httpHead<T>(…)\` uniformly — but defaulted to \`void\`, since a HEAD
   * response has no body.
   */
  protected httpHead<T = void>(
    path: string,
    options?: TransportOptions,
  ): Promise<T> {
    return this.request<T>("HEAD", path, options);
  }
}
`;

/**
 * Top-level names exported by the static `client/ApiClient.ts` module, and
 * whether each is type-only. The barrel needs this to re-export the module by
 * explicit name when a star export would be ambiguous — and type-only names
 * must go through `export type` so the emitted JavaScript does not reference a
 * binding that exists only at compile time.
 *
 * Kept in sync with {@link API_CLIENT_CONTENT} by a test that re-reads the
 * emitted file's own `export` declarations.
 */
export const API_CLIENT_EXPORTS: readonly { name: string; isType: boolean }[] =
  [
    { name: "RetryConfig", isType: true },
    { name: "FetchFunction", isType: true },
    { name: "HttpNext", isType: true },
    { name: "HttpMiddleware", isType: true },
    { name: "RequestContext", isType: true },
    { name: "RequestHook", isType: true },
    { name: "ResponseHook", isType: true },
    { name: "ErrorHook", isType: true },
    { name: "ClientConfig", isType: true },
    { name: "RequestOptions", isType: true },
    { name: "TransportOptions", isType: true },
    { name: "ApiError", isType: false },
    { name: "RateLimitError", isType: false },
    { name: "ServiceUnavailableError", isType: false },
    { name: "HttpClient", isType: false },
  ];

// ─── client/ApiClientRx.ts — RxJS Observable transport ───────────────────────

const RX_API_CLIENT_CONTENT = `import { Observable } from "rxjs";
import { HttpClient, type TransportOptions } from "./ApiClient.js";

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
 * - **Extensibility:** a custom \`config.fetch\` transport, \`config.middleware\`
 *   (and {@link HttpClient.useMiddleware}), and the
 *   \`onRequest\`/\`onResponse\`/\`onError\` hooks all apply unchanged, because every
 *   verb helper routes through the same \`HttpClient\` transport. \`onError\` fires
 *   before the error reaches \`subscriber.error\`.
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
    options?: TransportOptions,
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpGet<T>(path, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpPost$<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpPost<T>(path, body, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpPut$<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpPut<T>(path, body, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpPatch$<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpPatch<T>(path, body, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpDelete$<T>(
    path: string,
    options?: TransportOptions,
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpDelete<T>(path, { ...options, signal }),
      options?.signal,
    );
  }

  protected httpHead$<T = void>(
    path: string,
    options?: TransportOptions,
  ): Observable<T> {
    return this.observe<T>(
      (signal) => this.httpHead<T>(path, { ...options, signal }),
      options?.signal,
    );
  }
}
`;

/**
 * Top-level names exported by the static `client/ApiClientRx.ts` module.
 * See {@link API_CLIENT_EXPORTS}.
 */
export const RX_API_CLIENT_EXPORTS: readonly {
  name: string;
  isType: boolean;
}[] = [{ name: "RxHttpClient", isType: false }];

/**
 * Module basenames under `client/` that the static infrastructure occupies. A
 * generated client class named after one of these would have its file
 * overwritten, so the generated one is renamed instead.
 */
const INFRASTRUCTURE_MODULE_NAMES: readonly string[] = [
  "ApiClient",
  "ApiClientRx",
];

/**
 * Returns `base`, or `base` with the lowest numeric suffix that is not already
 * taken. Used wherever a generated name has to step aside for one that cannot
 * move.
 */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}

/**
 * Allocates the class (and file) name for a generated client out of a shared
 * pool, so no two generated clients — of either flavor — land on the same path,
 * and none lands on a static infrastructure module or a declared type name.
 *
 * Collisions are real: `interface Foo` emits `FooObservableClient` while
 * `interface FooObservable` emits its Promise client to that same name, and a
 * model named `WidgetsClient` would be both imported and declared by
 * `WidgetsClient`. Neither the infrastructure path nor a declared type can
 * move, so the generated client is renamed and a warning reported.
 *
 * Mutates `taken`, claiming whatever name it returns.
 */
function allocateClientModuleName(
  program: Program,
  preferred: string,
  target: Interface | Namespace,
  taken: Set<string>,
): string {
  const resolved = uniqueName(preferred, taken);
  taken.add(resolved);
  if (resolved !== preferred) {
    reportDiagnostic(program, {
      code: "client-module-name-collision",
      format: { preferred, resolved },
      target,
    });
  }
  return resolved;
}

/** Reads the top-level `export` declarations out of a generated module. */
function collectExportedNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern =
    /^export\s+(?:interface|type|class|enum|const|function)\s+(\w+)/gm;
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

/** A module the barrel re-exports, and the names it declares. */
interface BarrelModule {
  /** Relative import path, as it appears in the barrel. */
  path: string;
  /** Top-level exports of the module. */
  exports: readonly { name: string; isType: boolean }[];
}

/**
 * Resolves one module's contribution to the barrel.
 *
 * The barrel star-exports every generated module, so two modules exporting the
 * same name make the star export ambiguous and the package fails to compile
 * (TS2308). Modules are processed in priority order — declared TypeSpec types
 * first, then per-interface generated clients and endpoints, then the static
 * client infrastructure — and a later module aliases any name an earlier one
 * has already claimed.
 *
 * Returns `undefined` when nothing collides, so the common case keeps its
 * simpler `export *` line and byte-identical output.
 */
function resolveBarrelModule(
  program: Program,
  module: BarrelModule,
  claimed: Set<string>,
): IndexNamedExportView | undefined {
  if (!module.exports.some((e) => claimed.has(e.name))) {
    for (const e of module.exports) claimed.add(e.name);
    return undefined;
  }

  const values: IndexBindingView[] = [];
  const types: IndexBindingView[] = [];

  for (const { name, isType } of module.exports) {
    let alias: string | undefined;
    if (claimed.has(name)) {
      alias = uniqueName(`Client${name}`, claimed);
      reportDiagnostic(program, {
        code: "generated-export-name-collision",
        format: { name, alias, module: module.path },
        target: NoTarget,
      });
    }
    claimed.add(alias ?? name);
    (isType ? types : values).push(alias ? { name, alias } : { name });
  }

  return { from: module.path, values, types };
}

// ─── client/{Name}Client.ts generation ───────────────────────────────────────

/**
 * Members every generated `*Client` inherits from `HttpClient`. An operation
 * method with any of these names would shadow the inherited member with an
 * incompatible signature, so the generated package would fail to type-check —
 * and, for `useMiddleware`, middleware registration would become unreachable.
 *
 * Private base members are included: TypeScript rejects a subclass member that
 * shares a name with a private member of its base.
 */
const BASE_CLIENT_MEMBERS: readonly string[] = [
  // Every own property of Object.prototype — the complete set, as returned by
  // Object.getOwnPropertyNames(Object.prototype). TypeScript does not
  // type-check class members against Object's apparent members, so these
  // compile; the damage is at runtime. An async `toString`/`valueOf` breaks
  // coercion of the client (`${client}` throws), and a method named
  // `__proto__` shadows the accessor, so `client.__proto__` stops returning
  // the instance prototype.
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  // Not inherited, but a method named `then` makes every client instance a
  // thenable: `await client` would fire a request with the resolver as query.
  "then",
  "config",
  "middleware",
  "useMiddleware",
  "buildUrl",
  "request",
  "applyErrorHook",
  "httpGet",
  "httpPost",
  "httpPut",
  "httpPatch",
  "httpDelete",
  "httpHead",
];

/**
 * Members declared only on `RxHttpClient`, which exists solely for the
 * Observable flavor. A Promise-only build must not reserve these — an
 * operation named `observe` is perfectly valid there.
 */
const RX_CLIENT_MEMBERS: readonly string[] = [
  "observe",
  "httpGet$",
  "httpPost$",
  "httpPut$",
  "httpPatch$",
  "httpDelete$",
  "httpHead$",
];

/**
 * The names an operation method may not take, given which client flavors are
 * being emitted.
 *
 * When an Observable client is emitted the Rx members are reserved for *both*
 * flavors, so that a `client-style: both` build exposes the same method names
 * on its Promise and Observable clients rather than diverging.
 */
function reservedClientMembers(
  emitObservableClient: boolean,
): ReadonlySet<string> {
  return new Set(
    emitObservableClient
      ? [...BASE_CLIENT_MEMBERS, ...RX_CLIENT_MEMBERS]
      : BASE_CLIENT_MEMBERS,
  );
}

/**
 * Resolves the method name to emit for an operation. Operation names are used
 * verbatim unless they collide with an inherited base-class member, in which
 * case an `Operation` suffix is appended (and numbered, if that too is taken by
 * a sibling operation).
 *
 * Only the client method is renamed — the generated `*Endpoints` entry keeps
 * the original operation name, since a plain `as const` object inherits
 * nothing and therefore cannot collide.
 */
function clientMethodName(
  operationName: string,
  siblingNames: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string {
  if (!reserved.has(operationName)) return operationName;
  let candidate = `${operationName}Operation`;
  let suffix = 2;
  while (siblingNames.has(candidate) || reserved.has(candidate)) {
    candidate = `${operationName}Operation${suffix++}`;
  }
  return candidate;
}

/**
 * Warns once per operation whose client method had to be renamed. Reported
 * here rather than inside the view builder, which runs twice when both client
 * flavors are emitted.
 */
function reportReservedClientMethodNames(
  program: Program,
  ops: HttpOperation[],
  reserved: ReadonlySet<string>,
): void {
  const siblingNames = new Set(ops.map((op) => op.operation.name));
  for (const op of ops) {
    const renamed = clientMethodName(op.operation.name, siblingNames, reserved);
    if (renamed === op.operation.name) continue;
    reportDiagnostic(program, {
      code: "reserved-client-method-name",
      format: { name: op.operation.name, renamed },
      target: op.operation,
    });
  }
}

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
  reserved: ReadonlySet<string>,
): ClientView {
  const endpointsClassName = `${name}Endpoints`;
  const siblingNames = new Set(ops.map((op) => op.operation.name));

  const buildMethods = (
    modelImportSet: Set<string>,
    localNames: ClientLocalNames,
    rename: Map<string, string>,
  ) =>
    ops.map((op) =>
      buildClientMethodView(
        op,
        requestTypes,
        discriminatedRequestUnions,
        program,
        models,
        enums,
        modelImportSet,
        rename,
        siblingNames,
        reserved,
        localNames,
      ),
    );

  // The client's own model imports are only known once the method views have
  // been built, but the names those views reference depend on them — a model
  // named `RequestOptions` forces the infrastructure import to be aliased, and
  // a model named `Promise` must itself be aliased or it shadows the global
  // every return type is wrapped in. So build once to discover the imports,
  // resolve every local name, then build again for real. Both passes are pure
  // string work.
  const discovered = new Set<string>();
  buildMethods(
    discovered,
    defaultClientLocalNames(endpointsClassName),
    renameMap,
  );
  const localNames = resolveClientLocalNames(
    endpointsClassName,
    className,
    discovered,
  );
  const globalAliases = resolveShadowedGlobalAliases(
    discovered,
    new Set([className, ...Object.values(localNames)]),
  );

  // Keyed as name-only aliases so generic models keep their arguments; see
  // {@link RENAME_ALIAS}.
  const clientRenameMap = new Map([
    ...renameMap,
    ...[...globalAliases].map(
      ([name, alias]) => [`${RENAME_ALIAS}${name}`, alias] as const,
    ),
  ]);
  const modelImportSet = new Set<string>();
  const methods = buildMethods(modelImportSet, localNames, clientRenameMap);

  return {
    className,
    endpointsClassName,
    methods,
    modelImports: [...modelImportSet].map((name) => {
      const alias = globalAliases.get(name);
      return alias ? `${name} as ${alias}` : name;
    }),
    ...localNames,
  };
}

/**
 * Globals that `models.ts` references as the target of a scalar mapping:
 * `utcDateTime`/`offsetDateTime` → `Date`, `bytes` → `Uint8Array`.
 *
 * A generated type of the same name shadows the global *within that file*, so
 * a sibling model's `utcDateTime` property would silently resolve to the
 * user's own `Date` interface. It still compiles, which is what makes it
 * dangerous — the property is simply typed as the wrong thing.
 *
 * `Record` is not listed: TypeSpec rejects a `model Record` declaration before
 * the emitter ever sees it, since that shadows its own built-in template.
 */
const MODEL_SCALAR_GLOBALS: readonly string[] = ["Date", "Uint8Array"];

/**
 * For each scalar global shadowed by a generated type, picks a local alias and
 * the declaration that recovers the real global.
 *
 * A plain `type GlobalDate = Date` would not work: module-scope declarations
 * are hoisted, so it would resolve to the shadowing interface too. Going
 * through `globalThis` sidesteps the type namespace entirely.
 *
 * The declaration deliberately names no type other than the global itself:
 * `InstanceType<…>` would break for a spec that also declares `model
 * InstanceType`, which shadows that utility in this very file. Reading
 * `.prototype` off the constructor value has no such dependency — and
 * `globalThis` is resolved in the *value* namespace, so even a `model
 * globalThis` cannot shadow it.
 */
function resolveShadowedScalarGlobals(
  generatedTypeNames: ReadonlySet<string>,
): { aliases: Map<string, string>; declarations: string[] } {
  const aliases = new Map<string, string>();
  const declarations: string[] = [];
  const claimed = new Set(generatedTypeNames);
  for (const global of MODEL_SCALAR_GLOBALS) {
    if (!generatedTypeNames.has(global)) continue;
    const alias = uniqueName(`Global${global}`, claimed);
    claimed.add(alias);
    aliases.set(global, alias);
    declarations.push(
      `/** The global \`${global}\`, aliased because a generated type shadows that name. */\n` +
        `type ${alias} = typeof globalThis.${global}.prototype;`,
    );
  }
  return { aliases, declarations };
}

/**
 * Global identifiers the generated client text references by name. A model
 * import with one of these names would shadow the global inside the client
 * module — `import type { Promise }` turns every `Promise<T>` return type into
 * a reference to the user's model, which is not generic (TS2315).
 */
const CLIENT_REFERENCED_GLOBALS: readonly string[] = [
  "Promise",
  "Record",
  "Date",
  "Uint8Array",
];

/**
 * For each model import that shadows a referenced global, picks a local alias
 * (`Promise` → `PromiseModel`). Returned as a rename map so the same alias is
 * used in both the import specifier and every type reference.
 */
function resolveShadowedGlobalAliases(
  modelImports: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const claimed = new Set([...modelImports, ...taken]);
  for (const name of CLIENT_REFERENCED_GLOBALS) {
    if (!modelImports.has(name)) continue;
    const alias = uniqueName(`${name}Model`, claimed);
    claimed.add(alias);
    aliases.set(name, alias);
  }
  return aliases;
}

/**
 * Local names a generated client module uses for the symbols it imports from
 * outside `models.ts`. Each is the imported name unless a model of the same
 * name is also imported, in which case the *infrastructure* symbol is aliased
 * — the user's model keeps the plain name, matching how the barrel resolves
 * the same clash.
 */
interface ClientLocalNames {
  /** Local name for `HttpClient` from `./ApiClient.js`. */
  baseClassName: string;
  /** Local name for `RxHttpClient` from `./ApiClientRx.js`. */
  rxBaseClassName: string;
  /** Local name for `RequestOptions` from `./ApiClient.js`. */
  requestOptionsName: string;
  /** Local name for `Observable` from `rxjs`. */
  observableName: string;
  /** Local name for the `*Endpoints` object. */
  endpointsLocalName: string;
}

/** The local names used when nothing collides. */
function defaultClientLocalNames(endpointsClassName: string): ClientLocalNames {
  return {
    baseClassName: "HttpClient",
    rxBaseClassName: "RxHttpClient",
    requestOptionsName: "RequestOptions",
    observableName: "Observable",
    endpointsLocalName: endpointsClassName,
  };
}

/**
 * Aliases each imported symbol that a model import — or the generated class
 * itself — would shadow. `interface Http` declares `class HttpClient`, so its
 * base-class import must become `HttpClient as ClientHttpClient`.
 */
function resolveClientLocalNames(
  endpointsClassName: string,
  className: string,
  modelImports: ReadonlySet<string>,
): ClientLocalNames {
  const taken = new Set([...modelImports, className]);
  const local = (imported: string): string => {
    if (!taken.has(imported)) return imported;
    const alias = uniqueName(`Client${imported}`, taken);
    taken.add(alias);
    return alias;
  };
  return {
    baseClassName: local("HttpClient"),
    rxBaseClassName: local("RxHttpClient"),
    requestOptionsName: local("RequestOptions"),
    observableName: local("Observable"),
    endpointsLocalName: local(endpointsClassName),
  };
}

function buildClientMethodView(
  op: HttpOperation,
  requestTypes: Map<string, RequestType>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  modelImportSet: Set<string>,
  renameMap: Map<string, string>,
  siblingNames: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
  localNames: ClientLocalNames,
): import("./renderer.js").ClientMethodView {
  const pathArgs = resolvePathArgs(op);

  const queryParams = op.parameters.parameters.filter(
    (p) => p.type === "query",
  );
  // `Content-Type` is decided by the body's declared media type, not by the
  // caller, so it is not offered as a header argument.
  const headerParams = op.parameters.parameters.filter(
    (p) => p.type === "header" && p.name.toLowerCase() !== "content-type",
  );
  const objectType = (
    params: readonly HttpOperationParameter[],
    indexSignature: boolean,
  ) =>
    `{ ${[
      ...params.map(
        (p) =>
          `${formatPropertyKey(p.name)}${p.param.optional ? "?" : ""}: ${mapTsType(p.param.type, program, models, enums, renameMap)}`,
      ),
      ...(indexSignature ? ["[key: string]: unknown"] : []),
    ].join("; ")} }`;
  for (const p of [...queryParams, ...headerParams]) {
    collectModelNamesFromType(p.param.type, modelImportSet);
  }

  const body = resolveBodyParameter(
    op,
    requestTypes,
    discriminatedRequestUnions,
    program,
    models,
    enums,
    modelImportSet,
    renameMap,
  );

  // Determine response type from first 2xx response body
  const response = resolveResponseType(
    op,
    program,
    models,
    enums,
    modelImportSet,
    renameMap,
  );

  // Arguments in call order. A `query` argument is always offered — whether or
  // not the operation declares query parameters — so callers can pass ad-hoc
  // ones; declared parameters keep their types, keyed by their wire names.
  const args: ParameterSpec[] = pathArgs.map((a) => ({
    name: a.argName,
    type: "string",
    optional: a.optional,
  }));
  if (body) {
    args.push({ name: "body", type: body.type, optional: body.optional });
  }
  args.push({
    name: "query",
    type:
      queryParams.length > 0
        ? objectType(queryParams, true)
        : "Record<string, unknown>",
    optional: !queryParams.some((p) => !p.param.optional),
  });
  if (headerParams.length > 0) {
    args.push({
      name: "headers",
      type: objectType(headerParams, false),
      optional: !headerParams.some((p) => !p.param.optional),
    });
  }
  args.push({
    name: "options",
    type: localNames.requestOptionsName,
    optional: true,
  });
  const methodParams = renderParameterList(args);

  const pathArgNames = pathArgs.map((a) => a.argName).join(", ");
  const endpointCall = `${localNames.endpointsLocalName}.${op.operation.name}(${pathArgNames})`;

  const transport = ["...options", "query"];
  if (headerParams.length > 0) {
    // Explicit `options.headers` win, so a caller can always override.
    transport.push("headers: { ...headers, ...options?.headers }");
  }
  const exploded = queryParams
    .filter((p) => p.type === "query" && p.explode)
    .map((p) => p.name);
  if (exploded.length > 0) {
    transport.push(`explode: ${JSON.stringify(exploded)}`);
  }
  if (body?.contentType) {
    transport.push(`contentType: ${JSON.stringify(body.contentType)}`);
  }
  if (response.format) {
    transport.push(`responseFormat: ${JSON.stringify(response.format)}`);
  }
  const responseType = response.type;
  const transportArg = `{ ${transport.join(", ")} }`;

  // The Promise flavor calls the base verb helpers (`this.httpGet`,
  // `this.httpPost`, …); the Observable flavor calls the `$`-suffixed helpers
  // on RxHttpClient. Both share the same unwrapped `responseType` — the
  // wrapping `Promise<…>` / `Observable<…>` is applied by the template.
  // The helpers are prefixed so that a TypeSpec operation named after an HTTP
  // verb (e.g. `delete`) does not shadow — and clash with the signature of —
  // the inherited helper it delegates to.
  const helper = `http${capitalize(op.verb.toLowerCase())}`;
  const callArgs =
    op.verb === "get" || op.verb === "head" || op.verb === "delete"
      ? `${endpointCall}, ${transportArg}`
      : `${endpointCall}, ${body ? "body" : "undefined"}, ${transportArg}`;

  return {
    doc: getDoc(program, op.operation) ?? undefined,
    // The endpoint call above keeps the original operation name; only the
    // method name is renamed when it would shadow an inherited base member.
    name: clientMethodName(op.operation.name, siblingNames, reserved),
    methodParams,
    methodBody: `return this.${helper}<${responseType}>(${callArgs});`,
    methodBodyObservable: `return this.${helper}$<${responseType}>(${callArgs});`,
    responseType,
  };
}

/** One parameter of a generated method signature. */
interface ParameterSpec {
  /** Parameter name. */
  name: string;
  /** TypeScript type. */
  type: string;
  /** Whether the caller may omit it. */
  optional: boolean;
}

/**
 * Renders a parameter list. An optional parameter followed by a required one
 * cannot use `?` (TS1016), so it is typed `T | undefined` instead and the
 * caller passes `undefined` explicitly.
 */
function renderParameterList(args: readonly ParameterSpec[]): string {
  let requiredAfter = false;
  const rendered: string[] = [];
  for (let i = args.length - 1; i >= 0; i--) {
    const { name, type, optional } = args[i];
    if (!optional) {
      rendered.unshift(`${name}: ${type}`);
      requiredAfter = true;
    } else if (requiredAfter) {
      rendered.unshift(`${name}: ${type} | undefined`);
    } else {
      rendered.unshift(`${name}?: ${type}`);
    }
  }
  return rendered.join(", ");
}

/** The `body` argument of a generated client method. */
interface BodyParameter {
  /** TypeScript type of the argument. */
  type: string;
  /** Whether the body may be omitted. */
  optional: boolean;
  /**
   * Media type to send, when it is not plain `application/json`. JSON media
   * types such as `application/merge-patch+json` are still serialized as JSON.
   */
  contentType?: string;
}

/**
 * Resolves the request body argument for any body TypeSpec can declare: a
 * named model (narrowed to its visibility-filtered request type when one was
 * synthesized), an inline or spread model, an array, a scalar, a raw `bytes`
 * or text payload, a file, or a multipart form.
 */
function resolveBodyParameter(
  op: HttpOperation,
  requestTypes: Map<string, RequestType>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  modelImportSet: Set<string>,
  renameMap: Map<string, string>,
): BodyParameter | undefined {
  const body = op.parameters.body;
  if (!body) return undefined;
  const declared = body.contentTypes[0];
  const contentType =
    declared && declared.toLowerCase() !== "application/json"
      ? declared
      : undefined;
  const optional = body.property?.optional ?? false;

  // The caller assembles a multipart form; `fetch` then sets the multipart
  // boundary itself, so no content type is passed for it.
  if (body.bodyKind === "multipart") {
    return { type: "FormData", optional };
  }
  if (body.bodyKind === "file") {
    return { type: "Blob", optional, contentType };
  }

  const isJson = !contentType || /[/+]json\s*(;|$)/i.test(contentType);
  if (
    !isJson &&
    body.type.kind === "Scalar" &&
    builtinScalarName(body.type) === "bytes"
  ) {
    return { type: "Blob | ArrayBuffer | Uint8Array", optional, contentType };
  }

  const named = resolveNamedBodyModelType(
    op,
    body.type,
    requestTypes,
    discriminatedRequestUnions,
    program,
    modelImportSet,
    renameMap,
  );
  if (named) return { type: named, optional, contentType };

  collectModelNamesFromType(body.type, modelImportSet);
  return {
    type: mapTsType(body.type, program, models, enums, renameMap),
    optional,
    contentType,
  };
}

/**
 * For a body that is a single named, non-generic model, returns the type the
 * client should accept: its synthesized request type (`WidgetPostRequest`)
 * when one exists, otherwise the model itself. Returns `undefined` for
 * anything else — arrays, records, generic instances, inline models, scalars —
 * which map like any other type.
 */
function resolveNamedBodyModelType(
  op: HttpOperation,
  type: Type,
  requestTypes: Map<string, RequestType>,
  discriminatedRequestUnions: Map<string, DiscriminatedRequestUnion>,
  program: Program,
  modelImportSet: Set<string>,
  renameMap: Map<string, string>,
): string | undefined {
  if (type.kind !== "Model") return undefined;
  const bodyModel = type as Model;
  if (
    !bodyModel.name ||
    isArrayModelType(bodyModel) ||
    isRecordModelType(bodyModel) ||
    bodyModel.templateMapper?.args
  ) {
    return undefined;
  }
  const mergePatchBase = getMergePatchBaseName(bodyModel.name);
  const baseName = mergePatchBase ?? bodyModel.name;
  const requestTypeName = `${baseName}${requestTypeSuffix(op.verb)}Request`;
  const exists = (name: string) =>
    requestTypes.has(name) || discriminatedRequestUnions.has(name);
  if (exists(requestTypeName)) {
    modelImportSet.add(requestTypeName);
    return requestTypeName;
  }
  // A name collision may have forced this request type to be renamed under its
  // operation's own @tag prefix (see storeRequestType /
  // collectDiscriminatedRequestType) — retry under that name before falling
  // back to the unfiltered base model.
  const tags = getTags(program, op.operation);
  if (tags.length) {
    const prefixed = `${capitalize(tags[0])}${requestTypeName}`;
    if (exists(prefixed)) {
      modelImportSet.add(prefixed);
      return prefixed;
    }
  }
  if (isSynthesizedMergePatchModel(bodyModel)) return undefined;
  // Through the rename map like every other type reference, so a model aliased
  // to dodge a shadowed global (`Promise` → `PromiseModel`) is aliased here
  // too. Both rewrite kinds are consulted, in the same order mapTsType uses.
  // The import specifier is derived from the raw name.
  modelImportSet.add(bodyModel.name);
  return (
    renameMap.get(bodyModel.name) ??
    renameMap.get(`${RENAME_ALIAS}${bodyModel.name}`) ??
    bodyModel.name
  );
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
): ResponseShape {
  for (const resp of op.responses) {
    if (!is2xxStatusCode(resp.statusCodes)) continue;
    for (const content of resp.responses) {
      if (!content.body) continue;
      const bodyType = content.body.type;
      const contentType = content.body.contentTypes[0];
      const isJson = !contentType || /[/+]json\s*(;|$)/i.test(contentType);
      const isBytes =
        bodyType.kind === "Scalar" && builtinScalarName(bodyType) === "bytes";
      if (!isJson && isBytes) return { type: "Uint8Array", format: "binary" };
      const tsType = mapTsType(bodyType, program, models, enums, renameMap);
      if (tsType !== "void" && tsType !== "unknown") {
        collectModelNamesFromType(bodyType, modelImportSet);
        return isJson ? { type: tsType } : { type: tsType, format: "text" };
      }
    }
  }
  return { type: "void" };
}

/** The success response a generated client method resolves to. */
interface ResponseShape {
  /** TypeScript type of the resolved value. */
  type: string;
  /**
   * How the transport must read the body when it is not JSON: `text` for a
   * textual media type, `binary` for raw `bytes`.
   */
  format?: "text" | "binary";
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
    if (!m.name) {
      // An inline model is rendered in place, so the models it references
      // are what the client must import.
      for (const [, prop] of flattenProperties(m)) {
        collectModelNamesFromType(prop.type, into);
      }
      if (m.indexer) collectModelNamesFromType(m.indexer.value, into);
    } else if (!m.templateMapper?.args) {
      into.add(m.name);
    } else if (m.name && m.templateMapper?.args) {
      // Mirrors mapTsType's own `Array<T>` shortcut, which renders the native
      // `T[]` and never names the model. Adding it here anyway would import a
      // type the emitted code does not reference — and, when that model is the
      // only one in the spec, from a models.ts that is never written.
      if (!isNativeArrayShortcut(m) && !isNativeRecordShortcut(m)) {
        into.add(m.name);
      }
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

/** TypeScript version range the generated package builds with. */
export const GENERATED_TYPESCRIPT_RANGE = "^5.9.0";

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
      // `types` must precede `import`: conditions match in order, and
      // TypeScript stops at the first one it recognizes.
      exports[`./${v.value}`] = {
        types: `./dist/${v.value}/index.d.ts`,
        import: `./dist/${v.value}/index.js`,
      };
    }
    pkg.exports = exports;
  } else {
    pkg.exports = {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    };
    pkg.main = "./dist/index.js";
    pkg.types = "./dist/index.d.ts";
  }

  pkg.files = ["dist"];
  pkg.scripts = { build: "tsc" };
  // Pinned to the TypeScript line the generated code is tested against, so a
  // fresh install builds the same way today as it will after the next major.
  pkg.devDependencies = { typescript: GENERATED_TYPESCRIPT_RANGE };

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

/**
 * Three kinds of rewrite share one rename map during rendering, distinguished
 * by key prefix. Keeping them separate matters: they are not interchangeable.
 *
 * | Key              | Meaning                                                |
 * | ---------------- | ------------------------------------------------------ |
 * | `<name>`         | Whole-type substitution. A synthesized MergePatch model |
 * |                  | becomes its canonical output name; template arguments   |
 * |                  | are dropped, because the replacement is already concrete. |
 * | `alias:<name>`   | Name-only rewrite. The type is unchanged, so generic    |
 * |                  | arguments are preserved.                                 |
 * | `scalar:<name>`  | Rewrite of a scalar mapping's target (the global `Date` |
 * |                  | a `utcDateTime` maps to), never of a declared type.     |
 */
const RENAME_ALIAS = "alias:";
/** See {@link RENAME_ALIAS}. */
const RENAME_SCALAR = "scalar:";

/**
 * Whether a templated model renders as the native `T[]` rather than by name.
 *
 * Shared by the type mapper and the import collector so the two cannot
 * disagree about whether a name is referenced — a disagreement emits an import
 * of a type that never appears in the file.
 */
function isNativeArrayShortcut(m: Model): boolean {
  return m.name === "Array" && (m.templateMapper?.args?.length ?? 0) === 1;
}

/**
 * Whether a templated model renders as the native `Record<string, T>`. A
 * `Record<T>` whose argument is still a template parameter is not recognized
 * by `isRecordModelType`, so it reaches the generic path and would otherwise
 * be emitted as `Record<T>` — one type argument where TypeScript needs two.
 */
function isNativeRecordShortcut(m: Model): boolean {
  return m.name === "Record" && (m.templateMapper?.args?.length ?? 0) === 1;
}

function mapTsType(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renameMap?: Map<string, string>,
): string {
  switch (type.kind) {
    case "Scalar": {
      const mapped = mapScalar(type as Scalar, program);
      return renameMap?.get(`${RENAME_SCALAR}${mapped}`) ?? mapped;
    }

    case "Model": {
      const m = type as Model;
      if (isArrayModelType(m)) {
        return `${mapTsType(m.indexer!.value, program, models, enums, renameMap)}[]`;
      }
      if (isRecordModelType(m)) {
        return `Record<string, ${mapTsType(m.indexer!.value, program, models, enums, renameMap)}>`;
      }
      if (!m.name) {
        return renderInlineModel(m, program, models, enums, renameMap);
      }

      // During the rendering phase, synthesized MergePatch model names are
      // rewritten to their canonical output names (e.g. PetPatchRequest or Tag).
      // This is a whole-type substitution: the replacement already names a
      // concrete type, so any template arguments are deliberately dropped.
      const renamed = renameMap?.get(m.name);
      if (renamed !== undefined) return renamed;

      // A name-only alias, by contrast, renames the reference but leaves the
      // type itself alone — so a generic model must keep its arguments, or
      // `Date<string>` would be emitted as a bare `DateModel`.
      const aliased = renameMap?.get(`${RENAME_ALIAS}${m.name}`) ?? m.name;

      if (m.templateMapper?.args) {
        const args = m.templateMapper.args
          .filter(
            (a): a is Type =>
              (a as { entityKind?: string }).entityKind === "Type",
          )
          .map((a) => mapTsType(a, program, models, enums, renameMap));
        if (isNativeArrayShortcut(m)) return `${args[0]}[]`;
        if (isNativeRecordShortcut(m)) return `Record<string, ${args[0]}>`;
        const decl = m.namespace?.models.get(m.name);
        registerNamedType(program, models, decl ?? m);
        return args.length > 0 ? `${aliased}<${args.join(", ")}>` : aliased;
      }

      registerNamedType(program, models, m);
      return aliased;
    }

    case "Enum": {
      const e = type as Enum;
      if (e.name) registerNamedType(program, enums, e);
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

    case "Tuple":
      return `[${(type as Tuple).values
        .map((v) => mapTsType(v, program, models, enums, renameMap))
        .join(", ")}]`;

    default:
      return "unknown";
  }
}

/**
 * Renders an anonymous model — an inline `{ … }` type, a spread operation
 * body, or an inline response — as a TypeScript object type. HTTP metadata
 * (`@header`, `@query`, `@path`, `@statusCode`) travels outside the body and
 * is left out.
 */
function renderInlineModel(
  m: Model,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renameMap?: Map<string, string>,
): string {
  const fields: string[] = [];
  for (const [, prop] of flattenProperties(m)) {
    if (isMetadata(program, prop)) continue;
    const optional = prop.optional ? "?" : "";
    const type = mapTsType(prop.type, program, models, enums, renameMap);
    const key = formatPropertyKey(jsonPropertyName(program, prop));
    fields.push(`${key}${optional}: ${type}`);
  }
  if (m.indexer) {
    const value = mapTsType(m.indexer.value, program, models, enums, renameMap);
    fields.push(`[key: string]: ${value}`);
  }
  return fields.length > 0 ? `{ ${fields.join("; ")} }` : "{}";
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

/**
 * Whether a referenced type belongs in models.ts. Any named type the service
 * references is emitted, wherever it is declared — the service namespace, a
 * sibling such as `MyOrg.Shared`, or the global namespace — except the
 * TypeSpec standard library's own types (`TypeSpec.Http.*` and the like),
 * which describe the protocol rather than the API's data.
 */
function isEmittable(type: Model | Enum): boolean {
  if (!type.name) return false;
  const ns = namespaceNameOf(type);
  return ns !== "TypeSpec" && !ns.startsWith("TypeSpec.");
}

/** Full name of the namespace a type is declared in; `""` for global. */
function namespaceNameOf(type: Model | Enum): string {
  return type.namespace ? getNamespaceFullName(type.namespace) : "";
}

/** Names already reported as `duplicate-type-name`, per program. */
const reportedDuplicateNames = new WeakMap<Program, Set<string>>();

/**
 * Records a named model or enum for emission. Every generated type shares one
 * `models.ts`, so two different types with the same name from different
 * namespaces cannot both be emitted: the first one keeps the name, and the
 * clash is reported once as an error instead of the second silently replacing
 * the first and retyping every property that referenced it.
 */
function registerNamedType<T extends Model | Enum>(
  program: Program,
  types: Map<string, T>,
  type: T,
): void {
  const name = type.name!;
  const existing = types.get(name);
  if (existing && existing !== type) {
    const kept = namespaceNameOf(existing);
    const other = namespaceNameOf(type);
    if (kept !== other) {
      let reported = reportedDuplicateNames.get(program);
      if (!reported) {
        reported = new Set();
        reportedDuplicateNames.set(program, reported);
      }
      if (!reported.has(name)) {
        reported.add(name);
        reportDiagnostic(program, {
          code: "duplicate-type-name",
          format: {
            name,
            kept: kept || "(global)",
            other: other || "(global)",
          },
          target: type,
        });
      }
      return;
    }
  }
  types.set(name, type);
}

// ─── Model helpers ───────────────────────────────────────────────────────────

/**
 * Type parameters of a generic model, in declaration order.
 *
 * Taken from the template declaration itself, so `model Two<A, B> { a: B; b: A }`
 * stays `Two<A, B>` — a reference `Two<string, boolean>` must bind `A` to
 * `string` — and a parameter that no property mentions directly (only through
 * a union, a base model, or not at all) is still declared.
 */
function collectTypeParams(model: Model): string[] {
  const node = model.node;
  if (node && "templateParameters" in node && node.templateParameters.length) {
    return node.templateParameters.map((p) => p.id.sv);
  }
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

/** Matches a valid JavaScript identifier (ASCII subset). */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Words that cannot name a function parameter. Property keys may use them, so
 * {@link formatPropertyKey} does not consult this list.
 */
const RESERVED_WORDS = new Set([
  "arguments",
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
  "eval",
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

/**
 * Renders an object-type property key, quoting it when it is not a valid
 * identifier (`x-ms-id` → `"x-ms-id"`).
 */
export function formatPropertyKey(name: string): string {
  return IDENTIFIER_PATTERN.test(name) ? name : JSON.stringify(name);
}

/**
 * Converts a name to a valid JavaScript identifier that is not in `taken`, and
 * claims it. Invalid characters are dropped and the next character
 * upper-cased (`widget-id` → `widgetId`); a reserved word or a taken name gets
 * a `Param` suffix, numbered if that is taken too.
 */
export function toIdentifier(name: string, taken: Set<string>): string {
  let id = name.replace(/[^A-Za-z0-9_$]+(.)?/g, (_, next?: string) =>
    next ? next.toUpperCase() : "",
  );
  if (!id || /^[0-9]/.test(id)) id = `_${id}`;
  if (RESERVED_WORDS.has(id) || taken.has(id)) {
    id = uniqueName(`${id}Param`, taken);
  }
  taken.add(id);
  return id;
}

function sanitizeVersionForPath(version: string): string {
  return version.replace(/\./g, "_").replace(/^v/i, "v");
}

// Exported for use in tests
export { sanitizeVersionForPath };

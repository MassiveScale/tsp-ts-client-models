// Adversarial name sweep: emits a TypeSpec spec for every name that has ever
// collided with something the emitter generates — infrastructure exports,
// imported bindings, inherited members, JavaScript globals — and type-checks
// the resulting package under both client styles, and under the `path` and
// `interface` client shapes.
//
// The regular test suite pins each *known* collision with a targeted test. This
// script is the broader net for finding the next one: run it after changing
// anything that names a generated symbol.
//
//   npm run build && npm run sweep
//
// Exits non-zero if any check fails.

import { emitWithDiagnostics } from "../dist/test/test-host.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ts from "typescript";

const RXJS_STUB = `export declare class Subscriber<T> { readonly closed: boolean; next(value: T): void; error(err: unknown): void; complete(): void; }
export type TeardownLogic = (() => void) | void;
export declare class Observable<T> { constructor(subscribe?: (s: Subscriber<T>) => TeardownLogic); subscribe(o?: unknown): { unsubscribe(): void }; }
`;

const EMITTER = "@massivescale/tsp-ts-client-models";

async function typeCheck(code, options) {
  const [results, diags] = await emitWithDiagnostics(code, options);
  const errors = diags.filter((d) => d.severity === "error");

  // An error from the TypeSpec compiler itself means the spec is invalid, not
  // that the emitter mishandled it — `model Record`, for instance, shadows
  // TypeSpec's own built-in template and is rejected before the emitter runs.
  // Those cases are skipped; errors raised by *this* emitter are failures.
  if (errors.some((d) => !d.code.startsWith(EMITTER))) return { skipped: true };
  if (errors.length) {
    return {
      errors: errors.map((d) => `${d.code.split("/").pop()}: ${d.message}`),
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "tsp-sweep-"));
  try {
    for (const [key, content] of Object.entries(results)) {
      const rel = key
        .replace(/^.*?tsp-output[\\/]?/, "")
        .replace(/^[\\/]+/, "");
      const abs = join(dir, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    await mkdir(join(dir, "stubs"), { recursive: true });
    await writeFile(join(dir, "stubs", "rxjs.d.ts"), RXJS_STUB);

    const config = ts.readConfigFile(
      join(dir, "tsconfig.json"),
      ts.sys.readFile,
    );
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
    const program = ts.createProgram(
      parsed.fileNames.filter((f) => !f.includes("stubs")),
      {
        ...parsed.options,
        noEmit: true,
        baseUrl: dir,
        paths: { rxjs: [join(dir, "stubs", "rxjs.d.ts")] },
      },
    );
    return {
      errors: ts
        .getPreEmitDiagnostics(program)
        .map(
          (d) =>
            `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
        ),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const HEADER = `import "@typespec/http"; using Http; @service(#{ title: "Sweep" }) namespace SweepApi;`;
const cases = [];

// Interface names whose generated class or file collides with something.
for (const name of [
  "Http",
  "RxHttp",
  "Api",
  "ApiClientRx",
  "Observable",
  "Request",
  "Response",
  "Client",
  "Endpoints",
]) {
  cases.push([
    `interface ${name}`,
    `${HEADER} model Widget { id: string; } @route("/x") interface ${name} { @get list(): Widget[]; }`,
  ]);
}
// Two interfaces contending for one client module name across flavors.
cases.push([
  "interface Foo + FooObservable",
  `${HEADER} model Widget { id: string; } @route("/a") interface Foo { @get list(): Widget[]; } @route("/b") interface FooObservable { @get list(): Widget[]; }`,
]);

// Operation names that shadow inherited or prototype members. The
// Object.prototype set is taken from the runtime rather than hand-listed, so
// it cannot drift out of sync with what a client actually inherits.
for (const op of [
  ...Object.getOwnPropertyNames(Object.prototype),
  "then",
  "prototype",
  "length",
  "name",
  "request",
  "config",
  "middleware",
  "useMiddleware",
  "buildUrl",
  "applyErrorHook",
  "observe",
  "httpGet",
  "httpGet$",
  "use",
  "delete",
  "get",
]) {
  cases.push([
    `operation ${op}`,
    `${HEADER} model Widget { id: string; } @route("/x") interface Widgets { @route("/a") @get \`${op}\`(): Widget[]; @route("/b") @get list(): Widget[]; }`,
  ]);
}

// Model names that shadow globals, infrastructure, or imports when used as a
// response and body.
for (const model of [
  "Promise",
  "Record",
  "Date",
  "Uint8Array",
  "Array",
  "Object",
  "Error",
  "Request",
  "Response",
  "Map",
  "Set",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Function",
  "Headers",
  "URL",
  "URLSearchParams",
  "AbortSignal",
  "Partial",
  "Readonly",
  "Omit",
  "Pick",
  "HttpClient",
  "RequestOptions",
  "RxHttpClient",
  "Observable",
  "ApiError",
  "RequestContext",
  "ClientConfig",
  "RetryConfig",
  "HttpMiddleware",
  "WidgetsClient",
  "WidgetsObservableClient",
  "WidgetsEndpoints",
  "InstanceType",
  "globalThis",
]) {
  cases.push([
    `model ${model} as response/body`,
    `${HEADER} model ${model} { id: string; } @route("/x") interface Widgets { @get list(@query since?: utcDateTime): ${model}[]; @post create(@body b: ${model}): ${model}; }`,
  ]);
  // The same name again, but with a sibling model that exercises every
  // built-in whose mapping could be shadowed. A shadowing type is only
  // dangerous when something else in the file actually uses the global, and
  // the bare case above does not — which is how the models.ts `Date` bug hid.
  cases.push([
    `generic model ${model}<T> as response`,
    `${HEADER} model ${model}<T> { value: T; } @route("/x") interface Widgets { @get list(): ${model}<string>; }`,
  ]);
  cases.push([
    `model ${model} + sibling using every built-in`,
    `${HEADER} model ${model} { id: string; } model Sibling { when: utcDateTime; blob: bytes; tags: Record<string>; list: string[]; shadow: ${model}; } @route("/x") interface Widgets { @get list(): Sibling[]; @post create(@body b: ${model}): Sibling; }`,
  ]);
}

// Enum names that shadow, referenced from a model.
for (const e of ["Promise", "Record", "HttpClient", "WidgetsClient"]) {
  cases.push([
    `enum ${e}`,
    `${HEADER} enum ${e} { A: "a" } model Widget { id: string; kind: ${e}; } @route("/x") interface Widgets { @get list(): Widget[]; }`,
  ]);
}

// Names that only the `path` and `interface` shapes generate: URL segments
// that become getters on the root client or on a request builder, path
// parameters that become `by<Param>` methods, and models named after the
// request-builder infrastructure.
for (const segment of [
  ...Object.getOwnPropertyNames(Object.prototype),
  "then",
  "prototype",
  "adapter",
  "pathParameters",
  "requestOptions",
  "withOptions",
  "applyOptions",
  "config",
  "request",
  "useMiddleware",
  "get",
  "getAll",
  "rx",
  "item",
  "root",
  "$count",
]) {
  cases.push([
    `segment ${segment}`,
    `${HEADER} model Widget { id: string; } @route("/${segment}") interface Root { @get list(): Widget[]; } @route("/w/${segment}") interface Nested { @get list(): Widget[]; } @route("/w") interface W { @get list(): Widget[]; }`,
  ]);
}
for (const param of [
  "default",
  "this",
  "adapter",
  "Item",
  "ItemRequestBuilder",
  "String",
]) {
  cases.push([
    `path parameter ${param}`,
    `${HEADER} model Widget { id: string; } @route("/w") interface W { @get read(@path \`${param}\`: string): Widget; }`,
  ]);
}
for (const model of [
  "RequestBuilder",
  "RxRequestBuilder",
  "RootClient",
  "RxRootClient",
  "RequestAdapter",
  "WRequestBuilder",
  "SweepApiClient",
  "WEndpoints",
]) {
  cases.push([
    `model ${model} in a request builder`,
    `${HEADER} model ${model} { id: string; } @route("/w") interface W { @get list(): ${model}[]; @post create(@body b: ${model}): ${model}; }`,
  ]);
}

/** Every case runs under each of these option sets. */
const CONFIGS = [
  { "client-style": "promise" },
  { "client-style": "both" },
  { "client-style": "both", "client-shape": "path" },
  { "client-style": "both", "client-shape": "interface" },
];

let failures = 0;
let checks = 0;
let skipped = 0;
for (const [label, code] of cases) {
  for (const options of CONFIGS) {
    const name = `${options["client-style"]}${options["client-shape"] ? `/${options["client-shape"]}` : ""}`;
    checks++;
    const result = await typeCheck(code, options);
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (result.errors.length === 0) continue;
    failures++;
    console.log(`FAIL [${name}] ${label}`);
    for (const e of result.errors) console.log(`    ${e}`);
  }
}

console.log(
  `\n${checks} checks, ${failures} failures, ${skipped} skipped (spec rejected by TypeSpec itself)`,
);
process.exitCode = failures ? 1 : 0;

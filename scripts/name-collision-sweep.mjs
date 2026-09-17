// Adversarial name sweep: emits a TypeSpec spec for every name that has ever
// collided with something the emitter generates — infrastructure exports,
// imported bindings, inherited members, JavaScript globals — and type-checks
// the resulting package under both client styles.
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

const RXJS_STUB = `export declare class Subscriber<T> { next(value: T): void; error(err: unknown): void; complete(): void; }
export type TeardownLogic = (() => void) | void;
export declare class Observable<T> { constructor(subscribe?: (s: Subscriber<T>) => TeardownLogic); subscribe(o?: unknown): { unsubscribe(): void }; }
`;

async function typeCheck(code, options) {
  const [results, diags] = await emitWithDiagnostics(code, options);
  const tspErrors = diags
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code.split("/").pop()}: ${d.message}`);
  if (tspErrors.length) return tspErrors;

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
    return ts
      .getPreEmitDiagnostics(program)
      .map(
        (d) =>
          `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      );
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

// Operation names that shadow inherited or prototype members.
for (const op of [
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "constructor",
  "__proto__",
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
    `${HEADER} model Widget { id: string; } @route("/x") interface Widgets { @route("/a") @get ${op}(): Widget[]; @route("/b") @get list(): Widget[]; }`,
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
]) {
  cases.push([
    `model ${model} as response/body`,
    `${HEADER} model ${model} { id: string; } @route("/x") interface Widgets { @get list(@query since?: utcDateTime): ${model}[]; @post create(@body b: ${model}): ${model}; }`,
  ]);
}

// Enum names that shadow, referenced from a model.
for (const e of ["Promise", "Record", "HttpClient", "WidgetsClient"]) {
  cases.push([
    `enum ${e}`,
    `${HEADER} enum ${e} { A: "a" } model Widget { id: string; kind: ${e}; } @route("/x") interface Widgets { @get list(): Widget[]; }`,
  ]);
}

let failures = 0;
let checks = 0;
for (const [label, code] of cases) {
  for (const style of ["promise", "both"]) {
    checks++;
    const errors = await typeCheck(code, { "client-style": style });
    if (errors.length === 0) continue;
    failures++;
    console.log(`FAIL [${style}] ${label}`);
    for (const e of errors) console.log(`    ${e}`);
  }
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;

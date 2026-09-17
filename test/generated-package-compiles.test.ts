import { describe, it } from "node:test";
import { ok, strictEqual, deepStrictEqual } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as ts from "typescript";
import { emitWithDiagnostics } from "./test-host.js";
import { API_CLIENT_EXPORTS, RX_API_CLIENT_EXPORTS } from "../src/emitter.js";
import type { EmitterOptions } from "../src/lib.js";

/**
 * End-to-end guard: emitted packages must actually compile.
 *
 * Content assertions can only check for what a test author thought to look for.
 * A whole class of defects — a barrel whose star exports are ambiguous, a
 * client method that shadows an inherited member — only shows up when
 * TypeScript is pointed at the result, so these tests write the emitted files
 * to a temp directory and run the compiler over them using the package's own
 * emitted `tsconfig.json`.
 */

/**
 * A structural stand-in for the slice of `rxjs` the Observable client uses.
 *
 * The generated package declares `rxjs` as an optional peer dependency, so it
 * is not installed here. These tests are checking our generated code, not
 * rxjs's typings, and a stub keeps the Observable flavor genuinely type-checked
 * instead of drowned in unresolved-module errors.
 */
const RXJS_STUB = `export declare class Subscriber<T> {
  next(value: T): void;
  error(err: unknown): void;
  complete(): void;
}
export type TeardownLogic = (() => void) | void;
export declare class Observable<T> {
  constructor(subscribe?: (subscriber: Subscriber<T>) => TeardownLogic);
  subscribe(observer?: unknown): { unsubscribe(): void };
}
`;

/** Writes every emitted file to a fresh temp directory and returns its path. */
async function materialize(results: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsp-ts-client-"));
  for (const [key, content] of Object.entries(results)) {
    const relative = key
      .replace(/^.*?tsp-output[\\/]?/, "")
      .replace(/^[\\/]+/, "");
    const absolute = join(dir, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await mkdir(join(dir, "stubs"), { recursive: true });
  await writeFile(join(dir, "stubs", "rxjs.d.ts"), RXJS_STUB);
  return dir;
}

/** Type-checks a materialized package with its own emitted tsconfig.json. */
function typeCheck(dir: string): string[] {
  const configPath = join(dir, "tsconfig.json");
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  ok(!readResult.error, "Expected a readable emitted tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, dir);
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
}

/**
 * Emits a spec, type-checks it, and cleans up.
 *
 * `probe` is an extra `.ts` file compiled alongside the package. It is how a
 * test asserts what a generated type actually *means* rather than only that it
 * parses — a property typed as the wrong thing still compiles.
 */
async function emitAndTypeCheck(
  code: string,
  options?: EmitterOptions,
  probe?: string,
): Promise<{ errors: string[]; files: Record<string, string> }> {
  const [results] = await emitWithDiagnostics(code, options);
  const dir = await materialize(results);
  try {
    if (probe) await writeFile(join(dir, "probe.ts"), probe);
    return { errors: typeCheck(dir), files: results };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TYPE_CHECK_TIMEOUT = 120_000;

describe("generated package compiles", () => {
  it("compiles a plain package", { timeout: TYPE_CHECK_TIMEOUT }, async () => {
    const { errors } = await emitAndTypeCheck(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; name: string; }

        @route("/widgets")
        interface Widgets {
          @get list(): Widget[];
          @get read(@path id: string): Widget;
          @post create(@body body: Widget): Widget;
          @head exists(@path id: string): void;
        }
      `);

    deepStrictEqual(errors, []);
  });

  // Regression: the barrel star-exports both models.ts and client/ApiClient.ts,
  // so a model named after a client infrastructure export made the re-export
  // ambiguous and the package failed with TS2308.
  for (const infrastructureName of [
    "RequestContext",
    "ClientConfig",
    "ApiError",
    "HttpMiddleware",
    "RetryConfig",
  ]) {
    it(
      `compiles when a model is named ${infrastructureName}`,
      { timeout: TYPE_CHECK_TIMEOUT },
      async () => {
        const { errors } = await emitAndTypeCheck(`
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model ${infrastructureName} { id: string; }
          model Widget { id: string; detail: ${infrastructureName}; }

          @route("/widgets")
          interface Widgets {
            @get list(): Widget[];
          }
        `);

        deepStrictEqual(errors, []);
      },
    );
  }

  // Regression: a model used directly as a response/body is imported into the
  // generated client module, where client.hbs already imports an
  // infrastructure symbol of that name — TS2300, duplicate identifier.
  for (const infrastructureName of [
    "RequestOptions",
    "HttpClient",
    "WidgetsEndpoints",
  ]) {
    it(
      `compiles when ${infrastructureName} is a model used as a response`,
      { timeout: TYPE_CHECK_TIMEOUT },
      async () => {
        const { errors, files } = await emitAndTypeCheck(`
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model ${infrastructureName} { id: string; }

          @route("/widgets")
          interface Widgets {
            @get list(): ${infrastructureName}[];
            @post create(@body body: ${infrastructureName}): ${infrastructureName};
          }
        `);

        deepStrictEqual(errors, []);

        const clientKey = Object.keys(files).find((k) =>
          k.endsWith("client/WidgetsClient.ts"),
        );
        ok(clientKey, "Expected client/WidgetsClient.ts");
        // The model keeps the plain name; the infrastructure import yields.
        ok(
          files[clientKey].includes(`as Client${infrastructureName}`),
          `Expected the infrastructure import of ${infrastructureName} to be aliased`,
        );
      },
    );
  }

  it(
    "compiles when a model used as a response collides in the Observable flavor",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors } = await emitAndTypeCheck(
        `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Observable { id: string; }
        model RxHttpClient { name: string; }
        model RequestOptions { tag: string; }

        @route("/widgets")
        interface Widgets {
          @route("/a") @get list(): Observable[];
          @route("/b") @get other(): RxHttpClient[];
          @route("/c") @get third(): RequestOptions[];
        }
      `,
        { "client-style": "both" },
      );

      deepStrictEqual(errors, []);
    },
  );

  // Regression: `interface RxHttp` emits client/RxHttpClient.ts exporting
  // RxHttpClient, which the static ApiClientRx.ts also exports — TS2308.
  it(
    "compiles when a generated client class collides with an infrastructure export",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(
        `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; }

        @route("/rxhttp")
        interface RxHttp { @get list(): Widget[]; }
      `,
        { "client-style": "both" },
      );

      deepStrictEqual(errors, []);

      const indexKey = Object.keys(files).find((k) => k.endsWith("index.ts"));
      ok(indexKey, "Expected index.ts");
      ok(
        files[indexKey].includes("RxHttpClient as ClientRxHttpClient"),
        "The infrastructure export yields to the generated client class",
      );
    },
  );

  // Regression: `interface Foo` emits FooObservableClient while `interface
  // FooObservable` emits its *Promise* client to that same path. The second
  // write overwrote the first, silently dropping one client from the package.
  it(
    "keeps both clients when two interfaces contend for one module name",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(
        `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; }

        @route("/foo") interface Foo { @get list(): Widget[]; }
        @route("/fooobs") interface FooObservable { @get list(): Widget[]; }
      `,
        { "client-style": "both" },
      );

      deepStrictEqual(errors, []);

      // Four distinct client modules, none overwriting another.
      const clientFiles = Object.keys(files)
        .filter((k) => /client\/(?!ApiClient)/.test(k))
        .map((k) => k.slice(k.lastIndexOf("/") + 1))
        .sort();
      deepStrictEqual(clientFiles, [
        "FooClient.ts",
        "FooObservableClient.ts",
        "FooObservableClient2.ts",
        "FooObservableObservableClient.ts",
      ]);

      // Every interface still has a client of each flavor.
      const declared = clientFiles.map((f) => {
        const key = Object.keys(files).find((k) => k.endsWith(`/${f}`));
        ok(key, `Expected ${f}`);
        return /export class (\w+)/.exec(files[key])?.[1];
      });
      deepStrictEqual(declared, [
        "FooClient",
        "FooObservableClient",
        "FooObservableClient2",
        "FooObservableObservableClient",
      ]);
    },
  );

  // Regression: a model named after the client class was imported into the
  // very module that declares it — TS2440, conflicting local declaration.
  for (const [style, clientFile] of [
    ["promise", "client/WidgetsClient2.ts"],
    ["observable", "client/WidgetsObservableClient2.ts"],
  ] as const) {
    it(
      `compiles when a model is named after the ${style} client class`,
      { timeout: TYPE_CHECK_TIMEOUT },
      async () => {
        const modelName =
          style === "promise" ? "WidgetsClient" : "WidgetsObservableClient";
        const { errors, files } = await emitAndTypeCheck(
          `
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model ${modelName} { id: string; }

          @route("/widgets")
          interface Widgets { @get list(): ${modelName}[]; }
        `,
          { "client-style": style },
        );

        deepStrictEqual(errors, []);

        // The declared model keeps the plain name; the client class steps aside.
        const key = Object.keys(files).find((k) => k.endsWith(clientFile));
        ok(key, `Expected ${clientFile}`);
        const modelsKey = Object.keys(files).find((k) =>
          k.endsWith("models.ts"),
        );
        ok(modelsKey, "Expected models.ts");
        ok(
          files[modelsKey].includes(`export interface ${modelName} `),
          "The model must keep its declared name",
        );
      },
    );
  }

  // Regression: `interface Api` wrote client/ApiClient.ts, which the static
  // infrastructure file then silently overwrote — the client vanished.
  it(
    "keeps a generated client whose file name collides with the infrastructure",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; }

        @route("/api")
        interface Api { @get list(): Widget[]; }
      `);

      deepStrictEqual(errors, []);

      const infraKey = Object.keys(files).find((k) =>
        k.endsWith("client/ApiClient.ts"),
      );
      ok(infraKey, "Expected the infrastructure client/ApiClient.ts");
      ok(
        files[infraKey].includes("export class HttpClient"),
        "The infrastructure file must be intact",
      );

      const generatedKey = Object.keys(files).find((k) =>
        k.endsWith("client/ApiClient2.ts"),
      );
      ok(
        generatedKey,
        "The generated client must be emitted under a free name",
      );
      ok(
        files[generatedKey].includes("export class ApiClient2 extends"),
        "Expected the renamed generated client class",
      );
    },
  );

  // Regression: a generated type named after a global that a scalar maps to
  // shadows it inside models.ts, so a sibling model's `utcDateTime` silently
  // resolved to the user's own interface. It compiled — which is what made it
  // dangerous — so the probe asserts the property is really a JS Date.
  for (const [global, builtin, witness] of [
    ["Date", "utcDateTime", "getTime()"],
    ["Uint8Array", "bytes", "byteLength"],
  ] as const) {
    it(
      `keeps the global ${global} usable when a model shadows it`,
      { timeout: TYPE_CHECK_TIMEOUT },
      async () => {
        const { errors, files } = await emitAndTypeCheck(
          `
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model ${global} { id: string; }
          model Widget { real: ${builtin}; shadow: ${global}; }

          @route("/widgets")
          interface Widgets { @get list(): Widget[]; }
        `,
          undefined,
          // `real` must be the global; `shadow` must be the user's model.
          `import type { Widget } from "./models.js";
           declare const w: Widget;
           export const a = w.real.${witness};
           export const b: string = w.shadow.id;
          `,
        );

        deepStrictEqual(errors, []);

        const modelsKey = Object.keys(files).find((k) =>
          k.endsWith("models.ts"),
        );
        ok(modelsKey, "Expected models.ts");
        const models = files[modelsKey];
        ok(
          models.includes(
            `type Global${global} = typeof globalThis.${global}.prototype;`,
          ),
          "Expected the global alias declaration",
        );
        ok(
          models.includes(`real: Global${global};`),
          "The scalar property must use the alias",
        );
        ok(
          models.includes(`shadow: ${global};`),
          "A reference to the user's own model must not be aliased",
        );
        ok(
          !/^export type Global/m.test(models),
          "The alias must not be exported into the barrel",
        );
      },
    );
  }

  // Regression: the shadow alias is a name-only rewrite, so it must not swallow
  // the model's generic arguments — `Date<string>` became a bare `DateModel`,
  // which then failed as a use of a generic type without arguments.
  it(
    "keeps generic arguments when aliasing a model that shadows a global",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Date<T> { value: T; }

        @route("/widgets")
        interface Widgets { @get list(): Date<string>; }
      `);

      deepStrictEqual(errors, []);

      const key = Object.keys(files).find((k) =>
        k.endsWith("client/WidgetsClient.ts"),
      );
      ok(key, "Expected client/WidgetsClient.ts");
      ok(
        files[key].includes("Promise<DateModel<string>>"),
        "The alias must carry the generic argument through",
      );
    },
  );

  // Regression: the shadow alias used `InstanceType<…>`, which a spec declaring
  // `model InstanceType` shadows in that very file — TS2315.
  it(
    "builds the shadow alias without depending on another global name",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(
        `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model InstanceType { id: string; }
        model globalThis { id: string; }
        model Date { id: string; }
        model Widget { real: utcDateTime; a: InstanceType; b: globalThis; c: Date; }

        @route("/widgets")
        interface Widgets { @get list(): Widget[]; }
      `,
        undefined,
        `import type { Widget } from "./models.js";
         declare const w: Widget;
         export const t: number = w.real.getTime();
        `,
      );

      deepStrictEqual(errors, []);

      const key = Object.keys(files).find((k) => k.endsWith("models.ts"));
      ok(key, "Expected models.ts");
      ok(
        files[key].includes(
          "type GlobalDate = typeof globalThis.Date.prototype;",
        ),
        "Expected the alias to read .prototype off the constructor",
      );
      ok(
        !files[key].includes("InstanceType<"),
        "The alias must not depend on the InstanceType utility",
      );
    },
  );

  // Regression: `interface Http` declares `class HttpClient`, the same name as
  // the base class it imports — TS2440 and a self-referential extends clause.
  for (const style of ["promise", "both"] as const) {
    it(
      `compiles an interface named Http (${style})`,
      { timeout: TYPE_CHECK_TIMEOUT },
      async () => {
        const { errors, files } = await emitAndTypeCheck(
          `
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model Widget { id: string; }

          @route("/http") interface Http { @get list(): Widget[]; }
        `,
          { "client-style": style },
        );

        deepStrictEqual(errors, []);

        const key = Object.keys(files).find((k) =>
          k.endsWith("client/HttpClient.ts"),
        );
        ok(key, "Expected client/HttpClient.ts");
        // The generated class keeps its name; the base-class import yields.
        ok(
          files[key].includes("HttpClient as ClientHttpClient"),
          "Expected the base-class import to be aliased",
        );
        ok(
          files[key].includes(
            "export class HttpClient extends ClientHttpClient",
          ),
          "Expected the generated class to extend the alias",
        );
      },
    );
  }

  // Regression: a model named after a global the client references — most
  // importantly `Promise` — shadowed it when imported, so every
  // `Promise<T>` return type became a reference to the user's non-generic
  // model (TS2315). One spec covers every protected global at once.
  for (const style of ["promise", "both"] as const) {
    it(
      `compiles when models shadow Promise, Record, Date and Uint8Array (${style})`,
      { timeout: TYPE_CHECK_TIMEOUT },
      async () => {
        const { errors, files } = await emitAndTypeCheck(
          `
          import "@typespec/http";
          using Http;

          @service(#{ title: "Test API" })
          namespace TestApi;

          model Promise { id: string; }
          model Record { id: string; }
          model Date { id: string; }
          model Uint8Array { id: string; }

          @route("/x")
          interface Widgets {
            @route("/a") @get a(@query since?: utcDateTime): Promise[];
            @route("/b") @post b(@body body: Record): Record;
            @route("/c") @get c(): Date[];
            @route("/d") @post d(@body body: Uint8Array): Uint8Array;
          }
        `,
          { "client-style": style },
        );

        deepStrictEqual(errors, []);

        const key = Object.keys(files).find((k) =>
          k.endsWith("client/WidgetsClient.ts"),
        );
        ok(key, "Expected client/WidgetsClient.ts");
        const client = files[key];
        for (const g of ["Promise", "Record", "Date", "Uint8Array"]) {
          ok(
            client.includes(`${g} as ${g}Model`),
            `Expected the ${g} model import to be aliased`,
          );
        }
        ok(
          client.includes("Promise<PromiseModel[]>"),
          "The return type must wrap the aliased model in the global Promise",
        );
        ok(
          client.includes("body: RecordModel"),
          "The body parameter must use the alias too",
        );
        ok(
          client.includes("since?: Date"),
          "A scalar query param must still mean the global Date",
        );
      },
    );
  }

  // Object.prototype members compile when overridden — TypeScript does not
  // check class members against Object's apparent members — but an async
  // `toString`/`valueOf` breaks coercion, and a `then` method would make the
  // client a thenable. All are reserved regardless of client style.
  it(
    "renames operations named after Object.prototype members and then",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      // Every own property of Object.prototype, plus `then`.
      const names = [
        ...Object.getOwnPropertyNames(Object.prototype).filter(
          (n) => n !== "constructor",
        ),
        "then",
      ];
      const ops = names
        .map((n, i) => `@route("/${i}") @get \`${n}\`(): Widget[];`)
        .join("\n");
      const { errors, files } = await emitAndTypeCheck(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; }

        @route("/x") interface Widgets { ${ops} }
      `);

      deepStrictEqual(errors, []);

      const key = Object.keys(files).find((k) =>
        k.endsWith("client/WidgetsClient.ts"),
      );
      ok(key, "Expected client/WidgetsClient.ts");
      for (const n of names) {
        ok(
          files[key].includes(`async ${n}Operation(`),
          `Expected ${n} to be renamed`,
        );
        ok(
          !new RegExp(`async ${n}\\(`).test(files[key]),
          `Expected no bare ${n} method`,
        );
      }
    },
  );

  it(
    "compiles when a model collides with an Observable-flavor export",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors } = await emitAndTypeCheck(
        `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model RxHttpClient { id: string; }
        model RequestContext { id: string; }
        model Widget { id: string; a: RxHttpClient; b: RequestContext; }

        @route("/widgets")
        interface Widgets {
          @get list(): Widget[];
        }
      `,
        { "client-style": "both" },
      );

      deepStrictEqual(errors, []);
    },
  );

  const COLLIDING_OPS = `
        @route("/a") @get buildUrl(): Widget[];
        @route("/b") @get applyErrorHook(): Widget[];
        @route("/c") @get request(): Widget[];
        @route("/d") @get config(): Widget[];
        @route("/e") @get useMiddleware(): Widget[];
        @route("/f") @get httpGet(): Widget[];
        @route("/g") @get observe(): Widget[];
        @route("/h") @get httpGet$(): Widget[];
        @route("/i") @get use(): Widget[];
  `;

  const collidingSpec = `
    import "@typespec/http";
    using Http;

    @service(#{ title: "Test API" })
    namespace TestApi;

    model Widget { id: string; name: string; }

    @route("/widgets")
    interface Widgets {${COLLIDING_OPS}}
  `;

  /** Members of HttpClient — always reserved, whatever the client style. */
  const BASE_COLLISIONS = [
    "buildUrl",
    "applyErrorHook",
    "request",
    "config",
    "useMiddleware",
    "httpGet",
  ];
  /** Members of RxHttpClient — only reserved when that base is emitted. */
  const RX_COLLISIONS = ["observe", "httpGet$"];

  // Regression: these are members of the generated client's base class, so an
  // operation of the same name produced an incompatible override (TS2416) or
  // clashed with a private base member.
  it(
    "compiles and renames only base members for the Promise flavor",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(collidingSpec);
      deepStrictEqual(errors, []);

      const clientKey = Object.keys(files).find((k) =>
        k.endsWith("client/WidgetsClient.ts"),
      );
      ok(clientKey, "Expected client/WidgetsClient.ts");
      const client = files[clientKey];

      for (const name of BASE_COLLISIONS) {
        ok(client.includes(`async ${name}Operation(`), `Expected ${name}`);
      }
      // RxHttpClient is not the base here, so these names are free.
      for (const name of RX_COLLISIONS) {
        ok(
          client.includes(`async ${name}(`),
          `Promise-only clients must not reserve the Rx member ${name}`,
        );
      }
      ok(
        client.includes("async use("),
        "`use` is not reserved — the base member is useMiddleware",
      );
    },
  );

  it(
    "compiles and renames Rx members too when an Observable client is emitted",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(collidingSpec, {
        "client-style": "both",
      });
      deepStrictEqual(errors, []);

      for (const [file, prefix] of [
        ["client/WidgetsClient.ts", "async "],
        ["client/WidgetsObservableClient.ts", ""],
      ] as const) {
        const key = Object.keys(files).find((k) => k.endsWith(file));
        ok(key, `Expected ${file}`);
        // Both flavors rename the same set, so the two clients stay
        // method-for-method interchangeable.
        for (const name of [...BASE_COLLISIONS, ...RX_COLLISIONS]) {
          ok(
            files[key].includes(`${prefix}${name}Operation(`),
            `Expected ${name}Operation in ${file}`,
          );
        }
      }
    },
  );

  it(
    "compiles the Observable-only flavor when an operation shadows an Rx helper",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors } = await emitAndTypeCheck(collidingSpec, {
        "client-style": "observable",
      });

      deepStrictEqual(errors, []);
    },
  );
});

describe("client infrastructure export metadata", () => {
  // The barrel needs to know what client/ApiClient.ts exports, and whether each
  // name is type-only, to re-export it by name when a star export would be
  // ambiguous. That list is maintained by hand next to the file's source text,
  // so it is checked against the emitted file here.
  it("matches what the emitted infrastructure modules declare", async () => {
    const [results] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets { @get list(): Widget[]; }
    `,
      { "client-style": "both" },
    );

    for (const [file, declared] of [
      ["client/ApiClient.ts", API_CLIENT_EXPORTS],
      ["client/ApiClientRx.ts", RX_API_CLIENT_EXPORTS],
    ] as const) {
      const key = Object.keys(results).find((k) => k.endsWith(file));
      ok(key, `Expected ${file}`);

      const actual = [
        ...results[key].matchAll(
          /^export\s+(interface|type|class|enum|const|function)\s+(\w+)/gm,
        ),
      ].map((m) => ({
        name: m[2],
        // A class is the only one of these forms with a runtime binding.
        isType: m[1] !== "class" && m[1] !== "const" && m[1] !== "function",
      }));

      deepStrictEqual(
        actual,
        declared.map((d) => ({ name: d.name, isType: d.isType })),
        `${file} exports drifted from the hand-maintained list in emitter.ts`,
      );
    }
  });

  it("emits every infrastructure export through the barrel on a collision", async () => {
    const [results] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model RequestContext { id: string; }
      model Widget { id: string; ctx: RequestContext; }

      @route("/widgets")
      interface Widgets { @get list(): Widget[]; }
    `);

    const indexKey = Object.keys(results).find((k) => k.endsWith("index.ts"));
    ok(indexKey, "Expected index.ts");
    const index = results[indexKey];

    // Nothing may be dropped when the star export is replaced by a name list.
    for (const { name } of API_CLIENT_EXPORTS) {
      ok(
        index.includes(`  ${name},`) ||
          index.includes(`  ${name} as Client${name},`),
        `Expected ${name} to still be re-exported`,
      );
    }
    strictEqual(
      index.includes('export * from "./client/ApiClient.js"'),
      false,
      "The ambiguous star export must be gone",
    );
  });
});

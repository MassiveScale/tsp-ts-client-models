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

/** Emits a spec, type-checks it, and cleans up. */
async function emitAndTypeCheck(
  code: string,
  options?: EmitterOptions,
): Promise<{ errors: string[]; files: Record<string, string> }> {
  const [results] = await emitWithDiagnostics(code, options);
  const dir = await materialize(results);
  try {
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

  // Regression: these are members of the generated HttpClient base, so an
  // operation of the same name produced an incompatible override (TS2416) or
  // clashed with a private base member.
  it(
    "compiles when operations are named after inherited client members",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors, files } = await emitAndTypeCheck(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; name: string; }

        @route("/widgets")
        interface Widgets {
          @route("/a") @get buildUrl(): Widget[];
          @route("/b") @get applyErrorHook(): Widget[];
          @route("/c") @get request(): Widget[];
          @route("/d") @get config(): Widget[];
          @route("/e") @get useMiddleware(): Widget[];
          @route("/f") @get observe(): Widget[];
          @route("/g") @get httpGet(): Widget[];
          @route("/h") @get use(): Widget[];
        }
      `);

      deepStrictEqual(errors, []);

      const clientKey = Object.keys(files).find((k) =>
        k.endsWith("client/WidgetsClient.ts"),
      );
      ok(clientKey, "Expected client/WidgetsClient.ts");
      const client = files[clientKey];
      for (const renamed of [
        "async buildUrlOperation(",
        "async applyErrorHookOperation(",
        "async requestOperation(",
        "async configOperation(",
        "async useMiddlewareOperation(",
        "async observeOperation(",
        "async httpGetOperation(",
      ]) {
        ok(client.includes(renamed), `Expected ${renamed}`);
      }
      ok(
        client.includes("async use("),
        "`use` is not reserved — the base member is useMiddleware",
      );
    },
  );

  it(
    "compiles the Observable flavor when an operation shadows an Rx helper",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const { errors } = await emitAndTypeCheck(
        `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { id: string; name: string; }

        @route("/widgets")
        interface Widgets {
          @route("/a") @get observe(): Widget[];
          @route("/b") @get request(): Widget[];
        }
      `,
        { "client-style": "both" },
      );

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

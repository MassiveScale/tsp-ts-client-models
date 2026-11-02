import { after, describe, it } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import type { Diagnostic } from "@typespec/compiler";
import { emit, emitWithDiagnostics } from "./test-host.js";
import type { EmitterOptions } from "../src/lib.js";
import {
  REQUEST_BUILDER_EXPORTS,
  RX_REQUEST_BUILDER_EXPORTS,
} from "../src/request-builder-runtime.js";

/**
 * Tests for the `path` and `interface` client shapes: which files are
 * emitted, how members are named, that the result compiles, and that the
 * generated chains send the requests they promise.
 */

const HEADER = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Shape API" })
  namespace ShapeApi;
`;

/** A store API with nested routes, a mixed segment, a route of `/` and paging. */
const STORE_SPEC = `${HEADER}
  model Store { id: string; name?: string; }
  model StorePage { @pageItems items: Store[]; @nextLink next?: url; }

  @route("/stores")
  interface Stores {
    @list @get list(@query top?: int32): StorePage;
    @post create(@body body: Store): Store;
    @get read(@path storeId: string): Store;
    @delete remove(@path storeId: string): void;
  }

  @route("/stores/{storeId}/pets")
  interface Pets {
    @get read(@path storeId: string, @path petId: string, @header("x-trace") trace?: string): Store;
    @head exists(@path storeId: string, @path petId: string): void;
    @put replace(@path storeId: string, @path petId: string, @body body: Store): Store;
  }

  @route("/reports")
  interface Reports {
    @route("{from}-{to}") @get range(@path from: string, @path to: string): Store;
  }

  @route("/")
  interface Health {
    @get check(): void;
  }
`;

/** The content of the emitted file whose path ends with `file`. */
function file(files: Record<string, string>, name: string): string {
  const key = Object.keys(files).find((k) =>
    k.replace(/\\/g, "/").endsWith(name),
  );
  ok(key, `Expected ${name}; emitted: ${Object.keys(files).join(", ")}`);
  return files[key];
}

/** Whether a file whose path ends with `name` was emitted. */
function has(files: Record<string, string>, name: string): boolean {
  return Object.keys(files).some((k) => k.replace(/\\/g, "/").endsWith(name));
}

/** The emitted `client/` module basenames, sorted. */
function clientModules(files: Record<string, string>): string[] {
  return Object.keys(files)
    .map((k) => k.replace(/\\/g, "/"))
    .filter((k) => k.includes("client/"))
    .map((k) => k.slice(k.lastIndexOf("/") + 1))
    .sort();
}

/** The codes and messages of diagnostics this emitter reported. */
function emitterDiagnostics(diagnostics: readonly Diagnostic[]) {
  return diagnostics
    .filter((d) => d.code.startsWith("@massivescale/tsp-ts-client-models/"))
    .map((d) => ({
      code: d.code.replace("@massivescale/tsp-ts-client-models/", ""),
      message: d.message,
    }));
}

describe("client-shape: path", () => {
  it("emits a root client and one builder per URL segment", async () => {
    const files = await emit(STORE_SPEC, { "client-shape": "path" });

    deepStrictEqual(clientModules(files), [
      "HealthRequestBuilder.ts",
      "ReportsRequestBuilder.ts",
      "RequestBuilder.ts",
      "ShapeApiClient.ts",
      "StoresItemPetsItemRequestBuilder.ts",
      "StoresItemPetsRequestBuilder.ts",
      "StoresItemRequestBuilder.ts",
      "StoresRequestBuilder.ts",
      "runtime.ts",
    ]);
    ok(
      has(files, "endpoints/StoresEndpoints.ts"),
      "Endpoint objects are still emitted",
    );
  });

  it("exposes segments as getters and parameters as by<Param> methods", async () => {
    const files = await emit(STORE_SPEC, { "client-shape": "path" });

    const root = file(files, "client/ShapeApiClient.ts");
    ok(root.includes('import { RootClient } from "./RequestBuilder.js";'));
    ok(root.includes("export class ShapeApiClient extends RootClient {"));
    ok(root.includes("get stores(): StoresRequestBuilder {"));
    ok(root.includes("return new StoresRequestBuilder(this.adapter, []);"));
    ok(root.includes("get health(): HealthRequestBuilder {"));

    const stores = file(files, "client/StoresRequestBuilder.ts");
    ok(
      stores.includes("byStoreId(storeId: string): StoresItemRequestBuilder {"),
    );
    ok(
      stores.includes(
        "return new StoresItemRequestBuilder(this.adapter, [...this.pathParameters, storeId], this.requestOptions);",
      ),
    );

    const item = file(files, "client/StoresItemRequestBuilder.ts");
    ok(item.includes("get pets(): StoresItemPetsRequestBuilder {"));
    ok(
      item.includes(
        "return new StoresItemPetsRequestBuilder(this.adapter, this.pathParameters, this.requestOptions);",
      ),
    );
  });

  it("names operation methods after their HTTP verb and fills bound parameters from the builder", async () => {
    const files = await emit(STORE_SPEC, { "client-shape": "path" });

    const stores = file(files, "client/StoresRequestBuilder.ts");
    ok(
      stores.includes(
        "async get(query?: { top?: number; [key: string]: unknown }, options?: RequestOptions): Promise<StorePage> {",
      ),
    );
    ok(
      stores.includes(
        "getAll(query?: { top?: number; [key: string]: unknown }, options?: RequestOptions): AsyncGenerator<Store, void, undefined> {",
      ),
    );
    ok(stores.includes("async post(body: Store,"));

    const item = file(files, "client/StoresItemRequestBuilder.ts");
    ok(item.includes("StoresEndpoints.read(this.pathParameters[0])"));
    ok(
      item.includes(
        "async delete(query?: Record<string, unknown>, options?: RequestOptions): Promise<void> {",
      ),
    );

    const pet = file(files, "client/StoresItemPetsItemRequestBuilder.ts");
    ok(
      pet.includes(
        "PetsEndpoints.read(this.pathParameters[0], this.pathParameters[1])",
      ),
    );
    ok(pet.includes("async head("));
    ok(pet.includes("async put(body: Store,"));
  });

  it("passes the parameters after the chain to the method", async () => {
    const files = await emit(STORE_SPEC, { "client-shape": "path" });

    const reports = file(files, "client/ReportsRequestBuilder.ts");
    ok(
      reports.includes(
        "async get(from: string, to: string, query?: Record<string, unknown>, options?: RequestOptions): Promise<Store> {",
      ),
    );
    ok(reports.includes("ReportsEndpoints.range(from, to)"));
  });

  it("keeps operation names when two operations of one builder share a verb", async () => {
    const files = await emit(
      `${HEADER}
        model Toy { name: string; }
        @route("/toys")
        interface Toys {
          @sharedRoute @get list(): Toy[];
          @sharedRoute @get search(@query q: string): Toy[];
          @post create(@body body: Toy): Toy;
        }
      `,
      { "client-shape": "path" },
    );

    const toys = file(files, "client/ToysRequestBuilder.ts");
    ok(toys.includes("async list("));
    ok(toys.includes("async search("));
    ok(toys.includes("async post("));
  });

  it("imports each endpoints object a builder's operations come from", async () => {
    const files = await emit(
      `${HEADER}
        model Item { id: string; }
        @route("/items") interface Items { @get list(): Item[]; }
        @route("/items") interface Admin { @post create(@body body: Item): Item; }
      `,
      { "client-shape": "path" },
    );

    const items = file(files, "client/ItemsRequestBuilder.ts");
    ok(
      items.includes(
        'import { ItemsEndpoints } from "../endpoints/ItemsEndpoints.js";',
      ),
    );
    ok(
      items.includes(
        'import { AdminEndpoints } from "../endpoints/AdminEndpoints.js";',
      ),
    );
  });

  it("re-exports the root client, the builders and the builder infrastructure", async () => {
    const files = await emit(STORE_SPEC, { "client-shape": "path" });

    const index = file(files, "index.ts");
    ok(index.includes('export * from "./client/RequestBuilder.js";'));
    ok(index.includes('export * from "./client/ShapeApiClient.js";'));
    ok(index.includes('export * from "./client/StoresItemRequestBuilder.js";'));
    ok(
      index.indexOf("./client/runtime.js") <
        index.indexOf("./client/RequestBuilder.js"),
      "The base infrastructure is listed first",
    );
  });
});

describe("client-shape: interface", () => {
  it("nests interfaces and takes the parameters each adds as steps", async () => {
    const files = await emit(STORE_SPEC, { "client-shape": "interface" });

    deepStrictEqual(clientModules(files), [
      "HealthRequestBuilder.ts",
      "ReportsItemItemRequestBuilder.ts",
      "ReportsItemRequestBuilder.ts",
      "ReportsRequestBuilder.ts",
      "RequestBuilder.ts",
      "ShapeApiClient.ts",
      "StoresItemPetsItemRequestBuilder.ts",
      "StoresItemPetsRequestBuilder.ts",
      "StoresItemRequestBuilder.ts",
      "StoresRequestBuilder.ts",
      "runtime.ts",
    ]);
    const item = file(files, "client/StoresItemRequestBuilder.ts");
    ok(item.includes("get pets(): StoresItemPetsRequestBuilder {"));
    ok(item.includes("/** Requests of the `Pets` operations. */"));
    const reports = file(files, "client/ReportsItemItemRequestBuilder.ts");
    ok(
      reports.includes(
        "ReportsEndpoints.range(this.pathParameters[0], this.pathParameters[1])",
      ),
    );
  });
});

describe("client-shape: flat", () => {
  it("is the default and emits no request builders", async () => {
    const files = await emit(STORE_SPEC);

    ok(has(files, "client/StoresClient.ts"));
    strictEqual(has(files, "client/RequestBuilder.ts"), false);
    strictEqual(has(files, "client/ShapeApiClient.ts"), false);
  });

  it("ignores client-name", async () => {
    const files = await emit(STORE_SPEC, {
      "client-shape": "flat",
      "client-name": "not valid!",
    });

    ok(has(files, "client/StoresClient.ts"));
  });
});

describe("client-shape flavors and options", () => {
  it("emits a parallel Observable tree with client-style both", async () => {
    const files = await emit(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "both",
    });

    ok(has(files, "client/ShapeApiClient.ts"));
    ok(has(files, "client/StoresRequestBuilder.ts"));
    ok(has(files, "client/RequestBuilderRx.ts"));
    const root = file(files, "client/ShapeApiObservableClient.ts");
    ok(root.includes('import { RxRootClient } from "./RequestBuilderRx.js";'));
    ok(root.includes("get stores(): StoresObservableRequestBuilder {"));
    strictEqual(
      root.includes('from "rxjs"'),
      false,
      "A builder without methods imports no Observable",
    );

    const stores = file(files, "client/StoresObservableRequestBuilder.ts");
    ok(stores.includes('import { Observable } from "rxjs";'));
    ok(
      stores.includes(
        "export class StoresObservableRequestBuilder extends RxRequestBuilder {",
      ),
    );
    ok(
      stores.includes(
        "get(query?: { top?: number; [key: string]: unknown }, options?: RequestOptions): Observable<StorePage> {",
      ),
    );
    ok(stores.includes("this.httpGet$<StorePage>("));
    ok(
      stores.includes(
        "getAll(query?: { top?: number; [key: string]: unknown }, options?: RequestOptions): Observable<Store> {",
      ),
    );
    ok(stores.includes("this.paginate$<"));
  });

  it("emits only the Observable tree with client-style observable", async () => {
    const files = await emit(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "observable",
    });

    ok(has(files, "client/ShapeApiObservableClient.ts"));
    strictEqual(has(files, "client/ShapeApiClient.ts"), false);
    strictEqual(has(files, "client/StoresRequestBuilder.ts"), false);
  });

  it("names the root client after client-name", async () => {
    const files = await emit(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "both",
      "client-name": "Acme",
    });

    ok(
      file(files, "client/AcmeClient.ts").includes(
        "export class AcmeClient extends RootClient {",
      ),
    );
    ok(has(files, "client/AcmeObservableClient.ts"));
  });

  it("reports an invalid client-name and emits no client", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(STORE_SPEC, {
      "client-shape": "path",
      "client-name": "9lives",
    });

    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["invalid-client-name"],
    );
    deepStrictEqual(clientModules(files), []);
    ok(has(files, "endpoints/StoresEndpoints.ts"));
  });

  it("emits no client with generate-http-client false", async () => {
    const files = await emit(STORE_SPEC, {
      "client-shape": "path",
      "generate-http-client": false,
    });

    deepStrictEqual(clientModules(files), []);
  });

  it("emits a tree per version with all-versions", async () => {
    const files = await emit(
      `
        import "@typespec/http";
        import "@typespec/versioning";
        using Http;
        using Versioning;

        @service(#{ title: "Shape API" })
        @versioned(Versions)
        namespace ShapeApi;
        enum Versions { v1, v2 }

        model Store { id: string; }
        @route("/stores") interface Stores {
          @get list(): Store[];
          @added(Versions.v2) @get read(@path id: string): Store;
        }
      `,
      { "client-shape": "path", "all-versions": true },
    );

    ok(has(files, "v1/client/ShapeApiClient.ts"));
    strictEqual(has(files, "v1/client/StoresItemRequestBuilder.ts"), false);
    ok(has(files, "v2/client/StoresItemRequestBuilder.ts"));
  });

  it("renders a builder with an overridden template", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsp-shape-template-"));
    try {
      const template = join(dir, "builder.hbs");
      await writeFile(
        template,
        "// custom {{className}} {{steps.length}} {{methods.length}}\n",
      );
      const files = await emit(STORE_SPEC, {
        "client-shape": "path",
        templates: { requestBuilder: template },
      });

      ok(
        file(files, "client/StoresRequestBuilder.ts").includes(
          "// custom StoresRequestBuilder 1 2",
        ),
      );
      ok(
        file(files, "client/ShapeApiClient.ts").includes(
          "// custom ShapeApiClient 3 0",
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("client-shape member names", () => {
  it("gives a getter that matches a method a Path suffix", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        @route("/widgets") interface Widgets {
          @get list(): W[];
          @route("get") @get special(): W;
        }
      `,
      { "client-shape": "path" },
    );

    const widgets = file(files, "client/WidgetsRequestBuilder.ts");
    ok(widgets.includes("get getPath(): WidgetsGetRequestBuilder {"));
    ok(widgets.includes("async get("));
    deepStrictEqual(emitterDiagnostics(diagnostics), [
      {
        code: "builder-member-name-collision",
        message:
          'The step property "get" on "WidgetsRequestBuilder" would have the same name as another member of that class, so it was emitted as "getPath" instead.',
      },
    ]);
  });

  it("renames steps named after inherited or prototype members", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        @route("/config") interface Config { @get read(): W; }
        @route("/w/then") interface Then { @get read(): W; }
        @route("/w/constructor") interface Ctor { @get read(): W; }
        @route("/w/with-options") interface Opts { @get read(): W; }
      `,
      { "client-shape": "path" },
    );

    ok(
      file(files, "client/ShapeApiClient.ts").includes(
        "get configPath(): ConfigRequestBuilder {",
      ),
    );
    const w = file(files, "client/WRequestBuilder.ts");
    ok(w.includes("get thenPath(): WThenRequestBuilder {"));
    ok(w.includes("get constructorPath(): WConstructorRequestBuilder {"));
    ok(w.includes("get withOptionsPath(): WWithOptionsRequestBuilder {"));
    strictEqual(emitterDiagnostics(diagnostics).length, 4);
  });

  it("numbers a by<Param> step that matches a getter", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        @route("/a") interface A {
          @route("by-id") @get named(): W;
          @route("{id}") @get read(@path id: string): W;
        }
      `,
      { "client-shape": "path" },
    );

    const a = file(files, "client/ARequestBuilder.ts");
    ok(a.includes("get byId(): AByIdRequestBuilder {"));
    ok(a.includes("byId2(id: string): AItemRequestBuilder {"));
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.message),
      [
        'The step method "byId" on "ARequestBuilder" would have the same name as another member of that class, so it was emitted as "byId2" instead.',
      ],
    );
  });

  it("numbers two operation methods that share a name", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        @route("/x") interface A { @sharedRoute @get list(): W[]; }
        @route("/x") interface B { @sharedRoute @get list(@query q: string): W[]; }
      `,
      { "client-shape": "path" },
    );

    const x = file(files, "client/XRequestBuilder.ts");
    ok(x.includes("async list("));
    ok(x.includes("async list2("));
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["builder-member-name-collision"],
    );
  });

  it("suffixes an operation name that shadows a builder member", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        @route("/x") interface A {
          @sharedRoute @get withOptions(): W[];
          @sharedRoute @get other(@query q: string): W[];
        }
      `,
      { "client-shape": "path" },
    );

    ok(
      file(files, "client/XRequestBuilder.ts").includes(
        "async withOptionsOperation(",
      ),
    );
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["reserved-client-method-name"],
    );
  });

  it("numbers a paging method whose name is taken", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        model Page { @pageItems items: W[]; @nextLink next?: url; }
        @route("/x") interface A {
          @sharedRoute @list @get list(): Page;
          @sharedRoute @get listAll(@query q: string): W[];
        }
      `,
      { "client-shape": "path" },
    );

    ok(file(files, "client/XRequestBuilder.ts").includes("listAll2("));
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["paging-method-name-collision"],
    );
  });

  it("reports an unsupported paging style once", async () => {
    const [, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        model Page { @pageItems items: W[]; @header("x-next") @nextLink next?: string; }
        @route("/x") interface A { @list @get list(): Page; }
      `,
      { "client-shape": "path", "client-style": "both" },
    );

    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["unsupported-paging-style"],
    );
  });

  it("numbers a builder class that a model already names", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model StoresRequestBuilder { id: string; }
        model ShapeApiClient { id: string; }
        @route("/stores") interface Stores {
          @get list(): StoresRequestBuilder[];
          @post create(@body body: ShapeApiClient): void;
        }
      `,
      { "client-shape": "path" },
    );

    ok(has(files, "client/StoresRequestBuilder2.ts"));
    ok(has(files, "client/ShapeApiClient2.ts"));
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["client-module-name-collision", "client-module-name-collision"],
    );
  });

  it("names the root client ApiClient for a namespace ending in Api", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `
        import "@typespec/http";
        using Http;

        @service(#{ title: "Community API" })
        namespace MarketOnce.Community.Api;

        model Member { id: string; }
        @route("/members") interface Members { @get list(): Member[]; }
      `,
      { "client-shape": "path", "client-style": "both" },
    );

    ok(has(files, "client/runtime.ts"));
    ok(has(files, "client/runtimeRx.ts"));
    ok(
      file(files, "client/ApiClient.ts").includes(
        "export class ApiClient extends RootClient {",
      ),
    );
    ok(
      file(files, "client/ApiObservableClient.ts").includes(
        "export class ApiObservableClient extends ",
      ),
    );
    deepStrictEqual(emitterDiagnostics(diagnostics), []);
  });

  it("numbers builder classes whose names differ only in case", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model W { id: string; }
        @route("/ab/c") interface One { @get read(): W; }
        @route("/a/bc") interface Two { @get read(): W; }
      `,
      { "client-shape": "path" },
    );

    ok(has(files, "client/AbCRequestBuilder.ts"));
    ok(has(files, "client/ABcRequestBuilder2.ts"));
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["client-module-name-collision"],
    );
  });

  it("renames a by<Param> parameter that would shadow the builder it creates", async () => {
    const files = await emit(
      `${HEADER}
        model W { id: string; }
        @route("/") interface Root { @route("{ItemRequestBuilder}") @get read(@path ItemRequestBuilder: string): W; }
      `,
      { "client-shape": "path" },
    );

    ok(
      file(files, "client/ShapeApiClient.ts").includes(
        "byItemRequestBuilder(ItemRequestBuilderParam: string): ItemRequestBuilder {",
      ),
    );
  });

  it("aliases imports that a model shadows", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model RequestOptions { id: string; }
        model RequestBuilder { id: string; }
        model StoresEndpoints { id: string; }
        model Promise { id: string; }
        @route("/stores") interface Stores {
          @get list(): RequestOptions[];
          @post create(@body body: RequestBuilder): StoresEndpoints;
          @put replace(@body body: Promise): Promise;
        }
      `,
      { "client-shape": "path" },
    );

    const stores = file(files, "client/StoresRequestBuilder.ts");
    ok(
      stores.includes(
        'import { RequestBuilder as ClientRequestBuilder } from "./RequestBuilder.js";',
      ),
    );
    ok(
      stores.includes(
        'import type { RequestOptions as ClientRequestOptions } from "./runtime.js";',
      ),
    );
    ok(
      stores.includes(
        'import { StoresEndpoints as ClientStoresEndpoints } from "../endpoints/StoresEndpoints.js";',
      ),
    );
    ok(stores.includes("Promise as PromiseModel"));
    ok(
      stores.includes(
        "export class StoresRequestBuilder extends ClientRequestBuilder {",
      ),
    );
    ok(
      emitterDiagnostics(diagnostics).every(
        (d) => d.code === "generated-export-name-collision",
      ),
    );
  });
});

// ─── Type-checking ────────────────────────────────────────────────────────────

/** A structural stand-in for the slice of `rxjs` the Observable flavor uses. */
const RXJS_STUB = `export declare class Subscriber<T> {
  readonly closed: boolean;
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
  const dir = await mkdtemp(join(tmpdir(), "tsp-shape-"));
  for (const [key, content] of Object.entries(results)) {
    const relative = key
      .replace(/^.*?tsp-output[\\/]?/, "")
      .replace(/^[\\/]+/, "");
    await mkdir(dirname(join(dir, relative)), { recursive: true });
    await writeFile(join(dir, relative), content);
  }
  return dir;
}

/**
 * Emits a spec and type-checks it with the package's own tsconfig.json, plus
 * an optional probe file that uses the generated API.
 */
async function typeCheck(
  code: string,
  options: EmitterOptions,
  probe?: string,
): Promise<string[]> {
  const [results] = await emitWithDiagnostics(code, options);
  const dir = await materialize(results);
  try {
    await mkdir(join(dir, "stubs"), { recursive: true });
    await writeFile(join(dir, "stubs", "rxjs.d.ts"), RXJS_STUB);
    if (probe) await writeFile(join(dir, "probe.ts"), probe);
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

const TYPE_CHECK_TIMEOUT = 120_000;

describe("client-shape packages compile", () => {
  for (const shape of ["path", "interface"] as const) {
    for (const style of ["promise", "both"] as const) {
      it(
        `compiles the store API (${shape}, ${style})`,
        { timeout: TYPE_CHECK_TIMEOUT },
        async () => {
          const errors = await typeCheck(STORE_SPEC, {
            "client-shape": shape,
            "client-style": style,
          });

          deepStrictEqual(errors, []);
        },
      );
    }
  }

  it(
    "types a chained call the way it reads",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const errors = await typeCheck(
        STORE_SPEC,
        { "client-shape": "path" },
        `
        import { ShapeApiClient, type Store, type StoresItemRequestBuilder } from "./index.js";
        const api = new ShapeApiClient({ baseUrl: "https://example.com" });
        const store: Promise<Store> = api.stores.byStoreId("s").get();
        const kept: StoresItemRequestBuilder = api.stores.byStoreId("s").withOptions({ headers: { a: "b" } });
        const pet: Promise<Store> = kept.pets.byPetId("p").get(undefined, { "x-trace": "t" });
        const report: Promise<Store> = api.reports.get("a", "b");
        async function walk() { for await (const s of api.stores.getAll({ top: 5 })) { const id: string = s.id; void id; } }
        // @ts-expect-error a builder holds its path parameters, so the method takes none
        api.stores.byStoreId("s").get("s");
        void store; void pet; void report; void walk;
      `,
      );

      deepStrictEqual(errors, []);
    },
  );

  it(
    "compiles names that collide with the builder infrastructure",
    { timeout: TYPE_CHECK_TIMEOUT },
    async () => {
      const errors = await typeCheck(
        `${HEADER}
        model RequestOptions { id: string; }
        model RequestBuilder { id: string; }
        model RootClient { id: string; }
        model RxRequestBuilder { id: string; }
        model Observable { id: string; }
        model StoresEndpoints { id: string; }
        model Promise { id: string; }
        @route("/stores") interface Stores {
          @get list(): RequestOptions[];
          @post create(@body body: RequestBuilder): StoresEndpoints;
          @put replace(@body body: Promise): Observable;
          @patch update(@body body: RootClient): RxRequestBuilder;
        }
        @route("/rx") interface Rx { @get read(): void; }
      `,
        {
          "client-shape": "path",
          "client-style": "both",
          "client-name": "Root",
        },
      );

      deepStrictEqual(errors, []);
    },
  );
});

describe("request-builder infrastructure exports", () => {
  it("lists every top-level export of the static modules", async () => {
    const files = await emit(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "both",
    });

    for (const [name, declared] of [
      ["client/RequestBuilder.ts", REQUEST_BUILDER_EXPORTS],
      ["client/RequestBuilderRx.ts", RX_REQUEST_BUILDER_EXPORTS],
    ] as const) {
      const actual = [
        ...file(files, name).matchAll(
          /^export\s+(?:abstract\s+)?(interface|type|class|enum|const|function)\s+(\w+)/gm,
        ),
      ].map((m) => ({
        name: m[2],
        isType: m[1] !== "class" && m[1] !== "const" && m[1] !== "function",
      }));
      deepStrictEqual(actual, declared);
    }
  });

  it("aliases an infrastructure export that a model already names", async () => {
    const [files, diagnostics] = await emitWithDiagnostics(
      `${HEADER}
        model RootClient { id: string; }
        @route("/x") interface X { @get read(): RootClient; }
      `,
      { "client-shape": "path" },
    );

    ok(file(files, "index.ts").includes("RootClient as ClientRootClient"));
    deepStrictEqual(
      emitterDiagnostics(diagnostics).map((d) => d.code),
      ["generated-export-name-collision"],
    );
  });
});

// ─── Runtime behavior ─────────────────────────────────────────────────────────

/** A minimal rxjs `Observable`: cold, with teardown on unsubscribe. */
const OBSERVABLE_STUB = `export class Observable {
  constructor(subscribe) { this._subscribe = subscribe; }
  subscribe(observer) {
    let closed = false;
    const teardown = this._subscribe({
      get closed() { return closed; },
      next: (v) => { if (!closed) observer.next?.(v); },
      error: (e) => { if (!closed) { closed = true; observer.error?.(e); } },
      complete: () => { if (!closed) { closed = true; observer.complete?.(); } },
    });
    return { unsubscribe() { closed = true; teardown?.(); } };
  }
}
`;

const runtimeDirs: string[] = [];
after(async () => {
  for (const dir of runtimeDirs)
    await rm(dir, { recursive: true, force: true });
});

/**
 * Emits a spec, transpiles the package to JavaScript in a temp directory, and
 * imports its barrel.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(code: string, options: EmitterOptions): Promise<any> {
  const results = await emit(code, options);
  const dir = await mkdtemp(join(tmpdir(), "tsp-shape-run-"));
  runtimeDirs.push(dir);
  for (const [key, content] of Object.entries(results)) {
    const relative = key
      .replace(/^.*?tsp-output[\\/]?/, "")
      .replace(/^[\\/]+/, "");
    const target = join(dir, relative.replace(/\.ts$/, ".js"));
    await mkdir(dirname(target), { recursive: true });
    const source = relative.endsWith(".ts")
      ? ts.transpileModule(
          content.replace('from "rxjs"', 'from "../rxjs.js"'),
          {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              useDefineForClassFields: false,
            },
          },
        ).outputText
      : content;
    await writeFile(target, source);
  }
  await writeFile(join(dir, "rxjs.js"), OBSERVABLE_STUB);
  return import(pathToFileURL(join(dir, "index.js")).href);
}

/** A transport that records every request and answers with `respond`. */
function recorder(
  respond: (request: Request) => Response = () => json({ id: "s1" }),
) {
  const calls: Request[] = [];
  const transport = (request: Request) => {
    calls.push(request);
    return Promise.resolve(respond(request));
  };
  return Object.assign(transport, { calls });
}

/** A JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Client config that sends through `transport` without retries. */
function config(transport: (request: Request) => Promise<Response>) {
  return {
    baseUrl: "https://api.example.com",
    fetch: transport,
    retry: { maxAttempts: 1, baseDelayMs: 0 },
  };
}

describe("client-shape runtime", () => {
  it("sends each chain to the route it reads as", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));

    await api.stores.get({ top: 2 });
    await api.stores.post({ id: "n" });
    await api.stores.byStoreId("a/b").get();
    await api.stores.byStoreId("s").delete();
    await api.stores.byStoreId("s").pets.byPetId("p").get();
    await api.stores.byStoreId("s").pets.byPetId("p").put({ id: "p" });
    await api.stores.byStoreId("s").pets.byPetId("p").head();
    await api.reports.get("x", "y");
    await api.health.get();

    deepStrictEqual(
      transport.calls.map((r) => `${r.method} ${r.url}`),
      [
        "GET https://api.example.com/api/stores?top=2",
        "POST https://api.example.com/api/stores",
        "GET https://api.example.com/api/stores/a%2Fb",
        "DELETE https://api.example.com/api/stores/s",
        "GET https://api.example.com/api/stores/s/pets/p",
        "PUT https://api.example.com/api/stores/s/pets/p",
        "HEAD https://api.example.com/api/stores/s/pets/p",
        "GET https://api.example.com/api/reports/x-y",
        "GET https://api.example.com/api/",
      ],
    );
    strictEqual(await transport.calls[1].text(), '{"id":"n"}');
  });

  it("sends the same requests through the interface shape", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "interface",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));

    await api.stores.byStoreId("s").pets.byPetId("p").get();
    await api.reports.byFrom("x").byTo("y").get();

    deepStrictEqual(
      transport.calls.map((r) => r.url),
      [
        "https://api.example.com/api/stores/s/pets/p",
        "https://api.example.com/api/reports/x-y",
      ],
    );
  });

  it("adds withOptions headers under the call's own headers, down the chain only", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));

    const store = api.stores
      .byStoreId("s")
      .withOptions({ headers: { "X-Tenant": "t1", "X-Mode": "a" } });
    const pet = store.pets
      .byPetId("p")
      .withOptions({ headers: { "X-Pet": "1" } });
    await pet.get(
      {},
      { "x-trace": "declared" },
      { headers: { "X-Mode": "call" } },
    );
    await store.get();
    await api.stores.byStoreId("s").get();

    const [first, second, third] = transport.calls;
    strictEqual(first.headers.get("X-Tenant"), "t1");
    strictEqual(first.headers.get("X-Pet"), "1");
    strictEqual(first.headers.get("X-Mode"), "call");
    strictEqual(first.headers.get("x-trace"), "declared");
    strictEqual(second.headers.get("X-Tenant"), "t1");
    strictEqual(
      second.headers.get("X-Pet"),
      null,
      "A child's options never reach its parent",
    );
    strictEqual(
      third.headers.get("X-Tenant"),
      null,
      "A new chain starts with no options",
    );
  });

  it("aborts a request through a withOptions signal", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));
    const controller = new AbortController();
    controller.abort();

    await rejects(api.stores.withOptions({ signal: controller.signal }).get(), {
      name: "AbortError",
    });
    strictEqual(transport.calls.length, 0);
  });

  it("applies both a builder signal and a call signal", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));
    const builder = new AbortController();
    const call = new AbortController();
    call.abort();

    await rejects(
      api.stores
        .withOptions({ signal: builder.signal })
        .get(undefined, { signal: call.signal }),
      { name: "AbortError" },
    );
    await api.stores.withOptions({ signal: builder.signal }).get();
    strictEqual(transport.calls.length, 1);
  });

  it("walks every page, with the builder's options on each", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder((request) =>
      request.url.includes("page=2")
        ? json({ items: [{ id: "b" }] })
        : json({
            items: [{ id: "a" }],
            next: "https://api.example.com/api/stores?page=2",
          }),
    );
    const api = new ShapeApiClient(config(transport));

    const ids: string[] = [];
    for await (const store of api.stores
      .withOptions({ headers: { "X-Tenant": "t" } })
      .getAll()) {
      ids.push(store.id);
    }

    deepStrictEqual(ids, ["a", "b"]);
    deepStrictEqual(
      transport.calls.map((r) => r.headers.get("X-Tenant")),
      ["t", "t"],
    );
  });

  it("runs middleware registered on the root after a builder was created", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));
    const stores = api.stores;
    const seen: string[] = [];

    api.useMiddleware(
      (request: Request, next: (r: Request) => Promise<Response>) => {
        seen.push(request.url);
        return next(request);
      },
    );
    await stores.byStoreId("s").get();

    deepStrictEqual(seen, ["https://api.example.com/api/stores/s"]);
  });

  it("delivers the Observable flavor through the same chains", async () => {
    const { ShapeApiObservableClient } = await load(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "both",
    });
    const transport = recorder();
    const api = new ShapeApiObservableClient(config(transport));

    const value = await new Promise((resolve, reject) =>
      api.stores
        .byStoreId("s")
        .withOptions({ headers: { "X-Tenant": "t" } })
        .get()
        .subscribe({ next: resolve, error: reject }),
    );

    deepStrictEqual(value, { id: "s1" });
    strictEqual(transport.calls[0].url, "https://api.example.com/api/stores/s");
    strictEqual(transport.calls[0].headers.get("X-Tenant"), "t");
  });

  it("streams every page through the Observable flavor", async () => {
    const { ShapeApiObservableClient } = await load(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "observable",
    });
    const transport = recorder((request) =>
      request.url.includes("page=2")
        ? json({ items: [{ id: "b" }] })
        : json({ items: [{ id: "a" }], next: "/api/stores?page=2" }),
    );
    const api = new ShapeApiObservableClient(config(transport));

    const ids = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      api.stores.getAll().subscribe({
        next: (s: { id: string }) => seen.push(s.id),
        error: reject,
        complete: () => resolve(seen),
      });
    });

    deepStrictEqual(ids, ["a", "b"]);
  });

  it("sends every Observable verb", async () => {
    const { ShapeApiObservableClient } = await load(STORE_SPEC, {
      "client-shape": "path",
      "client-style": "observable",
    });
    const transport = recorder();
    const api = new ShapeApiObservableClient(config(transport));
    const run = (o: { subscribe(x: unknown): unknown }) =>
      new Promise((resolve, reject) =>
        o.subscribe({ next: resolve, error: reject }),
      );

    await run(api.stores.post({ id: "n" }));
    await run(api.stores.byStoreId("s").delete());
    await run(api.stores.byStoreId("s").pets.byPetId("p").put({ id: "p" }));
    await run(api.stores.byStoreId("s").pets.byPetId("p").head());

    deepStrictEqual(
      transport.calls.map((r) => r.method),
      ["POST", "DELETE", "PUT", "HEAD"],
    );
  });

  it("sends a patch and a header-cursor page through a builder", async () => {
    const { ShapeApiClient } = await load(
      `${HEADER}
        model W { id: string; }
        model Page { @pageItems items: W[]; @continuationToken next?: string; }
        @route("/w") interface Ws {
          @patch update(@body body: MergePatchUpdate<W>): W;
          @list @get list(@header("x-token") @continuationToken token?: string): Page;
        }
      `,
      { "client-shape": "path" },
    );
    const transport = recorder((request) =>
      request.method === "PATCH"
        ? json({ id: "w" })
        : request.headers.get("x-token") === "2"
          ? json({ items: [{ id: "b" }] })
          : json({ items: [{ id: "a" }], next: "2" }),
    );
    const api = new ShapeApiClient(config(transport));

    await api.w.patch({ id: "w" });
    const ids: string[] = [];
    for await (const w of api.w.getAll()) ids.push(w.id);

    strictEqual(
      transport.calls[0].headers.get("Content-Type"),
      "application/merge-patch+json",
    );
    deepStrictEqual(ids, ["a", "b"]);
  });

  it("lets a later header win whatever case either is spelled in", async () => {
    const { ShapeApiClient } = await load(STORE_SPEC, {
      "client-shape": "path",
    });
    const transport = recorder();
    const api = new ShapeApiClient(config(transport));
    const stores = api.stores
      .withOptions({ headers: { Authorization: "first" } })
      .withOptions({ headers: { authorization: "second" } });

    await stores.get();
    await stores.get(undefined, { headers: { AUTHORIZATION: "call" } });

    deepStrictEqual(
      transport.calls.map((r) => r.headers.get("Authorization")),
      ["second", "call"],
    );
  });

  it("starts a header cursor from the value added with withOptions", async () => {
    const { ShapeApiClient } = await load(
      `${HEADER}
        model W { id: string; }
        model Page { @pageItems items: W[]; }
        @route("/w") interface Ws {
          @list @get list(@header("x-skip") @offset skip?: int32): Page;
        }
      `,
      { "client-shape": "path" },
    );
    const transport = recorder((request) =>
      request.headers.get("x-skip") === "12"
        ? json({ items: [] })
        : json({ items: [{ id: "a" }, { id: "b" }] }),
    );
    const api = new ShapeApiClient(config(transport));
    const skipped = api.w.withOptions({ headers: { "X-Skip": "10" } });

    const ids: string[] = [];
    for await (const w of skipped.getAll()) ids.push(w.id);
    for await (const w of skipped.getAll(undefined, undefined, {
      headers: { "x-skip": "12" },
    })) {
      ids.push(w.id);
    }

    deepStrictEqual(ids, ["a", "b"]);
    deepStrictEqual(
      transport.calls.map((r) => r.headers.get("x-skip")),
      ["10", "12", "12"],
    );
  });
});

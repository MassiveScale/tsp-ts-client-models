import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { Diagnostic } from "@typespec/compiler";
import { emit, emitWithDiagnostics } from "./test-host.js";
import type { EmitterOptions } from "../src/lib.js";

const header = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  model Store { id: string; }
`;

/** Emits a `Stores` interface and returns its client files and diagnostics. */
async function emitStores(
  declarations: string,
  operations: string,
  options?: EmitterOptions,
): Promise<{
  client: string;
  observable: string;
  diagnostics: readonly Diagnostic[];
}> {
  const [out, diagnostics] = await emitWithDiagnostics(
    `${header}\n${declarations}\n@route("/stores") interface Stores {\n${operations}\n}`,
    options ?? { "client-style": "both" },
  );
  return {
    client: out["client/StoresClient.ts"],
    observable: out["client/StoresObservableClient.ts"],
    diagnostics,
  };
}

/** Returns the full text of the named method in a generated client. */
function methodText(client: string, name: string): string {
  const lines = client.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^  (async )?${name}\\(`).test(l),
  );
  ok(start >= 0, `Expected client method ${name}`);
  const end = lines.findIndex((l, i) => i > start && l === "  }");
  return lines.slice(start, end + 1).join("\n");
}

/** Whether the client declares a method with this name. */
function hasMethod(client: string, name: string): boolean {
  return new RegExp(`^  (async )?${name}\\(`, "m").test(client);
}

/** The diagnostics this emitter reported with the given short code. */
function ours(diagnostics: readonly Diagnostic[], code: string): Diagnostic[] {
  return diagnostics.filter(
    (d) => d.code === `@massivescale/tsp-ts-client-models/${code}`,
  );
}

/** Asserts exactly one `unsupported-paging-style` warning naming `reason`. */
function assertUnsupported(
  diagnostics: readonly Diagnostic[],
  reason: string,
): void {
  const warnings = ours(diagnostics, "unsupported-paging-style");
  strictEqual(warnings.length, 1, "Expected one unsupported-paging-style");
  ok(
    warnings[0].message.includes(reason),
    `Expected "${reason}" in: ${warnings[0].message}`,
  );
  strictEqual(warnings[0].severity, "warning");
}

const offsetPage = `model OffsetPage<T> { @pageItems items: T[]; total?: int32; }`;

describe("auto-paging methods", () => {
  describe("detection", () => {
    it("emits no paging method for an operation without @list", async () => {
      const { client } = await emitStores(
        `model Page<T> { items: T[]; }`,
        `@get list(@query skip?: int32): Page<Store>;`,
      );
      ok(hasMethod(client, "list"));
      ok(!hasMethod(client, "listAll"));
      ok(!client.includes("paginate"));
    });

    it("adds a paging method after the single-page method", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32): OffsetPage<Store>;`,
      );
      const lines = client.split("\n");
      const raw = lines.findIndex((l) => l.startsWith("  async list("));
      const paged = lines.findIndex((l) => l.startsWith("  listAll("));
      ok(raw >= 0 && paged > raw, "Expected listAll right after list");
    });

    it("takes the same arguments as the single-page method", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get @route("{region}") list(@path region: string, @query @offset skip?: int32, @header("x-tenant") tenant: string): OffsetPage<Store>;`,
      );
      const params = (name: string, prefix: string) =>
        methodText(client, name)
          .split("\n")[0]
          .replace(prefix, "")
          .replace(/\).*$/, "");
      strictEqual(
        params("listAll", "  listAll("),
        params("list", "  async list("),
      );
    });

    it("emits nothing for a @list operation when the client is disabled", async () => {
      const [out, diagnostics] = await emitWithDiagnostics(
        `${header}\nmodel Page<T> { @pageItems items: T[]; @pageSize size?: int32; }\n@route("/stores") interface Stores { @list @get list(@query @pageSize size?: int32): Page<Store>; }`,
        { "generate-http-client": false },
      );
      ok(!Object.keys(out).some((k) => k.includes("client/")));
      strictEqual(ours(diagnostics, "unsupported-paging-style").length, 0);
    });
  });

  describe("offset strategy", () => {
    it("seeds the counter from the parameter and advances by the item count", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32, @query @pageSize take?: int32 = 25): OffsetPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(
        text.includes(
          "listAll(query?: { skip?: number; take?: number; [key: string]: unknown }, options?: RequestOptions): AsyncGenerator<Store, void, undefined>",
        ),
      );
      ok(
        text.includes(
          "return this.paginate<OffsetPage<Store>, Store, number>(",
        ),
      );
      ok(
        text.includes(
          "(cursor, signal) => this.httpGet<OffsetPage<Store>>(StoresEndpoints.list(), { ...options, signal, query: { ...query, skip: cursor } })",
        ),
      );
      ok(text.includes("query?.skip ?? 0,"));
      ok(text.includes("(page) => page.items,"));
      ok(
        text.includes(
          "(_page, cursor, count) => (count === 0 ? undefined : cursor + count),",
        ),
      );
      ok(text.includes("options?.signal,"));
    });

    it("seeds from the parameter's declared default", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32 = 10): OffsetPage<Store>;`,
      );
      ok(methodText(client, "listAll").includes("query?.skip ?? 10,"));
    });

    it("keys a non-identifier wire name with quotes", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query("skip-count") @offset skip?: int32): OffsetPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(text.includes('query: { ...query, "skip-count": cursor }'));
      ok(text.includes('query?.["skip-count"] ?? 0,'));
    });

    it("reads and rewrites a header counter in the headers actually sent", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@header("x-skip") @offset skip?: int32): OffsetPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(
        text.includes(
          'headers: this.replaceHeader({ ...headers, ...options?.headers }, "x-skip", cursor)',
        ),
      );
      ok(
        text.includes(
          'Number(this.readHeader({ ...headers, ...options?.headers }, "x-skip") ?? 0),',
        ),
      );
    });

    it("resends the body of a POST list on every page", async () => {
      const { client } = await emitStores(
        `${offsetPage}\nmodel Filter { name?: string; }`,
        `@list @post list(@body filter: Filter, @query @offset skip?: int32): OffsetPage<Store>;`,
      );
      ok(
        methodText(client, "listAll").includes(
          "this.httpPost<OffsetPage<Store>>(StoresEndpoints.list(), body, { ...options, signal, query: { ...query, skip: cursor } })",
        ),
      );
    });
  });

  describe("pageIndex strategy", () => {
    it("advances the page index by one and seeds from its default", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @pageIndex page?: int32 = 1): OffsetPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(text.includes("query?.page ?? 1,"));
      ok(text.includes("query: { ...query, page: cursor }"));
      ok(text.includes("(page) => page.items,"));
      ok(
        text.includes(
          "(_page, cursor, count) => (count === 0 ? undefined : cursor + 1),",
        ),
      );
    });

    it("starts at zero when the page index has no default", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @pageIndex index?: int32): OffsetPage<Store>;`,
      );
      ok(methodText(client, "listAll").includes("query?.index ?? 0,"));
    });

    it("prefers offset when a page declares both counters", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32, @query @pageIndex index?: int32): OffsetPage<Store>;`,
      );
      ok(methodText(client, "listAll").includes("cursor + count"));
    });
  });

  describe("continuationToken strategy", () => {
    const tokenPage = `model TokenPage<T> { @pageItems items: T[]; @continuationToken nextToken?: string; }`;

    it("feeds each page's token back into the query", async () => {
      const { client } = await emitStores(
        tokenPage,
        `@list @get list(@query @continuationToken token?: string): TokenPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(
        text.includes(
          "return this.paginate<TokenPage<Store>, Store, string | undefined>(",
        ),
      );
      ok(text.includes("query: { ...query, token: cursor }"));
      ok(text.includes("query?.token ?? undefined,"));
      ok(text.includes("(page) => page.nextToken || undefined,"));
    });

    it("feeds a header token back into the headers actually sent", async () => {
      const { client } = await emitStores(
        tokenPage,
        `@list @get list(@header("x-token") @continuationToken token?: string): TokenPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(
        text.includes(
          'headers: this.replaceHeader({ ...headers, ...options?.headers }, "x-token", cursor)',
        ),
      );
      ok(
        text.includes(
          'this.readHeader({ ...headers, ...options?.headers }, "x-token") as string | undefined,',
        ),
      );
    });

    it("narrows a nullable request token to the cursor type", async () => {
      const { client, diagnostics } = await emitStores(
        tokenPage,
        `@list @get list(@query @continuationToken token?: string | null): TokenPage<Store>;`,
      );
      strictEqual(ours(diagnostics, "unsupported-paging-style").length, 0);
      ok(methodText(client, "listAll").includes("query?.token ?? undefined,"));
    });

    it("reads a token whose JSON name differs from its declared name", async () => {
      const { client } = await emitStores(
        `model TokenPage<T> { @pageItems @encodedName("application/json", "value") items: T[]; @continuationToken @encodedName("application/json", "@odata.next") nextToken?: string | null; }`,
        `@list @get list(@query @continuationToken token?: string): TokenPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(text.includes("(page) => page.value,"));
      ok(text.includes('(page) => page["@odata.next"] || undefined,'));
    });

    it("prefers a continuation token over an offset", async () => {
      const { client } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @continuationToken nextToken?: string; }`,
        `@list @get list(@query @continuationToken token?: string, @query @offset skip?: int32): Page<Store>;`,
      );
      ok(methodText(client, "listAll").includes("string | undefined"));
    });
  });

  describe("nextLink strategy", () => {
    const linkPage = `model LinkPage<T> { @pageItems value: T[]; @nextLink nextLink?: url; }`;

    it("requests the first page normally and then follows each link", async () => {
      const { client } = await emitStores(
        linkPage,
        `@list @get list(@query top?: int32, @header("x-tenant") tenant?: string): LinkPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(
        text.includes(
          "return this.paginate<LinkPage<Store>, Store, string | undefined>(",
        ),
      );
      ok(text.includes("cursor === undefined"));
      ok(
        text.includes(
          "? this.httpGet<LinkPage<Store>>(StoresEndpoints.list(), { ...options, signal, query, headers: { ...headers, ...options?.headers } })",
        ),
      );
      // The link carries the query; headers are replayed.
      ok(
        text.includes(
          ": this.httpGetNextLink<LinkPage<Store>>(cursor, { ...options, signal, headers: { ...headers, ...options?.headers } })",
        ),
      );
      ok(text.includes("      undefined,"));
      ok(text.includes("(page) => page.nextLink || undefined,"));
    });

    it("follows links without replaying query options such as explode", async () => {
      const { client } = await emitStores(
        linkPage,
        `@list @get list(@query(#{ explode: true }) tags?: string[]): LinkPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(text.includes('query, explode: ["tags"] })'));
      ok(
        text.includes(
          "this.httpGetNextLink<LinkPage<Store>>(cursor, { ...options, signal })",
        ),
      );
    });

    it("accepts a nullable string link", async () => {
      const { client, diagnostics } = await emitStores(
        `model LinkPage<T> { @pageItems value: T[]; @nextLink next: string | null; }`,
        `@list @get list(): LinkPage<Store>;`,
      );
      strictEqual(ours(diagnostics, "unsupported-paging-style").length, 0);
      ok(
        methodText(client, "listAll").includes(
          "(page) => page.next || undefined,",
        ),
      );
    });

    it("prefers a next link over a continuation token", async () => {
      const { client } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @nextLink next?: url; @continuationToken nextToken?: string; }`,
        `@list @get list(@query @continuationToken token?: string): Page<Store>;`,
      );
      ok(methodText(client, "listAll").includes("httpGetNextLink"));
    });

    it("notes the same-origin rule in the method's doc", async () => {
      const { client } = await emitStores(
        linkPage,
        `@list @get list(): LinkPage<Store>;`,
      );
      ok(
        client.includes(
          "Next-page links are followed only on the base URL's origin.",
        ),
      );
    });
  });

  describe("item types", () => {
    it("imports an enum item type that only the paging method names", async () => {
      const { client, observable } = await emitStores(
        `enum Kind { a, b }\nmodel Page { @pageItems items: Kind[]; @nextLink next?: url; }`,
        `@list @get list(): Page;`,
      );
      ok(client.includes('import type { Page, Kind } from "../models.js";'));
      ok(
        observable.includes('import type { Page, Kind } from "../models.js";'),
      );
      ok(
        methodText(client, "listAll").includes(
          "AsyncGenerator<Kind, void, undefined>",
        ),
      );
    });
  });

  describe("Observable flavor", () => {
    it("streams items through paginate$", async () => {
      const { observable } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32): OffsetPage<Store>;`,
      );
      const text = methodText(observable, "listAll");
      ok(
        text.includes(
          "listAll(query?: { skip?: number; [key: string]: unknown }, options?: RequestOptions): Observable<Store>",
        ),
      );
      ok(
        text.includes(
          "return this.paginate$<OffsetPage<Store>, Store, number>(",
        ),
      );
      // Each page goes through the Promise transport; paginate$ owns the Observable.
      ok(text.includes("this.httpGet<OffsetPage<Store>>("));
    });

    it("uses the aliased Observable when a model takes its name", async () => {
      const { observable } = await emitStores(
        `${offsetPage}\nmodel Observable { id: string; }`,
        `@list @get list(@query @offset skip?: int32): OffsetPage<Observable>;`,
        { "client-style": "observable" },
      );
      ok(
        methodText(observable, "listAll").includes(
          "): ClientObservable<Observable> {",
        ),
      );
    });
  });

  describe("documentation", () => {
    it("leads with the operation's own doc", async () => {
      const { client, observable } = await emitStores(
        offsetPage,
        `/** Lists the stores. */ @list @get list(@query @offset skip?: int32): OffsetPage<Store>;`,
      );
      ok(
        client.includes(
          "   * Lists the stores.\n   * \n   * Walks every page of `list` and yields each item in turn.",
        ),
      );
      ok(
        observable.includes(
          "   * Lists the stores.\n   * \n   * Walks every page of `list`, emitting each item as its page arrives, then completes.",
        ),
      );
    });

    it("describes the walk when the operation has no doc", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32): OffsetPage<Store>;`,
      );
      ok(
        client.includes(
          "  /** Walks every page of `list` and yields each item in turn.",
        ),
      );
    });
  });

  describe("naming", () => {
    it("steps aside for a sibling operation already named {method}All", async () => {
      const { client, diagnostics } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32): OffsetPage<Store>;
         @get @route("all") listAll(): Store[];`,
      );
      ok(hasMethod(client, "listAll"));
      ok(methodText(client, "listAll2").includes("this.paginate<"));
      const warnings = ours(diagnostics, "paging-method-name-collision");
      strictEqual(warnings.length, 1);
      ok(warnings[0].message.includes('"listAll"'));
      ok(warnings[0].message.includes('"listAll2"'));
    });

    it("reports a name collision once even when both flavors are emitted", async () => {
      const { diagnostics } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset skip?: int32): OffsetPage<Store>;
         @get @route("all") listAll(): Store[];`,
        { "client-style": "both" },
      );
      strictEqual(ours(diagnostics, "paging-method-name-collision").length, 1);
    });

    it("builds on the renamed single-page method of a reserved name", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get paginate(@query @offset skip?: int32): OffsetPage<Store>;`,
      );
      ok(hasMethod(client, "paginateOperation"));
      ok(hasMethod(client, "paginateOperationAll"));
    });

    it("reserves the paging helpers inherited from the base classes", async () => {
      const [, diagnostics] = await emitWithDiagnostics(
        `${header}\n@route("/stores") interface Stores {
          @get @route("a") paginate(): Store[];
          @get @route("b") httpGetNextLink(): Store[];
          @get @route("c") \`paginate$\`(): Store[];
        }`,
        { "client-style": "observable" },
      );
      strictEqual(ours(diagnostics, "reserved-client-method-name").length, 3);
    });

    it("keeps closure names clear of path arguments", async () => {
      const { client } = await emitStores(
        offsetPage,
        `@list @get @route("{cursor}/{signal}/{count}") list(@path cursor: string, @path signal: string, @path count: string, @query @offset skip?: int32): OffsetPage<Store>;`,
      );
      const text = methodText(client, "listAll");
      ok(text.includes("(cursor2, signal2) =>"));
      ok(text.includes("StoresEndpoints.list(cursor, signal, count)"));
      ok(text.includes("signal: signal2, query: { ...query, skip: cursor2 }"));
      ok(
        text.includes(
          "(_page, cursor2, count2) => (count2 === 0 ? undefined : cursor2 + count2)",
        ),
      );
    });
  });

  describe("unsupported paging", () => {
    it("warns when no forward signal is declared", async () => {
      const { client, diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @prevLink prev?: url; }`,
        `@list @get list(@query @pageSize size?: int32): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "no forward paging signal");
      ok(hasMethod(client, "list"));
      ok(!hasMethod(client, "listAll"));
    });

    it("warns once even when both flavors are emitted", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; }`,
        `@list @get list(): Page<Store>;`,
        { "client-style": "both" },
      );
      strictEqual(ours(diagnostics, "unsupported-paging-style").length, 1);
    });

    it("warns on items nested below the response body", async () => {
      const { diagnostics } = await emitStores(
        `model Inner<T> { @pageItems items: T[]; } model Page<T> { data: Inner<T>; @nextLink next?: url; }`,
        `@list @get list(): Page<Store>;`,
      );
      assertUnsupported(
        diagnostics,
        "not a top-level property of the response body",
      );
    });

    it("warns on a page wrapped in an explicit body property", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @nextLink next?: url; }`,
        `@list @get list(): { @header("x-total") total: int32; @body page: Page<Store> };`,
      );
      assertUnsupported(
        diagnostics,
        "not a top-level property of the response body",
      );
    });

    it("warns on a next link sent as a response header", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @header("x-next") @nextLink next?: string; }`,
        `@list @get list(): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "a response header");
    });

    it("warns on a continuation token sent as a response header", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @header("x-next") @continuationToken next?: string; }`,
        `@list @get list(@query @continuationToken token?: string): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "a response header");
    });

    it("warns on a next link that is not a string", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @nextLink next?: int32; }`,
        `@list @get list(): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "a @nextLink that is not a string");
    });

    it("warns on a next link typed as a model", async () => {
      const { diagnostics } = await emitStores(
        `model Link { href: string; } model Page<T> { @pageItems items: T[]; @nextLink next?: Link; }`,
        `@list @get list(): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "a @nextLink that is not a string");
    });

    it("warns on a next link that may be one of several types", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @nextLink next?: string | int32; }`,
        `@list @get list(): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "a @nextLink that is not a string");
    });

    it("warns on a continuation token with no request parameter", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @continuationToken next?: string; }`,
        `@list @get list(): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "no query or header parameter");
    });

    it("warns on a continuation token sent back in the body", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @continuationToken next?: string; }`,
        `@list @post list(@body body: { @continuationToken token?: string }): Page<Store>;`,
      );
      assertUnsupported(diagnostics, "no query or header parameter");
    });

    it("warns on a continuation token that is not a string", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @continuationToken next?: int32; }`,
        `@list @get list(@query @continuationToken token?: int32): Page<Store>;`,
      );
      assertUnsupported(
        diagnostics,
        "not a string on both the request and the response",
      );
    });

    it("warns on an offset that is not a query or header parameter", async () => {
      const { diagnostics } = await emitStores(
        offsetPage,
        `@list @post list(@body body: { @offset skip?: int32 }): OffsetPage<Store>;`,
      );
      assertUnsupported(
        diagnostics,
        "an @offset that is not a query or header parameter",
      );
    });

    it("warns on an offset encoded as a string", async () => {
      const { diagnostics } = await emitStores(
        offsetPage,
        `@list @get list(@query @offset @encode(string) skip?: int64): OffsetPage<Store>;`,
      );
      assertUnsupported(
        diagnostics,
        "an @offset parameter that is not a number",
      );
    });

    it("warns on a page index that is not a number", async () => {
      const { diagnostics } = await emitStores(
        offsetPage,
        `@list @get list(@query @pageIndex @encode(string) page?: int32): OffsetPage<Store>;`,
      );
      assertUnsupported(
        diagnostics,
        "a @pageIndex parameter that is not a number",
      );
    });

    it("warns on a page that is not a JSON body", async () => {
      const { diagnostics } = await emitStores(
        `model Page<T> { @pageItems items: T[]; @nextLink next?: url; }`,
        `@list @get list(): { @header contentType: "application/xml"; @body page: Page<Store> };`,
      );
      assertUnsupported(
        diagnostics,
        "no success response with a JSON object body",
      );
    });

    it("warns on a page returned only for a non-success status", async () => {
      const { diagnostics } = await emitStores(
        "",
        `@list @get list(): { @statusCode _: 404; @pageItems items: Store[]; @nextLink next?: url };`,
      );
      assertUnsupported(
        diagnostics,
        "no success response with a JSON object body",
      );
    });
  });

  describe("versioning", () => {
    it("emits the paging method in each version it exists in", async () => {
      const out = await emit(
        `
        import "@typespec/http";
        import "@typespec/versioning";
        using Http;
        using Versioning;

        @service(#{ title: "Test API" })
        @versioned(Versions)
        namespace TestApi;

        enum Versions { v1, v2 }

        model Store { id: string; }
        model Page<T> { @pageItems items: T[]; @nextLink next?: url; }

        @route("/stores")
        interface Stores {
          @list @get list(): Page<Store>;
          @added(Versions.v2) @list @get @route("archived") archived(): Page<Store>;
        }
      `,
        { "all-versions": true },
      );
      const v1 = out["v1/client/StoresClient.ts"];
      const v2 = out["v2/client/StoresClient.ts"];
      ok(hasMethod(v1, "listAll"));
      ok(!hasMethod(v1, "archivedAll"));
      ok(hasMethod(v2, "listAll"));
      ok(hasMethod(v2, "archivedAll"));
    });
  });
});

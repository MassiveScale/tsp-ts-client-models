import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./test-host.js";
import { formatPropertyKey, toIdentifier } from "../src/emitter.js";

const header = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  model Widget { id: string; name: string; }
`;

/** Emits a `Widgets` interface and returns its endpoints and client files. */
async function emitWidgets(
  operations: string,
): Promise<{ endpoints: string; client: string; models?: string }> {
  const out = await emit(
    `${header}\n@route("/widgets") interface Widgets {\n${operations}\n}`,
  );
  return {
    endpoints: out["endpoints/WidgetsEndpoints.ts"],
    client: out["client/WidgetsClient.ts"],
    models: out["models.ts"],
  };
}

/** Returns the line declaring the given client method. */
function methodLine(client: string, name: string): string {
  const line = client
    .split("\n")
    .find((l) => l.trimStart().startsWith(`async ${name}(`));
  ok(line, `Expected client method ${name}`);
  return line;
}

/** Returns the `return …` line of the given client method. */
function callLine(client: string, name: string): string {
  const lines = client.split("\n");
  const index = lines.findIndex((l) =>
    l.trimStart().startsWith(`async ${name}(`),
  );
  ok(index >= 0, `Expected client method ${name}`);
  return lines[index + 1];
}

describe("path parameters", () => {
  it("fills the route token from the parameter's wire name", async () => {
    const { endpoints, client } = await emitWidgets(
      `@get @route("{widget-id}") read(@path("widget-id") widgetId: string): Widget;`,
    );
    ok(
      endpoints.includes(
        "read: (widgetId: string) => `/api/widgets/${encodeURIComponent(String(widgetId))}`",
      ),
    );
    ok(callLine(client, "read").includes("WidgetsEndpoints.read(widgetId)"));
  });

  it("keeps reserved characters for allowReserved parameters", async () => {
    const { endpoints } = await emitWidgets(
      `@get @route("files/{+path}") file(@path path: string): void;`,
    );
    ok(endpoints.includes("${encodeURI(String(path))}"));
  });

  it("omits an optional path-style parameter and its slash when absent", async () => {
    const { endpoints, client } = await emitWidgets(
      `@get @route("{id}") read(@path id: string, @path tail?: string): void;`,
    );
    ok(
      endpoints.includes(
        '${tail === undefined ? "" : "/" + encodeURIComponent(String(tail))}',
      ),
    );
    ok(endpoints.includes("read: (id: string, tail?: string) =>"));
    ok(methodLine(client, "read").includes("id: string, tail?: string"));
  });

  it("orders required path arguments before optional ones", async () => {
    const { endpoints } = await emitWidgets(
      `@get @route("x{first}/{second}") read(@path first?: string, @path second: string): void;`,
    );
    ok(endpoints.includes("read: (second: string, first?: string) =>"));
  });

  it("renames path arguments that are reserved words or clash with method parameters", async () => {
    const { endpoints, client } = await emitWidgets(
      `@get @route("{default}/{query}") read(@path("default") \`default\`: string, @path query: string): void;`,
    );
    ok(endpoints.includes("read: (defaultParam: string, queryParam: string)"));
    ok(
      methodLine(client, "read").includes(
        "defaultParam: string, queryParam: string, query?:",
      ),
    );
  });
});

describe("query parameters", () => {
  it("keys declared query parameters by their wire names", async () => {
    const { client } = await emitWidgets(
      `@get list(@query("api-version") apiVersion: string, @query top?: int32): Widget[];`,
    );
    ok(
      methodLine(client, "list").includes(
        'query: { "api-version": string; top?: number; [key: string]: unknown }',
      ),
    );
  });

  it("makes query required when a declared query parameter is required", async () => {
    const { client } = await emitWidgets(
      `@get list(@query filter: string): Widget[];`,
    );
    ok(methodLine(client, "list").includes("query: { filter: string;"));
  });

  it("keeps query optional when every declared parameter is optional", async () => {
    const { client } = await emitWidgets(
      `@get list(@query filter?: string): Widget[];`,
    );
    ok(methodLine(client, "list").includes("query?: { filter?: string;"));
  });

  it("passes the wire names of exploded array parameters", async () => {
    const { client } = await emitWidgets(
      `@get list(@query(#{ explode: true }) tags?: string[], @query ids?: string[]): Widget[];`,
    );
    ok(callLine(client, "list").includes('explode: ["tags"]'));
  });
});

describe("header parameters", () => {
  it("adds a headers argument keyed by wire name and sends it", async () => {
    const { client } = await emitWidgets(
      `@get read(@header("x-tenant") tenant: string, @header ifMatch?: string): Widget;`,
    );
    ok(
      methodLine(client, "read").includes(
        'headers: { "x-tenant": string; "if-match"?: string }',
      ),
    );
    ok(
      callLine(client, "read").includes(
        "headers: { ...headers, ...options?.headers }",
      ),
    );
  });

  it("makes headers optional when every header is optional", async () => {
    const { client } = await emitWidgets(
      `@get read(@header ifMatch?: string): Widget;`,
    );
    ok(
      methodLine(client, "read").includes('headers?: { "if-match"?: string }'),
    );
  });

  it("types an optional argument followed by a required one as T | undefined", async () => {
    const { client } = await emitWidgets(
      `@get read(@header("x-tenant") tenant: string): Widget;`,
    );
    ok(
      methodLine(client, "read").includes(
        "query: Record<string, unknown> | undefined, headers: {",
      ),
    );
  });

  it("does not offer Content-Type as a header argument", async () => {
    const { client } = await emitWidgets(
      `@post upload(@header contentType: "text/plain", @body data: string): void;`,
    );
    ok(!methodLine(client, "upload").includes("headers"));
  });

  it("adds no headers argument when there are no header parameters", async () => {
    const { client } = await emitWidgets(`@get list(): Widget[];`);
    ok(!methodLine(client, "list").includes("headers"));
    strictEqual(
      callLine(client, "list").trim(),
      "return this.httpGet<Widget[]>(WidgetsEndpoints.list(), { ...options, query });",
    );
  });
});

describe("request bodies", () => {
  it("types a spread body as an inline object", async () => {
    const { client } = await emitWidgets(
      `@post create(name: string, size?: int32): Widget;`,
    );
    ok(
      methodLine(client, "create").includes(
        "body: { name: string; size?: number }",
      ),
    );
    ok(callLine(client, "create").includes(", body, "));
  });

  it("leaves metadata out of an inline body", async () => {
    const { client } = await emitWidgets(
      `@post create(@header("x-tenant") tenant: string, name: string): Widget;`,
    );
    ok(methodLine(client, "create").includes("body: { name: string }"));
  });

  it("types an array body without importing a nonexistent Array model", async () => {
    const { client } = await emitWidgets(
      `@post create(@body items: Widget[]): void;`,
    );
    ok(methodLine(client, "create").includes("body: Widget[]"));
    ok(client.includes("import type { Widget } from"));
  });

  it("types a numeric scalar body, which TypeSpec sends as text", async () => {
    const { client } = await emitWidgets(
      `@post resize(@body size: int32): void;`,
    );
    ok(methodLine(client, "resize").includes("body: number"));
    ok(callLine(client, "resize").includes('contentType: "text/plain"'));
  });

  it("sends a JSON array body with no explicit media type", async () => {
    const { client } = await emitWidgets(
      `@post tag(@body tags: string[]): void;`,
    );
    ok(methodLine(client, "tag").includes("body: string[]"));
    ok(!callLine(client, "tag").includes("contentType"));
  });

  it("sends a string body as text/plain, as TypeSpec declares it", async () => {
    const { client } = await emitWidgets(
      `@post rename(@body name: string): void;`,
    );
    ok(methodLine(client, "rename").includes("body: string"));
    ok(callLine(client, "rename").includes('contentType: "text/plain"'));
  });

  it("sends a text body with its media type", async () => {
    const { client } = await emitWidgets(
      `@post upload(@header contentType: "text/plain", @body data: string): void;`,
    );
    ok(methodLine(client, "upload").includes("body: string"));
    ok(callLine(client, "upload").includes('contentType: "text/plain"'));
  });

  it("accepts binary data for a bytes body", async () => {
    const { client } = await emitWidgets(
      `@put upload(@header contentType: "application/octet-stream", @body data: bytes): void;`,
    );
    ok(
      methodLine(client, "upload").includes(
        "body: Blob | ArrayBuffer | Uint8Array",
      ),
    );
    ok(
      callLine(client, "upload").includes(
        'contentType: "application/octet-stream"',
      ),
    );
  });

  it("accepts FormData for a multipart body", async () => {
    const { client } = await emitWidgets(
      `@post upload(@header contentType: "multipart/form-data", @multipartBody body: { name: HttpPart<string> }): void;`,
    );
    ok(methodLine(client, "upload").includes("body: FormData"));
    ok(!callLine(client, "upload").includes("contentType"));
  });

  it("accepts a Blob for a file body", async () => {
    const { client } = await emitWidgets(
      `@put upload(@body file: File): void;`,
    );
    ok(methodLine(client, "upload").includes("body: Blob"));
  });

  it("sends a merge-patch body with its media type", async () => {
    const { client } = await emitWidgets(
      `@patch update(@path id: string, @body patch: MergePatchUpdate<Widget>): Widget;`,
    );
    ok(
      callLine(client, "update").includes(
        'contentType: "application/merge-patch+json"',
      ),
    );
  });

  it("marks an optional body as optional", async () => {
    const { client } = await emitWidgets(
      `@post create(@body body?: Widget): Widget;`,
    );
    ok(methodLine(client, "create").includes("body?: Widget"));
  });
});

describe("response formats", () => {
  it("reads a JSON response without a format hint", async () => {
    const { client } = await emitWidgets(`@get list(): Widget[];`);
    ok(!callLine(client, "list").includes("responseFormat"));
  });

  it("reads a text response as text", async () => {
    const { client } = await emitWidgets(
      `@get @route("readme") readme(): { @header contentType: "text/plain"; @body body: string };`,
    );
    ok(methodLine(client, "readme").includes("Promise<string>"));
    ok(callLine(client, "readme").includes('responseFormat: "text"'));
  });

  it("reads a bytes response as binary", async () => {
    const { client } = await emitWidgets(
      `@get @route("raw") raw(): { @header contentType: "application/octet-stream"; @body body: bytes };`,
    );
    ok(methodLine(client, "raw").includes("Promise<Uint8Array>"));
    ok(callLine(client, "raw").includes('responseFormat: "binary"'));
  });

  it("resolves an operation with no response body to void", async () => {
    const { client } = await emitWidgets(
      `@post create(@body body: Widget): { @statusCode _: 201 };`,
    );
    ok(methodLine(client, "create").includes("Promise<void>"));
  });
});

describe("formatPropertyKey", () => {
  it("leaves a valid identifier bare", () =>
    strictEqual(formatPropertyKey("widgetId"), "widgetId"));
  it("leaves a reserved word bare, which is valid as a key", () =>
    strictEqual(formatPropertyKey("default"), "default"));
  it("quotes a name with a dash", () =>
    strictEqual(formatPropertyKey("x-ms-id"), '"x-ms-id"'));
  it("quotes a name starting with a digit", () =>
    strictEqual(formatPropertyKey("1st"), '"1st"'));
});

describe("toIdentifier", () => {
  it("camel-cases across invalid characters", () =>
    strictEqual(toIdentifier("widget-id", new Set()), "widgetId"));
  it("prefixes a leading digit", () =>
    strictEqual(toIdentifier("1st", new Set()), "_1st"));
  it("suffixes a reserved word", () =>
    strictEqual(toIdentifier("class", new Set()), "classParam"));
  it("suffixes a taken name and numbers further clashes", () => {
    const taken = new Set(["id", "idParam"]);
    strictEqual(toIdentifier("id", taken), "idParam2");
    ok(taken.has("idParam2"), "Expected the result to be claimed");
  });
  it("falls back to an underscore for a name with no valid characters", () =>
    strictEqual(toIdentifier("--", new Set()), "_"));
});

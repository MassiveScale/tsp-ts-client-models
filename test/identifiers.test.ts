import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./test-host.js";
import { escapeDocText } from "../src/renderer.js";

/** Emits `code` inside a service with one interface that returns `Widget`. */
async function emitModels(code: string): Promise<string> {
  const out = await emit(`
    import "@typespec/http";
    using Http;

    @service(#{ title: "Test API" })
    namespace TestApi;

    ${code}

    @route("/widgets") interface Widgets { @get list(): Widget[]; }
  `);
  return out["models.ts"];
}

describe("enum values", () => {
  it("emits numeric values unquoted", async () => {
    const models = await emitModels(`
      enum Priority { Low: 1, High: 10 }
      model Widget { priority: Priority; }
    `);
    ok(models.includes("Low = 1,"), models);
    ok(models.includes("High = 10,"));
  });

  it("emits string values single-quoted", async () => {
    const models = await emitModels(`
      enum Color { Red: "red", Blue }
      model Widget { color: Color; }
    `);
    ok(models.includes("Red = 'red',"));
    ok(models.includes("Blue = 'Blue',"));
  });

  it("escapes quotes and backslashes in string values", async () => {
    const models = await emitModels(`
      enum Phrase { Its: "it's", Path: "a\\\\b" }
      model Widget { phrase: Phrase; }
    `);
    ok(models.includes("Its = 'it\\'s',"), models);
    ok(models.includes("Path = 'a\\\\b',"), models);
  });

  it("quotes member names that are not identifiers", async () => {
    const models = await emitModels(`
      enum Kind { \`x-y\`: "x-y", \`1st\`: "first" }
      model Widget { kind: Kind; }
    `);
    ok(models.includes(`"x-y" = 'x-y',`), models);
    ok(models.includes(`"1st" = 'first',`), models);
  });
});

describe("property names", () => {
  it("quotes property names that are not identifiers", async () => {
    const models = await emitModels(`
      model Widget { \`x-ms-id\`: string; \`1abc\`?: int32; plain: string; }
    `);
    ok(models.includes(`"x-ms-id": string;`), models);
    ok(models.includes(`"1abc"?: number;`), models);
    ok(models.includes("plain: string;"));
  });

  it("quotes property names in synthesized request types", async () => {
    const out = await emit(`
      import "@typespec/http";
      using Http;
      @service(#{ title: "Test API" }) namespace TestApi;
      model Widget { @visibility(Lifecycle.Read) id: string; \`display-name\`: string; }
      @route("/widgets") interface Widgets { @post create(@body body: Widget): Widget; }
    `);
    const request = out["models.ts"].slice(
      out["models.ts"].indexOf("interface WidgetPostRequest"),
    );
    ok(request.includes(`"display-name": string;`), request);
  });
});

describe("doc comments", () => {
  it("escapes a comment terminator inside doc text", async () => {
    const models = await emitModels(`
      @doc("Matches a/*/b */ paths")
      model Widget { @doc("Ends with */") id: string; }
    `);
    ok(models.includes("/** Matches a/*\\/b *\\/ paths */"), models);
    ok(models.includes("/** Ends with *\\/ */"), models);
  });

  it("escapeDocText leaves text without a terminator unchanged", () =>
    strictEqual(escapeDocText("a * b / c"), "a * b / c"));

  it("escapeDocText escapes every terminator", () =>
    strictEqual(escapeDocText("*/x*/"), "*\\/x*\\/"));
});

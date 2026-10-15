import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./test-host.js";

const header = `
  import "@typespec/http";
  import "@typespec/versioning";
  using Http;
  using Versioning;

  @service(#{ title: "Test API" })
  @versioned(Versions)
  namespace TestApi;

  enum Versions { v1: "v1", v2: "v2" }
`;

/** Emits every version and returns each version's files keyed by path. */
async function emitAll(code: string): Promise<Record<string, string>> {
  return emit(header + code, { "all-versions": true });
}

/** Returns the body of `export interface <name> { … }` from a models file. */
function interfaceBody(models: string, name: string): string {
  const match = models.match(
    new RegExp(`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`),
  );
  ok(match, `Expected interface ${name}`);
  return match[1];
}

describe("versioned model projection", () => {
  it("includes a property only in versions where it exists", async () => {
    const out = await emitAll(`
      model Widget {
        id: string;
        @added(Versions.v2) added: string;
        @removed(Versions.v2) removed: string;
      }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `);
    const v1 = interfaceBody(out["v1/models.ts"], "Widget");
    const v2 = interfaceBody(out["v2/models.ts"], "Widget");
    ok(!v1.includes("added:"), "v1 must not have the v2 property");
    ok(v1.includes("removed: string;"), "v1 keeps the removed property");
    ok(v2.includes("added: string;"), "v2 has the added property");
    ok(!v2.includes("removed:"), "v2 must not have the removed property");
  });

  it("uses the old name before @renamedFrom takes effect", async () => {
    const out = await emitAll(`
      model Widget { @renamedFrom(Versions.v2, "oldName") newName: string; }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `);
    ok(interfaceBody(out["v1/models.ts"], "Widget").includes("oldName:"));
    ok(interfaceBody(out["v2/models.ts"], "Widget").includes("newName:"));
  });

  it("uses the old type before @typeChangedFrom takes effect", async () => {
    const out = await emitAll(`
      model Widget { @typeChangedFrom(Versions.v2, int32) size: string; }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `);
    ok(interfaceBody(out["v1/models.ts"], "Widget").includes("size: number;"));
    ok(interfaceBody(out["v2/models.ts"], "Widget").includes("size: string;"));
  });

  it("keeps a property required before @madeOptional takes effect", async () => {
    const out = await emitAll(`
      model Widget { @madeOptional(Versions.v2) note?: string; }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `);
    ok(interfaceBody(out["v1/models.ts"], "Widget").includes("note: string;"));
    ok(interfaceBody(out["v2/models.ts"], "Widget").includes("note?: string;"));
  });

  it("includes an enum member only in versions where it exists", async () => {
    const out = await emitAll(`
      enum Color { Red, @added(Versions.v2) Blue }
      model Widget { color: Color; }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `);
    ok(!out["v1/models.ts"].includes("Blue"), "v1 must not have Blue");
    ok(out["v2/models.ts"].includes("Blue = "), "v2 has Blue");
  });

  it("omits a model, operation, and interface before they are added", async () => {
    const out = await emitAll(`
      model Widget { id: string; }
      @added(Versions.v2) model Gadget { id: string; }
      @route("/widgets") interface Widgets {
        @get list(): Widget[];
        @added(Versions.v2) @get @route("gadget") gadget(): Gadget;
      }
      @added(Versions.v2) @route("/extras") interface Extras {
        @get list(): string[];
      }
    `);
    ok(!out["v1/models.ts"].includes("Gadget"), "v1 must not have Gadget");
    ok(out["v2/models.ts"].includes("export interface Gadget"));
    ok(!out["v1/endpoints/WidgetsEndpoints.ts"].includes("gadget"));
    ok(out["v2/endpoints/WidgetsEndpoints.ts"].includes("gadget"));
    strictEqual(out["v1/endpoints/ExtrasEndpoints.ts"], undefined);
    ok(out["v2/endpoints/ExtrasEndpoints.ts"], "v2 has the Extras interface");
  });

  it("includes a query parameter only in versions where it exists", async () => {
    const out = await emitAll(`
      @route("/widgets") interface Widgets {
        @get list(@added(Versions.v2) @query since?: string): string[];
      }
    `);
    ok(!out["v1/client/WidgetsClient.ts"].includes("since"));
    ok(out["v2/client/WidgetsClient.ts"].includes("since?: string"));
  });

  it("includes a discriminated variant only in versions where it exists", async () => {
    const out = await emitAll(`
      @discriminator("kind") model Pet { kind: string; }
      model Dog extends Pet { kind: "dog"; }
      @added(Versions.v2) model Cat extends Pet { kind: "cat"; }
      @route("/pets") interface Pets { @get list(): Pet[]; }
    `);
    ok(out["v1/models.ts"].includes("export type Pet = Dog;"));
    ok(out["v2/models.ts"].includes("export type Pet = Dog | Cat;"));
  });

  it("projects request types to the same version as their model", async () => {
    const out = await emitAll(`
      model Widget {
        @visibility(Lifecycle.Read) id: string;
        @renamedFrom(Versions.v2, "label") name: string;
      }
      @route("/widgets") interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `);
    const v1 = interfaceBody(out["v1/models.ts"], "WidgetPostRequest");
    const v2 = interfaceBody(out["v2/models.ts"], "WidgetPostRequest");
    ok(v1.includes("label: string;") && !v1.includes("id:"));
    ok(v2.includes("name: string;") && !v2.includes("id:"));
  });

  it("projects a single target-version the same way", async () => {
    const out = await emit(
      header +
        `
      model Widget { @added(Versions.v2) added: string; id: string; }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `,
      { "target-version": "v1" },
    );
    ok(!interfaceBody(out["models.ts"], "Widget").includes("added:"));
  });

  it("emits unversioned services from the original type graph", async () => {
    const out = await emit(`
      import "@typespec/http";
      using Http;
      @service(#{ title: "Test API" }) namespace TestApi;
      model Widget { id: string; }
      @route("/widgets") interface Widgets { @get list(): Widget[]; }
    `);
    ok(interfaceBody(out["models.ts"], "Widget").includes("id: string;"));
  });
});

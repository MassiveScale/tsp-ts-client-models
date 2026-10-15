import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./test-host.js";

/** Wraps declarations and an interface body in a minimal HTTP service. */
function spec(declarations: string, operations: string): string {
  return `
    import "@typespec/http";
    using Http;

    @service(#{ title: "Test API" })
    namespace TestApi;

    ${declarations}

    @route("/x") interface X { ${operations} }
  `;
}

describe("named unions", () => {
  it("emits a named union as a type alias and references it by name", async () => {
    const out = await emit(
      spec(
        `union Status { "active", "inactive" } model Widget { status: Status; }`,
        `@get read(): Widget;`,
      ),
    );
    ok(
      out["models.ts"].includes(`export type Status = "active" | "inactive";`),
    );
    ok(out["models.ts"].includes("status: Status;"));
  });

  it("emits a recursive union instead of overflowing the stack", async () => {
    const out = await emit(
      spec(
        `union JsonValue { string, int32, boolean, null, JsonValue[], Record<JsonValue> }
         model Doc { data: JsonValue; }`,
        `@get read(): Doc;`,
      ),
    );
    ok(
      out["models.ts"].includes(
        "export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };",
      ),
      out["models.ts"],
    );
  });

  it("keeps Record<string, T> when the values are not a recursive alias", async () => {
    const out = await emit(
      spec(`model Widget { tags: Record<string>; }`, `@get read(): Widget;`),
    );
    ok(out["models.ts"].includes("tags: Record<string, string>;"));
  });

  it("still writes an anonymous union in place", async () => {
    const out = await emit(
      spec(`model Widget { size: int32 | string; }`, `@get read(): Widget;`),
    );
    ok(out["models.ts"].includes("size: number | string;"));
  });

  it("imports a named union a client method returns", async () => {
    const out = await emit(
      spec(
        `model Cat { meow: boolean; } model Dog { bark: boolean; } union Pet { Cat, Dog }`,
        `@get read(): Pet;`,
      ),
    );
    ok(out["client/XClient.ts"].includes("import type { Pet } from"));
    ok(out["client/XClient.ts"].includes("Promise<Pet>"));
  });

  it("emits models reached only through a named union", async () => {
    const out = await emit(
      spec(
        `model Cat { meow: boolean; } model Dog { bark: boolean; }
         union Pet { Cat, Dog } model Home { pet: Pet; }`,
        `@get read(): Home;`,
      ),
    );
    ok(out["models.ts"].includes("export type Pet = Cat | Dog;"));
    ok(out["models.ts"].includes("export interface Cat {"));
    ok(out["models.ts"].includes("export interface Dog {"));
  });
});

describe("@discriminated unions", () => {
  const animals = `model Cat { meow: boolean; } model Dog { bark: boolean; }`;

  it("wraps each variant in the default object envelope", async () => {
    const out = await emit(
      spec(
        `${animals} @discriminated union Pet { cat: Cat, dog: Dog }`,
        `@get read(): Pet;`,
      ),
    );
    ok(
      out["models.ts"].includes(
        `export type Pet = { kind: "cat"; value: Cat } | { kind: "dog"; value: Dog };`,
      ),
      out["models.ts"],
    );
  });

  it("honours custom discriminator and envelope property names", async () => {
    const out = await emit(
      spec(
        `${animals} @discriminated(#{ discriminatorPropertyName: "type", envelopePropertyName: "data" })
         union Pet { cat: Cat, dog: Dog }`,
        `@get read(): Pet;`,
      ),
    );
    ok(out["models.ts"].includes(`{ type: "cat"; data: Cat }`));
  });

  it("merges the discriminator into the variant when the envelope is none", async () => {
    const out = await emit(
      spec(
        `${animals} @discriminated(#{ envelope: "none" }) union Pet { cat: Cat, dog: Dog }`,
        `@get read(): Pet;`,
      ),
    );
    ok(
      out["models.ts"].includes(
        `export type Pet = Cat & { kind: "cat" } | Dog & { kind: "dog" };`,
      ),
      out["models.ts"],
    );
  });

  it("sends a default variant bare", async () => {
    const out = await emit(
      spec(
        `${animals} model Unknown { raw: string; }
         @discriminated union Pet { cat: Cat, dog: Dog, Unknown }`,
        `@get read(): Pet;`,
      ),
    );
    ok(out["models.ts"].includes(`| Unknown;`), out["models.ts"]);
  });
});

describe("@discriminator bases", () => {
  it("emits a base with no variants as an interface, not an empty union", async () => {
    const out = await emit(
      spec(
        `@discriminator("kind") model Lonely { kind: string; x: string; }`,
        `@get read(): Lonely;`,
      ),
    );
    ok(out["models.ts"].includes("export interface Lonely {"));
    ok(!out["models.ts"].includes("export type Lonely"));
  });
});

describe("record spreads", () => {
  it("keeps declared properties alongside a spread record", async () => {
    const out = await emit(
      spec(
        `model Extra { known: string; ...Record<int32> }`,
        `@get read(): Extra;`,
      ),
    );
    ok(out["models.ts"].includes("export interface Extra {"));
    ok(out["models.ts"].includes("known: string;"));
    ok(out["models.ts"].includes("[key: string]: number | string;"));
    ok(out["client/XClient.ts"].includes("Promise<Extra>"));
  });

  it("keeps declared properties of a model that is a record", async () => {
    const out = await emit(
      spec(
        `model Bag is Record<string> { known: string; }`,
        `@get read(): Bag;`,
      ),
    );
    ok(out["models.ts"].includes("export interface Bag {"));
    ok(out["models.ts"].includes("[key: string]: string;"));
  });

  it("adds undefined to the index type when a property is optional", async () => {
    const out = await emit(
      spec(
        `model Extra { known?: boolean; ...Record<int32> }`,
        `@get read(): Extra;`,
      ),
    );
    ok(
      out["models.ts"].includes("[key: string]: number | boolean | undefined;"),
    );
  });

  it("emits models referenced only by the record's values", async () => {
    const out = await emit(
      spec(
        `model Tag { t: string; } model Extra { known: string; ...Record<Tag> }`,
        `@get read(): Extra;`,
      ),
    );
    ok(out["models.ts"].includes("export interface Tag {"));
  });

  it("still renders a property-less record as Record<string, T>", async () => {
    const out = await emit(
      spec(
        `model Plain is Record<int32>; model Widget { p: Plain; }`,
        `@get read(): Widget;`,
      ),
    );
    ok(out["models.ts"].includes("p: Record<string, number>;"));
  });

  it("widens the index signature of an inline model", async () => {
    const out = await emit(
      spec(
        `model Widget { inline: { a: string; ...Record<int32> }; }`,
        `@get read(): Widget;`,
      ),
    );
    ok(
      out["models.ts"].includes(
        "inline: { a: string; [key: string]: number | string };",
      ),
    );
  });
});

describe("request type name clashes", () => {
  it("renames a synthesized request type a declared type already uses", async () => {
    const [out, diagnostics] = await emitWithDiagnostics(
      spec(
        `model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
         model WidgetPostRequest { foo: string; }`,
        `@post create(@body body: Widget): void;
         @get @route("x") read(): WidgetPostRequest;`,
      ),
    );
    strictEqual(diagnostics.length, 1);
    strictEqual(
      diagnostics[0].code,
      "@massivescale/tsp-ts-client-models/request-type-name-collision",
    );
    const models = out["models.ts"];
    strictEqual(models.split("export interface WidgetPostRequest {").length, 2);
    ok(models.includes("export interface WidgetPostRequest2 {"));
    ok(out["client/XClient.ts"].includes("body: WidgetPostRequest2"));
    ok(out["client/XClient.ts"].includes("Promise<WidgetPostRequest>"));
  });

  it("renames a discriminated request union and keeps its members", async () => {
    const [out, diagnostics] = await emitWithDiagnostics(
      spec(
        `@discriminator("kind") model Pet { @visibility(Lifecycle.Read) id: string; kind: string; }
         model Dog extends Pet { kind: "dog"; }
         model PetPostRequest { note: string; }`,
        `@post create(@body body: Pet): void;
         @get @route("x") read(): PetPostRequest;`,
      ),
    );
    strictEqual(diagnostics.length, 1);
    ok(
      out["models.ts"].includes(
        "export type PetPostRequest2 = DogPostRequest;",
      ),
      out["models.ts"],
    );
    ok(out["client/XClient.ts"].includes("body: PetPostRequest2"));
  });

  it("points a merge-patch body at the renamed request type", async () => {
    const [out] = await emitWithDiagnostics(
      spec(
        `model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
         model WidgetPatchRequest { foo: string; }`,
        `@patch update(@body body: MergePatchUpdate<Widget>): void;
         @get @route("x") read(): WidgetPatchRequest;`,
      ),
    );
    ok(out["client/XClient.ts"].includes("body: WidgetPatchRequest2"));
  });
});

describe("discriminated write-body visibility", () => {
  it("filters a body when only a variant has a read-only property", async () => {
    const out = await emit(
      spec(
        `@discriminator("kind") model Pet { kind: string; name: string; }
         model Dog extends Pet { kind: "dog"; @visibility(Lifecycle.Read) licenseId: string; }
         model Cat extends Pet { kind: "cat"; }`,
        `@post create(@body body: Pet): void;`,
      ),
    );
    const models = out["models.ts"];
    ok(
      models.includes(
        "export type PetPostRequest = DogPostRequest | CatPostRequest;",
      ),
    );
    const dog = models.slice(models.indexOf("export interface DogPostRequest"));
    ok(!dog.slice(0, dog.indexOf("\n}")).includes("licenseId"));
    ok(out["client/XClient.ts"].includes("body: PetPostRequest"));
  });
});

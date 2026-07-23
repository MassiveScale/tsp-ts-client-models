import { strictEqual, ok, match, deepStrictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./test-host.js";
import {
  tryParseSemver,
  toCalVer,
  deriveNpmVersion,
  resolveRoutePrefix,
} from "../src/emitter.js";

describe("emitter", () => {
  // ─── Basic sanity ────────────────────────────────────────────────────────────

  it("emits nothing for an operation with no HTTP service", async () => {
    const results = await emit(`op test(): void;`);
    strictEqual(Object.keys(results).length, 0);
  });

  it("emits nothing for an HTTP service with no operations", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;
      @service(#{ title: "Test API" })
      namespace TestApi;
    `);
    strictEqual(Object.keys(results).length, 0);
  });

  // ─── Endpoint files ──────────────────────────────────────────────────────────

  it("emits an endpoints file for a simple GET interface", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/ItemsEndpoints.ts to be emitted");
    const content = results[endpointsFile];
    ok(
      content.includes("export const ItemsEndpoints"),
      "Expected ItemsEndpoints export",
    );
    ok(content.includes("list:"), "Expected list method");
    ok(content.includes("() =>"), "Expected no-arg arrow function");
    ok(
      content.includes("`/api/items`"),
      "Expected path template literal with default prefix",
    );
    ok(content.includes("as const"), "Expected as const");
  });

  it("emits path parameters as function arguments", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(@path id: string): Widget;
      }
    `);

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("WidgetsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/WidgetsEndpoints.ts");
    const content = results[endpointsFile];
    ok(
      content.includes("(id: string)"),
      "Expected path param in function signature",
    );
    ok(
      content.includes("`/api/widgets/${id}`"),
      "Expected template literal with path param",
    );
  });

  it("emits POST, PATCH, DELETE endpoint methods", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
        @patch update(@path id: string, @body body: Item): Item;
        @delete remove(@path id: string): void;
      }
    `);

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/ItemsEndpoints.ts");
    const content = results[endpointsFile];
    ok(content.includes("create:"), "Expected create method");
    ok(content.includes("update:"), "Expected update method");
    ok(content.includes("remove:"), "Expected remove method");
    ok(content.includes("(id: string)"), "Expected id param for update/remove");
  });

  it("emits multiple path params in the correct order", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/stores/{storeId}/items/{itemId}")
      interface Items {
        @get read(@path storeId: string, @path itemId: string): string;
      }
    `);

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile);
    const content = results[endpointsFile];
    ok(
      content.includes("(storeId: string, itemId: string)"),
      "Expected both path params",
    );
    ok(
      content.includes("`/api/stores/${storeId}/items/${itemId}`"),
      "Expected full path template",
    );
  });

  // ─── models.ts ───────────────────────────────────────────────────────────────

  it("emits a TypeScript interface for a model", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("A widget.")
      model Widget {
        @doc("The name.")
        name: string;
        count: int32;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];
    ok(
      content.includes("export interface Widget"),
      "Expected interface declaration",
    );
    ok(content.includes("name: string;"), "Expected name property");
    ok(content.includes("count: number;"), "Expected count as number");
    ok(
      content.includes("/** A widget. */"),
      "Expected JSDoc comment on interface",
    );
    ok(content.includes("/** The name. */"), "Expected JSDoc on property");
  });

  it("maps @encode(string) boolean properties to string, leaving plain booleans as boolean", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @encode(string) active: boolean;
        enabled: boolean;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];
    ok(
      content.includes("active: string;"),
      "Expected @encode(string) boolean to be typed as string",
    );
    ok(
      content.includes("enabled: boolean;"),
      "Expected plain boolean to remain boolean",
    );
  });

  it("emits optional properties with ?", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { required: string; optional?: int32; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile);
    const content = results[modelsFile];
    ok(
      content.includes("required: string;"),
      "Required property should not have ?",
    );
    ok(
      content.includes("optional?: number;"),
      "Optional property should have ?",
    );
    ok(!content.includes("required?: string"), "Required prop must not have ?");
  });

  it("emits a TypeScript enum", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("Widget colours.")
      enum Color {
        @doc("Red.") Red: "red",
        Green: "green",
        Blue: "blue",
      }

      model Item { color: Color; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts");
    const content = results[modelsFile];
    ok(content.includes("export enum Color"), "Expected enum declaration");
    ok(content.includes("Red = 'red'"), "Expected Red member");
    ok(content.includes("Green = 'green'"), "Expected Green member");
    ok(content.includes("/** Widget colours. */"), "Expected enum JSDoc");
    ok(content.includes("/** Red. */"), "Expected member JSDoc");
  });

  it("maps TypeSpec scalar types to correct TypeScript types", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Types {
        s: string;
        i32: int32;
        i64: int64;
        f: float64;
        b: boolean;
        dt: utcDateTime;
        by: bytes;
        @format("uuid") uid: string;
      }

      @route("/t")
      interface T {
        @get get(): Types;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile);
    const content = results[modelsFile];
    ok(content.includes("s: string;"), "string → string");
    ok(content.includes("i32: number;"), "int32 → number");
    ok(content.includes("i64: number;"), "int64 → number");
    ok(content.includes("f: number;"), "float64 → number");
    ok(content.includes("b: boolean;"), "boolean → boolean");
    ok(content.includes("dt: Date;"), "utcDateTime → Date");
    ok(content.includes("by: Uint8Array;"), "bytes → Uint8Array");
    ok(content.includes("uid: string;"), "@format(uuid) → string");
  });

  it("maps array types to T[]", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }
      model WidgetList { items: Widget[]; }

      @route("/widgets")
      interface Widgets {
        @get list(): WidgetList;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile);
    ok(
      results[modelsFile].includes("items: Widget[];"),
      "Expected Widget[] array type",
    );
  });

  it("emits generic interfaces with type parameters", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Page<T> {
        items: T[];
        total?: int32;
      }

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Page<Widget>;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts");
    const content = results[modelsFile];
    ok(
      content.includes("export interface Page<T>"),
      "Expected generic interface",
    );
    ok(content.includes("items: T[];"), "Expected T[] property");
  });

  it("emits string literal union types", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        status: "active" | "inactive";
      }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile);
    const content = results[modelsFile];
    ok(
      content.includes('"active" | "inactive"'),
      "Expected string literal union type",
    );
  });

  // ─── Request types ────────────────────────────────────────────────────────────

  it("generates a PostRequest interface excluding read-only properties for POST", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        @visibility(TypeSpec.Lifecycle.Read)
        createdAt: utcDateTime;
        name: string;
        count: int32;
      }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts with request type");
    const content = results[modelsFile];
    ok(
      content.includes("export interface ItemPostRequest"),
      "Expected ItemPostRequest interface",
    );
    ok(content.includes("name: string;"), "Expected name property");
    ok(content.includes("count: number;"), "Expected count property");
    ok(!content.includes("id: string"), "Read-only id should be excluded");
    ok(
      !content.includes("createdAt"),
      "Read-only createdAt should be excluded",
    );
  });

  it("generates a PatchRequest interface excluding read-only and create-only properties for PATCH", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        @visibility(TypeSpec.Lifecycle.Read, TypeSpec.Lifecycle.Create)
        tenantId: string;
        name: string;
      }

      @route("/items")
      interface Items {
        @patch update(@path id: string, @body body: Item): Item;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts");
    const content = results[modelsFile];
    ok(
      content.includes("export interface ItemPatchRequest"),
      "Expected ItemPatchRequest",
    );
    ok(content.includes("name: string;"), "Expected name");
    ok(!content.includes("id: string"), "id should be excluded");
    ok(
      !content.includes("tenantId"),
      "create-only tenantId should be excluded from patch",
    );
  });

  it("does not generate a request type when all properties are writable", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { name: string; count: int32; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    if (modelsFile) {
      ok(
        !results[modelsFile].includes("ItemPostRequest"),
        "Should not emit ItemPostRequest when all properties are writable",
      );
    }
  });

  // ─── @discriminator ─────────────────────────────────────────────────────────

  it("emits a discriminated base model as a union type alias of its variants", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum PetKind { Dog: "dog", Cat: "cat" }

      @doc("A pet.")
      @discriminator("petKind")
      model Pet {
        petKind: PetKind;
        name: string;
      }

      model Dog extends Pet {
        petKind: PetKind.Dog;
        isBarker: boolean;
      }

      model Cat extends Pet {
        petKind: PetKind.Cat;
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];

    ok(
      content.includes("export type Pet = Dog | Cat;"),
      "Expected Pet to be emitted as a union type alias",
    );
    ok(
      !content.includes("export interface Pet "),
      "Pet interface should not be emitted",
    );
    ok(content.includes("export interface Dog"), "Expected Dog interface");
    ok(content.includes("export interface Cat"), "Expected Cat interface");
    ok(
      content.includes('petKind: "dog";'),
      "Expected Dog.petKind narrowed to its literal value",
    );
    ok(
      content.includes('petKind: "cat";'),
      "Expected Cat.petKind narrowed to its literal value",
    );
    ok(content.includes("isBarker: boolean;"), "Expected Dog's own property");
    ok(content.includes("isPurrer: boolean;"), "Expected Cat's own property");
    ok(
      content.includes("name: string;"),
      "Expected inherited base property flattened into Dog/Cat",
    );
  });

  it("propagates the discriminated union type to properties referencing the base model", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum PetKind { Dog: "dog", Cat: "cat" }

      @discriminator("petKind")
      model Pet {
        petKind: PetKind;
      }

      model Dog extends Pet {
        petKind: PetKind.Dog;
        isBarker: boolean;
      }

      model Cat extends Pet {
        petKind: PetKind.Cat;
        isPurrer: boolean;
      }

      model Store {
        pets: Pet[];
      }

      @route("/stores")
      interface Stores {
        @get list(): Store[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];
    ok(
      content.includes("pets: Pet[];"),
      "Expected Store.pets to reference the Pet union alias by name",
    );
    ok(
      content.includes("export type Pet = Dog | Cat;"),
      "Expected Pet union alias",
    );
  });

  it("emits a per-variant union for a discriminated write body with read-only properties", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum PetKind { Dog: "dog", Cat: "cat" }

      @discriminator("petKind")
      model Pet {
        @visibility(Lifecycle.Read)
        id: string;

        petKind: PetKind;
        name: string;
      }

      model Dog extends Pet {
        petKind: PetKind.Dog;
        isBarker: boolean;
      }

      model Cat extends Pet {
        petKind: PetKind.Cat;
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @post create(@body pet: Pet): Pet;
        @get list(): Pet[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];

    ok(
      content.includes(
        "export type PetPostRequest = DogPostRequest | CatPostRequest;",
      ),
      "Expected PetPostRequest to be a union of per-variant request types",
    );
    ok(
      !content.includes("export interface PetPostRequest"),
      "PetPostRequest should not be a flat interface",
    );

    const dogRequestMatch =
      /export interface DogPostRequest \{([\s\S]*?)\}/.exec(content);
    ok(dogRequestMatch, "Expected DogPostRequest interface");
    ok(
      dogRequestMatch[1].includes('petKind: "dog";'),
      "Expected DogPostRequest.petKind narrowed to its literal value",
    );
    ok(
      dogRequestMatch[1].includes("isBarker: boolean;"),
      "Expected DogPostRequest to retain Dog's own property",
    );
    ok(
      !dogRequestMatch[1].includes("id:"),
      "Expected DogPostRequest to exclude the read-only id property",
    );

    const catRequestMatch =
      /export interface CatPostRequest \{([\s\S]*?)\}/.exec(content);
    ok(catRequestMatch, "Expected CatPostRequest interface");
    ok(
      catRequestMatch[1].includes('petKind: "cat";'),
      "Expected CatPostRequest.petKind narrowed to its literal value",
    );
    ok(
      catRequestMatch[1].includes("isPurrer: boolean;"),
      "Expected CatPostRequest to retain Cat's own property",
    );

    const clientFile = Object.keys(results).find((k) =>
      k.endsWith("PetsClient.ts"),
    );
    ok(clientFile, "Expected PetsClient.ts to be emitted");
    ok(
      results[clientFile].includes("body: PetPostRequest"),
      "Expected create() to accept the PetPostRequest union as its body",
    );
  });

  it("keeps variant interfaces even when a discriminated write body has no independent read operation", async () => {
    // Regression test: the per-variant request types (DogPostRequest,
    // CatPostRequest) were previously registered under the *variant's* name
    // (e.g. "Dog") in requestTypeBaseModels, which could suppress the plain
    // Dog/Cat interfaces the union alias (Pet = Dog | Cat) still references —
    // producing models.ts with a dangling reference. There is deliberately no
    // GET/list operation here, so Dog/Cat are never independently "read".
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum PetKind { Dog: "dog", Cat: "cat" }

      @discriminator("petKind")
      model Pet {
        @visibility(Lifecycle.Read)
        id: string;

        petKind: PetKind;
        name: string;
      }

      model Dog extends Pet {
        petKind: PetKind.Dog;
        isBarker: boolean;
      }

      model Cat extends Pet {
        petKind: PetKind.Cat;
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @post create(@body pet: Pet): Pet;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];

    ok(
      content.includes("export type Pet = Dog | Cat;"),
      "Expected Pet union alias to still be emitted even though Pet itself is never read via GET/HEAD",
    );
    ok(
      content.includes("export interface Dog"),
      "Expected Dog interface to still be emitted for the Pet union's sake",
    );
    ok(
      content.includes("export interface Cat"),
      "Expected Cat interface to still be emitted for the Pet union's sake",
    );
    ok(content.includes("id: string;"), "Expected Dog/Cat to include id");
    ok(content.includes("isBarker: boolean;"), "Expected Dog's own property");
    ok(content.includes("isPurrer: boolean;"), "Expected Cat's own property");
  });

  it("resolves a discriminated write-body collision across operations with @tag prefixes", async () => {
    // Regression test: two operations produce the same {Base}{Verb}Request
    // union name ("PetPatchRequest") but with differently-shaped variants
    // (different @parameterVisibility). Both the union and its members must
    // be renamed together and consistently, and no stale unprefixed variant
    // interface (e.g. a leftover "DogPatchRequest") should remain.
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum PetKind { Dog: "dog", Cat: "cat" }

      @discriminator("petKind")
      model Pet {
        @visibility(Lifecycle.Read)
        id: string;
        @visibility(Lifecycle.Create)
        ownerId: string;

        petKind: PetKind;
        name: string;
      }

      model Dog extends Pet {
        petKind: PetKind.Dog;
        isBarker: boolean;
      }

      model Cat extends Pet {
        petKind: PetKind.Cat;
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @tag("Standard")
        @patch update(@path id: string, @body pet: Pet): Pet;
        @get list(): Pet[];
      }

      @route("/admin/pets")
      interface AdminPets {
        @tag("Admin")
        @patch
        @parameterVisibility(Lifecycle.Create, Lifecycle.Update)
        update(@path id: string, @body pet: Pet): Pet;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts to be emitted");
    const content = results[modelsFile];

    ok(
      content.includes(
        "export type StandardPetPatchRequest = StandardDogPatchRequest | StandardCatPatchRequest;",
      ),
      "Expected Standard union to reference the Standard-prefixed variants",
    );
    ok(
      content.includes(
        "export type AdminPetPatchRequest = AdminDogPatchRequest | AdminCatPatchRequest;",
      ),
      "Expected Admin union to reference the Admin-prefixed variants",
    );
    ok(
      !content.includes("export type PetPatchRequest ="),
      "Unprefixed PetPatchRequest union should not exist once renamed",
    );
    ok(
      !content.includes("export interface DogPatchRequest"),
      "Stale unprefixed DogPatchRequest interface should not linger",
    );
    ok(
      !content.includes("export interface CatPatchRequest"),
      "Stale unprefixed CatPatchRequest interface should not linger",
    );

    const adminDogMatch =
      /export interface AdminDogPatchRequest \{([\s\S]*?)\}/.exec(content);
    ok(adminDogMatch, "Expected AdminDogPatchRequest interface");
    ok(
      adminDogMatch[1].includes("ownerId: string;"),
      "Admin variant includes Create-visibility ownerId per its @parameterVisibility",
    );

    const standardDogMatch =
      /export interface StandardDogPatchRequest \{([\s\S]*?)\}/.exec(content);
    ok(standardDogMatch, "Expected StandardDogPatchRequest interface");
    ok(
      !standardDogMatch[1].includes("ownerId"),
      "Standard variant excludes Create-only ownerId under default PATCH visibility",
    );

    // Regression test: client method bodies must resolve to the tag-prefixed
    // request type, not silently fall back to the unfiltered base model
    // (the unprefixed "PetPatchRequest" name is no longer registered once
    // renamed, so the lookup must retry under the operation's own @tag).
    const standardClientFile = Object.keys(results).find((k) =>
      k.endsWith("PetsClient.ts"),
    );
    ok(standardClientFile, "Expected PetsClient.ts to be emitted");
    ok(
      results[standardClientFile].includes("body: StandardPetPatchRequest"),
      "Expected Pets.update() to accept the StandardPetPatchRequest union as its body",
    );

    const adminClientFile = Object.keys(results).find((k) =>
      k.endsWith("AdminPetsClient.ts"),
    );
    ok(adminClientFile, "Expected AdminPetsClient.ts to be emitted");
    ok(
      results[adminClientFile].includes("body: AdminPetPatchRequest"),
      "Expected AdminPets.update() to accept the AdminPetPatchRequest union as its body",
    );
  });

  it("reports request-type-collision for a discriminated write-body collision with no @tag", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum PetKind { Dog: "dog", Cat: "cat" }

      @discriminator("petKind")
      model Pet {
        @visibility(Lifecycle.Read)
        id: string;
        @visibility(Lifecycle.Create)
        ownerId: string;

        petKind: PetKind;
        name: string;
      }

      model Dog extends Pet {
        petKind: PetKind.Dog;
        isBarker: boolean;
      }

      model Cat extends Pet {
        petKind: PetKind.Cat;
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @patch update(@path id: string, @body pet: Pet): Pet;
      }

      @route("/admin/pets")
      interface AdminPets {
        @patch
        @parameterVisibility(Lifecycle.Create, Lifecycle.Update)
        update(@path id: string, @body pet: Pet): Pet;
      }
    `);

    ok(
      diagnostics.some((d) => d.code.includes("request-type-collision")),
      "Expected a request-type-collision diagnostic",
    );
  });

  // ─── index.ts and package.json ────────────────────────────────────────────────

  it("emits an index.ts that re-exports models and endpoints", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const indexFile = Object.keys(results).find((k) => k.endsWith("index.ts"));
    ok(indexFile, "Expected index.ts");
    const content = results[indexFile];
    ok(
      content.includes('export * from "./models.js"'),
      "Expected models export",
    );
    ok(
      content.includes('export * from "./endpoints/WidgetsEndpoints.js"'),
      "Expected endpoints export",
    );
    ok(content.includes("AUTO-GENERATED"), "Expected auto-generated header");
  });

  it("emits a package.json with description derived from namespace", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    const pkg = JSON.parse(results[pkgFile]);
    ok(
      pkg.description?.includes("TestApi"),
      "Expected description containing namespace",
    );
    strictEqual(pkg.type, "module");
    strictEqual(pkg.sideEffects, false);
  });

  it("uses npm-package-name when provided", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "npm-package-name": "@acme/test-api-client" },
    );

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile);
    const pkg = JSON.parse(results[pkgFile]);
    strictEqual(pkg.name, "@acme/test-api-client");
  });

  it("uses npm-description when provided", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "npm-description": "My custom description." },
    );

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile);
    strictEqual(
      JSON.parse(results[pkgFile]).description,
      "My custom description.",
    );
  });

  it("derives package name from namespace when npm-package-name is not set", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace MyOrg.MyApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    strictEqual(JSON.parse(results[pkgFile]).name, "my-org-my-api");
  });

  it("emits package.json with exports, scripts, files, and devDependencies", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    const pkg = JSON.parse(results[pkgFile]);

    deepStrictEqual(pkg.exports, {
      ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
    });
    strictEqual(pkg.main, "./dist/index.js");
    strictEqual(pkg.types, "./dist/index.d.ts");
    deepStrictEqual(pkg.files, ["dist"]);
    deepStrictEqual(pkg.scripts, { build: "tsc" });
    ok(pkg.devDependencies?.typescript, "Expected typescript devDependency");
  });

  it("emits versioned exports when all-versions is true", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `,
      { "all-versions": true },
    );

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    const pkg = JSON.parse(results[pkgFile]);

    ok(pkg.exports?.["./v1.0"], "Expected v1.0 export");
    ok(pkg.exports?.["./v2.0"], "Expected v2.0 export");
    strictEqual(pkg.exports["./v1.0"].import, "./dist/v1.0/index.js");
    strictEqual(pkg.exports["./v1.0"].types, "./dist/v1.0/index.d.ts");
    strictEqual(pkg.exports["./v2.0"].import, "./dist/v2.0/index.js");
    strictEqual(pkg.exports["./v2.0"].types, "./dist/v2.0/index.d.ts");
    strictEqual(pkg.main, undefined, "No main for versioned output");
    deepStrictEqual(pkg.files, ["dist"]);
    deepStrictEqual(pkg.scripts, { build: "tsc" });
  });

  it("emits a tsconfig.json alongside package.json", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const tsConfigFile = Object.keys(results).find((k) =>
      k.endsWith("tsconfig.json"),
    );
    ok(tsConfigFile, "Expected tsconfig.json");
    const tsConfig = JSON.parse(results[tsConfigFile]);
    strictEqual(tsConfig.compilerOptions?.outDir, "./dist");
    strictEqual(tsConfig.compilerOptions?.declaration, true);
    ok(Array.isArray(tsConfig.include), "Expected include array");
    ok(Array.isArray(tsConfig.exclude), "Expected exclude array");
  });

  // ─── Versioning ──────────────────────────────────────────────────────────────

  it("defaults to emitting only the latest version for a versioned API", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `);

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("Items.ts"),
    );
    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );

    ok(!v1File, "v1.0 folder should not be emitted by default");
    ok(
      endpointsFile,
      "Expected endpoints/ItemsEndpoints.ts at root (no version folder in single-version mode)",
    );
    ok(results[endpointsFile].includes("list:"), "v2 should have list");
    ok(results[endpointsFile].includes("create:"), "v2 should have create");
  });

  it("emits only the target version when target-version is set", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `,
      { "target-version": "v1.0" },
    );

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/ItemsEndpoints.ts");
    ok(results[endpointsFile].includes("list:"), "v1 should have list");
    ok(
      !results[endpointsFile].includes("create:"),
      "v1 should not have create (added in v2)",
    );
  });

  it("emits all versions in separate subfolders when all-versions is true", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `,
      { "all-versions": true },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("ItemsEndpoints.ts"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("ItemsEndpoints.ts"),
    );

    ok(v1File, "Expected v1.0/endpoints/ItemsEndpoints.ts");
    ok(v2File, "Expected v2.0/endpoints/ItemsEndpoints.ts");
    ok(results[v1File].includes("list:"), "v1 should have list");
    ok(!results[v1File].includes("create:"), "v1 should not have create");
    ok(results[v2File].includes("list:"), "v2 should have list");
    ok(results[v2File].includes("create:"), "v2 should have create");
  });

  it("reports an error when target-version does not exist", async () => {
    const [, diags] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "target-version": "v9.0" },
    );

    ok(
      diags.some(
        (d) =>
          d.code === "@massivescale/tsp-ts-client-models/version-not-found",
      ),
      "Expected version-not-found diagnostic",
    );
  });

  // ─── npm version derivation ──────────────────────────────────────────────────

  describe("tryParseSemver", () => {
    it("parses two-part version", () =>
      strictEqual(tryParseSemver("1.2"), "1.2.0"));
    it("parses three-part version", () =>
      strictEqual(tryParseSemver("1.2.3"), "1.2.3"));
    it("strips leading v", () => strictEqual(tryParseSemver("v2.1"), "2.1.0"));
    it("strips leading V", () =>
      strictEqual(tryParseSemver("V3.0.1"), "3.0.1"));
    it("preserves pre-release suffix", () =>
      strictEqual(tryParseSemver("v2.0-preview"), "2.0.0-preview"));
    it("preserves rc suffix", () =>
      strictEqual(tryParseSemver("1.0.0-rc.1"), "1.0.0-rc.1"));
    it("returns undefined for single-digit", () =>
      strictEqual(tryParseSemver("v1"), undefined));
    it("returns undefined for date-style string", () =>
      strictEqual(tryParseSemver("2022-10-15"), undefined));
    it("returns undefined for plain label", () =>
      strictEqual(tryParseSemver("preview"), undefined));
  });

  describe("toCalVer", () => {
    it("formats as YYYY.MM.DD", () =>
      strictEqual(toCalVer(new Date(2026, 4, 21)), "2026.05.21"));
    it("zero-pads month and day", () =>
      strictEqual(toCalVer(new Date(2026, 0, 3)), "2026.01.03"));
  });

  it("uses semver parsed from TypeSpec API version as npm version", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v2_1: "v2.1" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    strictEqual(
      JSON.parse(results[pkgFile]).version,
      "2.1.0",
      "Expected semver from TypeSpec version",
    );
  });

  it("falls back to CalVer when TypeSpec version is not semver-parseable", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { sprint42: "sprint-42" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile);
    match(
      JSON.parse(results[pkgFile]).version,
      /^\d{4}\.\d{2}\.\d{2}$/,
      "Expected CalVer fallback",
    );
  });

  it("falls back to CalVer for unversioned API", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile);
    match(
      JSON.parse(results[pkgFile]).version,
      /^\d{4}\.\d{2}\.\d{2}$/,
      "Expected CalVer for unversioned API",
    );
  });

  it("uses npm-version option over derived version", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "npm-version": "3.0.0-beta.1" },
    );

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile);
    strictEqual(JSON.parse(results[pkgFile]).version, "3.0.0-beta.1");
  });

  it("uses target-version semver when target-version is specified", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v1_0: "v1.0", v2_0: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "target-version": "v1.0" },
    );

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile);
    strictEqual(JSON.parse(results[pkgFile]).version, "1.0.0");
  });

  // ─── Multi-line doc comments ──────────────────────────────────────────────────

  it("emits all lines of a multi-line model doc as JSDoc", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("First line.\\nSecond line.")
      model Widget {
        @doc("Prop first.\\nProp second.")
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile);
    const content = results[modelsFile];
    ok(content.includes("First line."), "Expected first doc line");
    ok(content.includes("Second line."), "Expected second doc line");
    ok(content.includes("Prop first."), "Expected first property doc line");
    ok(content.includes("Prop second."), "Expected second property doc line");
  });

  // ─── AUTO-GENERATED header ────────────────────────────────────────────────────

  it("includes AUTO-GENERATED header in emitted .ts files", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    for (const [path, content] of Object.entries(results)) {
      if (path.endsWith(".ts")) {
        ok(
          content.includes("AUTO-GENERATED"),
          `Expected AUTO-GENERATED header in ${path}`,
        );
      }
    }
  });

  // ─── route-prefix ────────────────────────────────────────────────────────────

  it("default route-prefix inserts version value for versioned API", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/ItemsEndpoints.ts");
    ok(
      results[endpointsFile].includes("`/api/v1.0/items`"),
      "Expected default prefix with version value",
    );
  });

  it("route-prefix option with {version} token uses actual version", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v2: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "route-prefix": "services/{version}/rest" },
    );

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile);
    ok(
      results[endpointsFile].includes("`/services/v2.0/rest/items`"),
      "Expected custom prefix with version token replaced",
    );
  });

  it("route-prefix option without {version} token is used as literal prefix", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "route-prefix": "myapi/v1" },
    );

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile);
    ok(
      results[endpointsFile].includes("`/myapi/v1/items`"),
      "Expected literal prefix",
    );
  });

  it("empty route-prefix emits path without any prefix", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "route-prefix": "" },
    );

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("ItemsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile);
    ok(
      results[endpointsFile].includes("`/items`"),
      "Expected path with no prefix",
    );
    ok(
      !results[endpointsFile].includes("`/api/items`"),
      "Expected no default prefix applied",
    );
  });

  it("route-prefix path params still work correctly with a prefix", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/widgets")
      interface Widgets {
        @get read(@path id: string): string;
      }
    `,
      { "route-prefix": "api/v1" },
    );

    const endpointsFile = Object.keys(results).find(
      (k) => k.endsWith("WidgetsEndpoints.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile);
    ok(
      results[endpointsFile].includes("`/api/v1/widgets/${id}`"),
      "Expected prefixed path with path param",
    );
  });

  describe("resolveRoutePrefix", () => {
    it("replaces {version} token with version value", () =>
      strictEqual(resolveRoutePrefix("api/{version}", "v1.0"), "api/v1.0"));
    it("removes {version} token when no version provided", () =>
      strictEqual(resolveRoutePrefix("api/{version}", undefined), "api"));
    it("returns empty string when prefix is empty", () =>
      strictEqual(resolveRoutePrefix("", "v1.0"), ""));
    it("returns empty string when prefix is empty and no version", () =>
      strictEqual(resolveRoutePrefix("", undefined), ""));
    it("returns literal prefix when no {version} token", () =>
      strictEqual(resolveRoutePrefix("api/v2", "v1.0"), "api/v2"));
    it("handles {version}-only prefix with a version", () =>
      strictEqual(resolveRoutePrefix("{version}", "v2.0"), "v2.0"));
    it("handles {version}-only prefix with no version", () =>
      strictEqual(resolveRoutePrefix("{version}", undefined), ""));
    it("strips leading and trailing slashes from resolved prefix", () =>
      strictEqual(resolveRoutePrefix("/api/{version}/", "v1.0"), "api/v1.0"));
    it("collapses double slashes when version is empty", () =>
      strictEqual(
        resolveRoutePrefix("api/{version}/rest", undefined),
        "api/rest",
      ));
  });

  // ─── MergePatch request models ───────────────────────────────────────────────

  it("generates a PatchRequest for MergePatch operations", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/rest";
      using Http;
      using Rest;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        id: string;
        name: string;
        count?: int32;
      }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts");
    const content = results[modelsFile];
    ok(
      content.includes("export interface WidgetPatchRequest"),
      "Expected WidgetPatchRequest from MergePatch",
    );
  });

  it("references the base model, not a missing PatchRequest, for a nested merge-patch type that has no PATCH of its own", async () => {
    // Regression: Store has a MergePatch (StorePatchRequest) and contains
    // `pets: Pet[]`. Pet has a POST (so it is in requestTypeBaseModels) but no
    // PATCH — so PetPatchRequest is never emitted. The nested reference inside
    // StorePatchRequest.pets must fall back to `Pet`, not dangle on
    // `PetPatchRequest`. (This surfaced in versioned APIs where an entity's PATCH
    // is @added in a later version than an entity that embeds it.)
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Pet {
        @visibility(Lifecycle.Read) id: string;
        name: string;
      }

      model Store {
        @visibility(Lifecycle.Read) id: string;
        name: string;
        pets: Pet[];
      }

      @route("/pets")
      interface Pets {
        @post create(@body body: Pet): Pet;
      }

      @route("/stores")
      interface Stores {
        @post create(@body body: Store): Store;
        @patch update(@path id: string, @body body: MergePatchUpdate<Store>): Store;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts");
    const content = results[modelsFile];
    ok(
      content.includes("export interface StorePatchRequest"),
      "Expected StorePatchRequest from Store's MergePatch",
    );
    ok(
      !content.includes("PetPatchRequest"),
      "StorePatchRequest.pets must not reference a never-emitted PetPatchRequest",
    );
    const storePatch = content.slice(content.indexOf("StorePatchRequest"));
    ok(
      /pets\??:\s*Pet\[\]/.test(storePatch),
      "Expected StorePatchRequest.pets to fall back to Pet[]",
    );
  });

  // ─── Collision detection ─────────────────────────────────────────────────────

  it("disambiguates colliding request types using @tag prefix", async () => {
    // Two @patch operations on the same model but with different @parameterVisibility
    // both produce "WidgetPatchRequest" with different property shapes.
    // The @tag on each operation resolves the collision with a name prefix.
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        name: string;
        @visibility(TypeSpec.Lifecycle.Create)
        tenantId: string;
      }

      @route("/widgets")
      interface Widgets {
        @tag("Standard")
        @patch update(@path id: string, @body body: Widget): Widget;
      }

      @route("/admin/widgets")
      interface AdminWidgets {
        @tag("Admin")
        @patch
        @parameterVisibility(TypeSpec.Lifecycle.Create, TypeSpec.Lifecycle.Update)
        update(@path id: string, @body body: Widget): Widget;
      }
    `);

    const modelsFile = Object.keys(results).find((k) =>
      k.endsWith("models.ts"),
    );
    ok(modelsFile, "Expected models.ts");
    const content = results[modelsFile];
    ok(
      content.includes("StandardWidgetPatchRequest") ||
        content.includes("AdminWidgetPatchRequest"),
      "Expected tag-prefixed request types for collision",
    );
  });

  it("reports request-type-collision diagnostic when @tag is missing", async () => {
    const [, diags] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        name: string;
        @visibility(TypeSpec.Lifecycle.Create)
        tenantId: string;
      }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: Widget): Widget;
      }

      @route("/admin/widgets")
      interface AdminWidgets {
        @patch
        @parameterVisibility(TypeSpec.Lifecycle.Create, TypeSpec.Lifecycle.Update)
        update(@path id: string, @body body: Widget): Widget;
      }
    `);

    ok(
      diags.some((d) => d.code.includes("request-type-collision")),
      "Expected request-type-collision diagnostic",
    );
  });

  // ─── HTTP client generation ───────────────────────────────────────────────────

  it("generates client/ApiClient.ts with HttpClient base class", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
        @get read(@path id: string): Widget;
      }
    `);

    const apiClientFile = Object.keys(results).find((k) =>
      k.includes("client/ApiClient.ts"),
    );
    ok(apiClientFile, "Expected client/ApiClient.ts");
    const content = results[apiClientFile];
    ok(content.includes("class HttpClient"), "Expected HttpClient class");
    ok(content.includes("ClientConfig"), "Expected ClientConfig interface");
    ok(content.includes("ApiError"), "Expected ApiError class");
    ok(content.includes("RetryConfig"), "Expected RetryConfig interface");
  });

  it("generates a typed client class per interface", async () => {
    const results = await emit(`
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
        @delete remove(@path id: string): void;
      }
    `);

    const clientFile = Object.keys(results).find((k) =>
      k.includes("client/WidgetsClient.ts"),
    );
    ok(clientFile, "Expected client/WidgetsClient.ts");
    const content = results[clientFile];
    ok(
      content.includes("class WidgetsClient extends HttpClient"),
      "Expected WidgetsClient extending HttpClient",
    );
    ok(content.includes("async list("), "Expected list method");
    ok(content.includes("async read("), "Expected read method");
    ok(content.includes("async create("), "Expected create method");
    ok(content.includes("async remove("), "Expected remove method");
    ok(
      content.includes("WidgetsEndpoints"),
      "Expected WidgetsEndpoints import",
    );
  });

  it("client method uses request type when one was generated", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @visibility(TypeSpec.Lifecycle.Read) id: string;
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `);

    const clientFile = Object.keys(results).find((k) =>
      k.includes("client/WidgetsClient.ts"),
    );
    ok(clientFile, "Expected client/WidgetsClient.ts");
    ok(
      results[clientFile].includes("WidgetPostRequest"),
      "Expected WidgetPostRequest used in client method",
    );
  });

  it("client is exported from index.ts", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/widgets")
      interface Widgets {
        @get list(): string[];
      }
    `);

    const indexFile = Object.keys(results).find((k) => k.endsWith("index.ts"));
    ok(indexFile, "Expected index.ts");
    const content = results[indexFile];
    ok(
      content.includes("./client/ApiClient.js"),
      "Expected ApiClient.js export",
    );
    ok(
      content.includes("./client/WidgetsClient.js"),
      "Expected WidgetsClient.js export",
    );
  });

  it("does not emit client files when generate-http-client is false", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/widgets")
      interface Widgets {
        @get list(): string[];
      }
    `,
      { "generate-http-client": false },
    );

    const clientFiles = Object.keys(results).filter((k) =>
      k.includes("client/"),
    );
    strictEqual(
      clientFiles.length,
      0,
      "No client files should be emitted when generate-http-client is false",
    );
  });

  it("does not shadow base transport helpers when an operation is named after an HTTP verb", async () => {
    // Regression: an operation literally named `delete` (or `get`, etc.) would
    // generate a public `delete()` method that shadowed the protected base
    // `HttpClient.delete<T>()` helper it delegates to — producing an incompatible
    // override (TS2416) and a self-referential call (TS2558). The base helpers
    // are now prefixed (`httpGet`, `httpDelete`, …) so no operation name collides.
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @delete delete(@path id: string): void;
        @get list(): Widget[];
      }
    `);

    const apiClientFile = Object.keys(results).find((k) =>
      k.includes("client/ApiClient.ts"),
    );
    ok(apiClientFile, "Expected client/ApiClient.ts");
    const api = results[apiClientFile];
    ok(api.includes("protected httpDelete<T>"), "Expected httpDelete helper");
    ok(api.includes("protected httpGet<T>"), "Expected httpGet helper");
    ok(
      !/protected delete<T>/.test(api),
      "Base helper must not use the bare verb name `delete`",
    );

    const clientFile = Object.keys(results).find((k) =>
      k.includes("client/WidgetsClient.ts"),
    );
    ok(clientFile, "Expected client/WidgetsClient.ts");
    const client = results[clientFile];
    ok(client.includes("async delete("), "Expected the delete() method");
    ok(
      client.includes("return this.httpDelete<void>("),
      "delete() body must call the prefixed helper, not itself",
    );
    ok(
      client.includes("return this.httpGet<Widget[]>("),
      "list() body must call the prefixed helper",
    );
  });

  // ─── Observable (RxJS) client flavor ──────────────────────────────────────────

  const OBSERVABLE_API = `
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
      @delete remove(@path id: string): void;
    }
  `;

  it("does not emit an Observable client or rxjs peer dep by default (promise)", async () => {
    const results = await emit(OBSERVABLE_API);

    ok(
      Object.keys(results).some((k) => k.includes("client/WidgetsClient.ts")),
      "Expected the Promise client by default",
    );
    ok(
      !Object.keys(results).some((k) => k.includes("ObservableClient.ts")),
      "No Observable client should be emitted by default",
    );
    ok(
      !Object.keys(results).some((k) => k.includes("client/ApiClientRx.ts")),
      "No ApiClientRx.ts should be emitted by default",
    );

    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    ok(
      !results[pkgFile].includes("rxjs"),
      "package.json must not reference rxjs by default",
    );
  });

  it("emits byte-for-byte identical output for the default and explicit promise style", async () => {
    const defaultOut = await emit(OBSERVABLE_API);
    const explicitOut = await emit(OBSERVABLE_API, {
      "client-style": "promise",
    });
    deepStrictEqual(
      explicitOut,
      defaultOut,
      "client-style: 'promise' must be identical to the default output",
    );
  });

  it("emits an Observable client backed by RxHttpClient when client-style is observable", async () => {
    const results = await emit(OBSERVABLE_API, {
      "client-style": "observable",
    });

    // Observable client class + signatures
    const obsFile = Object.keys(results).find((k) =>
      k.includes("client/WidgetsObservableClient.ts"),
    );
    ok(obsFile, "Expected client/WidgetsObservableClient.ts");
    const obs = results[obsFile];
    ok(
      obs.includes("class WidgetsObservableClient extends RxHttpClient"),
      "Expected WidgetsObservableClient extending RxHttpClient",
    );
    ok(
      obs.includes('import { Observable } from "rxjs";'),
      "Expected rxjs Observable import",
    );
    ok(obs.includes("list(query?"), "Expected non-async list method signature");
    ok(!obs.includes("async "), "Observable methods must not be async");
    ok(
      obs.includes("): Observable<Widget[]> {"),
      "Expected list() to return Observable<Widget[]>",
    );
    ok(
      obs.includes("return this.httpGet$<Widget[]>("),
      "Expected list() body to call the httpGet$ transport helper",
    );
    ok(
      obs.includes("return this.httpPost$<Widget>("),
      "Expected create() body to call the httpPost$ transport helper",
    );

    // Rx transport base
    const rxFile = Object.keys(results).find((k) =>
      k.includes("client/ApiClientRx.ts"),
    );
    ok(rxFile, "Expected client/ApiClientRx.ts");
    const rx = results[rxFile];
    ok(
      rx.includes("export class RxHttpClient extends HttpClient"),
      "Expected RxHttpClient extending HttpClient",
    );
    ok(
      rx.includes(
        'import { HttpClient, type RequestOptions } from "./ApiClient.js";',
      ),
      "Expected RxHttpClient to reuse the Promise transport from ApiClient.js",
    );
    ok(rx.includes("httpGet$<T>"), "Expected httpGet$ helper");
    ok(rx.includes("httpPost$<T>"), "Expected httpPost$ helper");
    ok(rx.includes("new AbortController()"), "Expected cancellation wiring");

    // Shared base transport still emitted (RxHttpClient depends on it)
    ok(
      Object.keys(results).some((k) => k.includes("client/ApiClient.ts")),
      "Expected shared ApiClient.ts to still be emitted",
    );

    // Promise client suppressed in observable-only mode
    ok(
      !Object.keys(results).some((k) => k.includes("client/WidgetsClient.ts")),
      "Promise client must not be emitted in observable-only mode",
    );

    // Barrel exports both bases and the observable client
    const indexFile = Object.keys(results).find((k) => k.endsWith("index.ts"));
    ok(indexFile, "Expected index.ts");
    const index = results[indexFile];
    ok(index.includes("./client/ApiClient.js"), "Expected ApiClient export");
    ok(
      index.includes("./client/ApiClientRx.js"),
      "Expected ApiClientRx export",
    );
    ok(
      index.includes("./client/WidgetsObservableClient.js"),
      "Expected WidgetsObservableClient export",
    );

    // Optional rxjs peer dependency
    const pkgFile = Object.keys(results).find((k) =>
      k.endsWith("package.json"),
    );
    ok(pkgFile, "Expected package.json");
    const pkg = JSON.parse(results[pkgFile]);
    ok(pkg.peerDependencies?.rxjs, "Expected rxjs peerDependency");
    strictEqual(
      pkg.peerDependenciesMeta?.rxjs?.optional,
      true,
      "Expected rxjs peer dependency to be optional",
    );
    ok(
      pkg.devDependencies?.rxjs,
      "Expected rxjs devDependency so the generated package builds standalone",
    );
    ok(
      pkg.devDependencies?.typescript,
      "Expected typescript devDependency to be preserved",
    );
  });

  it("emits both Promise and Observable clients side by side when client-style is both", async () => {
    const results = await emit(OBSERVABLE_API, { "client-style": "both" });

    ok(
      Object.keys(results).some((k) => k.includes("client/WidgetsClient.ts")),
      "Expected the Promise client",
    );
    ok(
      Object.keys(results).some((k) =>
        k.includes("client/WidgetsObservableClient.ts"),
      ),
      "Expected the Observable client",
    );
    ok(
      Object.keys(results).some((k) => k.includes("client/ApiClient.ts")),
      "Expected shared ApiClient.ts",
    );
    ok(
      Object.keys(results).some((k) => k.includes("client/ApiClientRx.ts")),
      "Expected ApiClientRx.ts",
    );

    const indexFile = Object.keys(results).find((k) => k.endsWith("index.ts"));
    ok(indexFile, "Expected index.ts");
    const index = results[indexFile];
    ok(
      index.includes("./client/WidgetsClient.js"),
      "Expected Promise client export",
    );
    ok(
      index.includes("./client/WidgetsObservableClient.js"),
      "Expected Observable client export",
    );

    // Both clients share the single ApiError from ApiClient.ts
    const rxFile = Object.keys(results).find((k) =>
      k.includes("client/ApiClientRx.ts"),
    );
    ok(rxFile, "Expected ApiClientRx.ts");
    ok(
      results[rxFile].includes('from "./ApiClient.js"'),
      "Rx client must import shared types from ApiClient.js (single ApiError)",
    );
  });

  // ─── Custom query parameters ─────────────────────────────────────────────────

  it("allows additional custom query parameters alongside declared ones", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/widgets")
      interface Widgets {
        @get list(@query status?: string): string[];
      }
    `);

    const clientFile = Object.keys(results).find((k) =>
      k.includes("client/WidgetsClient.ts"),
    );
    ok(clientFile, "Expected client/WidgetsClient.ts");
    const content = results[clientFile];
    ok(
      content.includes("query?: { status?: string; [key: string]: unknown }"),
      "Expected declared query param plus an index signature for custom keys",
    );
    ok(
      content.includes("{ ...options, query }"),
      "Expected query to be merged into the request options",
    );
  });

  it("always exposes a query parameter even when the operation declares none", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
        @post create(@body body: Widget): Widget;
      }
    `);

    const clientFile = Object.keys(results).find((k) =>
      k.includes("client/WidgetsClient.ts"),
    );
    ok(clientFile, "Expected client/WidgetsClient.ts");
    const content = results[clientFile];
    const matches = content.match(/query\?: Record<string, unknown>/g);
    ok(
      matches && matches.length === 2,
      "Expected both list (GET) and create (POST) to accept an untyped query bag",
    );
  });

  // ─── deriveNpmVersion unit tests ─────────────────────────────────────────────

  describe("deriveNpmVersion", () => {
    const noVersions: never[] = [];

    it("returns npm-version option when set", () => {
      strictEqual(
        deriveNpmVersion(noVersions, { "npm-version": "5.0.0" }),
        "5.0.0",
      );
    });

    it("returns CalVer when no versions and no option", () => {
      match(deriveNpmVersion(noVersions, {}), /^\d{4}\.\d{2}\.\d{2}$/);
    });
  });
});

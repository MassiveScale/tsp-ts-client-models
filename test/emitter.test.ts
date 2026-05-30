import { strictEqual, ok, match } from "node:assert";
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/Items.ts to be emitted");
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
      (k) => k.endsWith("Widgets.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/Widgets.ts");
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/Items.ts");
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
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
    ok(content.includes('Red = "red"'), "Expected Red member");
    ok(content.includes('Green = "green"'), "Expected Green member");
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

  it("generates a CreateRequest interface excluding read-only properties for POST", async () => {
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
      content.includes("export interface ItemCreateRequest"),
      "Expected ItemCreateRequest interface",
    );
    ok(content.includes("name: string;"), "Expected name property");
    ok(content.includes("count: number;"), "Expected count property");
    ok(!content.includes("id: string"), "Read-only id should be excluded");
    ok(
      !content.includes("createdAt"),
      "Read-only createdAt should be excluded",
    );
  });

  it("generates an UpdateRequest interface excluding read-only and create-only properties for PATCH", async () => {
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
      content.includes("export interface ItemUpdateRequest"),
      "Expected ItemUpdateRequest",
    );
    ok(content.includes("name: string;"), "Expected name");
    ok(!content.includes("id: string"), "id should be excluded");
    ok(
      !content.includes("tenantId"),
      "create-only tenantId should be excluded from update",
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
        !results[modelsFile].includes("ItemCreateRequest"),
        "Should not emit ItemCreateRequest when all properties are writable",
      );
    }
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
      content.includes('export * from "./endpoints/Widgets.js"'),
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
    );

    ok(!v1File, "v1.0 folder should not be emitted by default");
    ok(
      endpointsFile,
      "Expected endpoints/Items.ts at root (no version folder in single-version mode)",
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/Items.ts");
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
      (k) => k.includes("v1.0") && k.endsWith("Items.ts"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("Items.ts"),
    );

    ok(v1File, "Expected v1.0/endpoints/Items.ts");
    ok(v2File, "Expected v2.0/endpoints/Items.ts");
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
    );
    ok(endpointsFile, "Expected endpoints/Items.ts");
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
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
      (k) => k.endsWith("Items.ts") && k.includes("endpoints"),
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
      (k) => k.endsWith("Widgets.ts") && k.includes("endpoints"),
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

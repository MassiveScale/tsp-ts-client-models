import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./test-host.js";

/** Emits a service whose single operation returns `responseType`. */
async function emitWith(
  declarations: string,
  responseType: string,
): Promise<Record<string, string>> {
  return emit(`
    import "@typespec/http";
    using Http;

    @service(#{ title: "Test API" })
    namespace TestApi {
      ${declarations}
      @route("/w") interface W { @get read(): ${responseType}; }
    }
  `);
}

describe("generic models", () => {
  it("declares type parameters in declaration order", async () => {
    const out = await emitWith(
      `model Two<A, B> { a: B; b: A; }`,
      "Two<string, boolean>",
    );
    ok(out["models.ts"].includes("export interface Two<A, B> {"));
    ok(out["client/WClient.ts"].includes("Promise<Two<string, boolean>>"));
  });

  it("declares a parameter used only inside a union", async () => {
    const out = await emitWith(`model Opt<T> { v: T | null; }`, "Opt<int32>");
    ok(out["models.ts"].includes("export interface Opt<T> {"));
    ok(out["models.ts"].includes("v: T | null;"));
  });

  it("declares a parameter no property uses", async () => {
    const out = await emitWith(
      `model Phantom<T> { x: string; }`,
      "Phantom<int32>",
    );
    ok(out["models.ts"].includes("export interface Phantom<T> {"));
  });

  it("declares a parameter used only by the base model", async () => {
    const out = await emitWith(
      `model Base<T> { b: T; } model Sub<T> extends Base<T> { s: string; }`,
      "Sub<string>",
    );
    ok(out["models.ts"].includes("export interface Sub<T> {"));
    ok(out["models.ts"].includes("b: T;"));
  });

  it("renders Record<T> of a template parameter with a string key", async () => {
    const out = await emitWith(`model Rec<T> { m: Record<T>; }`, "Rec<int32>");
    ok(out["models.ts"].includes("m: Record<string, T>;"));
    ok(!out["client/WClient.ts"].includes("Record,"));
  });
});

describe("inline types", () => {
  it("renders an inline response model as an object type", async () => {
    const out = await emitWith(
      `model Widget { id: string; }`,
      "{ items: Widget[]; total: int32 }",
    );
    ok(
      out["client/WClient.ts"].includes(
        "Promise<{ items: Widget[]; total: number }>",
      ),
    );
    ok(out["client/WClient.ts"].includes("import type { Widget }"));
  });

  it("leaves response metadata out of an inline response", async () => {
    const out = await emitWith(
      `model Widget { id: string; }`,
      "{ @header etag: string; @body body: Widget }",
    );
    ok(out["client/WClient.ts"].includes("Promise<Widget>"));
  });

  it("renders an inline property model as an object type", async () => {
    const out = await emitWith(
      `model Widget { inline: { a: string; b?: int32 }; }`,
      "Widget",
    );
    ok(out["models.ts"].includes("inline: { a: string; b?: number };"));
  });

  it("renders a tuple", async () => {
    const out = await emitWith(
      `model Widget { pair: [string, int32]; }`,
      "Widget",
    );
    ok(out["models.ts"].includes("pair: [string, number];"));
  });
});

describe("types from other namespaces", () => {
  it("emits referenced types declared in a sibling namespace", async () => {
    const out = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace MyOrg.Api {
        model Widget { price: MyOrg.Shared.Money; }
        @route("/w") interface W { @get read(): Widget; }
      }
      namespace MyOrg.Shared {
        model Money { amount: decimal; unit: Unit; }
        enum Unit { USD, EUR }
      }
    `);
    ok(out["models.ts"].includes("export interface Money {"));
    ok(out["models.ts"].includes("export enum Unit {"));
  });

  it("does not emit TypeSpec standard library models", async () => {
    const out = await emitWith(
      `model Widget { id: string; }`,
      "Widget | NotFoundResponse",
    );
    ok(!out["models.ts"].includes("NotFoundResponse"));
  });

  it("reports two different types with the same name", async () => {
    const [out, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace Api {
        model Holder { a: A.Widget; b: B.Widget; }
        @route("/w") interface W { @get read(): Holder; }
      }
      namespace A { model Widget { fromA: string; } }
      namespace B { model Widget { fromB: string; } }
    `);
    const duplicates = diagnostics.filter(
      (d) =>
        d.code === "@massivescale/tsp-ts-client-models/duplicate-type-name",
    );
    strictEqual(duplicates.length, 1, "Expected one report per name");
    strictEqual(duplicates[0].severity, "error");
    ok(duplicates[0].message.includes('"A"'));
    ok(duplicates[0].message.includes('"B"'));
    ok(out["models.ts"].includes("fromA: string;"), "The first one is kept");
    ok(!out["models.ts"].includes("fromB"));
  });

  it("does not report one type reached through several paths", async () => {
    const [, diagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace Api {
        model Widget { id: string; }
        model Holder { a: Widget; b: Widget[]; }
        @route("/w") interface W {
          @get read(): Holder;
          @get @route("x") other(): Widget;
        }
      }
    `);
    strictEqual(diagnostics.length, 0);
  });
});

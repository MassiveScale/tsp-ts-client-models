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

describe("wire types", () => {
  /** Emits `Widget` with the given properties and returns its body. */
  async function widget(props: string, extra = ""): Promise<string> {
    const out = await emitWith(`${extra} model Widget { ${props} }`, "Widget");
    const models = out["models.ts"];
    const start = models.indexOf("export interface Widget {");
    return models.slice(start, models.indexOf("\n}", start));
  }

  it("types dates and times as the strings JSON carries", async () => {
    const body = await widget(
      `a: utcDateTime; b: offsetDateTime; c: plainDate; d: plainTime; e: duration;`,
    );
    for (const p of ["a", "b", "c", "d", "e"]) {
      ok(body.includes(`${p}: string;`), `${p} should be a string\n${body}`);
    }
  });

  it("types bytes as the base64 string JSON carries", async () => {
    ok((await widget(`raw: bytes;`)).includes("raw: string;"));
  });

  it("types a unix-timestamp date as a number", async () => {
    const body = await widget(
      `@encode(DateTimeKnownEncoding.unixTimestamp, int32) at: utcDateTime;`,
    );
    ok(body.includes("at: number;"), body);
  });

  it("keeps an rfc7231 date a string", async () => {
    const body = await widget(
      `@encode(DateTimeKnownEncoding.rfc7231) at: utcDateTime;`,
    );
    ok(body.includes("at: string;"), body);
  });

  it("types a duration in seconds as a number", async () => {
    const body = await widget(
      `@encode(DurationKnownEncoding.seconds, int32) a: duration;
       @encode(DurationKnownEncoding.seconds, float64) b: duration;`,
    );
    ok(body.includes("a: number;") && body.includes("b: number;"), body);
  });

  it("keeps base64url bytes a string", async () => {
    const body = await widget(
      `@encode(BytesKnownEncoding.base64url) raw: bytes;`,
    );
    ok(body.includes("raw: string;"), body);
  });

  it("types a boolean encoded as a string as a string", async () => {
    ok((await widget(`@encode(string) on: boolean;`)).includes("on: string;"));
  });

  it("applies an @encode on the scalar declaration wherever it is used", async () => {
    const body = await widget(
      `at: Epoch; history: Epoch[];`,
      `@encode(DateTimeKnownEncoding.unixTimestamp, int64) scalar Epoch extends utcDateTime;`,
    );
    ok(body.includes("at: number;"), body);
    ok(body.includes("history: number[];"), body);
  });

  it("applies a parameter's @encode to its query type", async () => {
    const withQuery = await emit(`
      import "@typespec/http";
      using Http;
      @service(#{ title: "Test API" })
      namespace TestApi;
      @route("/w") interface W {
        @get list(
          @query @encode(DateTimeKnownEncoding.unixTimestamp, int32) since?: utcDateTime,
          @query until?: utcDateTime,
        ): string[];
      }
    `);
    ok(
      withQuery["client/WClient.ts"].includes(
        "query?: { since?: number; until?: string;",
      ),
      withQuery["client/WClient.ts"],
    );
  });
});

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

describe("write-only model suppression", () => {
  const spec = (operations: string) => `
    import "@typespec/http";
    using Http;

    @service(#{ title: "Test API" })
    namespace TestApi;

    model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
    model Gadget { @visibility(Lifecycle.Read) id: string; label: string; }
    model Order { @visibility(Lifecycle.Read) id: string; gadget: Gadget; }

    @route("/x") interface X { ${operations} }
  `;

  it("still suppresses a model used only as a filtered write body", async () => {
    const out = await emit(spec(`@post create(@body body: Widget): void;`));
    ok(out["models.ts"].includes("export interface WidgetPostRequest"));
    ok(!out["models.ts"].includes("export interface Widget {"));
  });

  it("emits a model a POST returns", async () => {
    const out = await emit(spec(`@post create(@body body: Widget): Widget;`));
    ok(out["models.ts"].includes("export interface Widget {"));
    ok(out["client/XClient.ts"].includes("Promise<Widget>"));
  });

  it("emits a model a request type's property references", async () => {
    const out = await emit(spec(`@post create(@body body: Order): void;`));
    ok(out["models.ts"].includes("export interface OrderPostRequest"));
    ok(out["models.ts"].includes("export interface Gadget {"));
  });

  it("emits a model an array body references", async () => {
    const out = await emit(spec(`@post create(@body body: Widget[]): void;`));
    ok(out["models.ts"].includes("export interface Widget {"));
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

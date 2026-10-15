import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./test-host.js";

const header = `
  import "@typespec/http";
  using Http;
`;

describe("operation grouping", () => {
  it("keeps the service name for operations declared in the service namespace", async () => {
    const out = await emit(`${header}
      @service(#{ title: "Test API" }) namespace PetStore;
      @route("/pets") @get op list(): string[];
    `);
    ok(out["endpoints/PetStoreEndpoints.ts"]);
    ok(out["client/PetStoreClient.ts"]);
  });

  it("gives each sub-namespace its own endpoints and client", async () => {
    const out = await emit(`${header}
      @service(#{ title: "Test API" }) namespace PetStore;
      model Pet { id: string; }
      namespace Pets { @route("/pets") @get op list(): Pet[]; }
      namespace Stores { @route("/stores") @get op list(): string[]; }
    `);
    ok(out["endpoints/PetsEndpoints.ts"].includes("`/api/pets`"));
    ok(out["endpoints/StoresEndpoints.ts"].includes("`/api/stores`"));
    ok(out["client/PetsClient.ts"].includes("Promise<Pet[]>"));
    ok(out["client/StoresClient.ts"].includes("Promise<string[]>"));
    strictEqual(out["endpoints/PetStoreEndpoints.ts"], undefined);
  });

  it("names a nested sub-namespace after its own name", async () => {
    const out = await emit(`${header}
      @service(#{ title: "Test API" }) namespace PetStore;
      namespace Admin.Audit { @route("/audit") @get op list(): string[]; }
    `);
    ok(out["endpoints/AuditEndpoints.ts"]);
  });

  it("qualifies interfaces that share a name across namespaces", async () => {
    const [out, diagnostics] = await emitWithDiagnostics(`${header}
      @service(#{ title: "Test API" }) namespace PetStore;
      namespace Pets { @route("/pets") interface Ops { @get list(): string[]; } }
      namespace Stores { @route("/stores") interface Ops { @get list(): string[]; } }
    `);
    deepStrictEqual(diagnostics, []);
    ok(out["endpoints/PetsOpsEndpoints.ts"].includes("`/api/pets`"));
    ok(out["endpoints/StoresOpsEndpoints.ts"].includes("`/api/stores`"));
    ok(out["client/PetsOpsClient.ts"]);
    ok(out["client/StoresOpsClient.ts"]);
  });

  it("does not qualify an interface whose name is unique", async () => {
    const out = await emit(`${header}
      @service(#{ title: "Test API" }) namespace PetStore;
      namespace Pets { @route("/pets") interface Ops { @get list(): string[]; } }
    `);
    ok(out["endpoints/OpsEndpoints.ts"]);
  });

  it("numbers groups whose qualified names still collide", async () => {
    const out = await emit(`${header}
      @service(#{ title: "Test API" }) namespace PetStore;
      namespace ab { @route("/a") interface Cd { @get a(): string[]; } }
      namespace Ab { @route("/b") interface Cd { @get b(): string[]; } }
    `);
    ok(out["endpoints/AbCdEndpoints.ts"].includes("`/api/a`"));
    ok(out["endpoints/AbCd2Endpoints.ts"].includes("`/api/b`"));
  });
});

describe("multiple services", () => {
  const twoServices = `${header}
    @service(#{ title: "A" }) namespace Alpha.Store {
      model Foo { a: string; }
      @route("/a") @get op getA(): Foo;
    }
    @service(#{ title: "B" }) namespace Beta {
      model Bar { b: string; }
      @route("/b") @get op getB(): Bar;
    }
  `;

  it("emits each service into its own subfolder and package", async () => {
    const [out] = await emitWithDiagnostics(twoServices);
    ok(out["alpha-store/models.ts"].includes("export interface Foo"));
    ok(!out["alpha-store/models.ts"].includes("Bar"));
    ok(out["beta/models.ts"].includes("export interface Bar"));
    strictEqual(
      JSON.parse(out["alpha-store/package.json"]).name,
      "alpha-store",
    );
    strictEqual(JSON.parse(out["beta/package.json"]).name, "beta");
    strictEqual(out["models.ts"], undefined);
    strictEqual(out["package.json"], undefined);
  });

  it("warns that the services were split into subfolders", async () => {
    const [, diagnostics] = await emitWithDiagnostics(twoServices);
    strictEqual(diagnostics.length, 1);
    strictEqual(
      diagnostics[0].code,
      "@massivescale/tsp-ts-client-models/multiple-services",
    );
    ok(diagnostics[0].message.includes("alpha-store, beta"));
    ok(!diagnostics[0].message.includes("npm-package-name"));
  });

  it("ignores npm-package-name, and says so", async () => {
    const [out, diagnostics] = await emitWithDiagnostics(twoServices, {
      "npm-package-name": "@org/client",
    });
    strictEqual(JSON.parse(out["beta/package.json"]).name, "beta");
    ok(diagnostics[0].message.includes("npm-package-name"));
  });

  it("numbers services whose namespaces normalize to the same folder", async () => {
    const [out] = await emitWithDiagnostics(`${header}
      @service(#{ title: "A" }) namespace FooBar {
        @route("/a") @get op a(): string;
      }
      @service(#{ title: "B" }) namespace Foo.Bar {
        @route("/b") @get op b(): string;
      }
    `);
    strictEqual(JSON.parse(out["foo-bar/package.json"]).name, "foo-bar");
    strictEqual(JSON.parse(out["foo-bar-2/package.json"]).name, "foo-bar-2");
    ok(out["foo-bar/endpoints/FooBarEndpoints.ts"]);
    ok(out["foo-bar-2/endpoints/BarEndpoints.ts"]);
  });

  it("does not count a service without operations", async () => {
    const [out, diagnostics] = await emitWithDiagnostics(`${header}
      @service(#{ title: "A" }) namespace Alpha {
        @route("/a") @get op getA(): string;
      }
      @service(#{ title: "Empty" }) namespace Empty {}
    `);
    deepStrictEqual(diagnostics, []);
    ok(out["endpoints/AlphaEndpoints.ts"]);
  });
});

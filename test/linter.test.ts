import { beforeEach, describe, it } from "node:test";
import {
  createLinterRuleTester,
  LinterRuleTester,
} from "@typespec/compiler/testing";
import { BaseTester } from "./test-host.js";
import { synthesizedRequestTypeCollisionRule } from "../src/rules/synthesized-request-type-collision.js";

describe("synthesized-request-type-collision lint rule", () => {
  let ruleTester: LinterRuleTester;

  beforeEach(async () => {
    const runner = await BaseTester.createInstance();
    ruleTester = createLinterRuleTester(
      runner,
      synthesizedRequestTypeCollisionRule,
      "@massivescale/tsp-ts-client-models",
    );
  });

  it("reports a diagnostic when two operations would synthesize a same-named request type with different shapes and no @tag", async () => {
    await ruleTester
      .expect(`
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
      `)
      .toEmitDiagnostics({
        code: "@massivescale/tsp-ts-client-models/synthesized-request-type-collision",
      });
  });

  it("is valid when colliding operations are disambiguated with @tag", async () => {
    await ruleTester
      .expect(`
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
      `)
      .toBeValid();
  });

  it("is valid when two operations synthesize the same request type with identical shapes", async () => {
    await ruleTester
      .expect(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget {
          @visibility(TypeSpec.Lifecycle.Read)
          id: string;
          name: string;
        }

        @route("/widgets")
        interface Widgets {
          @patch update(@path id: string, @body body: Widget): Widget;
        }

        @route("/widgets2")
        interface Widgets2 {
          @patch update2(@path id: string, @body body: Widget): Widget;
        }
      `)
      .toBeValid();
  });
});

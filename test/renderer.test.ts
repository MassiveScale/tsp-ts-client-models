import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createRenderer } from "../src/renderer.js";
import { resolveTemplateOverrides } from "../src/emitter.js";

describe("renderer", () => {
  it("normalizes CRLF template line endings to LF", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsp-ts-renderer-"));
    try {
      const path = join(dir, "enum.hbs");
      writeFileSync(path, "export enum {{enumName}} {\r\n}\r\n", "utf-8");
      const output = createRenderer({ enum: path }).renderEnum({
        enumName: "Color",
        members: [],
      });
      strictEqual(output, "export enum Color {\n}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes a lone CR line ending to LF", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsp-ts-renderer-"));
    try {
      const path = join(dir, "union.hbs");
      writeFileSync(path, "type {{unionName}} = A;\rexport {};\r", "utf-8");
      const output = createRenderer({ union: path }).renderUnion({
        unionName: "Pet",
        memberNames: [],
      });
      strictEqual(output, "type Pet = A;\nexport {};\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits only LF line endings from the bundled templates", () => {
    const renderer = createRenderer();
    const output = renderer.renderIndex({ exports: ["./models.js"] });
    ok(!output.includes("\r"), "Bundled templates must not emit CR");
  });
});

describe("resolveTemplateOverrides", () => {
  const root = resolve("/projects/my-api");

  it("returns an empty map when no overrides are configured", () => {
    strictEqual(
      Object.keys(resolveTemplateOverrides(undefined, root)).length,
      0,
    );
  });

  it("resolves relative paths against the project root, not the cwd", () => {
    const result = resolveTemplateOverrides(
      { enum: "./templates/enum.hbs" },
      root,
    );
    strictEqual(result.enum, resolve(root, "templates/enum.hbs"));
  });

  it("keeps absolute paths unchanged", () => {
    const absolute = resolve("/shared/templates/client.hbs");
    const result = resolveTemplateOverrides({ client: absolute }, root);
    strictEqual(result.client, absolute);
  });

  it("skips empty override values", () => {
    const result = resolveTemplateOverrides({ file: "" }, root);
    strictEqual(result.file, undefined);
  });
});

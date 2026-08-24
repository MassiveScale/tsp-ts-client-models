import { strictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import type { Model, ModelProperty } from "@typespec/compiler";
import {
  capitalize,
  discriminatedVariantShapesMatch,
  flattenProperties,
  getMergePatchBaseName,
  propsHaveSameKeys,
  requestTypeSuffix,
} from "../src/request-types.js";

/** Builds a fake `ModelProperty`-shaped object for tests that only need a
 * distinct identity (map key equality) — none of the functions under test
 * inspect anything beyond property identity/keys here. */
function fakeProp(name: string): ModelProperty {
  return { name } as unknown as ModelProperty;
}

/** Builds a fake `Model`-shaped object carrying just the fields
 * `flattenProperties` reads: `baseModel` and `properties`. */
function fakeModel(
  propNames: string[],
  baseModel?: Model,
): Model {
  const properties = new Map<string, ModelProperty>();
  for (const name of propNames) properties.set(name, fakeProp(name));
  return { baseModel, properties } as unknown as Model;
}

describe("request-types", () => {
  describe("capitalize", () => {
    it("capitalizes the first character", () => {
      strictEqual(capitalize("post"), "Post");
    });

    it("leaves an already-capitalized string unchanged", () => {
      strictEqual(capitalize("Patch"), "Patch");
    });

    it("returns an empty string unchanged", () => {
      strictEqual(capitalize(""), "");
    });

    it("capitalizes a single character", () => {
      strictEqual(capitalize("x"), "X");
    });
  });

  describe("requestTypeSuffix", () => {
    it("capitalizes the HTTP verb", () => {
      strictEqual(requestTypeSuffix("post"), "Post");
      strictEqual(requestTypeSuffix("patch"), "Patch");
      strictEqual(requestTypeSuffix("put"), "Put");
    });
  });

  describe("getMergePatchBaseName", () => {
    it("strips the MergePatchUpdate suffix", () => {
      strictEqual(getMergePatchBaseName("PetMergePatchUpdate"), "Pet");
    });

    it("strips the MergePatchUpdateReplaceOnly suffix", () => {
      strictEqual(
        getMergePatchBaseName("PetMergePatchUpdateReplaceOnly"),
        "Pet",
      );
    });

    it("strips the MergePatchCreateOrUpdate suffix", () => {
      strictEqual(getMergePatchBaseName("PetMergePatchCreateOrUpdate"), "Pet");
    });

    it("returns undefined for a name with no synthesized suffix", () => {
      strictEqual(getMergePatchBaseName("Pet"), undefined);
    });

    it("returns undefined for a name that only partially matches a suffix", () => {
      strictEqual(getMergePatchBaseName("PetMergePatch"), undefined);
    });
  });

  describe("propsHaveSameKeys", () => {
    it("returns true for maps with identical keys", () => {
      const a = new Map([["id", fakeProp("id")], ["name", fakeProp("name")]]);
      const b = new Map([["id", fakeProp("id")], ["name", fakeProp("name")]]);
      ok(propsHaveSameKeys(a, b));
    });

    it("returns false when sizes differ", () => {
      const a = new Map([["id", fakeProp("id")]]);
      const b = new Map([["id", fakeProp("id")], ["name", fakeProp("name")]]);
      ok(!propsHaveSameKeys(a, b));
    });

    it("returns false when sizes match but keys differ", () => {
      const a = new Map([["id", fakeProp("id")]]);
      const b = new Map([["ownerId", fakeProp("ownerId")]]);
      ok(!propsHaveSameKeys(a, b));
    });

    it("returns true for two empty maps", () => {
      ok(propsHaveSameKeys(new Map(), new Map()));
    });
  });

  describe("discriminatedVariantShapesMatch", () => {
    it("returns true when every variant has the same property keys", () => {
      const a = new Map([
        ["Dog", new Map([["isBarker", fakeProp("isBarker")]])],
        ["Cat", new Map([["isPurrer", fakeProp("isPurrer")]])],
      ]);
      const b = new Map([
        ["Dog", new Map([["isBarker", fakeProp("isBarker")]])],
        ["Cat", new Map([["isPurrer", fakeProp("isPurrer")]])],
      ]);
      ok(discriminatedVariantShapesMatch(a, b));
    });

    it("returns false when the variant sets differ in size", () => {
      const a = new Map([["Dog", new Map([["isBarker", fakeProp("isBarker")]])]]);
      const b = new Map([
        ["Dog", new Map([["isBarker", fakeProp("isBarker")]])],
        ["Cat", new Map([["isPurrer", fakeProp("isPurrer")]])],
      ]);
      ok(!discriminatedVariantShapesMatch(a, b));
    });

    it("returns false when a variant is missing on one side", () => {
      const a = new Map([["Dog", new Map([["isBarker", fakeProp("isBarker")]])]]);
      const b = new Map([["Cat", new Map([["isPurrer", fakeProp("isPurrer")]])]]);
      ok(!discriminatedVariantShapesMatch(a, b));
    });

    it("returns false when a shared variant's property keys differ", () => {
      const a = new Map([["Dog", new Map([["isBarker", fakeProp("isBarker")]])]]);
      const b = new Map([["Dog", new Map([["ownerId", fakeProp("ownerId")]])]]);
      ok(!discriminatedVariantShapesMatch(a, b));
    });
  });

  describe("flattenProperties", () => {
    it("returns own properties for a model with no base model", () => {
      const model = fakeModel(["id", "name"]);
      const result = flattenProperties(model);
      strictEqual(result.size, 2);
      ok(result.has("id"));
      ok(result.has("name"));
    });

    it("merges inherited properties with own properties", () => {
      const base = fakeModel(["id"]);
      const derived = fakeModel(["name"], base);
      const result = flattenProperties(derived);
      strictEqual(result.size, 2);
      ok(result.has("id"));
      ok(result.has("name"));
    });

    it("lets a derived property shadow an inherited one of the same name", () => {
      const base = fakeModel(["name"]);
      const baseNameProp = base.properties.get("name")!;
      const derived = fakeModel(["name"], base);
      const derivedNameProp = derived.properties.get("name")!;
      const result = flattenProperties(derived);
      strictEqual(result.size, 1);
      strictEqual(result.get("name"), derivedNameProp);
      ok(result.get("name") !== baseNameProp);
    });

    it("walks multiple levels of inheritance", () => {
      const grandparent = fakeModel(["a"]);
      const parent = fakeModel(["b"], grandparent);
      const child = fakeModel(["c"], parent);
      const result = flattenProperties(child);
      strictEqual(result.size, 3);
      ok(result.has("a") && result.has("b") && result.has("c"));
    });
  });
});

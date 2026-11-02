import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import {
  buildInterfaceTree,
  buildPathTree,
  camelCase,
  firstItem,
  parseRoute,
  pascalCase,
  placeholderNames,
  splitSegments,
  stepName,
  walkTree,
  type TreeNode,
  type TreeOperation,
} from "../src/client-tree.js";

/**
 * An operation for a tree, carrying its own name. Every path parameter is
 * required unless listed in `optional`.
 */
function op(
  name: string,
  group: string,
  path: string,
  optional: string[] = [],
): TreeOperation<string> {
  return {
    value: name,
    path,
    group,
    requiredParams: new Set(
      placeholderNames(path).filter((p) => !optional.includes(p)),
    ),
  };
}

/**
 * Renders a tree as one line per builder: the chain that reaches it, its class
 * stem, and the operations sent from it with their bound parameters.
 */
function describeTree(node: TreeNode<string>, chain = "client"): string[] {
  const items = node.items
    .map(
      (i) =>
        `${i.value}(${[...i.bound].map(([k, v]) => `${k}=${v}`).join(",")})`,
    )
    .join(" ");
  const lines =
    node.kind === "root" ? [] : [`${chain} [${node.stem}] ${items}`.trim()];
  for (const child of node.children) {
    const step =
      child.kind === "parameter"
        ? `${chain}.by(${child.name})`
        : `${chain}.${child.name}`;
    lines.push(...describeTree(child, step));
  }
  return lines;
}

describe("route parsing", () => {
  it("splits on slashes outside expressions and drops empty segments", () => {
    deepStrictEqual(splitSegments("/a//b{/c}/d/"), ["a", "b{/c}", "d"]);
    deepStrictEqual(splitSegments("/"), []);
  });

  it("lists placeholder names, ignoring operators and explode markers", () => {
    deepStrictEqual(placeholderNames("/a/{x}/{+y}{/z*}{?q}"), [
      "x",
      "y",
      "z",
      "q",
    ]);
  });

  it("names literal segments in camelCase", () => {
    strictEqual(stepName("encoded-params"), "encodedParams");
    strictEqual(stepName("Stores"), "stores");
    strictEqual(stepName("a_b.c d"), "aBCD");
    strictEqual(stepName("$count"), "$count");
  });

  it("rejects segments that are not identifiers or hold an expression", () => {
    strictEqual(stepName("2fa"), undefined);
    strictEqual(stepName("items:batch"), undefined);
    strictEqual(stepName("{id}"), undefined);
    strictEqual(stepName("a}"), undefined);
    strictEqual(stepName("---"), undefined);
  });

  it("changes the case of the first character only", () => {
    strictEqual(camelCase("PetsOps"), "petsOps");
    strictEqual(pascalCase("storeId"), "StoreId");
    strictEqual(camelCase(""), "");
  });

  it("turns literal and parameter segments into steps", () => {
    deepStrictEqual(
      parseRoute("/stores/{storeId}/pets", new Set(["storeId"])),
      [
        { kind: "property", name: "stores", path: "/stores" },
        { kind: "parameter", name: "storeId", path: "/stores/{storeId}" },
        { kind: "property", name: "pets", path: "/stores/{storeId}/pets" },
      ],
    );
  });

  it("stops at a mixed segment, an invalid name, an optional or an operator parameter", () => {
    deepStrictEqual(
      parseRoute("/reports/{from}-{to}/x", new Set(["from", "to"])).map(
        (l) => l.name,
      ),
      ["reports"],
    );
    deepStrictEqual(
      parseRoute("/a/2fa/b", new Set()).map((l) => l.name),
      ["a"],
    );
    deepStrictEqual(
      parseRoute("/files/{name}/meta", new Set()).map((l) => l.name),
      ["files"],
    );
    deepStrictEqual(
      parseRoute("/files/{+path}", new Set(["path"])).map((l) => l.name),
      ["files"],
    );
  });
});

describe("path tree", () => {
  it("builds one builder per segment and binds parameters by position", () => {
    const root = buildPathTree([
      op("listStores", "Stores", "/stores"),
      op("readStore", "Stores", "/stores/{storeId}"),
      op("listPets", "Pets", "/stores/{storeId}/pets"),
      op("readPet", "Pets", "/stores/{storeId}/pets/{petId}"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.stores [Stores] listStores()",
      "client.stores.by(storeId) [StoresItem] readStore(storeId=0)",
      "client.stores.by(storeId).pets [StoresItemPets] listPets(storeId=0)",
      "client.stores.by(storeId).pets.by(petId) [StoresItemPetsItem] readPet(storeId=0,petId=1)",
    ]);
  });

  it("merges parameters of different names in one place, the first naming the step", () => {
    const root = buildPathTree([
      op("read", "Stores", "/stores/{storeId}"),
      op("pets", "Pets", "/stores/{id}/pets"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.stores [Stores]",
      "client.stores.by(storeId) [StoresItem] read(storeId=0)",
      "client.stores.by(storeId).pets [StoresItemPets] pets(id=0)",
    ]);
  });

  it("takes leading parameters as a step of the client", () => {
    const root = buildPathTree([
      op("read", "TenantSettings", "/{tenant}/settings"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.by(tenant) [Item]",
      "client.by(tenant).settings [ItemSettings] read(tenant=0)",
    ]);
  });

  it("leaves the parameters after the chain to the method", () => {
    const root = buildPathTree([
      op("range", "Reports", "/reports/{from}-{to}"),
      op("file", "Files", "/files/{name}", ["name"]),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.reports [Reports] range()",
      "client.files [Files] file()",
    ]);
  });

  it("reaches a route with no step by its group's name", () => {
    const root = buildPathTree([
      op("check", "Health", "/"),
      op("range", "Reports", "/{from}-{to}"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.health [Health] check()",
      "client.reports [Reports] range()",
    ]);
  });

  it("numbers sibling stems that match without regard to case", () => {
    const root = buildPathTree([
      op("named", "A", "/stores/item"),
      op("byId", "A", "/stores/{id}"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.stores [Stores]",
      "client.stores.item [StoresItem] named()",
      "client.stores.by(id) [StoresItem2] byId(id=0)",
    ]);
  });
});

describe("interface tree", () => {
  it("nests an interface under the operation whose route its own start with", () => {
    const root = buildInterfaceTree([
      op("list", "Stores", "/stores"),
      op("read", "Stores", "/stores/{storeId}"),
      op("listPets", "Pets", "/stores/{storeId}/pets"),
      op("readPet", "Pets", "/stores/{storeId}/pets/{petId}"),
      op("toys", "Toys", "/stores/{storeId}/pets/{petId}/toys"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.stores [Stores] list()",
      "client.stores.by(storeId) [StoresItem] read(storeId=0)",
      "client.stores.by(storeId).pets [StoresItemPets] listPets(storeId=0)",
      "client.stores.by(storeId).pets.by(petId) [StoresItemPetsItem] readPet(storeId=0,petId=1)",
      "client.stores.by(storeId).pets.by(petId).toys [StoresItemPetsItemToys] toys(storeId=0,petId=1)",
    ]);
  });

  it("keeps an interface with no parent on the client, with its parameters as steps", () => {
    const root = buildInterfaceTree([
      op("read", "Community", "/communities/{key}/configuration"),
      op("range", "Reports", "/reports/{from}-{to}"),
      op("check", "Health", "/"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.community [Community]",
      "client.community.by(key) [CommunityItem] read(key=0)",
      "client.reports [Reports]",
      "client.reports.by(from) [ReportsItem]",
      "client.reports.by(from).by(to) [ReportsItemItem] range(from=0,to=1)",
      "client.health [Health] check()",
    ]);
  });

  it("prefers the longest parent route and never a route of /", () => {
    const root = buildInterfaceTree([
      op("check", "Health", "/"),
      op("community", "Community", "/communities/{key}"),
      op("config", "Configuration", "/communities/{key}/configuration"),
      op("rewards", "Rewards", "/communities/{key}/configuration/rewards"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.health [Health] check()",
      "client.community [Community]",
      "client.community.by(key) [CommunityItem] community(key=0)",
      "client.community.by(key).configuration [CommunityItemConfiguration] config(key=0)",
      "client.community.by(key).configuration.rewards [CommunityItemConfigurationRewards] rewards(key=0)",
    ]);
  });

  it("does not nest under a route whose parameters are not all steps", () => {
    const root = buildInterfaceTree([
      op("file", "Files", "/files/{name}", ["name"]),
      op("meta", "Meta", "/files/{name}/meta"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.files [Files] file()",
      "client.meta [Meta]",
      "client.meta.by(name) [MetaItem] meta(name=0)",
    ]);
  });

  it("does not nest an interface whose own operation leaves a shared parameter optional", () => {
    const root = buildInterfaceTree([
      op("store", "Stores", "/stores/{id}"),
      op("pets", "Pets", "/stores/{id}/pets", ["id"]),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.stores [Stores]",
      "client.stores.by(id) [StoresItem] store(id=0)",
      "client.pets [Pets] pets()",
    ]);
  });

  it("matches parameter segments of different names when nesting", () => {
    const root = buildInterfaceTree([
      op("store", "Stores", "/stores/{storeId}"),
      op("pets", "Pets", "/stores/{id}/pets"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.stores [Stores]",
      "client.stores.by(storeId) [StoresItem] store(storeId=0)",
      "client.stores.by(storeId).pets [StoresItemPets] pets(id=0)",
    ]);
  });

  it("only nests under a route that is a strict prefix of every route of the interface", () => {
    const root = buildInterfaceTree([
      op("a", "A", "/x/y"),
      op("b1", "B", "/x/y/z"),
      op("b2", "B", "/x/w"),
    ]);

    deepStrictEqual(describeTree(root), [
      "client.a [A] a()",
      "client.b [B] b1() b2()",
    ]);
  });
});

describe("tree helpers", () => {
  it("walks every builder, parents first", () => {
    const root = buildPathTree([op("a", "G", "/a/b"), op("c", "G", "/c")]);

    deepStrictEqual(
      walkTree(root).map((n) => n.stem),
      ["", "A", "AB", "C"],
    );
  });

  it("finds the first operation reached from a builder", () => {
    const root = buildPathTree([op("deep", "G", "/a/b"), op("c", "G", "/c")]);

    strictEqual(firstItem(root), "deep");
    strictEqual(firstItem(root.children[1]), "c");
    strictEqual(firstItem({ ...root, children: [] }), undefined);
  });
});

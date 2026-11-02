/**
 * The request-builder trees of the `path` and `interface` client shapes: which
 * builder each operation is sent from, and the steps that lead to it from the
 * root client. It works on route templates and names only, so it depends on
 * nothing from the TypeSpec compiler.
 */

/** How the generated client chains its calls, from the `client-shape` option. */
export type ClientShape = "flat" | "path" | "interface";

/** How a builder is reached from the one before it. */
export type StepKind = "property" | "parameter";

/** An operation to place into a tree. */
export interface TreeOperation<T> {
  /** What the tree carries for the operation. */
  value: T;
  /** The route template without the route prefix, e.g. `/stores/{storeId}/pets`. */
  path: string;
  /** The wire names of the operation's required path parameters. */
  requiredParams: ReadonlySet<string>;
  /** The name of the interface or namespace that declares the operation, e.g. `Pets`. */
  group: string;
}

/** An operation sent from a builder. */
export interface TreeItem<T> {
  /** What the tree carries for the operation. */
  value: T;
  /**
   * The operation's path parameters the builder holds, by wire name, each with
   * its position in the builder's path parameter values. Every other path
   * parameter is an argument of the operation's method.
   */
  bound: ReadonlyMap<string, number>;
}

/** A request builder: the operations sent from it, and the builders reached from it. */
export interface TreeNode<T> {
  /** How the parent reaches it; `root` for the client itself. */
  kind: StepKind | "root";
  /**
   * For a `property` step, the property name (`stores`). For a `parameter`
   * step, the wire name of the parameter it takes (`storeId`), from the first
   * route that reaches it.
   */
  name: string;
  /** How many path parameter values the builder holds: its own and its ancestors'. */
  depth: number;
  /** The route template the builder stands for, e.g. `/stores/{storeId}`, when it stands for one. */
  path?: string;
  /** The interface or namespace the builder is named after, when it is named after one. */
  group?: string;
  /** The class name without its suffix, e.g. `StoresItem`; empty for the root. */
  stem: string;
  /** The operations sent from the builder, in declaration order. */
  items: TreeItem<T>[];
  /** The builders reached from it, in the order their steps first appear. */
  children: TreeNode<T>[];
}

/** One step of a parsed route. */
export interface RouteLink {
  /** Whether the step is a literal segment or a parameter segment. */
  kind: StepKind;
  /** The property name of a literal segment, or the wire name of a parameter. */
  name: string;
  /** The route template up to and including the step. */
  path: string;
}

/** A segment that is nothing but one expression, `{name}`. */
const PARAM_SEGMENT = /^\{([^{}]+)\}$/;

/** Every expression of a route template, with the parameter name it holds. */
const PLACEHOLDER = /\{[+#./;?&]?([^}*]+)\*?\}/g;

/** A valid JavaScript identifier (ASCII subset). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Splits a route template into its segments, ignoring empty ones. A `/` inside
 * an expression (`{/name}`) does not split it.
 *
 * @param path - The route template.
 * @returns The segments, as written.
 */
export function splitSegments(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  for (const c of path) {
    if (c === "{") depth++;
    if (c === "}") depth = Math.max(0, depth - 1);
    if (c === "/" && depth === 0) {
      if (current) segments.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * The parameter names a piece of route template holds, in order.
 *
 * @param path - The route template, or a part of it.
 * @returns The names.
 */
export function placeholderNames(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * The parameter a segment consists of, when it is nothing but one expression.
 *
 * @param segment - The segment.
 * @returns The expression's text, e.g. `storeId`, or `undefined`.
 */
function paramOf(segment: string): string | undefined {
  return PARAM_SEGMENT.exec(segment)?.[1];
}

/**
 * Lower-cases the first character of a name: `PetsOps` → `petsOps`.
 *
 * @param name - The name.
 * @returns The camelCase name.
 */
export function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Upper-cases the first character of a name: `storeId` → `StoreId`.
 *
 * @param name - The name.
 * @returns The PascalCase name.
 */
export function pascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The property name of a literal segment: its words joined in camelCase, the
 * words being separated by `-`, `_`, `.` or spaces (`encoded-params` →
 * `encodedParams`).
 *
 * @param segment - The segment.
 * @returns The name, or `undefined` when the segment holds an expression or
 *   does not make a JavaScript identifier (`2fa`, `items:batch`).
 */
export function stepName(segment: string): string | undefined {
  if (segment.includes("{") || segment.includes("}")) return undefined;
  const name = camelCase(
    segment
      .split(/[-_.\s]+/)
      .filter((word) => word.length > 0)
      .map(pascalCase)
      .join(""),
  );
  return IDENTIFIER.test(name) ? name : undefined;
}

/**
 * Splits a route template into the steps a `path` client reaches it by: each
 * literal segment is a property, and each segment that is one required path
 * parameter is a `by<Param>` step. The chain ends at the first segment that can
 * be neither (`{from}-{to}`, `2fa`, an optional parameter); every parameter
 * from there on is an argument of the operation's method.
 *
 * @param path - The route template, without the route prefix.
 * @param required - The wire names of the operation's required path parameters.
 * @returns The steps, in path order.
 */
export function parseRoute(
  path: string,
  required: ReadonlySet<string>,
): RouteLink[] {
  const links: RouteLink[] = [];
  let current = "";
  for (const segment of splitSegments(path)) {
    const param = paramOf(segment);
    const name = param === undefined ? stepName(segment) : undefined;
    if (param !== undefined ? !required.has(param) : name === undefined) break;
    current += `/${segment}`;
    links.push(
      param !== undefined
        ? { kind: "parameter", name: param, path: current }
        : { kind: "property", name: name!, path: current },
    );
  }
  return links;
}

/**
 * A new, empty root of a tree.
 *
 * @returns The root.
 */
function newRoot<T>(): TreeNode<T> {
  return {
    kind: "root",
    name: "",
    depth: 0,
    stem: "",
    items: [],
    children: [],
  };
}

/**
 * Finds the builder a step reaches from `parent`, or adds it. Property steps
 * with the same name reach the same builder. A builder has at most one
 * parameter step, so every parameter in that place reaches it, whatever it is
 * called; the first route to reach it names it.
 *
 * @param parent - The builder the step is taken from.
 * @param kind - The kind of step.
 * @param name - The property name, or the parameter's wire name.
 * @param details - The route the step stands for, or the group it is named after.
 * @param details.path - The route template, if any.
 * @param details.group - The interface or namespace, if any.
 * @returns The builder.
 */
function reach<T>(
  parent: TreeNode<T>,
  kind: StepKind,
  name: string,
  details: { path?: string; group?: string },
): TreeNode<T> {
  const found = parent.children.find(
    (c) => c.kind === kind && (kind === "parameter" || c.name === name),
  );
  if (found) return found;
  const node: TreeNode<T> = {
    kind,
    name,
    depth: parent.depth + (kind === "parameter" ? 1 : 0),
    stem: "",
    items: [],
    children: [],
  };
  if (details.path !== undefined) node.path = details.path;
  if (details.group !== undefined) node.group = details.group;
  parent.children.push(node);
  return node;
}

/**
 * Names every builder's class stem after the steps that lead to it: a property
 * adds its name in PascalCase, a parameter adds `Item`, as Kiota does
 * (`stores.byStoreId(id).pets` → `StoresItemPets`). Siblings whose stems would
 * match get a number.
 *
 * @param node - The builder whose children to name.
 */
function assignStems<T>(node: TreeNode<T>): void {
  const taken = new Set<string>();
  for (const child of node.children) {
    const base = `${node.stem}${child.kind === "parameter" ? "Item" : pascalCase(child.name)}`;
    let stem = base;
    for (let n = 2; taken.has(stem.toLowerCase()); n++) stem = `${base}${n}`;
    taken.add(stem.toLowerCase());
    child.stem = stem;
    assignStems(child);
  }
}

/**
 * Builds the `path` tree: every literal segment of a route is a property, and
 * every segment that is one required path parameter is a `by<Param>` step. An
 * operation whose route has no step at all (`/`, or a route that starts with a
 * mixed segment) is reached by its group's name instead.
 *
 * @param ops - The operations, in declaration order.
 * @returns The root client, with every builder reached from it.
 */
export function buildPathTree<T>(
  ops: readonly TreeOperation<T>[],
): TreeNode<T> {
  const root = newRoot<T>();
  for (const op of ops) {
    const links = parseRoute(op.path, op.requiredParams);
    const bound = new Map<string, number>();
    let node =
      links.length === 0
        ? reach(root, "property", camelCase(op.group), { group: op.group })
        : root;
    for (const link of links) {
      node = reach(node, link.kind, link.name, { path: link.path });
      if (link.kind === "parameter") bound.set(link.name, node.depth - 1);
    }
    node.items.push({ value: op.value, bound });
  }
  assignStems(root);
  return root;
}

/**
 * Whether a route starts with the given segments. A parameter segment matches
 * any parameter segment, since the names of one parameter can differ between
 * routes; any other segment must be the same text.
 *
 * @param prefix - The segments of the shorter route.
 * @param path - The segments of the longer route.
 * @returns `true` when `path` starts with `prefix`.
 */
function startsWith(
  prefix: readonly string[],
  path: readonly string[],
): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((segment, i) => {
      const a = paramOf(segment);
      const b = paramOf(path[i]);
      return a !== undefined || b !== undefined
        ? a !== undefined && b !== undefined
        : segment === path[i];
    })
  );
}

/**
 * The longest run of segments every route starts with, comparing parameter
 * segments as {@link startsWith} does.
 *
 * @param routes - The segments of each route; at least one.
 * @returns The common segments, as the first route writes them.
 */
function commonPrefix(routes: readonly string[][]): string[] {
  const [first, ...rest] = routes;
  let length = first.length;
  for (const route of rest) {
    let i = 0;
    while (
      i < Math.min(length, route.length) &&
      startsWith([first[i]], [route[i]])
    ) {
      i++;
    }
    length = i;
  }
  return first.slice(0, length);
}

/**
 * The wire names of an operation's required path parameters, in route order.
 *
 * @param op - The operation.
 * @returns The names, each once.
 */
function linkParams<T>(op: TreeOperation<T>): string[] {
  return [...new Set(placeholderNames(op.path))].filter((name) =>
    op.requiredParams.has(name),
  );
}

/**
 * Builds the `interface` tree: each interface is a property, and each required
 * path parameter its operation adds is a `by<Param>` step after it. An
 * interface hangs under the builder of another interface's operation whose
 * route every route of the interface starts with, and takes only the path
 * parameters that route does not hold (`/stores/{storeId}/pets/{petId}` under
 * `stores.byStoreId(id)` is `.pets.byPetId(petId)`). The longest such route
 * wins, and a route of `/` never does. An interface with no such parent is a
 * property of the root client.
 *
 * @param ops - The operations, in declaration order.
 * @returns The root client, with every builder reached from it.
 */
export function buildInterfaceTree<T>(
  ops: readonly TreeOperation<T>[],
): TreeNode<T> {
  const root = newRoot<T>();
  const groups = new Map<string, TreeOperation<T>[]>();
  for (const op of ops) {
    const list = groups.get(op.group) ?? [];
    list.push(op);
    groups.set(op.group, list);
  }

  const parents = new Map<string, { op: TreeOperation<T>; covered: number }>();
  for (const [group, members] of groups) {
    const routes = members.map((op) => splitSegments(op.path));
    const base = commonPrefix(routes);
    let best:
      { op: TreeOperation<T>; length: number; covered: number } | undefined;
    for (const [other, candidates] of groups) {
      if (other === group) continue;
      for (const candidate of candidates) {
        const segments = splitSegments(candidate.path);
        const names = placeholderNames(candidate.path);
        // The parent hands its own path parameters on, so it must take every
        // one of them as a step, and so must each operation of the interface.
        const aligned =
          segments.length > 0 &&
          segments.length < base.length &&
          segments.length > (best?.length ?? 0) &&
          names.every((name) => candidate.requiredParams.has(name)) &&
          startsWith(segments, base) &&
          members.every((op, i) =>
            placeholderNames(
              routes[i].slice(0, segments.length).join("/"),
            ).every((name) => op.requiredParams.has(name)),
          );
        if (aligned) {
          best = {
            op: candidate,
            length: segments.length,
            covered: linkParams(candidate).length,
          };
        }
      }
    }
    if (best) parents.set(group, { op: best.op, covered: best.covered });
  }

  const groupNodes = new Map<string, TreeNode<T>>();
  const opNodes = new Map<TreeOperation<T>, TreeNode<T>>();
  const groupNode = (group: string): TreeNode<T> => {
    let node = groupNodes.get(group);
    if (node) return node;
    const parent = parents.get(group);
    node = reach(
      parent ? opNode(parent.op) : root,
      "property",
      camelCase(group),
      {
        group,
      },
    );
    groupNodes.set(group, node);
    return node;
  };
  const opNode = (op: TreeOperation<T>): TreeNode<T> => {
    let node = opNodes.get(op);
    if (node) return node;
    node = groupNode(op.group);
    for (const name of linkParams(op).slice(node.depth)) {
      node = reach(node, "parameter", name, {});
    }
    opNodes.set(op, node);
    return node;
  };

  for (const op of ops) {
    const node = opNode(op);
    const bound = new Map(
      linkParams(op)
        .slice(0, node.depth)
        .map((name, i) => [name, i] as const),
    );
    node.items.push({ value: op.value, bound });
  }
  assignStems(root);
  return root;
}

/**
 * Lists a tree's builders, each before the builders reached from it.
 *
 * @param root - The root of the tree.
 * @returns Every builder, the root first.
 */
export function walkTree<T>(root: TreeNode<T>): TreeNode<T>[] {
  return [root, ...root.children.flatMap((child) => walkTree(child))];
}

/**
 * The first operation sent from a builder or from any builder reached from it,
 * which a diagnostic about the builder can point at.
 *
 * @param node - The builder.
 * @returns The operation, or `undefined` when none is reached.
 */
export function firstItem<T>(node: TreeNode<T>): T | undefined {
  if (node.items.length > 0) return node.items[0].value;
  for (const child of node.children) {
    const found = firstItem(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

/** Absolute path to the bundled default templates directory. */
const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates",
);

/** Names of the built-in Handlebars templates. */
export type TemplateName =
  | "file"
  | "interface"
  | "enum"
  | "endpoints"
  | "index";

/**
 * Partial map of template names to absolute file paths used to override the
 * built-in defaults. Any template not listed falls back to its bundled counterpart.
 */
export type TemplateOverrides = Partial<Record<TemplateName, string>>;

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** View model for a single TypeScript property declaration inside an interface. */
export interface PropertyView {
  /** Optional JSDoc text. */
  doc?: string;
  /** Property name (camelCase). */
  name: string;
  /** Full TypeScript type string, e.g. `"string"`, `"number"`, `"Widget[]"`. */
  type: string;
  /** When true the property is emitted as `name?: type`. */
  optional: boolean;
}

/** View model for a TypeScript `export interface` declaration. */
export interface InterfaceView {
  /** Optional JSDoc text. */
  doc?: string;
  /** PascalCase interface name. */
  interfaceName: string;
  /** Generic parameter string, e.g. `"<T>"` or `""` for non-generic interfaces. */
  genericSuffix: string;
  /** Ordered list of property view models. */
  properties: PropertyView[];
}

/** View model for a single TypeScript enum member. */
export interface EnumMemberView {
  /** Optional JSDoc text. */
  doc?: string;
  /** Member name (as declared in TypeSpec). */
  name: string;
  /** Wire string value written to / read from JSON. */
  memberValue: string;
}

/** View model for a TypeScript `export enum` declaration. */
export interface EnumView {
  /** Optional JSDoc text. */
  doc?: string;
  /** Enum name. */
  enumName: string;
  /** Ordered list of enum member view models. */
  members: EnumMemberView[];
}

/** View model for a single endpoint method entry. */
export interface EndpointMethodView {
  /** Optional JSDoc text. */
  doc?: string;
  /** camelCase method name, e.g. `"list"`, `"read"`. */
  name: string;
  /**
   * Pre-rendered arrow function text, e.g.:
   *   `() => \`/widgets\``
   *   `(id: string) => \`/widgets/${id}\``
   */
  functionText: string;
}

/** View model for the endpoint path utility `as const` object. */
export interface EndpointsView {
  /** Optional JSDoc text. */
  doc?: string;
  /** Name of the exported const, e.g. `"WidgetsEndpoints"`. */
  className: string;
  /** Ordered list of endpoint method view models. */
  methods: EndpointMethodView[];
}

/** View model passed to the `file` template — wraps any inner body with the file header. */
export interface FileView {
  /** Pre-rendered inner content. */
  body: string;
  /** Basename of the file being emitted, e.g. `"models.ts"`. */
  fileName: string;
}

/** View model for the barrel `index.ts`. */
export interface IndexView {
  /** Ordered list of relative import paths (with `.js` extension). */
  exports: string[];
}

// ---------------------------------------------------------------------------
// Renderer interface
// ---------------------------------------------------------------------------

/** Stateless code renderer. Obtain an instance via {@link createRenderer}. */
export interface Renderer {
  /** Renders the full file with auto-generated header comment wrapping the body. */
  renderFile(view: FileView): string;
  /** Renders a single `export interface` declaration. */
  renderInterface(view: InterfaceView): string;
  /** Renders a single `export enum` declaration. */
  renderEnum(view: EnumView): string;
  /** Renders the endpoint path utility `as const` object. */
  renderEndpoints(view: EndpointsView): string;
  /** Renders the barrel `index.ts` (file header + export * lines). */
  renderIndex(view: IndexView): string;
}

// ---------------------------------------------------------------------------
// Handlebars environment
// ---------------------------------------------------------------------------

function createHandlebarsEnv(): typeof Handlebars {
  const env = Handlebars.create();

  // Splits doc text on newlines and rejoins with `\n{prefix}` so every
  // continuation line in a JSDoc block gets the correct leading prefix.
  env.registerHelper("docLines", (doc: unknown, prefix: unknown) => {
    if (typeof doc !== "string" || !doc) return "";
    const sep = typeof prefix === "string" ? `\n${prefix}` : "\n * ";
    return doc.split("\n").join(sep);
  });

  env.registerHelper("isDefined", (value: unknown) => value !== undefined);
  env.registerHelper("eq", (a: unknown, b: unknown) => a === b);

  return env;
}

function loadTemplate(
  env: typeof Handlebars,
  name: TemplateName,
  override: string | undefined,
): HandlebarsTemplateDelegate {
  const path = override ?? resolve(TEMPLATES_DIR, `${name}.hbs`);
  const source = readFileSync(path, "utf-8");
  return env.compile(source, { noEscape: true });
}

// ---------------------------------------------------------------------------
// Per-element text renderers
// ---------------------------------------------------------------------------

function renderDocBlock(doc: string | undefined, indent: string): string {
  if (!doc) return "";
  if (!doc.includes("\n")) return `${indent}/** ${doc} */\n`;
  const lines = [`${indent}/**`];
  for (const line of doc.split("\n")) lines.push(`${indent} * ${line}`);
  lines.push(`${indent} */`);
  return lines.join("\n") + "\n";
}

function renderPropertyBlock(p: PropertyView): string {
  const lines: string[] = [];
  if (p.doc) {
    if (!p.doc.includes("\n")) {
      lines.push(`  /** ${p.doc} */`);
    } else {
      lines.push("  /**");
      for (const docLine of p.doc.split("\n")) lines.push(`   * ${docLine}`);
      lines.push("   */");
    }
  }
  lines.push(`  ${p.name}${p.optional ? "?" : ""}: ${p.type};`);
  return lines.join("\n");
}

function renderEnumMemberBlock(m: EnumMemberView): string {
  const lines: string[] = [];
  if (m.doc) {
    if (!m.doc.includes("\n")) {
      lines.push(`  /** ${m.doc} */`);
    } else {
      lines.push("  /**");
      for (const docLine of m.doc.split("\n")) lines.push(`   * ${docLine}`);
      lines.push("   */");
    }
  }
  lines.push(`  ${m.name} = "${m.memberValue}",`);
  return lines.join("\n");
}

function renderEndpointMethodBlock(m: EndpointMethodView): string {
  const lines: string[] = [];
  if (m.doc) {
    lines.push("  /**");
    for (const docLine of m.doc.split("\n")) {
      lines.push(`   * ${docLine}`);
    }
    lines.push("   */");
  }
  lines.push(`  ${m.name}: ${m.functionText},`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compiles all templates and returns a {@link Renderer} instance.
 *
 * Templates are compiled once; the returned renderer is cheap to call
 * repeatedly. Any template absent from `overrides` falls back to its bundled
 * `.hbs` file.
 */
export function createRenderer(overrides: TemplateOverrides = {}): Renderer {
  const env = createHandlebarsEnv();
  const fileTemplate = loadTemplate(env, "file", overrides.file);
  const interfaceTemplate = loadTemplate(env, "interface", overrides.interface);
  const enumTemplate = loadTemplate(env, "enum", overrides.enum);
  const endpointsTemplate = loadTemplate(env, "endpoints", overrides.endpoints);
  const indexTemplate = loadTemplate(env, "index", overrides.index);

  return {
    renderFile(view) {
      return fileTemplate(view);
    },

    renderInterface(view) {
      const docBlock = renderDocBlock(view.doc, "");
      const blocks = view.properties.map(renderPropertyBlock);
      const propertiesBlock =
        blocks.length > 0 ? blocks.join("\n") + "\n}" : "}";
      return interfaceTemplate({
        docBlock,
        interfaceName: view.interfaceName,
        genericSuffix: view.genericSuffix,
        propertiesBlock,
      });
    },

    renderEnum(view) {
      const docBlock = renderDocBlock(view.doc, "");
      const blocks = view.members.map(renderEnumMemberBlock);
      const membersBlock = blocks.length > 0 ? blocks.join("\n") + "\n}" : "}";
      return enumTemplate({ docBlock, enumName: view.enumName, membersBlock });
    },

    renderEndpoints(view) {
      const blocks = view.methods.map(renderEndpointMethodBlock);
      // Closing `} as const;` is embedded in methodsBlock so the template can use
      // safe `{{{methodsBlock}}}` (3 braces) — 4 braces would be CLOSE_RAW_BLOCK.
      const methodsBlock =
        blocks.length > 0 ? blocks.join("\n") + "\n} as const;" : "} as const;";
      return endpointsTemplate({
        doc: view.doc,
        className: view.className,
        methodsBlock,
      });
    },

    renderIndex(view) {
      const body = indexTemplate(view);
      return fileTemplate({ body, fileName: "index.ts" });
    },
  };
}

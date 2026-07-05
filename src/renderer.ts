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
  | "index"
  | "client"
  | "union";

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

/**
 * View model for a TypeScript discriminated union type alias, generated from a
 * TypeSpec model marked with `@discriminator`. The base model itself is not
 * emitted as an interface — this alias takes its name instead, so every
 * reference to the base model resolves to the precise union of its variants.
 */
export interface UnionView {
  /** Optional JSDoc text. */
  doc?: string;
  /** PascalCase name of the base (discriminated) model. */
  unionName: string;
  /** Ordered, deduplicated interface names of the concrete discriminated variants. */
  memberNames: string[];
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

/** View model for a single HTTP client method. */
export interface ClientMethodView {
  /** Optional JSDoc text. */
  doc?: string;
  /** camelCase method name, e.g. `"list"`, `"create"`. */
  name: string;
  /** Pre-rendered method signature arguments string, e.g. `"id: string, body: WidgetPostRequest"`. */
  methodParams: string;
  /** Pre-rendered method body, e.g. `"return this.post<Widget>(WidgetsEndpoints.create(), body);"`. */
  methodBody: string;
  /** TypeScript return type, e.g. `"Widget[]"` or `"void"`. */
  responseType: string;
}

/** View model for a typed HTTP client class bound to one TypeSpec Interface. */
export interface ClientView {
  /** PascalCase class name, e.g. `"WidgetsClient"`. */
  className: string;
  /** Name of the endpoints object, e.g. `"WidgetsEndpoints"`. */
  endpointsClassName: string;
  /** Ordered list of client method view models. */
  methods: ClientMethodView[];
  /** Deduplicated model type names imported from `"../models.js"`. */
  modelImports: string[];
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
  /** Renders a discriminated union `export type` alias. */
  renderUnion(view: UnionView): string;
  /** Renders the endpoint path utility `as const` object. */
  renderEndpoints(view: EndpointsView): string;
  /** Renders the barrel `index.ts` (file header + export * lines). */
  renderIndex(view: IndexView): string;
  /** Renders a typed HTTP client class for one TypeSpec Interface. */
  renderClient(view: ClientView): string;
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

  env.registerHelper("renderDoc", (doc: unknown, indent: unknown) => {
    if (typeof doc !== "string" || !doc) return "";
    const ind = typeof indent === "string" ? indent : "";
    if (!doc.includes("\n")) return `${ind}/** ${doc} */\n`;
    const lines = [`${ind}/**`];
    for (const line of doc.split("\n")) lines.push(`${ind} * ${line}`);
    lines.push(`${ind} */`);
    return lines.join("\n") + "\n";
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
  const unionTemplate = loadTemplate(env, "union", overrides.union);
  const endpointsTemplate = loadTemplate(env, "endpoints", overrides.endpoints);
  const indexTemplate = loadTemplate(env, "index", overrides.index);
  const clientTemplate = loadTemplate(env, "client", overrides.client);

  return {
    renderFile(view) {
      return fileTemplate(view);
    },

    renderInterface(view) {
      return interfaceTemplate(view);
    },

    renderEnum(view) {
      return enumTemplate(view);
    },

    renderUnion(view) {
      return unionTemplate(view);
    },

    renderEndpoints(view) {
      return endpointsTemplate(view);
    },

    renderIndex(view) {
      const body = indexTemplate(view);
      return fileTemplate({ body, fileName: "index.ts" });
    },

    renderClient(view) {
      const body = clientTemplate(view);
      return fileTemplate({ body, fileName: `${view.className}.ts` });
    },
  };
}

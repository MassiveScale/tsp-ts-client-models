import {
  createTypeSpecLibrary,
  JSONSchemaType,
  paramMessage,
} from "@typespec/compiler";
import type { TemplateOverrides } from "./renderer.js";

export interface EmitterOptions {
  "target-version"?: string;
  "all-versions"?: boolean;
  "npm-package-name"?: string;
  "npm-version"?: string;
  "npm-description"?: string;
  "route-prefix"?: string;
  "clean-output-dir"?: boolean;
  templates?: TemplateOverrides;
}

const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "target-version": {
      type: "string",
      description:
        "The specific API version to generate (e.g. 'v2.0'). Defaults to the latest declared version. Ignored when 'all-versions' is true.",
      nullable: true,
    },
    "all-versions": {
      type: "boolean",
      description:
        "When true, generate clients for every declared API version in separate subfolders. Defaults to false (latest version only).",
      nullable: true,
    },
    "npm-package-name": {
      type: "string",
      description:
        "The name for the generated npm package (e.g. '@my-org/my-api-client').",
      nullable: true,
    },
    "npm-version": {
      type: "string",
      description:
        "The version for the generated npm package. Derived from the TypeSpec API version when not set.",
      nullable: true,
    },
    "npm-description": {
      type: "string",
      description: "The description for the generated npm package.",
      nullable: true,
    },
    "route-prefix": {
      type: "string",
      description:
        "Route prefix prepended to all endpoint paths. Use {version} as a placeholder for the API version (e.g. 'api/{version}'). Defaults to 'api/{version}'.",
      nullable: true,
    },
    "clean-output-dir": {
      type: "boolean",
      description:
        "When true, all files and directories inside emitter-output-dir are deleted before emitting. Defaults to false.",
      nullable: true,
    },
    templates: {
      type: "object",
      description:
        "Override built-in Handlebars templates with custom .hbs file paths.",
      additionalProperties: false,
      nullable: true,
      properties: {
        file: {
          type: "string",
          nullable: true,
          description: "Outer file wrapper template.",
        },
        interface: {
          type: "string",
          nullable: true,
          description: "TypeScript interface template.",
        },
        enum: {
          type: "string",
          nullable: true,
          description: "TypeScript enum template.",
        },
        endpoints: {
          type: "string",
          nullable: true,
          description: "Endpoint path utility template.",
        },
        index: {
          type: "string",
          nullable: true,
          description: "Barrel index template.",
        },
      },
      required: [],
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "@massivescale/tsp-ts-client-models",
  diagnostics: {
    "template-load-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to load Handlebars template: ${"message"}`,
      },
    },
    "invalid-client-name-override": {
      severity: "error",
      messages: {
        default: paramMessage`Invalid @clientName override "${"name"}" on ${"kind"}: ${"reason"}.`,
      },
    },
    "client-name-collision": {
      severity: "error",
      messages: {
        default: paramMessage`@clientName override "${"name"}" on ${"kind"} collides with another emitted ${"scope"}.`,
      },
    },
    "unsafe-clean-output-dir": {
      severity: "error",
      messages: {
        default: paramMessage`Refusing to clean emitter-output-dir "${"outputDir"}" because it resolves to ${"reason"}.`,
      },
    },
    "clean-output-dir-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to clean emitter-output-dir "${"outputDir"}": ${"message"}`,
      },
    },
    "version-not-found": {
      severity: "error",
      messages: {
        default: paramMessage`Version "${"version"}" was not found. Available versions: ${"available"}.`,
      },
    },
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;

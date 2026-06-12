# Getting Started

`@massivescale/tsp-ts-client-models` is a [TypeSpec](https://typespec.io) emitter that generates a fully-typed, publishable npm package from your API definition. The output includes TypeScript models, request types, endpoint path utilities, and an optional native-`fetch` HTTP client.

## Prerequisites

- Node.js 18 or later (native `fetch` is required for the HTTP client)
- TypeSpec CLI (`npm install -g @typespec/compiler`)

## Installation

Add the emitter to your TypeSpec project:

```bash
npm install --save-dev @massivescale/tsp-ts-client-models
```

## Configuration

Add the emitter to your `tspconfig.yaml`:

```yaml
emit:
  - "@massivescale/tsp-ts-client-models"
options:
  "@massivescale/tsp-ts-client-models":
    emitter-output-dir: "{output-dir}/client"
    npm-package-name: "@my-org/my-api-client"
```

### All options

| Option                 | Type      | Default                         | Description                                                                                    |
| ---------------------- | --------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `target-version`       | `string`  | Latest declared version         | Generate only this version. Ignored when `all-versions` is `true`.                             |
| `all-versions`         | `boolean` | `false`                         | Generate every declared version in separate subfolders.                                        |
| `route-prefix`         | `string`  | `api/{version}`                 | Prefix for all endpoint paths. Use `{version}` as a placeholder. Set to `""` for bare paths.   |
| `npm-package-name`     | `string`  | Derived from TypeSpec namespace | Name for the generated package.                                                                |
| `npm-version`          | `string`  | Derived from TypeSpec version   | Explicit version for the generated package.                                                    |
| `npm-description`      | `string`  | `Client models for <Namespace>` | Description for the generated package.                                                         |
| `generate-http-client` | `boolean` | `true`                          | Generate typed HTTP client classes. Set to `false` to emit models and endpoint utilities only. |
| `templates`            | `object`  | —                               | Override individual built-in Handlebars templates with custom `.hbs` files.                    |

## Compile

```bash
tsp compile .
```

## Output structure

```
tsp-output/client/
├── models.ts                  # All TypeScript interfaces, enums, and request types
├── endpoints/
│   └── WidgetsEndpoints.ts    # Path constants per TypeSpec interface
├── client/
│   ├── ApiClient.ts           # Base HttpClient, ClientConfig, ApiError, etc.
│   └── WidgetsClient.ts       # Typed client class per TypeSpec interface
├── index.ts                   # Barrel export
├── package.json               # Ready-to-publish package manifest
└── tsconfig.json              # TypeScript compiler config
```

> When `all-versions: true`, each version is nested under a version subfolder, e.g. `v1.0/models.ts`.

## Build and publish the generated package

```bash
cd tsp-output/client
npm install
npm run build   # tsc → dist/
npm publish
```

## Quick usage example

```typescript
import { WidgetsClient } from "@my-org/my-api-client";

const client = new WidgetsClient({ baseUrl: "https://api.example.com" });
const widgets = await client.list();
```

See [http-client.md](./http-client.md) for full `ClientConfig` and retry options, and the [environments](./environments/) directory for framework-specific integration guides.

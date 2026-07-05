# @massivescale/tsp-ts-client-models

[TypeSpec](https://typespec.io) emitter that generates a fully-typed, publishable npm package from your API definition.

## Summary

This emitter produces:

- **TypeScript models** — `export interface` and `export enum` for every model and enum in your TypeSpec definition.
- **Discriminated unions** — a model marked with `@discriminator` is emitted as a TypeScript union of its concrete variants (e.g. `type Pet = Dog | Cat`), with the discriminator property narrowed to its literal value on each variant. See [docs/discriminated-models.md](docs/discriminated-models.md).
- **Request types** — visibility-filtered interfaces (e.g. `WidgetPostRequest`, `WidgetPatchRequest`) that strip server-managed fields like `id` from write operations. MergePatch operations are also supported.
- **Endpoint utilities** — `*Endpoints` `as const` objects with typed path-building functions per interface.
- **Typed HTTP client** _(optional, on by default)_ — one `*Client` class per TypeSpec interface using native `fetch`, with retry, `AbortSignal`, timeout support, and an always-available `query` parameter for custom query parameters on any call.

The output is a complete, buildable npm package (`package.json`, `tsconfig.json`, `index.ts`) ready to publish or consume locally.

> **Status:** Early development. Core code generation is implemented; some edge cases and advanced TypeSpec features may not yet be handled.

## Usage

Add the emitter to your TypeSpec project:

```bash
npm install @massivescale/tsp-ts-client-models
```

Configure it in your `tspconfig.yaml`:

```yaml
emit:
  - "@massivescale/tsp-ts-client-models"
options:
  "@massivescale/tsp-ts-client-models":
    emitter-output-dir: "{output-dir}/client"
```

### Emitter options

| Option                 | Type      | Default                                 | Description                                                                                                                                                               |
| ---------------------- | --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target-version`       | `string`  | Latest declared version                 | Emit only this API version. Ignored when `all-versions` is `true`.                                                                                                        |
| `all-versions`         | `boolean` | `false`                                 | When `true`, generate clients for every declared API version in separate subfolders.                                                                                      |
| `route-prefix`         | `string`  | `api/{version}`                         | Prefix prepended to every endpoint path. Use `{version}` as a placeholder for the API version (e.g. `api/{version}` → `/api/v1.0/items`). Set to `""` to emit bare paths. |
| `npm-package-name`     | `string`  | Derived from TypeSpec namespace         | The name given to the generated package. When omitted, the namespace is converted to kebab-case (e.g. `MyOrg.PetApi` → `my-org-pet-api`).                                 |
| `npm-version`          | `string`  | —                                       | The version assigned to the generated package.                                                                                                                            |
| `npm-description`      | `string`  | `Client models for the {namespace} API` | Description applied to the generated package.                                                                                                                             |
| `generate-http-client` | `boolean` | `true`                                  | Generate typed HTTP client classes. Set to `false` to emit models and endpoint utilities only.                                                                            |
| `templates`            | `object`  | —                                       | Override individual built-in Handlebars templates. See [Customizing templates](#customizing-templates).                                                                   |

Then compile your TypeSpec definition:

```bash
tsp compile .
```

## Customizing templates

Any of the six built-in [Handlebars](https://handlebarsjs.com/) templates can be replaced with your own `.hbs` file. Specify overrides in `tspconfig.yaml`:

```yaml
options:
  "@massivescale/tsp-ts-client-models":
    templates:
      enum: "./templates/enum.hbs"
      interface: "./templates/interface.hbs"
      endpoints: "./templates/endpoints.hbs"
```

### Template view models

Each template receives the corresponding view model as its Handlebars context.

**`enum`** — `EnumView`

| Field                   | Type                  | Description              |
| ----------------------- | --------------------- | ------------------------ |
| `doc`                   | `string \| undefined` | JSDoc text from `@doc`.  |
| `enumName`              | `string`              | Enum name.               |
| `members[]`             | `EnumMemberView[]`    | Ordered list of members. |
| `members[].doc`         | `string \| undefined` | Per-member `@doc` text.  |
| `members[].name`        | `string`              | Member name.             |
| `members[].memberValue` | `string`              | Wire string value.       |

**`interface`** — `InterfaceView`

| Field                   | Type                  | Description                                    |
| ----------------------- | --------------------- | ---------------------------------------------- |
| `doc`                   | `string \| undefined` | JSDoc text from `@doc`.                        |
| `interfaceName`         | `string`              | PascalCase interface name.                     |
| `genericSuffix`         | `string`              | Generic parameter string, e.g. `<T>`, or `""`. |
| `properties[]`          | `PropertyView[]`      | Ordered list of properties.                    |
| `properties[].doc`      | `string \| undefined` | Per-property `@doc` text.                      |
| `properties[].name`     | `string`              | Property name.                                 |
| `properties[].type`     | `string`              | TypeScript type string.                        |
| `properties[].optional` | `boolean`             | When `true`, emit `name?`.                     |

**`union`** — `UnionView`

| Field           | Type                  | Description                                                     |
| --------------- | --------------------- | --------------------------------------------------------------- |
| `doc`           | `string \| undefined` | JSDoc text from `@doc` on the `@discriminator`-annotated model. |
| `unionName`     | `string`              | PascalCase name of the base (discriminated) model.              |
| `memberNames[]` | `string[]`            | Ordered, deduplicated interface names of the concrete variants. |

**`endpoints`** — `EndpointsView`

| Field                    | Type                   | Description                                                                      |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------- |
| `doc`                    | `string \| undefined`  | JSDoc text from `@doc`.                                                          |
| `className`              | `string`               | Exported `const` name, e.g. `WidgetsEndpoints`.                                  |
| `methods[]`              | `EndpointMethodView[]` | Ordered list of endpoint methods.                                                |
| `methods[].doc`          | `string \| undefined`  | Per-operation `@doc` text.                                                       |
| `methods[].name`         | `string`               | camelCase method name.                                                           |
| `methods[].functionText` | `string`               | Pre-rendered arrow function, e.g. `(id: string) => \`/api/v1.0/widgets/${id}\``. |

**`file`** — `FileView`

| Field      | Type     | Description                                              |
| ---------- | -------- | -------------------------------------------------------- |
| `body`     | `string` | Pre-rendered inner content to wrap with the file header. |
| `fileName` | `string` | Basename of the file being emitted.                      |

**`index`** — `IndexView`

| Field       | Type       | Description                                                   |
| ----------- | ---------- | ------------------------------------------------------------- |
| `exports[]` | `string[]` | Ordered list of relative import paths (with `.js` extension). |

### Built-in Handlebars helpers

| Helper      | Signature              | Description                                                                                                                                           |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderDoc` | `renderDoc doc indent` | Formats `doc` as a JSDoc comment indented by `indent`. Single-line: `/** text */`. Multi-line: full `/**…*/` block. Returns `""` when `doc` is falsy. |
| `docLines`  | `docLines doc prefix`  | Joins `doc` lines with `\n{prefix}`. Useful for embedding multi-line text inside a comment block.                                                     |
| `isDefined` | `isDefined value`      | Returns `true` when `value` is not `undefined`.                                                                                                       |
| `eq`        | `eq a b`               | Returns `true` when `a === b`.                                                                                                                        |

## Using the generated client

After running `tsp compile .`, the emitter writes a complete, buildable npm package to the configured output directory. It includes:

- `models.ts` — TypeScript interfaces, enums, and request types
- `endpoints/*.ts` — path utility `as const` objects per TypeSpec interface
- `client/ApiClient.ts` — base `HttpClient`, `ClientConfig`, `ApiError`, retry logic (requires Node.js 18+ or a modern browser)
- `client/*Client.ts` — one typed client class per TypeSpec interface
- `index.ts` — barrel export
- `package.json` and `tsconfig.json` — ready to build and publish

To build and publish the generated package:

```bash
cd tsp-output/client   # wherever emitter-output-dir points
npm install
npm run build          # compiles TypeScript → dist/
npm publish
```

### HTTP client

```typescript
import { WidgetsClient } from "your-package-name";

const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  defaultHeaders: { Authorization: "Bearer …" },
  retry: { maxAttempts: 3 },
});

const widgets = await client.list();
const widget = await client.read("abc123");
await client.create({ name: "New Widget" }); // body typed as WidgetPostRequest

// Every method also accepts an optional `query` object — declared @query params
// keep their types, and arbitrary extra keys are always allowed, on any verb.
await client.list({ status: "active", debug: "true" });
```

See [docs/http-client.md](docs/http-client.md) for the full `ClientConfig`, error types, query parameters, and extension patterns.

### Endpoint utilities only

If you prefer to manage HTTP calls yourself (or set `generate-http-client: false`), the endpoint utilities are still generated:

```typescript
import { Widget, WidgetPostRequest, WidgetsEndpoints } from "your-package-name";

const url = WidgetsEndpoints.list(); // "/api/v2.0/widgets"
const url = WidgetsEndpoints.read("id"); // "/api/v2.0/widgets/id"
```

For multi-version output (`all-versions: true`), each version is a separate subpath export:

```typescript
import { WidgetsEndpoints as WidgetsV1Endpoints } from "your-package-name/v1.0";
import { WidgetsEndpoints as WidgetsV2Endpoints } from "your-package-name/v2.0";
```

### Request type naming

Request types use the HTTP verb as the suffix (since 0.3.0):

| TypeSpec operation | Generated request type |
| ------------------ | ---------------------- |
| `@post create(…)`  | `WidgetPostRequest`    |
| `@patch update(…)` | `WidgetPatchRequest`   |
| `@put replace(…)`  | `WidgetPutRequest`     |

> **Migrating from 0.2.x:** Rename `*CreateRequest` → `*PostRequest`, `*UpdateRequest` → `*PatchRequest`, `*ReplaceRequest` → `*PutRequest`.

See [docs/request-models.md](docs/request-models.md) for visibility filtering, MergePatch support, and collision detection.

### Discriminated models

A model annotated with `@discriminator` is emitted as a union type alias of its concrete variants rather than a flat interface:

```typespec
@discriminator("petKind")
model Pet { petKind: PetKind; name: string; }
model Dog extends Pet { petKind: PetKind.Dog; isBarker: boolean; }
model Cat extends Pet { petKind: PetKind.Cat; isPurrer: boolean; }
```

```typescript
export interface Dog {
  petKind: "dog";
  name: string;
  isBarker: boolean;
}
export interface Cat {
  petKind: "cat";
  name: string;
  isPurrer: boolean;
}
export type Pet = Dog | Cat;
```

Every reference to `Pet` (e.g. `pets: Pet[]`) resolves to the union, enabling standard TypeScript discriminated-union narrowing on `petKind`. See [docs/discriminated-models.md](docs/discriminated-models.md) for details, including multi-level hierarchies.

## Development

### Prerequisites

- Node.js (LTS)
- npm 11+

### Setup

```powershell
npm install
```

### Build

TypeScript must be compiled before running tests:

```powershell
npm run build
```

Use watch mode during active development:

```powershell
npm run watch
```

### Test

```powershell
npm run build && npm test
```

To run a single test file:

```powershell
node --test dist/test/emitter.test.js
```

### Lint & Format

```powershell
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format        # format all files
npm run format:check  # check formatting without writing
```

## Examples

- [`example/simple-api/](example/simple-api/) - Simple API example without versioning.
- [`example/versioned-api/`](example/versioned-api/) - Versioned Pet Store TypeSpec API demonstrating multi-version route and model definitions.

## Contributing

See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for architecture details, conventions, and development guidance.

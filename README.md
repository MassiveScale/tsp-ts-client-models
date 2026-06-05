# @massivescale/tsp-ts-client-models

[TypeSpec](https://typespec.io) emitter for generating C# API clients using [Refit](https://www.nuget.org/packages/Refit).

## Summary

This emitter produces an npm package with client-facing models for each `GET`, `POST`, `PATCH`, and `DELETE` operation in your TypeSpec definition. The generated client contains the models for each resource, request, and enumeration needed to call the API. The MVP does not implement an actual client, this is currently left up to the consuming application. It does however produce a utility for retriving the reletive path to each endpoints and models associated with it, allowing you to easily fetch the correct endpoint at build and runtime.

It is also version-aware, allowing you to call any endpoint version from a package.

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

| Option             | Type      | Default                                 | Description                                                                                                                                                               |
| ------------------ | --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target-version`   | `string`  | Latest declared version                 | Emit only this API version. Ignored when `all-versions` is `true`.                                                                                                        |
| `all-versions`     | `boolean` | `false`                                 | When `true`, generate clients for every declared API version in separate subfolders.                                                                                      |
| `route-prefix`     | `string`  | `api/{version}`                         | Prefix prepended to every endpoint path. Use `{version}` as a placeholder for the API version (e.g. `api/{version}` → `/api/v1.0/items`). Set to `""` to emit bare paths. |
| `npm-package-name` | `string`  | Derived from TypeSpec namespace         | The name given to the generated package. When omitted, the namespace is converted to kebab-case (e.g. `MyOrg.PetApi` → `my-org-pet-api`).                                 |
| `npm-version`      | `string`  | —                                       | The version assigned to the generated package.                                                                                                                            |
| `npm-description`  | `string`  | `Client models for the {namespace} API` | Description applied to the generated package.                                                                                                                             |
| `templates`        | `object`  | —                                       | Override individual built-in Handlebars templates. See [Customizing templates](#customizing-templates).                                                                   |

Then compile your TypeSpec definition:

```bash
tsp compile .
```

## Customizing templates

Any of the five built-in [Handlebars](https://handlebarsjs.com/) templates can be replaced with your own `.hbs` file. Specify overrides in `tspconfig.yaml`:

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

- TypeScript source files (`models.ts`, `endpoints/*.ts`, `index.ts`)
- A `package.json` with `exports`, `scripts`, `files`, and `devDependencies` pre-filled
- A `tsconfig.json` configured for `NodeNext` modules with `declaration` output

To build and publish the generated package:

```bash
cd tsp-output/client   # wherever emitter-output-dir points
npm install
npm run build          # compiles TypeScript → dist/
npm publish
```

Consumers install and import it as a normal ESM package:

```typescript
import { Widget, WidgetCreateRequest } from "your-package-name";
import { WidgetsEndpoints } from "your-package-name";

const url = WidgetsEndpoints.list(); // "/api/v2.0/widgets"
```

For multi-version output (`all-versions: true`), each version is a separate subpath export:

```typescript
import { WidgetsEndpoints } from "your-package-name/v1.0";
import { WidgetsEndpoints } from "your-package-name/v2.0";
```

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

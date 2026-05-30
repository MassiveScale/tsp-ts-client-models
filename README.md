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

| Option             | Type      | Default                                 | Description                                                                          |
| ------------------ | --------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `target-version`   | `string`  | Latest declared version                 | Emit only this API version. Ignored when `all-versions` is `true`.                   |
| `all-versions`     | `boolean` | `false`                                 | When `true`, generate clients for every declared API version in separate subfolders. |
| `npm-package-name` | `string`  | —                                       | The name given to the generated package                                              |
| `npm-version`      | `string`  | —                                       | The version assigned to the generated package.                                       |
| `npm-description`  | `string`  | `Client models for the {namespace} API` | Description applied to the generated package.                                        |
| `templates`        | `object`  | —                                       | Override individual built-in Handlebars templates.                                   |

Then compile your TypeSpec definition:

```bash
tsp compile .
```

## Using the generated client

TODO: Replace with basic usage example

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.3.0] — 2026-06-11

### Breaking changes

- **Request type naming convention changed.** Generated request types now use the HTTP verb as the suffix instead of a semantic word.

  | Old (≤ 0.2.x)          | New (0.3.0+)         |
  | ---------------------- | -------------------- |
  | `WidgetCreateRequest`  | `WidgetPostRequest`  |
  | `WidgetUpdateRequest`  | `WidgetPatchRequest` |
  | `WidgetReplaceRequest` | `WidgetPutRequest`   |

  **Migration:** rename all usages of `*CreateRequest`, `*UpdateRequest`, and `*ReplaceRequest` to `*PostRequest`, `*PatchRequest`, and `*PutRequest` respectively.

### Added

- **MergePatch request models.** When an operation body is `MergePatchUpdate<T>`, `MergePatchUpdateReplaceOnly<T>`, or `MergePatchCreateOrUpdate<T>` from `@typespec/rest`, the emitter now generates a `{BaseName}PatchRequest` using the synthesized model's properties (all optional, read-only properties excluded).
- **Collision detection and `@tag`-based disambiguation.** When two operations produce a request type with the same name but different property shapes, the emitter automatically prefixes both with their `@tag` value (e.g. `StandardWidgetPatchRequest`, `AdminWidgetPatchRequest`). If any conflicting operation has no `@tag`, a `request-type-collision` compiler diagnostic error is raised.
- **HTTP client generation.** The emitter now generates a complete, typed HTTP client per TypeSpec interface when `generate-http-client` is not `false` (default: `true`).
  - `client/ApiClient.ts` — base `HttpClient` class, `ClientConfig`, `RetryConfig`, `RequestOptions`, `ApiError`, `RateLimitError`, `ServiceUnavailableError`. Uses native `fetch`.
  - `client/{Interface}Client.ts` — one typed class per TypeSpec interface, with methods for each operation. Path params become positional arguments; body params use the corresponding request type when one was generated.
  - Automatic retry for `429`/`503` responses with exponential backoff. Honors `Retry-After` header.
  - `AbortSignal` support for per-request cancellation and timeout.
  - All client files exported from `index.ts`.
- **New emitter option `generate-http-client`** (`boolean`, default `true`). Set to `false` to emit models and endpoint utilities only, skipping the `client/` directory.
- **Documentation.** Added `docs/` directory with guides for getting started, request models, the HTTP client, and integration with Node.js, React, Angular, SvelteKit, Vue, and Nx monorepos.

## [0.2.0] — 2026-06-05

### Added

- `renderDoc` Handlebars helper available in all templates. Formats a doc string as a JSDoc comment with a given indent prefix — single-line docs emit `/** text */`, multi-line docs emit a full `/** … */` block. Returns an empty string when the doc is absent.
- The emitter now generates a `tsconfig.json` alongside `package.json` in the output directory. It targets `ES2020`, uses `NodeNext` module resolution, and compiles declarations to `./dist`.
- Generated `package.json` now includes `exports`, `main`, `types`, `files`, `scripts`, and `devDependencies` fields so the output package can be built (`npm run build`) and published (`npm publish`) without any manual edits.
- `package.json` `exports` is populated automatically: a flat `"."` entry for single-version output, and per-version subpath entries (e.g. `"./v1.0"`, `"./v2.0"`) when `all-versions: true`.
- `package.json` `name` is now auto-derived from the TypeSpec service namespace when `npm-package-name` is not set (e.g. `MyOrg.PetApi` → `my-org-pet-api`).

### Fixed

- `@doc` decorators on individual endpoint operations were silently dropped. They now appear as JSDoc comments on each method entry in the generated `*Endpoints` `as const` object.
- Generated `package.json` was missing `name`, `exports`, `scripts`, `files`, and `devDependencies`, making the emitted package impossible to build or publish without manual intervention.

### Changed

- Templates no longer receive pre-rendered block strings (`membersBlock`, `propertiesBlock`, `methodsBlock`). They now iterate directly over the raw view model arrays (`members`, `properties`, `methods`), giving template overrides full control over indentation, formatting, and structure.
- Enum member values are now single-quoted in the default template (e.g. `Red = 'red'`).

## [0.1.0] — 2026-06-03

### Added

- Initial emitter implementation: generates TypeScript `export interface` and `export enum` declarations from TypeSpec models.
- Endpoint path utility generation: produces an `export const FooEndpoints = { … } as const` object for each TypeSpec interface, with typed arrow functions for each operation.
- Version-aware generation via `target-version` and `all-versions` options.
- `route-prefix` option to control the path prefix prepended to every endpoint (default `api/{version}`; supports `{version}` token substitution).
- `npm-package-name`, `npm-version`, and `npm-description` options for the generated `package.json`.
- Handlebars template override support: any of the five built-in templates (`file`, `interface`, `enum`, `endpoints`, `index`) can be replaced with a custom `.hbs` file.
- Request type generation: `CreateRequest` and `UpdateRequest` interfaces derived from visibility-filtered model properties.
- Barrel `index.ts` re-exporting all generated models and endpoint files.

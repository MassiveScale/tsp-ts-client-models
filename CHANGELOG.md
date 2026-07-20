# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.6.0] — 2026-07-20

### Changed

- **Upgraded to the TypeSpec 1.14.0 release train.** `@typespec/compiler` and `@typespec/http` bumped to `^1.14.0`, `@typespec/rest` and `@typespec/versioning` to `^0.84.0`. The `@typespec/compiler` dependency is now pinned to `^1.14.0` (previously the floating `latest` tag) for reproducible builds. No emitter API changes were required — the release contains no breaking changes for the compiler/http/rest/versioning APIs this emitter consumes.

### Added

- **`@encode(string)` on boolean properties.** A property annotated with `@encode(string)` on a `boolean` (TypeSpec 1.14.0) is now emitted with the TypeScript type `string` instead of `boolean`. The generated `fetch`/JSON client performs no per-field transformation, so such a value arrives from `response.json()` as the string `"true"`/`"false"`; typing it `string` matches the actual runtime shape. Plain booleans and all other encodings are unaffected.

## [0.5.0] — 2026-07-07

### Fixed

- **Discriminated write bodies now preserve per-variant fields.** A `POST`/`PUT`/`PATCH` operation whose body is a `@discriminator` base model that also has a read-only/create-only property (e.g. a server-assigned `id`) previously generated a single flat `{Base}{Verb}Request` interface built only from the base model's own properties — silently dropping every variant-specific field (e.g. `Dog.isBarker`) and widening the discriminator back to its full enum type. The request type is now a union of per-variant filtered request types (e.g. `PetPostRequest = DogPostRequest | CatPostRequest`), each keeping its own fields and its discriminator narrowed to its literal value. See [docs/discriminated-models.md](docs/discriminated-models.md#write-bodies-with-read-only-properties).
- **Fixed dangling references in the discriminated write-body union.** The base model's own union alias (e.g. `Pet = Dog | Cat`) could be omitted entirely for a write-only API with no `GET`/`HEAD` operation, and a naming collision between two operations producing the same `{Base}{Verb}Request` (e.g. different `@parameterVisibility`) could leave the union referencing per-variant interfaces that had been renamed out from under it, or leave stale unprefixed interfaces behind. Collisions are now resolved with the same `@tag`-prefix convention as plain request types, renaming the union and every member together.

## [0.4.0] — 2026-07-05

### Added

- **`@discriminator` support.** A model annotated with `@discriminator` is now emitted as a TypeScript discriminated union of its concrete variants (e.g. `export type Pet = Dog | Cat;`) instead of a flat interface. Variant interfaces have their discriminator property narrowed to its literal wire value (e.g. `petKind: "dog"`), and are automatically discovered from the TypeSpec inheritance graph even when no operation references them directly. Every reference to the base model (properties, response types, etc.) now resolves to the precise union. Multi-level hierarchies are flattened to their concrete leaf variants. See [docs/discriminated-models.md](docs/discriminated-models.md).
- **Custom query parameters on any client method.** Every generated HTTP client method now accepts an optional `query` parameter, regardless of HTTP verb (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`) and even when the TypeSpec operation declares no `@query` parameters. Declared query params keep their specific types; an index signature (or, when none are declared, `Record<string, unknown>`) allows arbitrary additional keys to be passed through on any call. See [docs/http-client.md](docs/http-client.md#query-parameters).
- Property types set to a specific enum member (e.g. `petKind: PetKind.Dog`) now map to the correct TypeScript string literal type (e.g. `"dog"`) instead of `unknown`.

### Fixed

- `client/ApiClient.ts`'s `post`/`put`/`patch`/`delete`/`head` helper methods now accept a `query` option — previously only `get` did, and passing `query` through `delete`/`head` would fail to type-check.

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

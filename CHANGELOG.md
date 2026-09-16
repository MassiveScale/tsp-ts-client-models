# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.8.0] — 2026-09-16

### Added

- **Pluggable HTTP client: custom transport, middleware, and lifecycle hooks.** The generated `HttpClient` base (`client/ApiClient.ts`) now exposes three extension points on `ClientConfig`, so existing auth and error-handling code can be reused with a generated client instead of being reimplemented around it:
  - **`fetch?: FetchFunction`** — replaces the global `fetch` with any function taking a `Request` and returning a `Response`. Retry, timeout, error mapping, and JSON parsing all still apply; only the network call is swapped. Makes test stubs trivial and lets `axios`/Angular `HttpClient` be adapted with a short shim.
  - **`middleware?: HttpMiddleware[]`** plus **`HttpClient.use(middleware)`** — an onion-style pipeline, `(request, next) => Promise<Response>`, with the first entry as the outermost layer and the transport at the center. Layers can short-circuit (never call `next`), replay (call `next` twice — e.g. refresh a token on 401 and retry), or wrap the call in `try`/`catch`. `use()` appends inside `config.middleware` and returns the client for chaining.
  - **`onRequest` / `onResponse` / `onError` hooks** — plain callbacks for the common cases, each receiving a `RequestContext` (`method`, `url`, `attempt`). `onRequest` runs before any middleware and `onResponse` after all of it — both once per retry attempt, so token injection sees every attempt. `onResponse` also observes non-2xx responses before they become an `ApiError`. **`onError` is terminal:** it fires exactly once per logical call, after every retry attempt has failed, which is what an app-level error handler wants; returning a value from it substitutes the thrown error, returning nothing lets the original propagate.

  The middleware chain is composed **inside** the retry loop, so every layer and both request/response hooks are re-invoked per attempt. All of this applies unchanged to the Observable (RxJS) flavor — `RxHttpClient` routes through the same transport, and `onError` fires before the error reaches `subscriber.error`. **Fully backward compatible:** every new field is optional, and a client configured without them behaves exactly as before. New exported types: `FetchFunction`, `HttpNext`, `HttpMiddleware`, `RequestContext`, `RequestHook`, `ResponseHook`, `ErrorHook`. See [docs/client-extensibility.md](docs/client-extensibility.md).

- **First lint rule: `synthesized-request-type-collision`.** The emitter has always detected — at _emit_ time — when two operations would synthesize a same-named request body type with different property shapes (the `request-type-collision` diagnostic). This is now also predicted at _lint_ time, before an emit is ever run, via a new `$linter` export and its `synthesized-request-type-collision` rule (`severity: "warning"`, included in the `recommended` and `all` rule sets). The rule checks every declared API version independently (since which versions get emitted depends on emitter options a lint pass can't see) and reuses the exact same collision-detection logic as the emitter, so its findings always agree with what emission would report. Add `@tag` to disambiguate conflicting operations, exactly as the emit-time diagnostic already instructs.

### Fixed

- **`RateLimitError` and `ServiceUnavailableError` are now actually thrown.** Both classes have been exported and documented since the client was introduced, but the transport only ever constructed a plain `ApiError` — so `catch (e) { if (e instanceof RateLimitError) … }` never matched. A 429 now throws a `RateLimitError` (with `retryAfterMs` parsed from the `Retry-After` header, or `undefined` when the header is absent or is an HTTP-date) and a 503 throws a `ServiceUnavailableError`. Both carry the parsed error body. Since both extend `ApiError`, existing `instanceof ApiError` and `err.status` checks are unaffected.
- **`ApiError` now carries the originating `Response`.** A new optional `response` property exposes the status line and headers (e.g. a correlation ID) to error handlers. Its body is already consumed — the parsed value remains on `err.body`.
- **`HEAD` requests no longer reject with a JSON parse error.** The transport unconditionally called `response.json()` on any 2xx that was not a 204, so every `HEAD` call — whose response body is always empty — failed after a successful round trip. `HEAD`, `204`, and `205` now resolve to `undefined` without touching the body.
- **A malformed success body is no longer retried.** The response body of a 2xx was parsed inside the retry loop but returned un-awaited, so a JSON parse failure escaped the loop's `catch` and bypassed error handling entirely. Parsing now happens once, after the retry loop, so a bad body is surfaced to the caller (and to the new `onError` hook) instead of being silently mis-handled.
- **`synthesized-request-type-collision` missing-`@tag` diagnostic now blames the correct operation.** When a collision was detected and one of the two colliding operations had no `@tag`, the `missingTag` diagnostic was always reported against the newly-processed operation, even when it was actually the previously-registered operation that lacked the `@tag`. The rule now reports against whichever operation genuinely has no `@tag` (both, if neither does), for both the plain request-type collision check and the discriminated-union variant collision check.

### Changed

- **Extracted request-type-collision detection into `src/request-types.ts`.** The naming, visibility-filtering, and shape-comparison helpers `collectRequestType`/`collectDiscriminatedRequestType` rely on (`capitalize`, `flattenProperties`, `isOpInVersion`, `requestTypeSuffix`, `getMergePatchBaseName`, `propsHaveSameKeys`, `hasHiddenProperties`, `filterPropsForRequest`, `discriminatedVariantShapesMatch`) moved from `src/emitter.ts` into a new `src/request-types.ts` module. This is a behavior-preserving refactor with no change to emitted output — it exists so the new lint rule (below) can reuse the identical logic instead of duplicating it.
- **Upgraded to the TypeSpec 1.15.0 release train.** `@typespec/compiler` and `@typespec/http` bumped to `^1.15.0`, `@typespec/rest` and `@typespec/versioning` to `^0.85.0`. `@typespec/http` and `@typespec/versioning` are now also declared as explicit `peerDependencies` (alongside `@typespec/compiler`) since this emitter structurally uses HTTP operation/route concepts and versioning APIs at its core — matching the convention of sibling emitter packages. `@typespec/rest` remains a devDependency only; it is used solely by the example fixtures and test suite for cross-library compatibility, never by `src/`. No emitter API changes were required — 1.15.0's `using X;` resolution change (statements before a file-level `namespace` now resolve from the global namespace) does not affect this project, since every `using` target in `example/**/*.tsp` (`Http`, `Versioning`) is already a genuine top-level global.

## [0.7.0] — 2026-07-23

### Added

- **RxJS Observable client flavor (`client-style` option).** A new emitter option `client-style` selects the return-type flavor of the generated HTTP client(s): `promise` (default — unchanged behavior), `observable`, or `both`. The `observable`/`both` flavors emit a `{Name}ObservableClient` class per interface whose methods return a cold RxJS `Observable<T>` (the request fires on `subscribe`; unsubscribing aborts the in-flight `fetch` via `AbortController`), backed by a new `client/ApiClientRx.ts` base (`RxHttpClient`). `RxHttpClient` extends the existing `HttpClient` and reuses the same `fetch` transport, retry/backoff, timeout, and `ApiError`/`RateLimitError`/`ServiceUnavailableError` classes — so `catchError` sees the same error types as the Promise client. When enabled, the generated `package.json` declares `rxjs` as an **optional** `peerDependency` (`^7.0.0 || ^8.0.0`) and also lists it as a `devDependency` so the generated package type-checks and builds standalone (npm does not auto-install optional peer dependencies). **Promise-only consumers are unaffected:** with the default `promise` style, output is byte-for-byte identical and no `rxjs` dependency is added. The `templates.clientObservable` override slot lets you customize the Observable client template. See [docs/environments/angular.md](docs/environments/angular.md) and [docs/http-client.md](docs/http-client.md#observable-rxjs-client).

### Fixed

- **Operations named after an HTTP verb no longer break the generated client.** An operation literally named `delete` (or `get`, `post`, etc.) generated a public method that shadowed the base `HttpClient` transport helper of the same name, producing an incompatible-override error (TS2416) and a self-referential call (TS2558) — so the generated package failed to compile. The base transport helpers are now prefixed (`httpGet`, `httpPost`, `httpPut`, `httpPatch`, `httpDelete`, `httpHead`; and `httpGet$`, … on `RxHttpClient`), so no operation name can collide. **Note for extenders:** if you subclass a generated client and call or override the protected verb helpers, rename `get`/`post`/… to `httpGet`/`httpPost`/… (`request` is unchanged).
- **Fixed a dangling `{Base}PatchRequest` reference for transitively-referenced merge-patch types.** When a model with a MergePatch body (e.g. `StorePatchRequest`) contained another model (`pets: Pet[]`) whose base had a request type but no PATCH of its own (e.g. `Pet` has a POST but its PATCH is `@added` in a later API version), the nested property referenced a `PetPatchRequest` that was never emitted, so `models.ts` failed to compile. Such references now fall back to the base model (`Pet[]`) when no `{Base}PatchRequest` is emitted for that version.

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

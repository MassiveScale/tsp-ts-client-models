# HTTP Client

The emitter generates a typed HTTP client for each TypeSpec interface. The client uses the native `fetch` API and requires no external dependencies.

## Generated structure

```
client/
├── ApiClient.ts               ← base infrastructure (Promise transport)
├── ApiClientRx.ts             ← RxJS base (only with client-style: observable|both)
├── WidgetsClient.ts           ← Promise client, one per interface
└── WidgetsObservableClient.ts ← Observable client (only with client-style: observable|both)
```

All generated files are exported from `index.ts` and are part of the generated package.

To skip client generation, set `generate-http-client: false` in `tspconfig.yaml`. To generate RxJS `Observable`-based clients (for Angular), set `client-style: observable` or `client-style: both` — see [Observable (RxJS) client](#observable-rxjs-client).

## ApiClient.ts

Contains the base `HttpClient` class and supporting types. All generated `*Client` classes extend `HttpClient`.

### `ClientConfig`

Passed to the constructor of every client class.

```typescript
interface ClientConfig {
  baseUrl: string; // Required. No trailing slash needed.
  defaultHeaders?: Record<string, string>; // Sent with every request.
  timeout?: number; // Milliseconds, for the whole call including retries.
  retry?: RetryConfig;

  // Extensibility — see docs/client-extensibility.md
  fetch?: FetchFunction; // Custom transport. Default: the global fetch.
  middleware?: HttpMiddleware[]; // Onion-style layers, outermost first.
  onRequest?: RequestHook; // Before middleware, once per attempt.
  onResponse?: ResponseHook; // After middleware, once per attempt.
  onError?: ErrorHook; // Once, after retries are exhausted. Not on cancel.
}
```

`fetch`, `middleware`, and the three hooks let you inject your own transport, attach access tokens, and route failures into an app-level error handler without wrapping every call site. See [Extending the generated client](client-extensibility.md) — that page covers the full pipeline, including where each piece runs relative to retry.

### `RetryConfig`

Controls automatic retry for `429 Too Many Requests` and `503 Service Unavailable` responses.

```typescript
interface RetryConfig {
  maxAttempts?: number; // Default: 3
  baseDelayMs?: number; // Default: 1000 (exponential: 1s, 2s, 4s, …)
  retryOn?: number[]; // Default: [429, 503]
}
```

Retries use **exponential backoff**: `baseDelayMs * 2^attempt`. When a retried `429` or `503` carries a `Retry-After` header (in seconds), the client waits that long instead.

- A `retryOn` status is retried for every method, because the server sent it to say it did not act on the request.
- A network failure, where no response arrived, is retried only for idempotent methods: `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS`. A `POST` or `PATCH` may already have reached the server, so resending it could apply it twice.
- A call the caller cancelled, or one that timed out, is never retried. Aborting during a backoff wait ends the wait at once.
- The body of a response that is retried is discarded, so it does not hold the connection open.

### `RequestOptions`

Passed as an optional last argument to every client method.

```typescript
interface RequestOptions {
  headers?: Record<string, string>; // Merged over defaultHeaders.
  signal?: AbortSignal; // For manual cancellation.
}
```

Every request sends `Accept: application/json`, or the media type the operation declares for its response when that is not JSON (`text/plain`, `application/octet-stream`). Your own `Accept` header still wins. A `Content-Type` is sent only when the request has a body, so a cross-origin `GET` does not trigger a CORS preflight just for that header. Header names are matched case-insensitively, so a per-request `content-type` replaces the default instead of being sent alongside it.

### Error classes

| Class                     | Status | Extra properties                           |
| ------------------------- | ------ | ------------------------------------------ |
| `ApiError`                | any    | `status`, `statusText`, `body`, `response` |
| `RateLimitError`          | 429    | `retryAfterMs` (parsed from `Retry-After`) |
| `ServiceUnavailableError` | 503    | —                                          |

All three are thrown for a non-2xx response after the retry attempts are exhausted. `RateLimitError` and `ServiceUnavailableError` extend `ApiError`, so `instanceof ApiError` catches every case.

```typescript
try {
  await client.create(payload);
} catch (err) {
  if (err instanceof RateLimitError) {
    await sleep(err.retryAfterMs ?? 60_000);
  } else if (err instanceof ApiError) {
    console.error(err.status, err.statusText, err.body);
    console.error(err.response?.headers.get("X-Request-Id"));
  }
}
```

`err.response` is the originating `Response`, useful for status and headers. Its body is already consumed — the parsed value is on `err.body`.

To route every failure into a handler you already have, use the `onError` hook instead of a `try`/`catch` at each call site:

```typescript
const client = new WidgetsClient({
  baseUrl,
  onError: (error, context) => appErrorHandler.report(error, context),
});
```

## Generated client classes

Each TypeSpec interface becomes a class that extends `HttpClient`. Operations declared directly in a namespace are grouped by that namespace instead: operations in the service namespace itself take the service's name (`namespace PetStore` → `PetStoreClient`), and operations in a sub-namespace take the sub-namespace's name (`namespace PetStore.Pets` → `PetsClient`). When two interfaces or sub-namespaces share a name, both are qualified with their namespace path (`Pets.Ops` and `Stores.Ops` → `PetsOpsClient` and `StoresOpsClient`), so neither overwrites the other.

```typescript
// TypeSpec
@route("/widgets")
interface Widgets {
  @get list(): Widget[];
  @get read(@path id: string): Widget;
  @post create(@body body: Widget): Widget;
  @patch update(@path id: string, @body body: Widget): Widget;
  @delete remove(@path id: string): void;
}

// Generated
export class WidgetsClient extends HttpClient {
  async list(query?: Record<string, unknown>, options?: RequestOptions): Promise<Widget[]> { … }
  async read(id: string, query?: Record<string, unknown>, options?: RequestOptions): Promise<Widget> { … }
  async create(body: WidgetPostRequest, query?: Record<string, unknown>, options?: RequestOptions): Promise<Widget> { … }
  async update(id: string, body: WidgetPatchRequest, query?: Record<string, unknown>, options?: RequestOptions): Promise<Widget> { … }
  async remove(id: string, query?: Record<string, unknown>, options?: RequestOptions): Promise<void> { … }
}
```

- Arguments come in this order: path parameters, `body`, `query`, `headers` (only when the operation declares `@header` parameters), then `options`.
- Path parameters become leading positional arguments, required ones first. Their values are percent-encoded (`encodeURIComponent`), so an id such as `a/b` stays one path segment. A parameter declared with `allowReserved` (`{+path}`) keeps reserved characters such as `/`. An optional path parameter can be omitted, and its separator is omitted with it.
- A path parameter whose name is a reserved word, or clashes with `body`, `query`, `headers` or `options`, gets a `Param` suffix (`default` → `defaultParam`). The route still uses the TypeSpec wire name.
- If a request type was generated for the body model, the body parameter uses that type (e.g. `WidgetPostRequest`). Otherwise the raw model is used.
- Every other body shape is supported too. See [Request bodies](#request-bodies).
- The response type is the TypeScript equivalent of the first 2xx response body. Operations with no body response use `void`. A JSON body is parsed, and an empty one (a `201` with no content, for example) resolves to `undefined`. A textual response such as `text/plain` resolves to the raw string, and is typed `string` whatever its TypeSpec type: a `text/plain` `int32` arrives as `"42"`. A `bytes` response with a non-JSON media type resolves to a `Uint8Array`.
- Every method accepts a `query` parameter, regardless of HTTP verb. See [Query parameters](#query-parameters).
- When an argument after an optional one is required, the optional one is typed `T | undefined`, and you pass `undefined` to skip it.

### Request bodies

| TypeSpec body                                                        | Generated `body` type               | Sent as                                           |
| -------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- |
| `@body body: Widget`                                                 | `WidgetPostRequest` or `Widget`     | JSON                                              |
| Spread or inline (`op create(name: string, size: int32)`)            | `{ name: string; size: number }`    | JSON                                              |
| `@body items: Widget[]`                                              | `Widget[]`                          | JSON                                              |
| `@body patch: MergePatchUpdate<Widget>`                              | `WidgetPatchRequest`                | JSON, as `application/merge-patch+json`           |
| `@body data: string` (or another scalar)                             | `string`                            | As-is, as `text/plain` (TypeSpec's default)       |
| `@header contentType: "application/octet-stream", @body data: bytes` | `Blob \| ArrayBuffer \| Uint8Array` | As-is, with the declared media type               |
| `@body file: File`                                                   | `Blob`                              | As-is, with the declared media type               |
| `@multipartBody body: { … }`                                         | `FormData`                          | As-is; `fetch` sets the multipart boundary itself |

A `Content-Type` you set in `options.headers` decides how the body is serialized, so a JSON media type always gets JSON and any other is sent as-is. A `@delete` operation with a `@body` sends it too.

For a multipart body you build the `FormData` yourself, using the part names from the TypeSpec definition. A `Content-Type` header parameter is never offered as an argument, because the body's declared media type decides it. You can still override it through `options.headers`.

### Header parameters

`@header` parameters become a `headers` argument, keyed by their wire names. It is required when any of them is required:

```typespec
@get read(@path id: string, @header("x-tenant") tenant: string, @header ifMatch?: string): Widget;
```

```typescript
async read(
  id: string,
  query: Record<string, unknown> | undefined,
  headers: { "x-tenant": string; "if-match"?: string },
  options?: RequestOptions,
): Promise<Widget>;

await client.read("w1", undefined, { "x-tenant": "contoso" });
```

A `Date` value is sent as an HTTP-date, an array is joined with commas, and `undefined`/`null` values are skipped. Headers in `options.headers` override the declared ones. Header names are matched case-insensitively.

### Reserved method names

A generated client extends `HttpClient`, so an operation whose name matches an inherited member would shadow it with an incompatible signature and the generated package would not compile. Those operations get an `Operation` suffix on the **client method only**, and the emitter reports a `reserved-client-method-name` warning naming the substitution:

```typespec
@get request(): Widget[];   // collides with HttpClient.request
```

```typescript
async requestOperation(…): Promise<Widget[]> {
  return this.httpGet<Widget[]>(WidgetsEndpoints.request(), …); // endpoint name unchanged
}
```

Which names are reserved depends on the base class your client actually extends, so a Promise-only build does not give up names that exist only on `RxHttpClient`:

| `client-style`               | Reserved                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promise` (default)          | `Object.prototype` members (`constructor`, `toString`, `toLocaleString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`) and `then`, which would make the client a thenable; plus `HttpClient` members: `config`, `middleware`, `useMiddleware`, `buildUrl`, `request`, `applyErrorHook`, `httpGet`/`httpPost`/`httpPut`/`httpPatch`/`httpDelete`/`httpHead` |
| `observable` &middot; `both` | The above, plus `RxHttpClient` members: `observe` and the `$` verb helpers (`httpGet$`, `httpPost$`, …)                                                                                                                                                                                                                                                                            |

So `@get observe(): Widget[]` generates `client.observe()` under the default style, and `client.observeOperation()` once an Observable client is in the mix. Under `both`, the larger set applies to _both_ generated clients, so the Promise and Observable flavors stay method-for-method interchangeable.

The `*Endpoints` object is a plain `as const` and inherits nothing, so its keys always keep the original operation name. Rename the operation in TypeSpec if you want the method name back.

### Export name collisions

`index.ts` star-exports every generated module, so two modules exporting the same name would make the re-export ambiguous and the package would not compile (TS2308). This happens when a TypeSpec declaration is named after something the emitter also generates — an infrastructure export like `RequestContext`, `ClientConfig` or `ApiError`, an endpoint object like `WidgetsEndpoints`, or a client class like `WidgetsClient`.

The barrel resolves it by priority. Whichever module comes first keeps the plain name; later ones are re-exported explicitly, with a `Client` prefix:

1. **Declared TypeSpec types** (`models.ts`) — always keep the plain name.
2. **Generated endpoint objects and client classes.**
3. **Static client infrastructure** (`ApiClient.ts`, `ApiClientRx.ts`).

```typespec
model RequestContext { id: string; }
```

```typescript
// index.ts
export * from "./models.js"; // RequestContext = your model
export { ApiError, HttpClient /* … */ } from "./client/ApiClient.js";
export type {
  RequestContext as ClientRequestContext /* … */,
} from "./client/ApiClient.js";
```

A `generated-export-name-collision` warning reports each substitution. The aliased name is a normal root export, so the infrastructure type is still reachable:

```typescript
import type { ClientRequestContext } from "@my-org/my-api-client";
```

> The generated package's `exports` map only exposes the package root, so `@my-org/my-api-client/client/ApiClient.js` is **not** importable — use the aliased root export above. Rename the TypeSpec declaration if you would rather have the plain name back.

The same applies inside a generated client module: if a model used as a response or request body is named `HttpClient`, `RequestOptions`, `Observable`, or after the interface's own `*Endpoints` object, the client's _infrastructure_ import is aliased and the model keeps the plain name in the method signatures. The generated class itself counts too: `interface Http` declares `class HttpClient`, so its base-class import becomes `HttpClient as ClientHttpClient`.

The one case where the **model** import is aliased instead is a model named after a global the client text references — `Promise`, `Record`, `Date`, or `Uint8Array`. Importing `Promise` from `models.ts` would shadow the global that every return type is wrapped in, so the client imports it as `Promise as PromiseModel` and uses that alias in its signatures. The model's exported name is unchanged; only the client module's local binding differs.

### Client module name collisions

Generated client class names are allocated from one shared pool, so no two land on the same file. A client steps aside — taking a numeric suffix and reporting a `client-module-name-collision` warning — when its preferred name is already taken by:

| Case                      | Example                                                                                              | Result                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| The static infrastructure | `interface Api` → `client/ApiClient.ts`                                                              | `ApiClient2`           |
| Another generated client  | `interface Foo` (Observable) and `interface FooObservable` (Promise) both want `FooObservableClient` | `FooObservableClient2` |
| A declared type           | `model WidgetsClient` alongside `interface Widgets`                                                  | `WidgetsClient2`       |

The infrastructure path cannot move (every client imports `./ApiClient.js`) and a declared type keeps its own name, so the generated client is what yields. Rename the interface — or the type it collides with — to get the plain name back.

## Query parameters

Every generated client method accepts a `query` object, whether or not the TypeSpec operation declares any `@query` parameters, and regardless of HTTP verb (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` all support it). It is optional unless one of the declared query parameters is required.

If the operation declares `@query` parameters, they keep their specific types and the object also accepts arbitrary additional keys. Keys are the parameters' wire names, so `@query("api-version") apiVersion: string` is passed as `{ "api-version": "2024-01-01" }`:

```typespec
@get list(@query status?: string): Widget[];
```

```typescript
// Generated
async list(
  query?: { status?: string; [key: string]: unknown },
  options?: RequestOptions,
): Promise<Widget[]>;

// Usage — declared param plus an ad-hoc custom one
await client.list({ status: "active", debug: "true" });
```

If the operation declares no `@query` parameters at all, `query` is still available, typed as an open bag:

```typescript
async create(body: WidgetPostRequest, query?: Record<string, unknown>, options?: RequestOptions): Promise<Widget>;

await client.create(newWidget, { dryRun: "true" });
```

Values passed in `query` are appended to the URL as a query string (via `URLSearchParams`):

- `undefined` and `null` values are omitted.
- A `Date` is sent as an ISO 8601 string.
- An array is joined with commas (`ids=a,b`). For a parameter declared with `@query(#{ explode: true })` it is repeated instead (`tags=a&tags=b`).
- Any other object is sent as JSON.

## Instantiation

```typescript
import { WidgetsClient } from "@my-org/my-api-client";

const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  defaultHeaders: { Authorization: `Bearer ${token}` },
  timeout: 10_000,
  retry: { maxAttempts: 5, baseDelayMs: 500 },
});
```

## Per-request headers and cancellation

```typescript
const controller = new AbortController();

const widget = await client.read("abc123", {
  headers: { "X-Trace-Id": "xyz" },
  signal: controller.signal,
});

// Cancel in-flight request
controller.abort();
```

## Observable (RxJS) client

By default the emitter generates Promise-based clients. Set `client-style` in `tspconfig.yaml` to also (or instead) generate an RxJS `Observable`-based client — ideal for Angular:

```yaml
options:
  "@massivescale/tsp-ts-client-models":
    client-style: both # "promise" (default) | "observable" | "both"
```

| Value        | Emits                                                           |
| ------------ | --------------------------------------------------------------- |
| `promise`    | `{Name}Client` only (default; output unchanged, no `rxjs`)      |
| `observable` | `{Name}ObservableClient` only                                   |
| `both`       | Both clients side by side, sharing one `ApiClient.ts` transport |

When `observable`/`both` is selected the emitter adds a `client/ApiClientRx.ts` base (`RxHttpClient extends HttpClient`) and declares `rxjs` in the generated `package.json` as both an **optional** `peerDependency` (so consumers resolve their own version) and a `devDependency` (so the generated package type-checks and builds standalone — npm does not auto-install optional peers). The Promise flavor is completely unaffected — with the default `promise` style, no `rxjs` dependency is added and no extra files are emitted.

```typescript
// Generated (client-style: observable | both)
export class WidgetsObservableClient extends RxHttpClient {
  list(query?: Record<string, unknown>, options?: RequestOptions): Observable<Widget[]> { … }
  read(id: string, query?: Record<string, unknown>, options?: RequestOptions): Observable<Widget> { … }
  create(body: WidgetPostRequest, query?: Record<string, unknown>, options?: RequestOptions): Observable<Widget> { … }
}
```

The method signatures, path/body/query parameters, and `RequestOptions` are identical to the Promise client — only the return type differs (`Observable<T>` instead of `Promise<T>`).

### Semantics

- **Cold:** the underlying `fetch` fires on `subscribe`, not when the Observable is created. Each subscription triggers its own request; use `shareReplay`/`share` (or Angular's `async` pipe with a single subscription) if you need to share one result across subscribers.
- **Cancellation:** unsubscribing aborts the in-flight request via `AbortController` and stops any pending retry. A `RequestOptions.signal` you pass also aborts it, and a configured `timeout` still applies and rejects with the same `TimeoutError` as the Promise client. Neither unsubscribing nor your own signal calls `onError`.
- **Errors:** `ApiError` / `RateLimitError` / `ServiceUnavailableError` are delivered via the Observable's error channel, so `catchError` sees the same types as the Promise client. Retry/backoff and timeout behavior are shared with `HttpClient` — `RxHttpClient` reuses the same transport.
- **Extensibility:** `config.fetch`, `config.middleware`, `client.useMiddleware()`, and the `onRequest`/`onResponse`/`onError` hooks all behave identically, for the same reason. `onError` fires before the error reaches `subscriber.error`, so a `catchError` downstream sees whatever the hook decided to throw.

```typescript
import { WidgetsObservableClient } from "@my-org/my-api-client";
import { catchError, of } from "rxjs";

const client = new WidgetsObservableClient({
  baseUrl: "https://api.example.com",
});

const sub = client
  .list({ status: "active" })
  .pipe(catchError((err) => of([])))
  .subscribe((widgets) => console.log(widgets));

// Cancel the in-flight request
sub.unsubscribe();
```

See [Using in Angular](environments/angular.md) for the full Angular integration.

## Extending the client

Three extension points are built into every generated client — a custom `fetch` transport, an onion-style middleware pipeline, and `onRequest`/`onResponse`/`onError` hooks:

```typescript
const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  fetch: myTransport,
  middleware: [authMiddleware, loggingMiddleware],
  onError: (error) => appErrorHandler.report(error),
});

client.useMiddleware(tracingMiddleware); // also registerable after construction
```

Middleware and the request/response hooks run **once per retry attempt**, so a layer that refreshes an expired token sees every attempt. `onError` runs **once**, after the last attempt fails. See [Extending the generated client](client-extensibility.md) for the full pipeline, worked examples (auth, refresh-on-401, caching, logging, test stubs, axios/Angular adapters), and the `Request`/`Response` rules for writing middleware.

Subclassing still works too:

```typescript
import { WidgetsClient, type ClientConfig } from "@my-org/my-api-client";

export class AuthenticatedWidgetsClient extends WidgetsClient {
  constructor(config: Omit<ClientConfig, "defaultHeaders">, token: string) {
    super({ ...config, defaultHeaders: { Authorization: `Bearer ${token}` } });
  }
}
```

Or extend `HttpClient` directly to build a fully custom client that still participates in retry and error handling.

## Timeout

Set a global timeout (milliseconds) via `ClientConfig.timeout`. It bounds the whole call, retries and backoff waits included, and it applies even when a request passes its own `signal`: whichever fires first wins. A timeout rejects with a `TimeoutError` and is reported to `onError`.

A per-request timeout or cancellation uses an `AbortSignal`:

```typescript
const widget = await client.read("abc123", undefined, {
  signal: AbortSignal.timeout(5_000), // 5 seconds
});
```

A call the caller aborts rejects with the signal's reason (an `AbortError` by default) and is **not** reported to `onError`, since the caller already knows. The same applies to unsubscribing from an Observable client.

`AbortSignal.timeout()` is available in Node.js 17.3+ and all modern browsers.

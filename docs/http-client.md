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
  timeout?: number; // Milliseconds. Uses AbortSignal.timeout().
  retry?: RetryConfig;

  // Extensibility — see docs/client-extensibility.md
  fetch?: FetchFunction; // Custom transport. Default: the global fetch.
  middleware?: HttpMiddleware[]; // Onion-style layers, outermost first.
  onRequest?: RequestHook; // Before middleware, once per attempt.
  onResponse?: ResponseHook; // After middleware, once per attempt.
  onError?: ErrorHook; // Once, after retries are exhausted.
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

Retries use **exponential backoff**: `baseDelayMs * 2^attempt`. For `429` responses, the `Retry-After` header is honored when present.

### `RequestOptions`

Passed as an optional last argument to every client method.

```typescript
interface RequestOptions {
  headers?: Record<string, string>; // Merged over defaultHeaders.
  signal?: AbortSignal; // For manual cancellation.
}
```

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

Each TypeSpec interface becomes a class that extends `HttpClient`.

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

- Path parameters become leading positional arguments.
- If a request type was generated for the body model, the body parameter uses that type (e.g. `WidgetPostRequest`). Otherwise the raw model is used.
- The response type is the TypeScript equivalent of the first 2xx response body. Operations with no body response use `void`.
- Every method accepts an optional `query` parameter, regardless of HTTP verb — see [Query parameters](#query-parameters).

## Query parameters

Every generated client method accepts an optional `query` object, whether or not the TypeSpec operation declares any `@query` parameters, and regardless of HTTP verb (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` all support it).

If the operation declares `@query` parameters, they keep their specific types and the object also accepts arbitrary additional keys:

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

Values passed in `query` are appended to the URL as a query string (via `URLSearchParams`); `undefined`/`null` values are omitted.

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
- **Cancellation:** unsubscribing aborts the in-flight request via `AbortController`. A `RequestOptions.signal` you pass also aborts it, and a configured `timeout` still applies.
- **Errors:** `ApiError` / `RateLimitError` / `ServiceUnavailableError` are delivered via the Observable's error channel, so `catchError` sees the same types as the Promise client. Retry/backoff and timeout behavior are shared with `HttpClient` — `RxHttpClient` reuses the same transport.
- **Extensibility:** `config.fetch`, `config.middleware`, `client.use()`, and the `onRequest`/`onResponse`/`onError` hooks all behave identically, for the same reason. `onError` fires before the error reaches `subscriber.error`, so a `catchError` downstream sees whatever the hook decided to throw.

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

client.use(tracingMiddleware); // also registerable after construction
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

Set a global timeout (milliseconds) via `ClientConfig.timeout`. Per-request timeout can be applied using a manual `AbortSignal`:

```typescript
const widget = await client.read("abc123", {
  signal: AbortSignal.timeout(5_000), // 5 seconds
});
```

`AbortSignal.timeout()` is available in Node.js 17.3+ and all modern browsers.

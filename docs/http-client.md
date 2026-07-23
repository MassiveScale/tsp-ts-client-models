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
}
```

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

| Class                     | Status | When thrown                      |
| ------------------------- | ------ | -------------------------------- |
| `ApiError`                | any    | Non-2xx after all retry attempts |
| `RateLimitError`          | 429    | Subclass of `ApiError`           |
| `ServiceUnavailableError` | 503    | Subclass of `ApiError`           |

```typescript
try {
  await client.create(payload);
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.status, err.statusText, err.body);
  }
}
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

When `observable`/`both` is selected the emitter adds a `client/ApiClientRx.ts` base (`RxHttpClient extends HttpClient`) and declares `rxjs` as an **optional** peer dependency in the generated `package.json`. The Promise flavor is completely unaffected — with the default `promise` style, no `rxjs` dependency is added and no extra files are emitted.

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

You can extend any generated client to add shared logic:

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

# HTTP Client

The emitter generates a typed HTTP client for each TypeSpec interface. The client uses the native `fetch` API and requires no external dependencies.

## Generated structure

```
client/
├── ApiClient.ts        ← base infrastructure
└── WidgetsClient.ts    ← one class per TypeSpec interface
```

Both files are exported from `index.ts` and are part of the generated package.

To skip client generation, set `generate-http-client: false` in `tspconfig.yaml`.

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
  async list(options?: RequestOptions): Promise<Widget[]> { … }
  async read(id: string, options?: RequestOptions): Promise<Widget> { … }
  async create(body: WidgetPostRequest, options?: RequestOptions): Promise<Widget> { … }
  async update(id: string, body: WidgetPatchRequest, options?: RequestOptions): Promise<Widget> { … }
  async remove(id: string, options?: RequestOptions): Promise<void> { … }
}
```

- Path parameters become leading positional arguments.
- If a request type was generated for the body model, the body parameter uses that type (e.g. `WidgetPostRequest`). Otherwise the raw model is used.
- The response type is the TypeScript equivalent of the first 2xx response body. Operations with no body response use `void`.

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

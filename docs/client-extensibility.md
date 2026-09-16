# Extending the generated client

The generated client is built so you can plug your **existing** code into it — the token fetcher you already wrote, the error handler your app already uses, the logging you already have — without forking the generated output or wrapping every call site.

There are three ways in, from smallest to largest:

| You want to…                                   | Use            |
| ---------------------------------------------- | -------------- |
| Swap out `fetch` for your own transport        | `config.fetch` |
| React to every request, response, or failure   | Hooks          |
| Wrap a call — retry, cache, short-circuit, log | Middleware     |

All three work identically on the Promise client and the [Observable (RxJS) client](http-client.md#observable-rxjs-client), because both flavors route through the same `HttpClient` transport.

---

## Quick reference

```typescript
const client = new WidgetsClient({
  baseUrl: "https://api.example.com",

  // 1. Custom transport. Anything fetch-compatible.
  fetch: myFetch,

  // 2. Middleware. Outermost first. Runs once per retry attempt.
  middleware: [authMiddleware, loggingMiddleware],

  // 3. Hooks. Simple callbacks for the common cases.
  onRequest: (request, context) => {
    /* … */
  },
  onResponse: (response, context) => {
    /* … */
  },
  onError: (error, context) => {
    /* … */
  },
});

// Middleware can also be added after construction.
client.use(tracingMiddleware);
```

---

## Where everything runs

This ordering is the part worth understanding, because it is what makes token refresh work:

```
request()
└── retry loop  ── attempt 0, 1, 2 …
    └── onRequest hook
        └── middleware[0]          (outermost)
            └── middleware[1]
                └── config.fetch   (or the global fetch)
            └── onResponse hook
    └── retry decision (429 / 503 / your retryOn list)
└── onError hook                   (once, after retries are exhausted)
```

Two consequences:

- **Middleware and the `onRequest`/`onResponse` hooks run once per attempt.** A layer that attaches an access token is re-invoked on every retry, so an expired token is refreshed instead of being replayed.
- **`onError` runs once per logical call**, after the last attempt fails. It is a terminal, app-level handler — not a per-attempt observer. If you need per-attempt error handling, put a `try`/`catch` around `next()` inside a middleware.

---

## 1. Custom transport (`config.fetch`)

`config.fetch` replaces the global `fetch`. It receives a `Request` and returns a `Response`:

```typescript
export type FetchFunction = (request: Request) => Promise<Response>;
```

The global `fetch` satisfies this type as-is, so the simplest override just wraps it:

```typescript
const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  fetch: async (request) => {
    console.time(request.url);
    try {
      return await fetch(request);
    } finally {
      console.timeEnd(request.url);
    }
  },
});
```

Everything else — retry, timeout, error mapping, JSON parsing — still applies. You are replacing the network call, not the client.

### Testing against a stub

Because the transport is just a function, tests need no network and no mocking library:

```typescript
const client = new WidgetsClient({
  baseUrl: "https://test.local",
  fetch: async () =>
    new Response(JSON.stringify([{ id: "w1", name: "Widget" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
});

expect(await client.list()).toEqual([{ id: "w1", name: "Widget" }]);
```

### Adapting a non-`fetch` HTTP library

The client only understands `fetch`-compatible transports. To use `axios`, Angular's `HttpClient`, or anything else, write a small adapter that converts between `Request`/`Response` and your library's types:

```typescript
import axios from "axios";

const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  fetch: async (request) => {
    const body = request.body ? await request.text() : undefined;
    const res = await axios.request({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      data: body,
      // Let the generated client map non-2xx to ApiError itself.
      validateStatus: () => true,
      responseType: "text",
    });
    return new Response(res.data, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers as Record<string, string>,
    });
  },
});
```

---

## 2. Hooks

Hooks are plain callbacks. Use them when you want to observe or lightly adjust a call, and you do not need to wrap it.

### `onRequest`

Runs before any middleware, once per attempt. Return a replacement `Request`, or return nothing to keep the original.

```typescript
const client = new WidgetsClient({
  baseUrl: "https://api.example.com",
  onRequest: async (request) => {
    const token = await getAccessToken(); // your existing code
    const authed = new Request(request);
    authed.headers.set("Authorization", `Bearer ${token}`);
    return authed;
  },
});
```

> Build the replacement with `new Request(request, …)` rather than `new Request(url, …)`. That copy carries the method, body, and `AbortSignal` across; building from a bare URL silently drops cancellation.

### `onResponse`

Runs after all middleware, once per attempt, **including for non-2xx responses** — so it sees a 401 or a 500 before the client turns it into an `ApiError`. Return a replacement `Response`, or nothing to keep the original.

```typescript
onResponse: (response, context) => {
  metrics.record(context.method, context.url, response.status);
};
```

> If you read the body here (`response.json()`, `response.text()`), read it from `response.clone()`. A body can only be consumed once, and the client still needs it.

### `onError`

Runs once, after every retry attempt has failed. This is where an app-level error handler belongs.

```typescript
onError: (error, context) => {
  appErrorHandler.report(error, { url: context.url });
  // Return nothing → the original error still propagates to the caller.
};
```

You can also translate the error by returning a replacement:

```typescript
onError: (error) => {
  if (error instanceof RateLimitError) {
    return new QuotaExceededError("Try again in a minute.");
  }
  // Anything else passes through unchanged.
};
```

| Return value          | Result                         |
| --------------------- | ------------------------------ |
| nothing / `undefined` | The original error is thrown   |
| any other value       | That value is thrown instead   |
| (the hook throws)     | The hook's own error is thrown |

### `RequestContext`

Every hook receives a context describing the call:

```typescript
interface RequestContext {
  readonly method: string; // "GET"
  readonly url: string; // fully-resolved, including query string
  readonly attempt: number; // zero-based; 0 is the first try
}
```

---

## 3. Middleware

Middleware is the full-power option: an onion, where each layer gets the request, calls `next`, and gets the response back.

```typescript
export type HttpMiddleware = (
  request: Request,
  next: (request: Request) => Promise<Response>,
) => Promise<Response>;
```

Layers listed earlier wrap the ones listed later; `config.fetch` sits at the center. Layers added via `client.use()` go inside those from `config.middleware`.

Unlike hooks, middleware can **not call `next` at all** (short-circuit), **call it more than once** (retry), or **wrap it in `try`/`catch`** (per-attempt error handling).

### Authentication

```typescript
const authMiddleware: HttpMiddleware = async (request, next) => {
  const token = await tokenStore.get(); // your existing token code
  const authed = new Request(request);
  authed.headers.set("Authorization", `Bearer ${token}`);
  return next(authed);
};
```

### Refresh-on-401 and replay

The one case hooks cannot express:

```typescript
const refreshMiddleware: HttpMiddleware = async (request, next) => {
  const first = await next(request.clone());
  if (first.status !== 401) return first;

  await tokenStore.refresh();
  const retried = new Request(request);
  retried.headers.set("Authorization", `Bearer ${await tokenStore.get()}`);
  return next(retried);
};
```

Note the `request.clone()` on the first call — a request body can only be read once, so the original must be kept intact for the replay.

### Logging

```typescript
const loggingMiddleware: HttpMiddleware = async (request, next) => {
  const started = performance.now();
  try {
    const response = await next(request);
    logger.info(
      `${request.method} ${request.url} → ${response.status} (${Math.round(performance.now() - started)}ms)`,
    );
    return response;
  } catch (error) {
    logger.error(`${request.method} ${request.url} failed`, error);
    throw error;
  }
};
```

### Short-circuiting (caching, offline mode)

```typescript
const cacheMiddleware: HttpMiddleware = async (request, next) => {
  if (request.method !== "GET") return next(request);

  const hit = cache.get(request.url);
  if (hit) return hit.clone(); // never reaches the network

  const response = await next(request);
  if (response.ok) cache.set(request.url, response.clone());
  return response;
};
```

### Registering later

`use()` appends a layer and returns the client, so registrations chain:

```typescript
const client = new WidgetsClient({ baseUrl })
  .use(authMiddleware)
  .use(loggingMiddleware);
```

This is handy when a layer depends on something not available at construction time — a DI container, a router, a user session.

---

## Rules for writing middleware

A few `Request`/`Response` facts that will otherwise bite you:

1. **Bodies are single-use.** Call `.clone()` before reading a body you intend to pass along, on both requests and responses.
2. **Build modified requests from the original.** `new Request(request, { headers })` preserves the method, body, and `AbortSignal`. `new Request(request.url, { headers })` does not.
3. **Always return a `Response`.** Throwing from a layer aborts the attempt; the retry loop treats it like a transport failure.
4. **Keep layers stateless per call.** They are re-invoked on every retry attempt.

---

## Errors

| Class                     | Status | Extra properties                           |
| ------------------------- | ------ | ------------------------------------------ |
| `ApiError`                | any    | `status`, `statusText`, `body`, `response` |
| `RateLimitError`          | 429    | `retryAfterMs` (parsed from `Retry-After`) |
| `ServiceUnavailableError` | 503    | —                                          |

`RateLimitError` and `ServiceUnavailableError` extend `ApiError`, so `instanceof ApiError` catches all three.

```typescript
import { ApiError, RateLimitError } from "@my-org/my-api-client";

try {
  await client.list();
} catch (error) {
  if (error instanceof RateLimitError) {
    await sleep(error.retryAfterMs ?? 60_000);
  } else if (error instanceof ApiError) {
    console.error(error.status, error.body);
    console.error(error.response?.headers.get("X-Request-Id"));
  }
}
```

`error.response` is the originating `Response`. Its **body is already consumed** (it was parsed into `error.body`); use it for status and headers only.

---

## Choosing between the three

| Situation                                             | Reach for      |
| ----------------------------------------------------- | -------------- |
| Add an auth header                                    | `onRequest`    |
| Report failures to Sentry / an app error handler      | `onError`      |
| Record metrics per response                           | `onResponse`   |
| Refresh a token on 401 and replay the request         | Middleware     |
| Cache or short-circuit responses                      | Middleware     |
| Time or trace a whole call                            | Middleware     |
| Route requests through axios, Angular, or a test stub | `config.fetch` |

When in doubt: start with a hook, and move to middleware the moment you need to wrap or repeat the call.

---

## Still available: subclassing

Extending a generated client class also still works, and composes with everything above:

```typescript
import { WidgetsClient, type ClientConfig } from "@my-org/my-api-client";

export class AuthenticatedWidgetsClient extends WidgetsClient {
  constructor(config: ClientConfig, tokenStore: TokenStore) {
    super({
      ...config,
      middleware: [...(config.middleware ?? []), authMiddleware(tokenStore)],
    });
  }
}
```

See [docs/http-client.md](http-client.md) for the rest of the client surface.

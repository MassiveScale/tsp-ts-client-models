import { describe, it } from "node:test";
import { ok, strictEqual, deepStrictEqual, match, rejects } from "node:assert";
import * as ts from "typescript";
import { emit } from "./test-host.js";

/**
 * Behavioral tests for the generated `client/ApiClient.ts` transport.
 *
 * The emitter writes that file as static TypeScript source, so the only way to
 * prove the middleware pipeline, hooks, and retry ordering actually work is to
 * transpile the emitted text and execute it. The module has no imports, so it
 * can be loaded straight from a `data:` URL.
 */

/** A fetch-compatible transport stub. */
type Transport = (request: Request) => Promise<Response>;

/** The subset of the generated `HttpClient` these tests drive. */
interface HttpClientLike {
  useMiddleware(middleware: unknown): HttpClientLike;
  request<T>(
    method: string,
    path: string,
    options?: Record<string, unknown>,
  ): Promise<T>;
}

/** The exports these tests reach for out of the generated module. */
interface ApiClientModule {
  HttpClient: new (config: Record<string, unknown>) => HttpClientLike;
  ApiError: new (...args: never[]) => Error;
  RateLimitError: new (...args: never[]) => Error;
  ServiceUnavailableError: new (...args: never[]) => Error;
}

const MINIMAL_SPEC = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  model Widget { id: string; name: string; }

  @route("/widgets")
  interface Widgets {
    @get list(): Widget[];
  }
`;

let cached: Promise<ApiClientModule> | undefined;

/** Emits, transpiles, and imports the generated `ApiClient.ts` module once. */
function loadApiClient(): Promise<ApiClientModule> {
  cached ??= (async () => {
    const results = await emit(MINIMAL_SPEC);
    const key = Object.keys(results).find((k) =>
      k.endsWith("client/ApiClient.ts"),
    );
    ok(key, "Expected client/ApiClient.ts to be emitted");
    const js = ts.transpileModule(results[key], {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        useDefineForClassFields: false,
      },
    }).outputText;
    const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
    return (await import(url)) as ApiClientModule;
  })();
  return cached;
}

/** Builds a JSON response with the given body and status. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A transport that replays the given responses in order. */
function sequence(...responses: Response[]): Transport & { calls: Request[] } {
  const calls: Request[] = [];
  const transport = (request: Request) => {
    calls.push(request);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return Promise.resolve(next.clone());
  };
  return Object.assign(transport, { calls });
}

/**
 * A transport that never answers on its own: it settles only when the
 * request's signal aborts, rejecting with the signal's reason as `fetch` does.
 */
function hanging(): Transport & { calls: Request[] } {
  const calls: Request[] = [];
  const transport = (request: Request) => {
    calls.push(request);
    return new Promise<Response>((_, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(request.signal.reason),
        { once: true },
      );
    });
  };
  return Object.assign(transport, { calls });
}

/** The subset of the generated `RxHttpClient` these tests drive. */
interface RxHttpClientLike {
  httpGet$(
    path: string,
    options?: Record<string, unknown>,
  ): {
    subscribe(observer: {
      next?: (value: unknown) => void;
      error?: (error: unknown) => void;
    }): { unsubscribe(): void };
  };
}

/**
 * A minimal stand-in for rxjs's `Observable`: cold, closes on error or
 * complete, and runs the teardown on unsubscribe. rxjs is an optional peer of
 * the generated package and is not installed here.
 */
const OBSERVABLE_STUB = `class Observable {
  constructor(subscribe) { this._subscribe = subscribe; }
  subscribe(observer) {
    let closed = false;
    const teardown = this._subscribe({
      next: (v) => { if (!closed) observer.next?.(v); },
      error: (e) => { if (!closed) { closed = true; observer.error?.(e); } },
      complete: () => { if (!closed) { closed = true; observer.complete?.(); } },
    });
    return { unsubscribe() { closed = true; teardown?.(); } };
  }
}`;

let cachedRx:
  | Promise<{
      RxHttpClient: new (config: Record<string, unknown>) => RxHttpClientLike;
    }>
  | undefined;

/**
 * Emits the Observable flavor, then imports its `ApiClientRx.ts` with the
 * `ApiClient.js` import pointed at the transpiled infrastructure module and
 * rxjs replaced by {@link OBSERVABLE_STUB}.
 */
function loadRxClient(): NonNullable<typeof cachedRx> {
  cachedRx ??= (async () => {
    const results = await emit(MINIMAL_SPEC, { "client-style": "observable" });
    const source = (suffix: string) => {
      const key = Object.keys(results).find((k) => k.endsWith(suffix));
      ok(key, `Expected ${suffix} to be emitted`);
      return ts.transpileModule(results[key], {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: false,
        },
      }).outputText;
    };
    const toUrl = (js: string) =>
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
    const rx = source("client/ApiClientRx.ts")
      .replace(/import \{ Observable \} from "rxjs";/, OBSERVABLE_STUB)
      .replace(
        '"./ApiClient.js"',
        JSON.stringify(toUrl(source("client/ApiClient.ts"))),
      );
    return import(toUrl(rx));
  })();
  return cachedRx;
}

/** Config defaults that keep retry-driven tests from sleeping for seconds. */
const FAST_RETRY = { maxAttempts: 1, baseDelayMs: 0 };

describe("generated ApiClient transport", () => {
  describe("transport injection", () => {
    it("uses config.fetch instead of the global fetch", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({ id: "w1" }));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
      });

      const result = await client.request("GET", "/widgets/w1");

      deepStrictEqual(result, { id: "w1" });
      strictEqual(transport.calls.length, 1);
      strictEqual(transport.calls[0].url, "https://api.example.com/widgets/w1");
      strictEqual(transport.calls[0].method, "GET");
    });

    it("falls back to the global fetch when config.fetch is absent", async () => {
      const { HttpClient } = await loadApiClient();
      const original = globalThis.fetch;
      const seen: Request[] = [];
      globalThis.fetch = ((request: Request) => {
        seen.push(request);
        return Promise.resolve(jsonResponse({ ok: true }));
      }) as typeof fetch;
      try {
        const client = new HttpClient({
          baseUrl: "https://api.example.com",
          retry: FAST_RETRY,
        });
        const result = await client.request("GET", "/widgets");
        deepStrictEqual(result, { ok: true });
        strictEqual(seen.length, 1);
      } finally {
        globalThis.fetch = original;
      }
    });

    it("trims a trailing slash from baseUrl", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse([]));
      const client = new HttpClient({
        baseUrl: "https://api.example.com/",
        retry: FAST_RETRY,
        fetch: transport,
      });

      await client.request("GET", "/widgets");

      strictEqual(transport.calls[0].url, "https://api.example.com/widgets");
    });

    it("serializes query parameters and omits null/undefined values", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse([]));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
      });

      await client.request("GET", "/widgets", {
        query: { status: "active", page: 2, skip: undefined, tag: null },
      });

      const url = new URL(transport.calls[0].url);
      strictEqual(url.searchParams.get("status"), "active");
      strictEqual(url.searchParams.get("page"), "2");
      ok(!url.searchParams.has("skip"), "undefined query values are dropped");
      ok(!url.searchParams.has("tag"), "null query values are dropped");
    });

    it("omits the query string entirely when no query is supplied", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse([]));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
      });

      await client.request("GET", "/widgets", { query: {} });

      strictEqual(transport.calls[0].url, "https://api.example.com/widgets");
    });

    it("merges defaultHeaders and per-request headers onto the Request", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        defaultHeaders: { Authorization: "Bearer base", "X-App": "demo" },
      });

      await client.request("GET", "/widgets", {
        headers: { Authorization: "Bearer override" },
      });

      const headers = transport.calls[0].headers;
      strictEqual(headers.get("Authorization"), "Bearer override");
      strictEqual(headers.get("X-App"), "demo");
      strictEqual(headers.get("Accept"), "application/json");
    });

    it("serializes the body as JSON", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
      });

      await client.request("POST", "/widgets", { body: { name: "New" } });

      strictEqual(await transport.calls[0].text(), '{"name":"New"}');
    });
  });

  describe("request serialization", () => {
    /** Sends one request through a recording transport and returns it. */
    async function send(
      method: string,
      options?: Record<string, unknown>,
      config?: Record<string, unknown>,
    ): Promise<Request> {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        ...config,
      });
      await client.request(method, "/widgets", options);
      return transport.calls[0];
    }

    it("sends no Content-Type on a request without a body", async () => {
      const request = await send("GET");
      strictEqual(request.headers.get("Content-Type"), null);
      strictEqual(request.headers.get("Accept"), "application/json");
    });

    it("labels a JSON body as application/json", async () => {
      const request = await send("POST", { body: { a: 1 } });
      strictEqual(request.headers.get("Content-Type"), "application/json");
      strictEqual(await request.text(), '{"a":1}');
    });

    it("serializes a JSON-family media type as JSON", async () => {
      const request = await send("PATCH", {
        body: { a: null },
        contentType: "application/merge-patch+json",
      });
      strictEqual(
        request.headers.get("Content-Type"),
        "application/merge-patch+json",
      );
      strictEqual(await request.text(), '{"a":null}');
    });

    it("sends a text body as-is with its declared media type", async () => {
      const request = await send("POST", {
        body: "hello",
        contentType: "text/plain",
      });
      strictEqual(request.headers.get("Content-Type"), "text/plain");
      strictEqual(await request.text(), "hello");
    });

    it("sends a binary body as-is with its declared media type", async () => {
      const request = await send("PUT", {
        body: new Uint8Array([1, 2, 3]),
        contentType: "application/octet-stream",
      });
      strictEqual(
        request.headers.get("Content-Type"),
        "application/octet-stream",
      );
      deepStrictEqual(
        [...new Uint8Array(await request.arrayBuffer())],
        [1, 2, 3],
      );
    });

    it("lets fetch label a FormData body with its multipart boundary", async () => {
      const form = new FormData();
      form.append("name", "w1");
      const request = await send("POST", { body: form });
      match(
        request.headers.get("Content-Type") ?? "",
        /^multipart\/form-data; boundary=/,
      );
      ok((await request.text()).includes("w1"));
    });

    it("merges header names case-insensitively, later layers winning", async () => {
      const request = await send(
        "POST",
        { body: "x", headers: { "content-type": "text/csv" } },
        { defaultHeaders: { ACCEPT: "text/plain" } },
      );
      strictEqual(request.headers.get("Content-Type"), "text/csv");
      strictEqual(request.headers.get("Accept"), "text/plain");
    });

    it("formats header values and skips missing ones", async () => {
      const when = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
      const request = await send("GET", {
        headers: {
          "if-modified-since": when,
          "x-tags": ["a", "b"],
          "x-count": 3,
          "x-absent": undefined,
          "x-null": null,
        },
      });
      strictEqual(
        request.headers.get("if-modified-since"),
        "Fri, 02 Jan 2026 03:04:05 GMT",
      );
      strictEqual(request.headers.get("x-tags"), "a,b");
      strictEqual(request.headers.get("x-count"), "3");
      strictEqual(request.headers.has("x-absent"), false);
      strictEqual(request.headers.has("x-null"), false);
    });

    it("formats query values: dates, arrays, objects", async () => {
      const request = await send("GET", {
        query: {
          since: new Date(Date.UTC(2026, 0, 2)),
          ids: ["a", "b"],
          filter: { x: 1 },
        },
      });
      const params = new URL(request.url).searchParams;
      strictEqual(params.get("since"), "2026-01-02T00:00:00.000Z");
      strictEqual(params.get("ids"), "a,b");
      strictEqual(params.get("filter"), '{"x":1}');
    });

    it("repeats an exploded array query parameter", async () => {
      const request = await send("GET", {
        query: { tags: ["a", "b"], ids: ["c", "d"] },
        explode: ["tags"],
      });
      const params = new URL(request.url).searchParams;
      deepStrictEqual(params.getAll("tags"), ["a", "b"]);
      deepStrictEqual(params.getAll("ids"), ["c,d"]);
    });
  });

  describe("success bodies", () => {
    /** Sends one GET that receives `response` and returns what it resolves to. */
    async function receive(
      response: Response,
      options?: Record<string, unknown>,
    ): Promise<unknown> {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(response),
      });
      return client.request("POST", "/widgets", options);
    }

    it("resolves an empty 201 to undefined instead of failing to parse", async () => {
      strictEqual(
        await receive(new Response(null, { status: 201 })),
        undefined,
      );
    });

    it("resolves an empty 200 to undefined", async () => {
      strictEqual(await receive(new Response("", { status: 200 })), undefined);
    });

    it("resolves a whitespace-only JSON body to undefined", async () => {
      strictEqual(
        await receive(new Response(" \n", { status: 200 })),
        undefined,
      );
    });

    it("parses a JSON body", async () => {
      deepStrictEqual(await receive(jsonResponse({ id: "w1" }, 201)), {
        id: "w1",
      });
    });

    it("returns a text body as a string", async () => {
      strictEqual(
        await receive(new Response("hello", { status: 200 }), {
          responseFormat: "text",
        }),
        "hello",
      );
    });

    it("returns an empty text body as an empty string", async () => {
      strictEqual(
        await receive(new Response(null, { status: 200 }), {
          responseFormat: "text",
        }),
        "",
      );
    });

    it("returns a binary body as bytes", async () => {
      const result = await receive(
        new Response(new Uint8Array([7, 8]), { status: 200 }),
        { responseFormat: "binary" },
      );
      ok(result instanceof Uint8Array);
      deepStrictEqual([...result], [7, 8]);
    });
  });

  describe("middleware pipeline", () => {
    it("runs layers outermost-first and innermost-last", async () => {
      const { HttpClient } = await loadApiClient();
      const order: string[] = [];
      const layer =
        (name: string) =>
        async (request: Request, next: (r: Request) => Promise<Response>) => {
          order.push(`${name}:before`);
          const response = await next(request);
          order.push(`${name}:after`);
          return response;
        };
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        middleware: [layer("outer"), layer("inner")],
      });

      await client.request("GET", "/widgets");

      deepStrictEqual(order, [
        "outer:before",
        "inner:before",
        "inner:after",
        "outer:after",
      ]);
    });

    it("lets a layer rewrite the outgoing request", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        middleware: [
          (request: Request, next: (r: Request) => Promise<Response>) => {
            const authed = new Request(request);
            authed.headers.set("Authorization", "Bearer injected");
            return next(authed);
          },
        ],
      });

      await client.request("GET", "/widgets");

      strictEqual(
        transport.calls[0].headers.get("Authorization"),
        "Bearer injected",
      );
    });

    it("lets a layer short-circuit without reaching the transport", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({ fromNetwork: true }));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        middleware: [() => Promise.resolve(jsonResponse({ cached: true }))],
      });

      const result = await client.request("GET", "/widgets");

      deepStrictEqual(result, { cached: true });
      strictEqual(transport.calls.length, 0, "transport must not be reached");
    });

    it("lets a layer rewrite the response", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({ raw: true })),
        middleware: [
          async (request: Request, next: (r: Request) => Promise<Response>) => {
            await next(request);
            return jsonResponse({ replaced: true });
          },
        ],
      });

      deepStrictEqual(await client.request("GET", "/widgets"), {
        replaced: true,
      });
    });

    it("appends useMiddleware() layers inside config.middleware and returns the client", async () => {
      const { HttpClient } = await loadApiClient();
      const order: string[] = [];
      const layer =
        (name: string) =>
        (request: Request, next: (r: Request) => Promise<Response>) => {
          order.push(name);
          return next(request);
        };
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        middleware: [layer("fromConfig")],
      });

      const returned = client.useMiddleware(layer("fromUse"));
      strictEqual(
        returned,
        client,
        "useMiddleware() returns the client for chaining",
      );

      await client.request("GET", "/widgets");

      deepStrictEqual(order, ["fromConfig", "fromUse"]);
    });

    it("works with no middleware configured at all", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({ plain: true })),
      });

      deepStrictEqual(await client.request("GET", "/widgets"), {
        plain: true,
      });
    });

    it("re-runs the whole chain on every retry attempt", async () => {
      const { HttpClient } = await loadApiClient();
      let invocations = 0;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        fetch: sequence(
          new Response(null, { status: 503 }),
          new Response(null, { status: 503 }),
          jsonResponse({ recovered: true }),
        ),
        middleware: [
          (request: Request, next: (r: Request) => Promise<Response>) => {
            invocations++;
            return next(request);
          },
        ],
      });

      deepStrictEqual(await client.request("GET", "/widgets"), {
        recovered: true,
      });
      strictEqual(invocations, 3, "middleware sees each retry attempt");
    });

    it("surfaces an error thrown by a layer", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        middleware: [() => Promise.reject(new Error("layer exploded"))],
      });

      await rejects(() => client.request("GET", "/widgets"), /layer exploded/);
    });
  });

  describe("hooks", () => {
    it("onRequest can replace the outgoing request", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        onRequest: (request: Request) => {
          const next = new Request(request);
          next.headers.set("X-Hook", "yes");
          return next;
        },
      });

      await client.request("GET", "/widgets");

      strictEqual(transport.calls[0].headers.get("X-Hook"), "yes");
    });

    it("onRequest returning nothing keeps the original request", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        onRequest: () => undefined,
      });

      await client.request("GET", "/widgets");

      strictEqual(transport.calls[0].url, "https://api.example.com/widgets");
    });

    it("onRequest runs before middleware", async () => {
      const { HttpClient } = await loadApiClient();
      const order: string[] = [];
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        onRequest: () => {
          order.push("hook");
        },
        middleware: [
          (request: Request, next: (r: Request) => Promise<Response>) => {
            order.push("middleware");
            return next(request);
          },
        ],
      });

      await client.request("GET", "/widgets");

      deepStrictEqual(order, ["hook", "middleware"]);
    });

    it("onResponse can replace the response", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({ raw: true })),
        onResponse: () => jsonResponse({ swapped: true }),
      });

      deepStrictEqual(await client.request("GET", "/widgets"), {
        swapped: true,
      });
    });

    it("onResponse returning nothing keeps the original response", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({ raw: true })),
        onResponse: () => undefined,
      });

      deepStrictEqual(await client.request("GET", "/widgets"), { raw: true });
    });

    it("onResponse observes non-2xx responses", async () => {
      const { HttpClient } = await loadApiClient();
      const seen: number[] = [];
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({ error: "nope" }, 400)),
        onResponse: (response: Response) => {
          seen.push(response.status);
        },
      });

      await rejects(() => client.request("GET", "/widgets"));
      deepStrictEqual(seen, [400]);
    });

    it("onError fires once after retries are exhausted", async () => {
      const { HttpClient } = await loadApiClient();
      const contexts: Record<string, unknown>[] = [];
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        fetch: sequence(new Response(null, { status: 503 })),
        onError: (_error: unknown, context: Record<string, unknown>) => {
          contexts.push(context);
        },
      });

      await rejects(() => client.request("GET", "/widgets"));

      strictEqual(contexts.length, 1, "onError is terminal, not per-attempt");
      strictEqual(contexts[0].method, "GET");
      strictEqual(contexts[0].url, "https://api.example.com/widgets");
      strictEqual(contexts[0].attempt, 2);
    });

    it("onError can replace the thrown error", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({}, 400)),
        onError: () => new Error("app-level failure"),
      });

      await rejects(
        () => client.request("GET", "/widgets"),
        /app-level failure/,
      );
    });

    it("onError returning nothing propagates the original error", async () => {
      const { HttpClient, ApiError } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({}, 400)),
        onError: () => undefined,
      });

      await rejects(
        () => client.request("GET", "/widgets"),
        (err: unknown) => err instanceof ApiError,
      );
    });

    it("onError sees a body that cannot be serialized", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      let seen: unknown;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
        onError: (error: unknown) => {
          seen = error;
        },
      });

      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await rejects(() =>
        client.request("POST", "/widgets", { body: circular }),
      );
      ok(seen instanceof TypeError, "the serialization error reaches onError");
      strictEqual(transport.calls.length, 0, "nothing was ever sent");
    });

    it("onError sees a BigInt body that cannot be serialized", async () => {
      const { HttpClient } = await loadApiClient();
      let seen: unknown;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        onError: (error: unknown) => {
          seen = error;
        },
      });

      await rejects(() =>
        client.request("POST", "/widgets", { body: { count: 1n } }),
      );
      ok(seen instanceof TypeError, "the serialization error reaches onError");
    });

    it("onError can replace a serialization failure", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        onError: () => new Error("bad payload"),
      });

      await rejects(
        () => client.request("POST", "/widgets", { body: { count: 1n } }),
        /bad payload/,
      );
    });

    it("onError receives a usable url when query serialization fails", async () => {
      const { HttpClient } = await loadApiClient();
      let context: Record<string, unknown> | undefined;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({})),
        onError: (_error: unknown, ctx: Record<string, unknown>) => {
          context = ctx;
        },
      });

      // Serializing this throws, so buildUrl fails before a full URL exists.
      const hostile = {
        toJSON() {
          throw new TypeError("cannot serialize");
        },
      };
      await rejects(() =>
        client.request("GET", "/widgets", { query: { bad: hostile } }),
      );
      strictEqual(context?.url, "https://api.example.com/widgets");
    });

    it("onError sees transport failures too", async () => {
      const { HttpClient } = await loadApiClient();
      let seen: unknown;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: () => Promise.reject(new TypeError("network down")),
        onError: (error: unknown) => {
          seen = error;
        },
      });

      await rejects(() => client.request("GET", "/widgets"));
      ok(seen instanceof TypeError);
    });
  });

  describe("errors and status handling", () => {
    it("throws RateLimitError with retryAfterMs for a 429", async () => {
      const { HttpClient, RateLimitError } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(
          new Response(JSON.stringify({ detail: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "2" },
          }),
        ),
      });

      await rejects(
        () => client.request("GET", "/widgets"),
        (err: unknown) => {
          ok(err instanceof RateLimitError);
          const e = err as Error & {
            status: number;
            retryAfterMs?: number;
            body?: unknown;
          };
          strictEqual(e.status, 429);
          strictEqual(e.retryAfterMs, 2000);
          deepStrictEqual(e.body, { detail: "slow down" });
          return true;
        },
      );
    });

    // Only the RFC 9110 delta-seconds form is accepted, and the *whole* value
    // must parse. parseFloat would happily turn "2seconds" into 2s, "-1" into a
    // negative delay, and "Infinity" into a retry that never fires.
    const retryAfterCases: [string, number | undefined][] = [
      ["2", 2000],
      ["0", 0],
      ["2.5", 2500],
      ["  3  ", 3000],
      ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
      ["2seconds", undefined],
      ["-1", undefined],
      ["Infinity", undefined],
      ["1e3", undefined],
      ["", undefined],
      ["NaN", undefined],
      // Overflows to Infinity at Number().
      [`1${"0".repeat(400)}`, undefined],
      // Finite as seconds (1e306) but Infinity once multiplied by 1000.
      [`1${"0".repeat(306)}`, undefined],
      // Finite even in milliseconds (1e308), but far beyond what a timer can
      // represent — setTimeout would wrap it to ~1ms and retry immediately.
      [`1${"0".repeat(305)}`, undefined],
      // The exact boundary: 2^31-1 ms is the largest delay a timer honors.
      ["2147483.647", 2147483647],
      ["2147483.648", undefined],
    ];

    for (const [header, expected] of retryAfterCases) {
      it(`parses Retry-After ${JSON.stringify(header)} as ${expected}`, async () => {
        const { HttpClient, RateLimitError } = await loadApiClient();
        const client = new HttpClient({
          baseUrl: "https://api.example.com",
          retry: FAST_RETRY,
          fetch: sequence(
            new Response(null, {
              status: 429,
              headers: { "Retry-After": header },
            }),
          ),
        });

        await rejects(
          () => client.request("GET", "/widgets"),
          (err: unknown) => {
            ok(err instanceof RateLimitError);
            strictEqual(
              (err as { retryAfterMs?: number }).retryAfterMs,
              expected,
            );
            return true;
          },
        );
      });
    }

    // Trusting any of these breaks the retry: the first two hang the call
    // forever on delay(Infinity), while the third wraps past the timer maximum
    // and fires again almost immediately — the opposite of what the server
    // asked for. All three must fall back to exponential backoff.
    for (const header of [
      "Infinity",
      `1${"0".repeat(306)}`,
      `1${"0".repeat(305)}`,
    ]) {
      it(`ignores Retry-After ${JSON.stringify(header.slice(0, 12))}… instead of stalling the retry`, async () => {
        const { HttpClient } = await loadApiClient();
        const transport = sequence(
          new Response(null, {
            status: 429,
            headers: { "Retry-After": header },
          }),
          jsonResponse({ recovered: true }),
        );
        const client = new HttpClient({
          baseUrl: "https://api.example.com",
          retry: { maxAttempts: 2, baseDelayMs: 0 },
          fetch: transport,
        });

        deepStrictEqual(await client.request("GET", "/widgets"), {
          recovered: true,
        });
        strictEqual(transport.calls.length, 2);
      });
    }

    it("throws ServiceUnavailableError for a 503", async () => {
      const { HttpClient, ServiceUnavailableError } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(new Response(null, { status: 503 })),
      });

      await rejects(
        () => client.request("GET", "/widgets"),
        (err: unknown) => {
          ok(err instanceof ServiceUnavailableError);
          strictEqual((err as unknown as { status: number }).status, 503);
          return true;
        },
      );
    });

    it("throws ApiError carrying the parsed body and originating response", async () => {
      const { HttpClient, ApiError } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(jsonResponse({ title: "Bad Request" }, 400)),
      });

      await rejects(
        () => client.request("GET", "/widgets"),
        (err: unknown) => {
          ok(err instanceof ApiError);
          const e = err as Error & {
            status: number;
            body?: unknown;
            response?: Response;
          };
          strictEqual(e.status, 400);
          deepStrictEqual(e.body, { title: "Bad Request" });
          strictEqual(e.response?.status, 400);
          return true;
        },
      );
    });

    it("tolerates a non-JSON error body", async () => {
      const { HttpClient, ApiError } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(new Response("<html>oops</html>", { status: 500 })),
      });

      await rejects(
        () => client.request("GET", "/widgets"),
        (err: unknown) => {
          ok(err instanceof ApiError);
          strictEqual((err as { body?: unknown }).body, undefined);
          return true;
        },
      );
    });

    it("retries a 503 and succeeds on a later attempt", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(
        new Response(null, { status: 503 }),
        jsonResponse({ recovered: true }),
      );
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 2, baseDelayMs: 0 },
        fetch: transport,
      });

      deepStrictEqual(await client.request("GET", "/widgets"), {
        recovered: true,
      });
      strictEqual(transport.calls.length, 2);
    });

    it("does not retry a status outside retryOn", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}, 400));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        fetch: transport,
      });

      await rejects(() => client.request("GET", "/widgets"));
      strictEqual(transport.calls.length, 1);
    });

    it("retries transport failures and rethrows the last one", async () => {
      const { HttpClient } = await loadApiClient();
      let calls = 0;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        fetch: () => {
          calls++;
          return Promise.reject(new TypeError("network down"));
        },
      });

      await rejects(() => client.request("GET", "/widgets"), /network down/);
      strictEqual(calls, 3);
    });

    it("returns undefined for a 204 without parsing a body", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(new Response(null, { status: 204 })),
      });

      strictEqual(await client.request("DELETE", "/widgets/w1"), undefined);
    });

    it("returns undefined for a 205 without parsing a body", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(new Response(null, { status: 205 })),
      });

      strictEqual(await client.request("POST", "/widgets/reset"), undefined);
    });

    it("returns undefined for HEAD without parsing an empty body", async () => {
      const { HttpClient } = await loadApiClient();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: sequence(new Response(null, { status: 200 })),
      });

      strictEqual(await client.request("HEAD", "/widgets"), undefined);
    });

    it("surfaces a malformed success body without retrying it", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(new Response("not json", { status: 200 }));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        fetch: transport,
      });

      await rejects(() => client.request("GET", "/widgets"));
      strictEqual(
        transport.calls.length,
        1,
        "a bad success body must not trigger a retry",
      );
    });
  });

  describe("cancellation", () => {
    it("propagates a caller-supplied AbortSignal onto the Request", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        fetch: transport,
      });
      const controller = new AbortController();

      await client.request("GET", "/widgets", { signal: controller.signal });
      controller.abort();

      strictEqual(transport.calls[0].signal.aborted, true);
    });

    it("rejects an already-aborted call without sending it", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({}));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        fetch: transport,
      });

      await rejects(
        () =>
          client.request("GET", "/widgets", { signal: AbortSignal.abort() }),
        { name: "AbortError" },
      );
      strictEqual(transport.calls.length, 0);
    });

    it("does not retry a request the caller aborted in flight", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = hanging();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        fetch: transport,
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await rejects(
        () => client.request("GET", "/widgets", { signal: controller.signal }),
        { name: "AbortError" },
      );
      strictEqual(transport.calls.length, 1);
    });

    it("stops waiting out a retry backoff as soon as the caller aborts", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(new Response(null, { status: 503 }));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 60_000 },
        fetch: transport,
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      const started = Date.now();

      await rejects(
        () => client.request("GET", "/widgets", { signal: controller.signal }),
        { name: "AbortError" },
      );
      ok(Date.now() - started < 5_000, "the backoff must not be sat out");
      strictEqual(transport.calls.length, 1);
    });

    it("applies config.timeout together with a caller's signal", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = hanging();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 0 },
        timeout: 20,
        fetch: transport,
      });

      await rejects(
        () =>
          client.request("GET", "/widgets", {
            signal: new AbortController().signal,
          }),
        { name: "TimeoutError" },
      );
      strictEqual(transport.calls.length, 1, "a timeout is not retried");
    });

    it("bounds the whole call, backoff included, by config.timeout", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(new Response(null, { status: 503 }));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 60_000 },
        timeout: 20,
        fetch: transport,
      });
      const started = Date.now();

      await rejects(() => client.request("GET", "/widgets"), {
        name: "TimeoutError",
      });
      ok(Date.now() - started < 5_000);
      strictEqual(transport.calls.length, 1);
    });

    it("does not call onError when the caller cancels", async () => {
      const { HttpClient } = await loadApiClient();
      let reported = 0;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        fetch: hanging(),
        onError: () => {
          reported++;
        },
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await rejects(() =>
        client.request("GET", "/widgets", { signal: controller.signal }),
      );
      strictEqual(reported, 0);
    });

    it("calls onError when the call times out", async () => {
      const { HttpClient } = await loadApiClient();
      let seen: unknown;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        timeout: 10,
        fetch: hanging(),
        onError: (error: unknown) => {
          seen = error;
        },
      });

      await rejects(() => client.request("GET", "/widgets"));
      strictEqual((seen as Error | undefined)?.name, "TimeoutError");
    });

    it("applies config.timeout when no signal is supplied", async () => {
      const { HttpClient } = await loadApiClient();
      let abortedDuringFlight = false;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: FAST_RETRY,
        timeout: 5,
        fetch: async (request: Request) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          abortedDuringFlight = request.signal.aborted;
          return jsonResponse({});
        },
      });

      await client.request("GET", "/widgets");

      ok(abortedDuringFlight, "the timeout signal fires while in flight");
    });
  });

  describe("retry policy", () => {
    /** A transport that fails at the network level every time. */
    function failing(): Transport & { calls: Request[] } {
      const calls: Request[] = [];
      return Object.assign(
        (request: Request) => {
          calls.push(request);
          return Promise.reject(new TypeError("fetch failed"));
        },
        { calls },
      );
    }

    for (const method of ["POST", "PATCH"]) {
      it(`does not resend a ${method} after a network failure`, async () => {
        const { HttpClient } = await loadApiClient();
        const transport = failing();
        const client = new HttpClient({
          baseUrl: "https://api.example.com",
          retry: { maxAttempts: 3, baseDelayMs: 0 },
          fetch: transport,
        });

        await rejects(
          () => client.request(method, "/widgets", { body: {} }),
          /fetch failed/,
        );
        strictEqual(transport.calls.length, 1);
      });
    }

    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      it(`resends an idempotent ${method} after a network failure`, async () => {
        const { HttpClient } = await loadApiClient();
        const transport = failing();
        const client = new HttpClient({
          baseUrl: "https://api.example.com",
          retry: { maxAttempts: 3, baseDelayMs: 0 },
          fetch: transport,
        });

        await rejects(() => client.request(method, "/widgets"), /fetch failed/);
        strictEqual(transport.calls.length, 3);
      });
    }

    it("matches the method case-insensitively", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = failing();
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 2, baseDelayMs: 0 },
        fetch: transport,
      });

      await rejects(() => client.request("get", "/widgets"));
      strictEqual(transport.calls.length, 2);
    });

    it("still retries a POST on a retryOn status", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(
        new Response(null, { status: 503 }),
        jsonResponse({ id: "w1" }, 201),
      );
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 2, baseDelayMs: 0 },
        fetch: transport,
      });

      deepStrictEqual(await client.request("POST", "/widgets", { body: {} }), {
        id: "w1",
      });
      strictEqual(transport.calls.length, 2);
    });

    for (const status of [429, 503]) {
      it(`waits for Retry-After on a ${status} instead of the backoff`, async () => {
        const { HttpClient } = await loadApiClient();
        const transport = sequence(
          new Response(null, { status, headers: { "Retry-After": "0" } }),
          jsonResponse({ ok: true }),
        );
        const client = new HttpClient({
          baseUrl: "https://api.example.com",
          // The backoff alone would take a minute; Retry-After says now.
          retry: { maxAttempts: 2, baseDelayMs: 60_000 },
          fetch: transport,
        });
        const started = Date.now();

        deepStrictEqual(await client.request("GET", "/widgets"), { ok: true });
        ok(Date.now() - started < 5_000, "Retry-After replaces the backoff");
      });
    }

    it("backs off exponentially when there is no Retry-After", async () => {
      const { HttpClient } = await loadApiClient();
      const times: number[] = [];
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 20 },
        fetch: () => {
          times.push(Date.now());
          return Promise.resolve(new Response(null, { status: 503 }));
        },
      });

      await rejects(() => client.request("GET", "/widgets"));
      strictEqual(times.length, 3);
      ok(times[1] - times[0] >= 15, "first retry waits about baseDelayMs");
      ok(times[2] - times[1] >= 35, "second retry waits about 2 x baseDelayMs");
    });

    it("discards the body of a response it retries", async () => {
      const { HttpClient } = await loadApiClient();
      let cancelled = false;
      const stream = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      let call = 0;
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 2, baseDelayMs: 0 },
        fetch: () =>
          Promise.resolve(
            call++ === 0
              ? new Response(stream, { status: 503 })
              : jsonResponse({}),
          ),
      });

      await client.request("GET", "/widgets");
      ok(cancelled, "the retried response's body must be cancelled");
    });

    it("still sends once when maxAttempts is 0", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(jsonResponse({ ok: true }));
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 0 },
        fetch: transport,
      });

      deepStrictEqual(await client.request("GET", "/widgets"), { ok: true });
      strictEqual(transport.calls.length, 1);
    });
  });

  describe("Observable flavor", () => {
    it("stops retrying and skips onError once unsubscribed", async () => {
      const { RxHttpClient } = await loadRxClient();
      const transport = sequence(new Response(null, { status: 503 }));
      let reported = 0;
      const client = new RxHttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 3, baseDelayMs: 50 },
        fetch: transport,
        onError: () => {
          reported++;
        },
      });

      const subscription = client.httpGet$("/widgets").subscribe({});
      await new Promise((resolve) => setTimeout(resolve, 10));
      subscription.unsubscribe();
      await new Promise((resolve) => setTimeout(resolve, 200));

      strictEqual(transport.calls.length, 1, "no retry after unsubscribe");
      strictEqual(reported, 0, "onError is not called for unsubscribe");
    });

    it("times out with the same error as the Promise flavor", async () => {
      const { RxHttpClient } = await loadRxClient();
      const client = new RxHttpClient({
        baseUrl: "https://api.example.com",
        timeout: 10,
        fetch: hanging(),
      });

      const error = await new Promise<unknown>((resolve) => {
        client.httpGet$("/widgets").subscribe({ error: resolve });
      });
      strictEqual((error as Error).name, "TimeoutError");
    });

    it("aborts when the outer signal aborts", async () => {
      const { RxHttpClient } = await loadRxClient();
      const transport = hanging();
      const client = new RxHttpClient({
        baseUrl: "https://api.example.com",
        fetch: transport,
      });
      const controller = new AbortController();

      const error = new Promise<unknown>((resolve) => {
        client
          .httpGet$("/widgets", { signal: controller.signal })
          .subscribe({ error: resolve });
      });
      controller.abort();

      strictEqual(((await error) as Error).name, "AbortError");
      strictEqual(transport.calls.length, 1);
    });

    it("never sends when the outer signal is already aborted", async () => {
      const { RxHttpClient } = await loadRxClient();
      const transport = hanging();
      const client = new RxHttpClient({
        baseUrl: "https://api.example.com",
        fetch: transport,
      });

      const error = await new Promise<unknown>((resolve) => {
        client
          .httpGet$("/widgets", { signal: AbortSignal.abort() })
          .subscribe({ error: resolve });
      });
      strictEqual((error as Error).name, "AbortError");
      strictEqual(transport.calls.length, 0);
    });
  });
});

import { describe, it } from "node:test";
import { ok, strictEqual, deepStrictEqual, rejects } from "node:assert";
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

      // Stringifying this throws, so buildUrl fails before a full URL exists.
      const hostile = {
        toString() {
          throw new TypeError("cannot stringify");
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
      [`1${"0".repeat(400)}`, undefined],
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

    it("ignores a malformed Retry-After instead of stalling the retry", async () => {
      const { HttpClient } = await loadApiClient();
      const transport = sequence(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "Infinity" },
        }),
        jsonResponse({ recovered: true }),
      );
      const client = new HttpClient({
        baseUrl: "https://api.example.com",
        retry: { maxAttempts: 2, baseDelayMs: 0 },
        fetch: transport,
      });

      // Would hang forever on delay(Infinity) if the header were trusted.
      deepStrictEqual(await client.request("GET", "/widgets"), {
        recovered: true,
      });
      strictEqual(transport.calls.length, 2);
    });

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

      await client.request("GET", "/widgets", { signal: AbortSignal.abort() });

      strictEqual(transport.calls[0].signal.aborted, true);
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
});

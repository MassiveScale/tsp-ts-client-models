import { describe, it } from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import * as ts from "typescript";
import { emit } from "./test-host.js";

/**
 * Behavioral tests for generated auto-paging methods.
 *
 * Content assertions show what the emitter writes; these prove the written
 * code walks pages correctly. The generated client, its endpoints, and the
 * client infrastructure are transpiled and linked to each other through
 * `data:` URLs, then driven against a stub transport.
 */

/** A fetch-compatible transport stub that records every request. */
type Transport = ((request: Request) => Promise<Response>) & {
  calls: Request[];
};

/** A minimal Observable subscription, as the rxjs stub below hands out. */
interface Subscription {
  unsubscribe(): void;
}

/** A minimal Observable, as the rxjs stub below implements it. */
interface ObservableLike<T> {
  subscribe(observer: {
    next?: (value: T) => void;
    error?: (error: unknown) => void;
    complete?: () => void;
  }): Subscription;
}

/** Arguments every generated paging method ends with. */
type Options = { signal?: AbortSignal; headers?: Record<string, string> };

/** The generated Promise client's paging methods. */
interface StoresClient {
  offsetAll(
    query?: Record<string, unknown>,
    options?: Options,
  ): AsyncGenerator<{ id: string }>;
  pagesAll(
    query?: Record<string, unknown>,
    options?: Options,
  ): AsyncGenerator<{ id: string }>;
  linkedAll(
    query?: Record<string, unknown>,
    headers?: Record<string, unknown>,
    options?: Options,
  ): AsyncGenerator<{ id: string }>;
  tokenAll(
    query?: Record<string, unknown>,
    options?: Options,
  ): AsyncGenerator<{ id: string }>;
  request<T>(
    method: string,
    path: string | URL,
    options?: Record<string, unknown>,
  ): Promise<T>;
  httpGetNextLink<T>(link: string): Promise<T>;
}

/** The generated Observable client's paging methods. */
interface StoresObservableClient {
  offsetAll(
    query?: Record<string, unknown>,
    options?: Options,
  ): ObservableLike<{ id: string }>;
}

const SPEC = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  model Store { id: string; }
  model OffsetPage<T> { @pageItems items: T[]; }
  model IndexPage<T> { @pageItems items?: T[]; }
  model LinkPage<T> { @pageItems value: T[]; @nextLink nextLink?: url; }
  model TokenPage<T> { @pageItems items: T[]; @continuationToken next?: string; }

  @route("/stores")
  interface Stores {
    @list @get offset(@query @offset skip?: int32, @query take?: int32): OffsetPage<Store>;
    @list @route("pages") @get pages(@query @pageIndex page?: int32 = 1): IndexPage<Store>;
    @list @route("linked") @get linked(@query top?: int32, @header("x-tenant") tenant?: string): LinkPage<Store>;
    @list @route("token") @get token(@query @continuationToken token?: string): TokenPage<Store>;
  }
`;

/**
 * A minimal stand-in for rxjs's `Observable`: cold, closes on error or
 * complete, exposes `closed` to the producer, and runs the teardown on
 * unsubscribe.
 */
const OBSERVABLE_STUB = `class Observable {
  constructor(subscribe) { this._subscribe = subscribe; }
  subscribe(observer) {
    let closed = false;
    const teardown = this._subscribe({
      get closed() { return closed; },
      next: (v) => { if (!closed) observer.next?.(v); },
      error: (e) => { if (!closed) { closed = true; observer.error?.(e); } },
      complete: () => { if (!closed) { closed = true; observer.complete?.(); } },
    });
    return { unsubscribe() { closed = true; teardown?.(); } };
  }
}`;

/** Transpiles generated TypeScript to an importable `data:` URL. */
function toModuleUrl(source: string): string {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: false,
    },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}

let cached:
  | Promise<{
      StoresClient: new (config: Record<string, unknown>) => StoresClient;
      StoresObservableClient: new (
        config: Record<string, unknown>,
      ) => StoresObservableClient;
    }>
  | undefined;

/** Emits both client flavors once and links their modules together. */
function loadClients(): NonNullable<typeof cached> {
  cached ??= (async () => {
    const files = await emit(SPEC, { "client-style": "both" });
    const apiClient = toModuleUrl(files["client/ApiClient.ts"]);
    const endpoints = toModuleUrl(files["endpoints/StoresEndpoints.ts"]);
    const rxClient = toModuleUrl(
      files["client/ApiClientRx.ts"]
        .replace('import { Observable } from "rxjs";', OBSERVABLE_STUB)
        .replace('"./ApiClient.js"', JSON.stringify(apiClient)),
    );
    const link = (source: string) =>
      source
        .replace('"./ApiClient.js"', JSON.stringify(apiClient))
        .replace('"./ApiClientRx.js"', JSON.stringify(rxClient))
        .replace('"../endpoints/StoresEndpoints.js"', JSON.stringify(endpoints))
        // Only referenced in type positions, so nothing is lost.
        .replace('import { Observable } from "rxjs";', "");
    const { StoresClient } = await import(
      toModuleUrl(link(files["client/StoresClient.ts"]))
    );
    const { StoresObservableClient } = await import(
      toModuleUrl(link(files["client/StoresObservableClient.ts"]))
    );
    return { StoresClient, StoresObservableClient };
  })();
  return cached;
}

/** Builds a JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A transport that replays the given responses in order, then repeats the last. */
function sequence(...responses: Response[]): Transport {
  const calls: Request[] = [];
  const transport = (request: Request) => {
    calls.push(request);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return Promise.resolve(next.clone());
  };
  return Object.assign(transport, { calls });
}

/**
 * A transport that answers with `first`, then never answers again on its own:
 * later requests settle only when their signal aborts.
 */
function firstThenHang(first: Response): Transport {
  const calls: Request[] = [];
  const transport = (request: Request) => {
    calls.push(request);
    if (calls.length === 1) return Promise.resolve(first);
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

/** Client config that sends through `transport` without retry delays. */
function config(transport: Transport, baseUrl = "https://api.example.com") {
  return {
    baseUrl,
    fetch: transport,
    retry: { maxAttempts: 1, baseDelayMs: 0 },
  };
}

/** Collects every item an async iterable yields. */
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

/** Item ids, for compact assertions. */
const ids = (items: { id: string }[]) => items.map((i) => i.id);

/** The query parameter `name` of a recorded request. */
const param = (request: Request, name: string) =>
  new URL(request.url).searchParams.get(name);

/** Waits for every pending promise callback to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("generated auto-paging methods", () => {
  describe("offset", () => {
    it("advances by each page's item count until a page is empty", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }, { id: "b" }] }),
        json({ items: [{ id: "c" }] }),
        json({ items: [] }),
      );
      const client = new StoresClient(config(transport));

      const items = await collect(client.offsetAll({ take: 2 }));

      deepStrictEqual(ids(items), ["a", "b", "c"]);
      deepStrictEqual(
        transport.calls.map((r) => param(r, "skip")),
        ["0", "2", "3"],
      );
      ok(transport.calls.every((r) => param(r, "take") === "2"));
    });

    it("starts from the caller's own offset", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "k" }] }),
        json({ items: [] }),
      );
      const client = new StoresClient(config(transport));

      await collect(client.offsetAll({ skip: 10 }));

      deepStrictEqual(
        transport.calls.map((r) => param(r, "skip")),
        ["10", "11"],
      );
    });

    it("ends the walk on a page with no body", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }] }),
        new Response("", { status: 200 }),
      );
      const client = new StoresClient(config(transport));

      deepStrictEqual(ids(await collect(client.offsetAll())), ["a"]);
      strictEqual(transport.calls.length, 2);
    });

    it("requests no further page once iteration stops", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(json({ items: [{ id: "a" }, { id: "b" }] }));
      const client = new StoresClient(config(transport));

      for await (const item of client.offsetAll()) {
        strictEqual(item.id, "a");
        break;
      }

      strictEqual(transport.calls.length, 1);
    });

    it("surfaces a failed page as the transport's error", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }] }),
        json({ message: "boom" }, 500),
      );
      const client = new StoresClient(config(transport));
      const seen: string[] = [];

      await rejects(
        (async () => {
          for await (const item of client.offsetAll()) seen.push(item.id);
        })(),
        (err: Error) => err.name === "ApiError",
      );
      deepStrictEqual(seen, ["a"]);
    });

    it("aborts the page in flight when the caller's signal fires", async () => {
      const { StoresClient } = await loadClients();
      const transport = firstThenHang(json({ items: [{ id: "a" }] }));
      const client = new StoresClient(config(transport));
      const controller = new AbortController();
      const pages = client.offsetAll(undefined, { signal: controller.signal });

      strictEqual((await pages.next()).value?.id, "a");
      const pending = pages.next();
      await settle();
      controller.abort(new Error("stop"));

      await rejects(pending, /stop/);
      strictEqual(transport.calls.length, 2);
      ok(transport.calls[1].signal.aborted);
    });
  });

  describe("pageIndex", () => {
    it("counts pages from the declared default and treats missing items as empty", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }] }),
        json({ items: [{ id: "b" }] }),
        json({}),
      );
      const client = new StoresClient(config(transport));

      deepStrictEqual(ids(await collect(client.pagesAll())), ["a", "b"]);
      deepStrictEqual(
        transport.calls.map((r) => param(r, "page")),
        ["1", "2", "3"],
      );
    });
  });

  describe("continuationToken", () => {
    it("sends each page's token back until none is returned", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }], next: "t1" }),
        json({ items: [{ id: "b" }], next: "t2" }),
        json({ items: [{ id: "c" }], next: "" }),
      );
      const client = new StoresClient(config(transport));

      deepStrictEqual(ids(await collect(client.tokenAll())), ["a", "b", "c"]);
      deepStrictEqual(
        transport.calls.map((r) => param(r, "token")),
        [null, "t1", "t2"],
      );
    });

    it("stops when the server repeats the token it was sent", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }], next: "same" }),
        json({ items: [{ id: "b" }], next: "same" }),
      );
      const client = new StoresClient(config(transport));

      deepStrictEqual(ids(await collect(client.tokenAll())), ["a", "b"]);
      strictEqual(transport.calls.length, 2);
    });
  });

  describe("nextLink", () => {
    it("follows absolute links on the same origin and replays headers", async () => {
      const { StoresClient } = await loadClients();
      const link = "https://api.example.com/v1/stores/linked?top=1&skipToken=x";
      const transport = sequence(
        json({ value: [{ id: "a" }], nextLink: link }),
        json({ value: [{ id: "b" }] }),
      );
      const client = new StoresClient(
        config(transport, "https://api.example.com/v1"),
      );

      const items = await collect(
        client.linkedAll({ top: 1 }, { "x-tenant": "t-1" }),
      );

      deepStrictEqual(ids(items), ["a", "b"]);
      strictEqual(
        transport.calls[0].url,
        "https://api.example.com/v1/api/stores/linked?top=1",
      );
      // The link already carries the query, so nothing is appended to it.
      strictEqual(transport.calls[1].url, link);
      ok(transport.calls.every((r) => r.headers.get("x-tenant") === "t-1"));
    });

    it("resolves relative and root-relative links against the base URL", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ value: [{ id: "a" }], nextLink: "stores/linked?page=2" }),
        json({ value: [{ id: "b" }], nextLink: "/elsewhere?page=3" }),
        json({ value: [{ id: "c" }] }),
      );
      const client = new StoresClient(
        config(transport, "https://api.example.com/v1/"),
      );

      deepStrictEqual(ids(await collect(client.linkedAll())), ["a", "b", "c"]);
      strictEqual(
        transport.calls[1].url,
        "https://api.example.com/v1/stores/linked?page=2",
      );
      strictEqual(
        transport.calls[2].url,
        "https://api.example.com/elsewhere?page=3",
      );
    });

    it("refuses a link to another origin before sending anything", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(
        json({ value: [{ id: "a" }], nextLink: "https://evil.example/steal" }),
      );
      const client = new StoresClient(config(transport));

      await rejects(
        collect(client.linkedAll()),
        /Refusing to follow a next-page link to https:\/\/evil\.example/,
      );
      strictEqual(transport.calls.length, 1);
    });

    it("resolves a relative base URL against the page's location", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(json({ value: [] }));
      const client = new StoresClient(config(transport, "/api"));
      Object.defineProperty(globalThis, "location", {
        value: { href: "https://app.example.com/home" },
        configurable: true,
      });
      try {
        await client.httpGetNextLink("stores?page=2");
      } finally {
        delete (globalThis as { location?: unknown }).location;
      }

      strictEqual(
        transport.calls[0].url,
        "https://app.example.com/api/stores?page=2",
      );
    });

    it("rejects a link when a relative base URL has nothing to resolve against", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(json({ value: [] }));
      const client = new StoresClient(config(transport, "/api"));

      await rejects(client.httpGetNextLink("stores?page=2"), TypeError);
      strictEqual(transport.calls.length, 0);
    });
  });

  describe("resolved URLs", () => {
    it("appends a query to a URL that already has one", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(json({}));
      const client = new StoresClient(config(transport));

      await client.request("GET", new URL("https://api.example.com/x?a=1"), {
        query: { b: 2 },
      });

      strictEqual(transport.calls[0].url, "https://api.example.com/x?a=1&b=2");
    });

    it("starts a query string on a URL without one", async () => {
      const { StoresClient } = await loadClients();
      const transport = sequence(json({}));
      const client = new StoresClient(config(transport));

      await client.request("GET", new URL("https://api.example.com/x"), {
        query: { b: 2 },
      });

      strictEqual(transport.calls[0].url, "https://api.example.com/x?b=2");
    });
  });

  describe("Observable flavor", () => {
    it("emits every item of every page, then completes", async () => {
      const { StoresObservableClient } = await loadClients();
      const transport = sequence(
        json({ items: [{ id: "a" }, { id: "b" }] }),
        json({ items: [{ id: "c" }] }),
        json({ items: [] }),
      );
      const client = new StoresObservableClient(config(transport));

      const seen = await new Promise<string[]>((resolve, reject) => {
        const items: string[] = [];
        client.offsetAll().subscribe({
          next: (item) => items.push(item.id),
          error: reject,
          complete: () => resolve(items),
        });
      });

      deepStrictEqual(seen, ["a", "b", "c"]);
      strictEqual(transport.calls.length, 3);
    });

    it("stops paging when the subscriber unsubscribes", async () => {
      const { StoresObservableClient } = await loadClients();
      const transport = sequence(json({ items: [{ id: "a" }, { id: "b" }] }));
      const client = new StoresObservableClient(config(transport));
      const seen: string[] = [];

      const subscription: Subscription = client.offsetAll().subscribe({
        next: (item) => {
          seen.push(item.id);
          subscription.unsubscribe();
        },
      });
      await settle();

      deepStrictEqual(seen, ["a"]);
      strictEqual(transport.calls.length, 1);
    });

    it("aborts the page in flight on unsubscribe", async () => {
      const { StoresObservableClient } = await loadClients();
      const transport = firstThenHang(json({ items: [{ id: "a" }] }));
      const client = new StoresObservableClient(config(transport));
      let errored = false;

      const subscription = client
        .offsetAll()
        .subscribe({ error: () => (errored = true) });
      await settle();
      subscription.unsubscribe();
      await settle();

      strictEqual(transport.calls.length, 2);
      ok(transport.calls[1].signal.aborted);
      ok(!errored, "Unsubscribing is not an error");
    });

    it("delivers a failed page through error", async () => {
      const { StoresObservableClient } = await loadClients();
      const transport = sequence(json({ message: "boom" }, 500));
      const client = new StoresObservableClient(config(transport));

      const error = await new Promise<unknown>((resolve) => {
        client.offsetAll().subscribe({ error: resolve });
      });

      strictEqual((error as Error).name, "ApiError");
    });

    it("aborts with the reason of the caller's signal", async () => {
      const { StoresObservableClient } = await loadClients();
      const transport = firstThenHang(json({ items: [{ id: "a" }] }));
      const client = new StoresObservableClient(config(transport));
      const controller = new AbortController();

      const error = new Promise<unknown>((resolve) => {
        client
          .offsetAll(undefined, { signal: controller.signal })
          .subscribe({ error: resolve });
      });
      await settle();
      controller.abort(new Error("caller stopped"));

      strictEqual(((await error) as Error).message, "caller stopped");
    });

    it("never sends a request when the caller's signal already aborted", async () => {
      const { StoresObservableClient } = await loadClients();
      const transport = sequence(json({ items: [{ id: "a" }] }));
      const client = new StoresObservableClient(config(transport));
      const controller = new AbortController();
      controller.abort(new Error("too late"));

      const error = await new Promise<unknown>((resolve) => {
        client
          .offsetAll(undefined, { signal: controller.signal })
          .subscribe({ error: resolve });
      });

      strictEqual((error as Error).message, "too late");
      strictEqual(transport.calls.length, 0);
    });
  });
});

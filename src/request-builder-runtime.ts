/**
 * The static infrastructure of the `path` and `interface` client shapes:
 * `client/RequestBuilder.ts`, and `client/RequestBuilderRx.ts` for the RxJS
 * flavor. The root client creates a request adapter over its own protected
 * verb helpers, and every request builder reached from it sends through that
 * adapter, so they all share one configuration, one middleware pipeline and
 * one set of hooks.
 */

/** A top-level export of a static module, and whether it is type-only. */
export interface StaticExport {
  /** The exported name. */
  name: string;
  /** Whether the export exists only at compile time. */
  isType: boolean;
}

/** The contents of `client/RequestBuilder.ts`, without the generated-file header. */
export const REQUEST_BUILDER_CONTENT = `import {
  HttpClient,
  type ClientConfig,
  type RequestOptions,
  type TransportOptions,
} from "./ApiClient.js";

/**
 * The transport a request builder sends through: the verb helpers of the root
 * client the chain started from. Every builder of one client shares it, so a
 * middleware registered on the root client with \`useMiddleware\` reaches the
 * requests of every builder, including builders created before it.
 */
export interface RequestAdapter {
  /** Sends a GET. */
  httpGet<T>(path: string, options?: TransportOptions): Promise<T>;
  /** Sends a POST. */
  httpPost<T>(path: string, body?: unknown, options?: TransportOptions): Promise<T>;
  /** Sends a PUT. */
  httpPut<T>(path: string, body?: unknown, options?: TransportOptions): Promise<T>;
  /** Sends a PATCH. */
  httpPatch<T>(path: string, body?: unknown, options?: TransportOptions): Promise<T>;
  /** Sends a DELETE. */
  httpDelete<T>(
    path: string,
    options?: TransportOptions & { body?: unknown },
  ): Promise<T>;
  /** Sends a HEAD. */
  httpHead<T = void>(path: string, options?: TransportOptions): Promise<T>;
  /** Sends a GET to a next-page link returned by the server. */
  httpGetNextLink<T>(link: string, options?: TransportOptions): Promise<T>;
  /** Walks a paged operation and yields every item of every page. */
  paginate<TPage, TItem, TCursor>(
    fetchPage: (
      cursor: TCursor,
      signal: AbortSignal | undefined,
    ) => Promise<TPage | undefined>,
    first: TCursor,
    items: (page: TPage) => readonly TItem[] | undefined,
    next: (page: TPage, cursor: TCursor, count: number) => TCursor | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<TItem, void, undefined>;
  /** Reads a header from a call's headers, matching names case-insensitively. */
  readHeader(headers: Record<string, unknown> | undefined, name: string): unknown;
  /** Returns a copy of a call's headers with one header replaced. */
  replaceHeader(
    headers: Record<string, unknown> | undefined,
    name: string,
    value: unknown,
  ): Record<string, unknown>;
}

/**
 * Base class of a root client whose calls are chained through request
 * builders. It is an ordinary {@link HttpClient}: the configuration,
 * middleware and hooks it is given apply to every request any of its builders
 * sends.
 */
export class RootClient extends HttpClient {
  /** The transport handed to every request builder created from this client. */
  protected readonly adapter: RequestAdapter;

  constructor(config: ClientConfig) {
    super(config);
    // The helpers are protected, so the adapter is built in here, where they
    // can be reached.
    const client = this;
    this.adapter = {
      httpGet<T>(path: string, options?: TransportOptions) {
        return client.httpGet<T>(path, options);
      },
      httpPost<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPost<T>(path, body, options);
      },
      httpPut<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPut<T>(path, body, options);
      },
      httpPatch<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPatch<T>(path, body, options);
      },
      httpDelete<T>(path: string, options?: TransportOptions & { body?: unknown }) {
        return client.httpDelete<T>(path, options);
      },
      httpHead<T = void>(path: string, options?: TransportOptions) {
        return client.httpHead<T>(path, options);
      },
      httpGetNextLink<T>(link: string, options?: TransportOptions) {
        return client.httpGetNextLink<T>(link, options);
      },
      paginate(fetchPage, first, items, next, signal) {
        return client.paginate(fetchPage, first, items, next, signal);
      },
      readHeader(headers, name) {
        return client.readHeader(headers, name);
      },
      replaceHeader(headers, name, value) {
        return client.replaceHeader(headers, name, value);
      },
    };
  }
}

/**
 * Puts the headers of \`next\` over those of \`base\`. Names are matched without
 * regard to case, as they are when sent, so a header of \`next\` replaces one of
 * \`base\` however either is spelled.
 */
function mergeHeaders(
  base: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const replaced = new Set(Object.keys(next ?? {}).map((name) => name.toLowerCase()));
  const merged: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(base ?? {})) {
    if (!replaced.has(name.toLowerCase())) merged[name] = value;
  }
  return Object.assign(merged, next);
}

/**
 * Merges request options over the options of a builder: headers from \`next\`
 * replace those of \`base\` with the same name in any case, and every abort
 * signal of both applies.
 */
export function mergeRequestOptions<O extends Pick<TransportOptions, "headers" | "signal">>(
  base: RequestOptions | undefined,
  next: O | undefined,
): O | undefined {
  if (!base) return next;
  const merged = { ...base, ...next } as O;
  if (base.headers || next?.headers) {
    merged.headers = mergeHeaders(base.headers, next?.headers);
  }
  const signals = [base.signal, next?.signal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  // Set even for one signal: \`next\` may carry \`signal: undefined\`, which the
  // spread above copied over the builder's own.
  if (signals.length > 0) {
    merged.signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  }
  return merged;
}

/**
 * Base class of every generated request builder. A builder holds the path
 * parameter values of the steps that led to it, and the options added with
 * {@link RequestBuilder.withOptions}, and sends its requests through the
 * adapter of the root client it was created from.
 *
 * Each step returns a new builder, so a builder can be kept and reused, and
 * what is added to one never reaches the builder it was created from.
 */
export abstract class RequestBuilder<A extends RequestAdapter = RequestAdapter> {
  /**
   * @param adapter - The transport of the root client.
   * @param pathParameters - The path parameter values of the steps so far, in order.
   * @param requestOptions - The options added to this builder and the ones before it.
   */
  constructor(
    protected readonly adapter: A,
    protected readonly pathParameters: readonly string[],
    protected readonly requestOptions?: RequestOptions,
  ) {}

  /**
   * Returns a copy of this builder that adds \`options\` to every request it
   * sends, and to every builder created from it. Headers are merged over those
   * added before, and every signal added can abort the request. The options
   * passed to a single call still win over these.
   */
  withOptions(options: RequestOptions): this {
    const Builder = this.constructor as new (
      adapter: A,
      pathParameters: readonly string[],
      requestOptions?: RequestOptions,
    ) => this;
    return new Builder(
      this.adapter,
      this.pathParameters,
      mergeRequestOptions(this.requestOptions, options),
    );
  }

  /** Puts a call's own options over the options added to this builder. */
  protected applyOptions<O extends TransportOptions>(options: O | undefined): O | undefined {
    return mergeRequestOptions(this.requestOptions, options);
  }

  protected httpGet<T>(path: string, options?: TransportOptions): Promise<T> {
    return this.adapter.httpGet<T>(path, this.applyOptions(options));
  }

  protected httpPost<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<T> {
    return this.adapter.httpPost<T>(path, body, this.applyOptions(options));
  }

  protected httpPut<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<T> {
    return this.adapter.httpPut<T>(path, body, this.applyOptions(options));
  }

  protected httpPatch<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Promise<T> {
    return this.adapter.httpPatch<T>(path, body, this.applyOptions(options));
  }

  protected httpDelete<T>(
    path: string,
    options?: TransportOptions & { body?: unknown },
  ): Promise<T> {
    return this.adapter.httpDelete<T>(path, this.applyOptions(options));
  }

  protected httpHead<T = void>(path: string, options?: TransportOptions): Promise<T> {
    return this.adapter.httpHead<T>(path, this.applyOptions(options));
  }

  protected httpGetNextLink<T>(link: string, options?: TransportOptions): Promise<T> {
    return this.adapter.httpGetNextLink<T>(link, this.applyOptions(options));
  }

  protected paginate<TPage, TItem, TCursor>(
    fetchPage: (
      cursor: TCursor,
      signal: AbortSignal | undefined,
    ) => Promise<TPage | undefined>,
    first: TCursor,
    items: (page: TPage) => readonly TItem[] | undefined,
    next: (page: TPage, cursor: TCursor, count: number) => TCursor | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<TItem, void, undefined> {
    return this.adapter.paginate(fetchPage, first, items, next, signal);
  }

  /**
   * Reads a header from a call's headers over this builder's own, the way they
   * are sent, so a paging cursor sent in a header starts from a value added
   * with {@link RequestBuilder.withOptions}.
   */
  protected readHeader(
    headers: Record<string, unknown> | undefined,
    name: string,
  ): unknown {
    return this.adapter.readHeader(
      mergeHeaders(this.requestOptions?.headers, headers),
      name,
    );
  }

  protected replaceHeader(
    headers: Record<string, unknown> | undefined,
    name: string,
    value: unknown,
  ): Record<string, unknown> {
    return this.adapter.replaceHeader(headers, name, value);
  }
}
`;

/**
 * Top-level names exported by `client/RequestBuilder.ts`. Kept in sync with
 * {@link REQUEST_BUILDER_CONTENT} by a test that re-reads the emitted file.
 */
export const REQUEST_BUILDER_EXPORTS: readonly StaticExport[] = [
  { name: "RequestAdapter", isType: true },
  { name: "RootClient", isType: false },
  { name: "mergeRequestOptions", isType: false },
  { name: "RequestBuilder", isType: false },
];

/** The contents of `client/RequestBuilderRx.ts`, without the generated-file header. */
export const RX_REQUEST_BUILDER_CONTENT = `import { Observable } from "rxjs";
import type { ClientConfig, TransportOptions } from "./ApiClient.js";
import { RxHttpClient } from "./ApiClientRx.js";
import { RequestBuilder, type RequestAdapter } from "./RequestBuilder.js";

/**
 * The transport of an RxJS request builder: the Promise helpers of
 * {@link RequestAdapter}, plus the \`$\` helpers of the root
 * {@link RxHttpClient}, which return cold Observables.
 */
export interface RxRequestAdapter extends RequestAdapter {
  /** Sends a GET when subscribed. */
  httpGet$<T>(path: string, options?: TransportOptions): Observable<T>;
  /** Sends a POST when subscribed. */
  httpPost$<T>(path: string, body?: unknown, options?: TransportOptions): Observable<T>;
  /** Sends a PUT when subscribed. */
  httpPut$<T>(path: string, body?: unknown, options?: TransportOptions): Observable<T>;
  /** Sends a PATCH when subscribed. */
  httpPatch$<T>(path: string, body?: unknown, options?: TransportOptions): Observable<T>;
  /** Sends a DELETE when subscribed. */
  httpDelete$<T>(
    path: string,
    options?: TransportOptions & { body?: unknown },
  ): Observable<T>;
  /** Sends a HEAD when subscribed. */
  httpHead$<T = void>(path: string, options?: TransportOptions): Observable<T>;
  /** Streams every item of a paged operation. */
  paginate$<TPage, TItem, TCursor>(
    fetchPage: (
      cursor: TCursor,
      signal: AbortSignal | undefined,
    ) => Promise<TPage | undefined>,
    first: TCursor,
    items: (page: TPage) => readonly TItem[] | undefined,
    next: (page: TPage, cursor: TCursor, count: number) => TCursor | undefined,
    outerSignal?: AbortSignal,
  ): Observable<TItem>;
}

/**
 * Base class of an RxJS root client whose calls are chained through request
 * builders. See {@link RxHttpClient} for how its Observables behave.
 */
export class RxRootClient extends RxHttpClient {
  /** The transport handed to every request builder created from this client. */
  protected readonly adapter: RxRequestAdapter;

  constructor(config: ClientConfig) {
    super(config);
    // The helpers are protected, so the adapter is built in here, where they
    // can be reached.
    const client = this;
    this.adapter = {
      httpGet<T>(path: string, options?: TransportOptions) {
        return client.httpGet<T>(path, options);
      },
      httpPost<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPost<T>(path, body, options);
      },
      httpPut<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPut<T>(path, body, options);
      },
      httpPatch<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPatch<T>(path, body, options);
      },
      httpDelete<T>(path: string, options?: TransportOptions & { body?: unknown }) {
        return client.httpDelete<T>(path, options);
      },
      httpHead<T = void>(path: string, options?: TransportOptions) {
        return client.httpHead<T>(path, options);
      },
      httpGetNextLink<T>(link: string, options?: TransportOptions) {
        return client.httpGetNextLink<T>(link, options);
      },
      paginate(fetchPage, first, items, next, signal) {
        return client.paginate(fetchPage, first, items, next, signal);
      },
      readHeader(headers, name) {
        return client.readHeader(headers, name);
      },
      replaceHeader(headers, name, value) {
        return client.replaceHeader(headers, name, value);
      },
      httpGet$<T>(path: string, options?: TransportOptions) {
        return client.httpGet$<T>(path, options);
      },
      httpPost$<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPost$<T>(path, body, options);
      },
      httpPut$<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPut$<T>(path, body, options);
      },
      httpPatch$<T>(path: string, body?: unknown, options?: TransportOptions) {
        return client.httpPatch$<T>(path, body, options);
      },
      httpDelete$<T>(path: string, options?: TransportOptions & { body?: unknown }) {
        return client.httpDelete$<T>(path, options);
      },
      httpHead$<T = void>(path: string, options?: TransportOptions) {
        return client.httpHead$<T>(path, options);
      },
      paginate$(fetchPage, first, items, next, outerSignal) {
        return client.paginate$(fetchPage, first, items, next, outerSignal);
      },
    };
  }
}

/**
 * Base class of every generated RxJS request builder. It sends through the
 * same kind of adapter as {@link RequestBuilder}, and adds the \`$\` helpers.
 */
export abstract class RxRequestBuilder extends RequestBuilder<RxRequestAdapter> {
  protected httpGet$<T>(path: string, options?: TransportOptions): Observable<T> {
    return this.adapter.httpGet$<T>(path, this.applyOptions(options));
  }

  protected httpPost$<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Observable<T> {
    return this.adapter.httpPost$<T>(path, body, this.applyOptions(options));
  }

  protected httpPut$<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Observable<T> {
    return this.adapter.httpPut$<T>(path, body, this.applyOptions(options));
  }

  protected httpPatch$<T>(
    path: string,
    body?: unknown,
    options?: TransportOptions,
  ): Observable<T> {
    return this.adapter.httpPatch$<T>(path, body, this.applyOptions(options));
  }

  protected httpDelete$<T>(
    path: string,
    options?: TransportOptions & { body?: unknown },
  ): Observable<T> {
    return this.adapter.httpDelete$<T>(path, this.applyOptions(options));
  }

  protected httpHead$<T = void>(path: string, options?: TransportOptions): Observable<T> {
    return this.adapter.httpHead$<T>(path, this.applyOptions(options));
  }

  protected paginate$<TPage, TItem, TCursor>(
    fetchPage: (
      cursor: TCursor,
      signal: AbortSignal | undefined,
    ) => Promise<TPage | undefined>,
    first: TCursor,
    items: (page: TPage) => readonly TItem[] | undefined,
    next: (page: TPage, cursor: TCursor, count: number) => TCursor | undefined,
    outerSignal?: AbortSignal,
  ): Observable<TItem> {
    return this.adapter.paginate$(fetchPage, first, items, next, outerSignal);
  }
}
`;

/** Top-level names exported by `client/RequestBuilderRx.ts`. */
export const RX_REQUEST_BUILDER_EXPORTS: readonly StaticExport[] = [
  { name: "RxRequestAdapter", isType: true },
  { name: "RxRootClient", isType: false },
  { name: "RxRequestBuilder", isType: false },
];

/**
 * Members every generated request builder inherits from `RequestBuilder`. A
 * step or operation method with one of these names would shadow it.
 */
export const REQUEST_BUILDER_MEMBERS: readonly string[] = [
  "adapter",
  "pathParameters",
  "requestOptions",
  "withOptions",
  "applyOptions",
  "httpGet",
  "httpPost",
  "httpPut",
  "httpPatch",
  "httpDelete",
  "httpHead",
  "httpGetNextLink",
  "paginate",
  "readHeader",
  "replaceHeader",
];

/** Members only `RxRequestBuilder` adds. */
export const RX_REQUEST_BUILDER_MEMBERS: readonly string[] = [
  "httpGet$",
  "httpPost$",
  "httpPut$",
  "httpPatch$",
  "httpDelete$",
  "httpHead$",
  "paginate$",
];

/** Members a root client adds to those it inherits from `HttpClient`. */
export const ROOT_CLIENT_MEMBERS: readonly string[] = ["adapter"];

# Paging

An operation marked `@list` gets a second client method that walks every page for you. It sits right after the single-page method, takes exactly the same arguments, and is named after it with an `All` suffix: `list` gets `listAll`.

```typespec
model PagedResult<T> {
  @pageItems items: T[];
  totalCount?: int32;
}

@route("/stores")
interface Stores {
  @list
  @get
  list(@query @offset skip?: int32, @query @pageSize take?: int32 = 25): PagedResult<Store>;
}
```

```typescript
// One page, exactly as before.
const page = await client.list({ take: 50 });

// Every store, across every page.
for await (const store of client.listAll({ take: 50 })) {
  console.log(store.id);
}
```

The paging method is generated from TypeSpec's own paging decorators only. The emitter never guesses from property names such as `nextLink` or `skip`. An operation without `@list` gets no paging method, even when its response looks paged.

## Strategies

The page model and the operation's parameters decide how the method reaches the next page. When a page declares more than one signal, the first one in this table wins.

| Strategy            | Declared with                                                        | How the next page is requested                                                          | Paging stops when                      |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `nextLink`          | `@nextLink` on the page                                              | `GET` the link the page returned                                                        | the page has no link, or an empty one  |
| `continuationToken` | `@continuationToken` on the page **and** on a query/header parameter | Repeat the operation with the parameter set to the token the page returned              | the page has no token, or an empty one |
| `offset`            | `@offset` on a query/header parameter                                | Repeat the operation with the offset moved forward by the number of items just received | a page comes back with no items        |
| `pageIndex`         | `@pageIndex` on a query/header parameter                             | Repeat the operation with the page index plus one                                       | a page comes back with no items        |

Every strategy also stops when a page comes back with no body, or when the server returns the same link or token it was just given, so a server that never moves forward cannot trap the loop.

`@prevLink`, `@firstLink`, `@lastLink` and `@pageSize` never drive iteration. They are still ordinary properties and parameters of the single-page method.

### Where the walk starts

The walk starts wherever your arguments point. Pass `{ skip: 100 }` and the first page requested is at offset 100. Pass a `token` and the walk resumes from that token.

A cursor sent as a header is read from the headers the request actually sends, so a value in `options.headers` counts too, and it wins over the declared `headers` argument just as it does on the single-page method. Header names match case-insensitively, and each page's cursor replaces every copy of the header, whatever its case.

When you leave a counter out, the walk starts from the parameter's declared default, or from `0` when it has none. Declare `@pageIndex page?: int32 = 1` for an API whose pages are numbered from one.

### Following next-page links

The first page is requested exactly like the single-page method. Every page after that is a `GET` of the link the server returned:

- **The query string is not resent.** The link already carries it, as the `nextLink` convention requires.
- **Header parameters are resent**, and so are your `options.headers` and the client's `defaultHeaders`, middleware, hooks, retry and timeout.
- **The link is resolved against the client's `baseUrl`.** An absolute link (`https://api.example.com/v1/stores?page=2`), a root-relative link (`/v1/stores?page=2`) and a relative link (`stores?page=2`) all work. A relative `baseUrl` such as `/api` is resolved against the page's own address in a browser.
- **The link must stay on the `baseUrl`'s origin.** A link to any other scheme, host or port is refused with an `Error` before anything is sent, so the credentials your client carries never reach a server that a response pointed it at.

## Promise client

The Promise client's paging method returns an `AsyncGenerator`. Nothing is requested until you start iterating, and each page is requested only when the loop reaches it:

```typescript
for await (const store of client.listAll()) {
  if (store.id === wanted) break; // no further page is requested
}
```

A failed page rejects the iteration with the same `ApiError` the single-page method would throw. Pass `options.signal` to cancel: the page request in flight is aborted and the loop rejects with the signal's reason.

To collect everything into an array:

```typescript
const stores = [];
for await (const store of client.listAll()) stores.push(store);
```

## Observable client

The Observable client's paging method returns an `Observable` of items. It is cold, like every other method: each subscription walks the pages from the start.

```typescript
client.listAll().subscribe({
  next: (store) => console.log(store.id),
  complete: () => console.log("done"),
});
```

Items are emitted as each page arrives, and the Observable completes after the last page. Unsubscribing, or using an operator such as `take(10)`, aborts the page request in flight and requests no further pages. As with every Observable method, unsubscribing counts as cancelling, so `onError` is not called for it.

## When no paging method is generated

A `@list` operation still gets its single-page method in every case. The paging method is left out, with an `unsupported-paging-style` **warning** naming the reason, when:

- the page's items, next link or continuation token is not a top-level property of the JSON response body, for example because it is nested inside another property, or sent as a response header;
- no success response has a JSON object body;
- the next link is not a string (`string` and `url` both work, and so does `string | null`);
- the continuation token is not a string on both the request and the response, or the request has no query or header parameter for it;
- the `@offset` or `@pageIndex` parameter is not a query or header parameter, or is not a number (for example `@encode(string)`);
- the page declares none of `@nextLink`, `@continuationToken`, `@offset` or `@pageIndex`.

## Method names

The paging method is named `{method}All`, built from the single-page method's name. When the single-page method was renamed because its operation name is reserved, the paging method follows it: an operation named `paginate` gets `paginateOperation` and `paginateOperationAll`.

When `{method}All` is already taken by another operation, the paging method gets a number (`listAll2`), and a `paging-method-name-collision` **warning** says so. Rename the colliding operation to keep the name you intended.

The base classes add `paginate`, `httpGetNextLink`, `readHeader`, `replaceHeader` and, on the Observable client, `paginate$`. Like every inherited member, these names are reserved, so an operation with one of them gets an `Operation` suffix. See [Reserved method names](http-client.md#reserved-method-names).

## Custom templates

A `client` or `clientObservable` template override that does not render `methods[].paging` simply leaves the paging methods out. See the `ClientView` table in the [README](../README.md#template-view-models) for the fields to render.

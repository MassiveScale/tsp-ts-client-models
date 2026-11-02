# Client shapes

The `client-shape` option picks how calls are chained from the generated client. Given this TypeSpec:

```typespec
@route("/stores")
interface Stores {
  @get list(): Store[];
  @get read(@path storeId: string): Store;
}

@route("/stores/{storeId}/pets")
interface Pets {
  @get read(@path storeId: string, @path petId: string): Pet;
  @patch update(@path storeId: string, @path petId: string, @body body: MergePatchUpdate<Pet>): void;
}
```

each shape reads a pet like this:

| `client-shape`   | Call                                                                             |
| ---------------- | -------------------------------------------------------------------------------- |
| `flat` (default) | `new PetsClient(config).read(storeId, petId)`                                    |
| `path`           | `new PetStoreClient(config).stores.byStoreId(storeId).pets.byPetId(petId).get()` |
| `interface`      | `new PetStoreClient(config).stores.byStoreId(storeId).pets.byPetId(petId).get()` |

```yaml
options:
  "@massivescale/tsp-ts-client-models":
    client-shape: path # "flat" (default) | "path" | "interface"
    client-name: PetStore # optional; the root client becomes PetStoreClient
```

`flat` is the one-class-per-interface client described in [HTTP Client](http-client.md), and its output does not change when the other shapes are used. `path` and `interface` replace those classes with **one root client** and a tree of **request builders**, the way the [Microsoft Graph SDK](https://learn.microsoft.com/graph/sdks/sdks-overview) is shaped. The `*Endpoints` objects are emitted for every shape.

## The root client

The root client is named `{client-name}Client`. `client-name` defaults to the last segment of the service namespace, so `namespace Acme.PetStore` gives `PetStoreClient`. It must be a valid JavaScript identifier; an invalid one is reported as an `invalid-client-name` error and no client is emitted.

The root client is an ordinary `HttpClient`. It takes the same `ClientConfig`, and its `useMiddleware`, hooks, retry and timeout apply to every request sent from any builder created from it, including builders created before a middleware was added:

```typescript
import { PetStoreClient } from "@my-org/pet-store-client";

const api = new PetStoreClient({
  baseUrl: "https://api.example.com",
  defaultHeaders: { Authorization: `Bearer ${token}` },
});

const store = await api.stores.byStoreId("s1").get();
await api.stores.byStoreId("s1").pets.byPetId("p1").patch({ name: "Rex" });
```

The root client only creates builders; it sends nothing itself.

## `path`

`path` follows the URL, one step per segment:

- A **literal segment** is a getter named in camelCase: `stores` is `.stores`, and `encoded-params` is `.encodedParams`.
- A **segment that is one required path parameter** is a `by<Param>(value)` method: `{storeId}` is `.byStoreId(id)`. Parameters right after each other are separate steps: `lookup/{kind}/{id}` is `.lookup.byKind(kind).byId(id)`.
- Routes that share segments share steps, so `Stores` and `Pets` above both start at `api.stores`.
- A parameter at the start of a route is a step of the root client: `/{tenant}/settings` is `api.byTenant(t).settings.get()`.
- Two routes that put differently named parameters in the same place (`/stores/{storeId}` and `/stores/{id}/pets`) share one step, named after the first route that reaches it: `byStoreId`.
- A segment that mixes text and parameters (`{from}-{to}`), that cannot be a JavaScript name (`2fa`, `items:batch`), or that is an optional parameter ends the chain. The operation's method takes the parameters from there on as arguments: `/reports/{from}-{to}` is `api.reports.get(from, to)`.
- A route with no step at all (`/`, or one that starts with a mixed segment) is reached through its interface's name: `api.health.get()`.

## `interface`

`interface` keeps the interface names of `flat`, but nests them:

- Each interface is a getter named after it in camelCase: `interface Stores` is `.stores`.
- Each required path parameter an operation adds is a `by<Param>(value)` step after it, in route order.
- An interface hangs under the operation of another interface whose route every one of its own routes starts with, and takes only the parameters that route does not hold. With the TypeSpec above, `Pets` hangs under `Stores.read` (`/stores/{storeId}`), so it is `api.stores.byStoreId(id).pets` and takes only `petId`. The longest such route wins, and a route of `/` never does.
- An interface with no such parent is a getter of the root client: `/reports/{from}-{to}` is `api.reports.byFrom(from).byTo(to).get()`.

## Operation methods

In both shapes, an operation's method is named after its HTTP verb: `get`, `post`, `put`, `patch`, `delete` and `head`. When two or more operations of one builder share a verb (two `@sharedRoute` searches, or several `GET`s of one interface), each of them keeps its operation name instead.

The method takes the same arguments as the `flat` method of the same operation, minus the path parameters its builder already holds: the remaining path parameters, `body`, `query`, `headers` (when declared) and `options`. A `@list` operation also gets `{method}All`, usually `getAll`, which walks every page. See [Paging](paging.md).

## Builders

Every step returns a **new** builder, so a builder can be kept in a variable and reused:

```typescript
const pets = api.stores.byStoreId("s1").pets;
const rex = await pets.byPetId("rex").get();
const tom = await pets.byPetId("tom").get();
```

A builder is named after the steps that lead to it, with `Item` for a parameter step: `api.stores.byStoreId(id).pets` is a `StoresItemPetsRequestBuilder`. Every builder class is exported from the package root, so it can be used as a type.

### `withOptions`

`withOptions(options)` returns a copy of a builder that adds `RequestOptions` to every request it sends, and to every builder created from it:

```typescript
const tenant = api.stores
  .byStoreId("s1")
  .withOptions({ headers: { "X-Tenant": "contoso" } });

await tenant.get(); // sends X-Tenant
await tenant.pets.byPetId("p1").get(); // sends X-Tenant
await api.stores.byStoreId("s1").get(); // a new chain: no X-Tenant
```

- Headers are merged. A header added later in the chain replaces one of the same name added earlier, and the options passed to a single call replace both. Names are matched without regard to case, so `authorization` replaces `Authorization`.
- Every `signal` added applies: the request is aborted when any of them aborts.
- What is added to a builder never reaches the builder it was created from.

For an auto-paging method, the builder's options reach every page, including pages fetched from a next-page link. A paging cursor sent in a header (a `@continuationToken`, `@offset` or `@pageIndex` header parameter) starts from the value added with `withOptions`, unless the call passes its own.

## Observable (RxJS) flavor

With `client-style: observable` or `both`, a parallel tree is emitted for the RxJS flavor. Its root is `{client-name}ObservableClient` and its builders are `{steps}ObservableRequestBuilder`. The steps and method names are the same as in the Promise tree; the methods return `Observable<T>`, with the semantics described in [Observable (RxJS) client](http-client.md#observable-rxjs-client).

```typescript
const api = new PetStoreObservableClient({ baseUrl });
api.stores
  .byStoreId("s1")
  .get()
  .subscribe((store) => console.log(store.name));
```

## Generated files

```
client/
├── ApiClient.ts                          ← base transport (as in flat)
├── RequestBuilder.ts                     ← RootClient, RequestBuilder, withOptions
├── RequestBuilderRx.ts                   ← RxRootClient, RxRequestBuilder (observable|both)
├── PetStoreClient.ts                     ← the root client
├── StoresRequestBuilder.ts               ← api.stores
├── StoresItemRequestBuilder.ts           ← api.stores.byStoreId(id)
├── StoresItemPetsRequestBuilder.ts       ← api.stores.byStoreId(id).pets
└── StoresItemPetsItemRequestBuilder.ts   ← api.stores.byStoreId(id).pets.byPetId(id)
```

## Names that collide

A builder inherits members such as `withOptions`, `adapter`, `pathParameters` and `httpGet`, and every class has the members of `Object.prototype`. Generated names step aside when they would collide, and a warning says so:

| Collision                                                                                    | Result                               | Warning                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------- |
| A getter named like a method of its builder or an inherited member (`/widgets/get`, `/then`) | `Path` suffix: `getPath`, `thenPath` | `builder-member-name-collision` |
| A `by<Param>` step named like a getter of its builder (`/a/by-id` and `/a/{id}`)             | A number: `byId2`                    | `builder-member-name-collision` |
| Two operations of one builder with the same name                                             | A number: `list2`                    | `builder-member-name-collision` |
| An operation name that is an inherited member (`withOptions`)                                | `Operation` suffix                   | `reserved-client-method-name`   |
| `{method}All` already taken                                                                  | A number: `listAll2`                 | `paging-method-name-collision`  |
| A class name taken by a model, another builder, or one that differs only in case             | A number: `StoresRequestBuilder2`    | `client-module-name-collision`  |

A model named after something a builder imports (`RequestBuilder`, `RequestOptions`, `Observable`, a `*Endpoints` object) keeps its name, and the builder imports the other one under an alias, as the `flat` client does.

## Custom templates

The root client and the builders are rendered with the `requestBuilder` template, and their RxJS counterparts with `requestBuilderObservable`. See [Template view models](../README.md#template-view-models) for the `RequestBuilderView` they receive.

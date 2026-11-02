import "@typespec/http";

using Http;

/**
 * A store API emitted with `client-shape: path`, where every URL segment is a
 * step of the call chain: `api.stores.byStoreId(storeId).pets.get()`. It covers
 * steps shared by several interfaces, a route that starts with a parameter, a
 * segment that mixes text and parameters, a route of `/`, two operations
 * sharing a verb on one builder, and paging.
 */
@service(#{ title: "Path Tree" })
namespace MassiveScale.PathTree;

model Store {
  id: string;
  name: string;
}

model Pet {
  id: string;
  name: string;
}

model PetPage {
  @pageItems items: Pet[];
  @nextLink next?: url;
}

model Toy {
  name: string;
}

model Settings {
  theme: string;
}

model Report {
  total: int32;
}

@route("/stores")
interface Stores {
  /** List every store. */
  @get list(): Store[];

  /** Open a store. */
  @post create(@body body: Store): Store;

  /** Read one store. */
  @get read(@path storeId: string): Store;

  /** Close a store. */
  @delete remove(@path storeId: string): void;
}

@route("/stores/{storeId}/pets")
interface Pets {
  /** List the pets of a store, one page at a time. */
  @list @get list(@path storeId: string): PetPage;

  /** Read one pet. */
  @get read(@path storeId: string, @path petId: string): Pet;

  /** Change some of a pet's properties. */
  @patch update(
    @path storeId: string,
    @path petId: string,
    @body body: MergePatchUpdate<Pet>,
  ): void;
}

@route("/stores/{storeId}/pets/{petId}/toys")
interface Toys {
  /** List a pet's toys. */
  @sharedRoute @get list(@path storeId: string, @path petId: string): Toy[];

  /** Search a pet's toys by name. */
  @sharedRoute @get search(
    @path storeId: string,
    @path petId: string,
    @query q: string,
  ): Toy[];
}

@route("/{tenant}/settings")
interface TenantSettings {
  /** Read a tenant's settings. */
  @get read(@path tenant: string): Settings;
}

@route("/reports")
interface Reports {
  /** Report on a date range. */
  @route("{from}-{to}") @get range(@path from: string, @path to: string): Report;
}

@route("/")
interface Health {
  /** Check that the service is up. */
  @get check(): void;
}

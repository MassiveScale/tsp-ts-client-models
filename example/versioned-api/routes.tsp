import "@typespec/rest";
import "./versioning.tsp";
import "./common.tsp";
import "./models.tsp";

using Http;
using Versioning;
@service(#{ title: "MassiveScale Sandbox - Pet Store API" })
@versioned(Versions)
namespace MassiveScale.Sandbox.Api;

@route("store")
@tag("Stores")
@doc("Controller for Store entities.")
interface Stores {
    @doc("Retrieves a list of all stores.")
    @get
    list(@query skip?: int32, @query take?: int32 = 25): PagedResult<Store>;

    @doc("Retrieves a specific store by its unique identifier.")
    @get
    read(@path id: string): Store | ErrorResponse;

    @doc("Creates a new store with the provided information.")
    @post
    create(@body body: Store):
        | {
              @statusCode statusCode: 201;
              @body body: Store;
          }
        | ErrorResponse;

    @doc("Updates an existing store with the provided information. Only the fields included in the request body will be updated.")
    @patch
    update(@path id: string, @body body: MergePatchUpdate<Store>):
        | NoContentResponse
        | ErrorResponse;

    @doc("Deletes a store by its unique identifier.")
    @delete
    delete(@path id: string): void | ErrorResponse;
}

@route("{storeId}/pets")
@tag("Pets")
@doc("Controller for Pet entities within a Store.")
interface Pets {
    @doc("Retrieves a list of all pets in the specified store.")
    @get
    list(
        @path storeId: string,
        @query skip?: int32,
        @query take?: int32 = 25,
    ): Pet[];

    @doc("Adds a new pet to the specified store.")
    @post
    create(@path storeId: string, @body body: Create<Pet>): Pet | ErrorResponse;

    @doc("Updates an existing pet in the specified store. Only the fields included in the request body will be updated.")
    @added(Versions.v2_0)
    @patch
    update(
        @path storeId: string,
        @path petId: string,
        @body body: MergePatchUpdate<Pet>,
    ): Pet | ErrorResponse;

    @doc("Removes a pet from the specified store.")
    @added(Versions.v2_0)
    @delete
    delete(@path storeId: string, @path petId: string): void | ErrorResponse;
}

@route("customers")
@tag("Customers")
@doc("Controller for Customer entities.")
interface Customers {
    @doc("Retrieves a list of all customers.")
    @get
    list(): Customer[];

    @doc("Retrieves a specific customer by their unique identifier.")
    @get
    read(@path id: string): Customer | ErrorResponse;

    @doc("Creates a new customer with the provided information.")
    @post
    create(@body body: Customer):
        | {
              @statusCode statusCode: 201;
              @body body: Customer;
          }
        | ErrorResponse;

    @doc("Updates an existing customer with the provided information. Only the fields included in the request body will be updated.")
    @patch
    update(@path id: string, @body body: MergePatchUpdate<Customer>):
        | Customer
        | ErrorResponse;

    @doc("Deletes a customer by their unique identifier.")
    @removed(Versions.v2_0)
    @delete
    delete(@path id: string): void | ErrorResponse;
}

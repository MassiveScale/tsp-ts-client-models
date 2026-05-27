namespace MassiveScale.Sandbox.Api;

/** Strips server-generated fields for create operations. Alias of T for simplicity. */
alias Create<T> = T;

/**
 * Base model for all entities in the API.
 */
model EntityBase {
    @doc("Unique identifier of the entity.")
    @key
    @visibility(Lifecycle.Read)
    @format("uuid")
    id: string;

    @doc("Date and time when the resource was created.")
    @visibility(Lifecycle.Read)
    createdDateTime: utcDateTime;

    @doc("Date and time when the resource was last modified.")
    @visibility(Lifecycle.Read)
    lastModifiedDateTime: utcDateTime;
}

/**
 * Represents an error response from the API.
 */
@error
model ErrorResponse {
    @doc("The HTTP status of the error response. e.g. badRequest, notFound, internalServerError, etc.")
    code: string;

    @doc("A human-readable message describing the error.")
    message: string;

    @doc("Correlation id for the request that resulted in the error.")
    trace: string;

    @doc("An optional array of inner errors that provide more details about the error.")
    innererror?: ErrorResponse[];
}

/**
 * Model template for paginated results from the API.
 * This is not intended to be used directly, but rather to be extended
 * by specific models for paginated results using the pattern `model XList is PagedResult<X>`.
 */
model PagedResult<T> {
    @doc("The collection of items in the current page of results.")
    items: T[];

    @doc("The total count of items in the collection, if known.")
    totalCount?: int32;
}

import "./common.tsp";
import "./versioning.tsp";

using Versioning;
namespace MassiveScale.Sandbox.Api;

@doc("Represents the category of a pet, e.g. dog, cat, fish, etc.")
enum PetKind {
    Dog: "dog",
    Cat: "cat",
    Fish: "fish",
    Bird: "bird",
    Reptile: "reptile",
}

@doc("Represents a pet in the pet store.")
@discriminator("petKind")
model Pet is EntityBase {
    @doc("The discriminator property for the pet type.")
    @visibility(Lifecycle.Read)
    petKind: PetKind;

    @doc("The name of the pet.")
    name: string = "Unnamed Pet";

    @doc("A list of photo URLs for the pet.")
    @maxItems(5)
    photoUrls: string[];

    @doc("A list of tags associated with the pet.")
    @maxItems(10)
    @added(Versions.v2_0)
    tags?: Tag[];

    @doc("The status of the pet in the store, e.g. available, pending, sold.")
    @visibility(Lifecycle.Read, Lifecycle.Update)
    status: "available" | "pending" | "sold" = "available";
}

@doc("Represents a dog in the pet store.")
model Dog extends Pet {
    @doc("The discriminator property for the pet type.")
    @visibility(Lifecycle.Read)
    petKind: PetKind.Dog;

    @doc("Indicates whether the dog barks.")
    isBarker: boolean;
}

@doc("Represents a cat in the pet store.")
model Cat extends Pet {
    @doc("The discriminator property for the pet type.")
    @visibility(Lifecycle.Read)
    petKind: PetKind.Cat;

    @doc("Indicates whether the cat purrs.")
    isPurrer: boolean;
}

@doc("Represents a store in the pet store API.")
model Store extends EntityBase {
    @doc("The name of the store.")
    @maxLength(100)
    name: string;

    @doc("The phone number of the store.")
    @format("phone")
    phoneNumber: string;

    @doc("The email address of the store.")
    @added(Versions.v2_0)
    @format("email")
    @maxLength(255)
    email: string;

    @doc("The list of pets available in the store.")
    @minItems(0)
    pets: Pet[];
}

@doc("Represents a customer of the pet store.")
model Customer extends EntityBase {
    @doc("The first name of the customer.")
    @maxLength(100)
    firstName: string;

    @doc("The last name of the customer.")
    @maxLength(100)
    lastName: string;

    @doc("The email address of the customer.")
    @format("email")
    @maxLength(255)
    email?: string;

    @doc("The phone number of the customer.")
    @format("phone")
    @maxLength(20)
    phoneNumber?: string;
}

@doc("Represents an order placed by a customer for one or more pets.")
model Order extends EntityBase {
    @doc("The ID of the customer placing the order.")
    @format("uuid")
    customerId: string;

    @doc("The list of items in the order.")
    @minItems(0)
    items: OrderItem[];

    @doc("The status of the order, e.g. placed, approved, delivered.")
    @visibility(Lifecycle.Read, Lifecycle.Update)
    status?: "placed" | "approved" | "delivered" = "placed";
}

@doc("Represents an individual item in an order, which corresponds to a specific pet being ordered.")
model OrderItem extends EntityBase {
    @doc("The ID of the pet being ordered.")
    @format("uuid")
    petId: string;

    @doc("The quantity of pets being ordered.")
    @minValue(1)
    quantity: int32;

    @doc("The price of the pet at the time of the order.")
    price: decimal;
}

model Tag {
    @doc("The unique identifier of the tag.")
    @visibility(Lifecycle.Read, Lifecycle.Create)
    id: int64;

    @doc("The name of the tag.")
    @visibility(Lifecycle.Read, Lifecycle.Create, Lifecycle.Update)
    name: string;
}

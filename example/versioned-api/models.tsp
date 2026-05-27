import "./common.tsp";
import "./versioning.tsp";

using Versioning;
namespace MassiveScale.Sandbox.Api;

/**
 * This is a pet.
 * It is also an example of a multiple-line doc comment.
 */
model Pet is EntityBase {
    @doc("The category of the pet, e.g. dog, cat, etc.")
    @visibility(Lifecycle.Read)
    category?: PetCategory;

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

@doc("Represents a paginated list of pets.")
enum PetCategory {
    @doc("A domesticated carnivorous mammal that typically has a long snout, an acute sense of smell, and a barking, howling, or whining voice.")
    Dog: "dog",

    @doc("A small domesticated carnivorous mammal with soft fur, a short snout, and retractable claws.")
    Cat: "cat",

    @doc("A small domesticated rodent that typically has a pointed snout, relatively large ears and eyes, and a long tail.")
    Fish: "fish",

    @doc("A warm-blooded egg-laying vertebrate animal distinguished by the possession of feathers, wings, and a beak and (typically) by being able to fly.")
    Bird: "bird",

    @doc("A reptile is a cold-blooded, air-breathing vertebrate that has scales or scutes and typically lays soft-shelled eggs on land.")
    Reptile: "reptile",
}

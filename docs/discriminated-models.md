# Discriminated Models (`@discriminator`)

When a TypeSpec model is annotated with `@discriminator`, the emitter treats it as the base of a polymorphic hierarchy and generates a TypeScript **discriminated union** instead of a single flat interface.

```typespec
enum PetKind { Dog: "dog", Cat: "cat" }

@discriminator("petKind")
model Pet {
  petKind: PetKind;
  name: string;
}

model Dog extends Pet {
  petKind: PetKind.Dog;
  isBarker: boolean;
}

model Cat extends Pet {
  petKind: PetKind.Cat;
  isPurrer: boolean;
}
```

Generates:

```typescript
export interface Dog {
  petKind: "dog";
  name: string;
  isBarker: boolean;
}

export interface Cat {
  petKind: "cat";
  name: string;
  isPurrer: boolean;
}

export type Pet = Dog | Cat;
```

## Key behaviors

- **No flat `Pet` interface is emitted.** The base model's name becomes a union type alias of its concrete variants instead, so `Pet` always resolves to the precise set of possible shapes.
- **The discriminator property is narrowed to its literal value** on each variant (`petKind: "dog"`, not `petKind: PetKind`), enabling TypeScript to narrow the union via a simple equality check:

  ```typescript
  function describe(pet: Pet): string {
    if (pet.petKind === "dog") {
      return pet.isBarker ? "A barking dog" : "A quiet dog"; // narrowed to Dog
    }
    return pet.isPurrer ? "A purring cat" : "A quiet cat"; // narrowed to Cat
  }
  ```

- **Variant models are discovered automatically**, even if no operation references them directly. It is common for an operation to only reference the base type (e.g. `pets: Pet[]`) — the emitter still finds `Dog` and `Cat` via the TypeSpec inheritance graph and emits them.
- **Every reference to the base model becomes the union.** A property or response typed `Pet[]` is emitted as `Pet[]` (i.e. `(Dog | Cat)[]`) — no changes are needed at the reference site.
- **Multi-level hierarchies are flattened.** If an intermediate model in the hierarchy has no discriminator value of its own, the emitter walks down to its concrete descendants and includes those in the union instead.

## Limitations

- Only the model-inheritance form of `@discriminator` (a base model with `extends`-based subtypes) is supported. `@discriminator` on a `union` declaration is not yet handled.

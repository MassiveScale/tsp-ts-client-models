import {
  DecoratorContext,
  Enum,
  EnumMember,
  Model,
  ModelProperty,
  Program,
  Type,
} from "@typespec/compiler";

const clientNameKey = Symbol.for(
  "@massivescale/tsp-ts-client-models/clientName",
);

/**
 * Decorator implementation for `@clientName`.
 * Stores the override name in program state, keyed by the decorated element.
 */
export function $clientName(
  context: DecoratorContext,
  target: Model | ModelProperty | Enum | EnumMember,
  name: string,
): void {
  context.program.stateMap(clientNameKey).set(target, name);
}

/**
 * Returns the `@clientName` override for `target`, or `undefined` when
 * no override has been applied.
 */
export function getClientName(
  program: Program,
  target: Type,
): string | undefined {
  return program.stateMap(clientNameKey).get(target) as string | undefined;
}

import "@typespec/compiler";
import "../dist/src/decorators.js";

/**
 * Override the name of this element in the emitted TypeScript library.
 * Applies to models (interfaces), enums, enum members, and model properties.
 *
 * @param name The name to use in the emitted TypeScript.
 *
 * @example
 * ```typespec
 * @clientName("AnimalModel")
 * model Pet {}
 *
 * @clientName("Direction")
 * enum Heading { North, South, East, West }
 *
 * model Widget {
 *   @clientName("identifier")
 *   id: string;
 * }
 * ```
 */
extern dec clientName(target: unknown, name: valueof string);

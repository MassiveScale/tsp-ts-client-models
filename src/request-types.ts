import { Model, ModelProperty, Program } from "@typespec/compiler";
import { HttpOperation, Visibility, isVisible } from "@typespec/http";
import {
  Availability,
  getAvailabilityMap,
  Version,
} from "@typespec/versioning";

// ─── Shared naming / collision-detection helpers ─────────────────────────────
//
// Extracted from `emitter.ts` so the same synthesized-request-type collision
// logic can be reused by both the emitter (`request-type-collision` runtime
// diagnostic) and the `synthesized-request-type-collision` lint rule, which
// predicts the same collision at lint time. These functions are pure — none
// of them write files or map TypeSpec types to TypeScript output — so they
// are safe to call from a lint rule's `root` handler with no side effects.

/** Capitalizes the first character of a string. */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Flattens a model's own properties together with all inherited (base model)
 * properties into a single map, keyed by property name (derived properties
 * shadow inherited ones of the same name). */
export function flattenProperties(model: Model): Map<string, ModelProperty> {
  const props = new Map<string, ModelProperty>();
  if (model.baseModel) {
    for (const [name, prop] of flattenProperties(model.baseModel)) {
      props.set(name, prop);
    }
  }
  for (const [name, prop] of model.properties) {
    props.set(name, prop);
  }
  return props;
}

/**
 * Checks if an HTTP operation is available in the given API version.
 * Returns true if the operation has no availability constraints or if it is
 * marked as Added or Available in the target version.
 */
export function isOpInVersion(
  program: Program,
  op: HttpOperation,
  version: Version,
): boolean {
  const avail = getAvailabilityMap(program, op.operation);
  if (!avail) return true;
  const a = avail.get(version.name);
  return a === Availability.Added || a === Availability.Available;
}

/**
 * Returns the capitalized HTTP verb name to be used as a suffix in request type names.
 * For example, "post" → "Post", "patch" → "Patch".
 */
export function requestTypeSuffix(verb: string): string {
  return capitalize(verb);
}

// TypeSpec synthesizes these model name suffixes internally for PATCH/MergePatch bodies.
// They are never valid output names — all detected models are renamed to {Base}PatchRequest.
const TYPESPEC_MERGE_PATCH_INTERNAL_SUFFIXES = [
  "MergePatchUpdate",
  "MergePatchUpdateReplaceOnly",
  "MergePatchCreateOrUpdate",
];

export function getMergePatchBaseName(modelName: string): string | undefined {
  for (const suffix of TYPESPEC_MERGE_PATCH_INTERNAL_SUFFIXES) {
    if (modelName.endsWith(suffix)) return modelName.slice(0, -suffix.length);
  }
  return undefined;
}

export function propsHaveSameKeys(
  a: Map<string, ModelProperty>,
  b: Map<string, ModelProperty>,
): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

export function hasHiddenProperties(
  model: Model,
  visibility: Visibility,
  program: Program,
): boolean {
  for (const [, prop] of flattenProperties(model)) {
    if (!isVisible(program, prop, visibility)) return true;
  }
  return false;
}

export function filterPropsForRequest(
  model: Model,
  visibility: Visibility,
  version: Version | undefined,
  program: Program,
): Map<string, ModelProperty> {
  const result = new Map<string, ModelProperty>();
  for (const [name, prop] of flattenProperties(model)) {
    if (version) {
      const avail = getAvailabilityMap(program, prop);
      if (avail) {
        const a = avail.get(version.name);
        if (a !== Availability.Added && a !== Availability.Available) continue;
      }
    }
    if (!isVisible(program, prop, visibility)) continue;
    result.set(name, prop);
  }
  return result;
}

/** Compares two discriminated request-union variant property maps for structural equality (variant set + property keys). */
export function discriminatedVariantShapesMatch(
  a: Map<string, Map<string, ModelProperty>>,
  b: Map<string, Map<string, ModelProperty>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [variantName, aProps] of a) {
    const bProps = b.get(variantName);
    if (!bProps || !propsHaveSameKeys(aProps, bProps)) return false;
  }
  return true;
}

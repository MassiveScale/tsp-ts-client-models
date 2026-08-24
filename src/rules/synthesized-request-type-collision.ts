import {
  createRule,
  Discriminator,
  getDiscriminatedUnionFromInheritance,
  getDiscriminator,
  getTags,
  Model,
  ModelProperty,
  paramMessage,
  Program,
} from "@typespec/compiler";
import {
  getAllHttpServices,
  HttpOperation,
  resolveRequestVisibility,
  Visibility,
} from "@typespec/http";
import { getAllVersions, Version } from "@typespec/versioning";
import {
  capitalize,
  discriminatedVariantShapesMatch,
  filterPropsForRequest,
  getMergePatchBaseName,
  hasHiddenProperties,
  isOpInVersion,
  propsHaveSameKeys,
  requestTypeSuffix,
} from "../request-types.js";

/** In-memory record of a synthesized (non-discriminated) request type,
 * mirroring `RequestType` in `emitter.ts` minus the fields the emitter needs
 * for rendering (`name`, `doc`) — this rule only predicts collisions, it
 * never maps types or writes files. */
interface SynthesizedRequestType {
  props: Map<string, ModelProperty>;
  sourceOp: HttpOperation;
}

/** In-memory record of a synthesized discriminated write-body union,
 * mirroring `DiscriminatedRequestUnion` in `emitter.ts` minus `memberNames`
 * (which is only needed to render the union type alias). */
interface SynthesizedDiscriminatedUnion {
  variantProps: Map<string, Map<string, ModelProperty>>;
  sourceOp: HttpOperation;
}

/**
 * Re-runs the request-type synthesis + collision-detection logic that
 * `emitter.ts`'s `collectRequestType`/`collectDiscriminatedRequestType` use
 * (via the shared helpers in `request-types.ts`) for a single API version (or
 * the unversioned case when `version` is `undefined`), reporting the same
 * `request-type-collision`-shaped diagnostic the emitter reports at emit
 * time — but at lint time, before any version is selected for emission.
 */
function checkVersion(
  program: Program,
  operations: HttpOperation[],
  version: Version | undefined,
  report: (op: HttpOperation, missingTag: boolean, name: string) => void,
): void {
  const requestTypes = new Map<string, SynthesizedRequestType>();
  const discriminatedUnions = new Map<string, SynthesizedDiscriminatedUnion>();

  const ops = version
    ? operations.filter((op) => isOpInVersion(program, op, version))
    : operations;

  for (const op of ops) {
    if (!op.parameters.body) continue;
    const body = op.parameters.body;
    if (body.bodyKind !== "single" || body.type.kind !== "Model") continue;
    if (op.verb !== "post" && op.verb !== "patch" && op.verb !== "put")
      continue;

    const bodyModel = body.type as Model;
    if (!bodyModel.name) continue;

    const mergePatchBase = getMergePatchBaseName(bodyModel.name);
    if (mergePatchBase !== undefined) {
      const requestTypeName = `${mergePatchBase}PatchRequest`;
      checkPlainCollision(
        requestTypeName,
        new Map(bodyModel.properties),
        op,
        requestTypes,
        program,
        report,
      );
      continue;
    }

    const visibility = resolveRequestVisibility(program, op.operation, op.verb);
    if (!hasHiddenProperties(bodyModel, visibility, program)) continue;

    const suffix = requestTypeSuffix(op.verb);

    const discriminator = getDiscriminator(program, bodyModel);
    if (discriminator) {
      checkDiscriminatedCollision(
        bodyModel,
        discriminator,
        visibility,
        version,
        suffix,
        op,
        program,
        discriminatedUnions,
        report,
      );
      continue;
    }

    const requestTypeName = `${bodyModel.name}${suffix}Request`;
    const newProps = filterPropsForRequest(
      bodyModel,
      visibility,
      version,
      program,
    );
    checkPlainCollision(
      requestTypeName,
      newProps,
      op,
      requestTypes,
      program,
      report,
    );
  }
}

function checkPlainCollision(
  requestTypeName: string,
  newProps: Map<string, ModelProperty>,
  op: HttpOperation,
  requestTypes: Map<string, SynthesizedRequestType>,
  program: Program,
  report: (op: HttpOperation, missingTag: boolean, name: string) => void,
): void {
  const existing = requestTypes.get(requestTypeName);
  if (existing) {
    if (!propsHaveSameKeys(existing.props, newProps)) {
      const existingTags = getTags(program, existing.sourceOp.operation);
      const newTags = getTags(program, op.operation);
      if (!existingTags.length || !newTags.length) {
        report(op, !existingTags.length, requestTypeName);
        return;
      }
      const existingPrefix = capitalize(existingTags[0]);
      const newPrefix = capitalize(newTags[0]);
      requestTypes.delete(requestTypeName);
      requestTypes.set(`${existingPrefix}${requestTypeName}`, existing);
      requestTypes.set(`${newPrefix}${requestTypeName}`, {
        props: newProps,
        sourceOp: op,
      });
    }
    return;
  }
  requestTypes.set(requestTypeName, { props: newProps, sourceOp: op });
}

function checkDiscriminatedCollision(
  bodyModel: Model,
  discriminator: Discriminator,
  visibility: Visibility,
  version: Version | undefined,
  suffix: string,
  op: HttpOperation,
  program: Program,
  discriminatedUnions: Map<string, SynthesizedDiscriminatedUnion>,
  report: (op: HttpOperation, missingTag: boolean, name: string) => void,
): void {
  const [union] = getDiscriminatedUnionFromInheritance(
    bodyModel,
    discriminator,
  );
  const variants: Model[] = [];
  const seen = new Set<Model>();
  for (const variant of union.variants.values()) {
    if (seen.has(variant) || !variant.name) continue;
    seen.add(variant);
    variants.push(variant);
  }

  const variantProps = new Map<string, Map<string, ModelProperty>>();
  for (const variant of variants) {
    variantProps.set(
      variant.name!,
      filterPropsForRequest(variant, visibility, version, program),
    );
  }

  const requestTypeName = `${bodyModel.name}${suffix}Request`;
  const existing = discriminatedUnions.get(requestTypeName);

  if (existing) {
    if (discriminatedVariantShapesMatch(existing.variantProps, variantProps))
      return;

    const existingTags = getTags(program, existing.sourceOp.operation);
    const newTags = getTags(program, op.operation);
    if (!existingTags.length || !newTags.length) {
      report(op, !existingTags.length, requestTypeName);
      return;
    }

    discriminatedUnions.delete(requestTypeName);
    discriminatedUnions.set(
      `${capitalize(existingTags[0])}${requestTypeName}`,
      existing,
    );
    discriminatedUnions.set(`${capitalize(newTags[0])}${requestTypeName}`, {
      variantProps,
      sourceOp: op,
    });
    return;
  }

  discriminatedUnions.set(requestTypeName, { variantProps, sourceOp: op });
}

export const synthesizedRequestTypeCollisionRule = createRule({
  name: "synthesized-request-type-collision",
  severity: "warning",
  description:
    "Check for operations that would synthesize a same-named request body type with a different shape, predicting at lint time the collision the emitter otherwise only detects at emit time.",
  messages: {
    default: paramMessage`Request type "${"name"}" is produced by two operations with different shapes. Add @tag to both operations to disambiguate.`,
    missingTag: paramMessage`Request type "${"name"}" collision: operation "${"op"}" has no @tag for disambiguation. Add @tag to all conflicting operations.`,
  },
  create(context) {
    return {
      root: (program) => {
        const [services] = getAllHttpServices(program);
        for (const service of services) {
          if (service.operations.length === 0) continue;
          const allVersions = getAllVersions(program, service.namespace) ?? [
            undefined,
          ];
          for (const version of allVersions) {
            checkVersion(
              program,
              service.operations,
              version,
              (op, missingTag, name) => {
                context.reportDiagnostic({
                  messageId: missingTag ? "missingTag" : "default",
                  format: { name, op: op.operation.name },
                  target: op.operation,
                });
              },
            );
          }
        }
      },
    };
  },
});

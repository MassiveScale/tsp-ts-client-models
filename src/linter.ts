import { defineLinter } from "@typespec/compiler";
import { synthesizedRequestTypeCollisionRule } from "./rules/synthesized-request-type-collision.js";

export const $linter = defineLinter({
  rules: [synthesizedRequestTypeCollisionRule],
  ruleSets: {
    recommended: {
      enable: {
        "@massivescale/tsp-ts-client-models/synthesized-request-type-collision": true,
      },
    },
    all: {
      enable: {
        "@massivescale/tsp-ts-client-models/synthesized-request-type-collision": true,
      },
    },
  },
});

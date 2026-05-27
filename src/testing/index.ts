import { resolvePath } from "@typespec/compiler";
import { createTestLibrary, TypeSpecTestLibrary } from "@typespec/compiler/testing";
import { fileURLToPath } from "url";

export const TspTsClientModelsTestLibrary: TypeSpecTestLibrary = createTestLibrary({
  name: "@massivescale/tsp-ts-client-models",
  packageRoot: resolvePath(fileURLToPath(import.meta.url), "../../../../"),
});

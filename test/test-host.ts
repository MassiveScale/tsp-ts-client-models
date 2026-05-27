import { Diagnostic, resolvePath } from "@typespec/compiler";
import { expectDiagnosticEmpty, createTester } from "@typespec/compiler/testing";
import type { EmitterOptions } from "../src/lib.js";

const BaseTester = createTester(resolvePath(import.meta.dirname, "../.."), {
  libraries: ["@massivescale/tsp-ts-client-models", "@typespec/http", "@typespec/versioning"],
});

function testerFor(options?: EmitterOptions) {
  return BaseTester.emit("@massivescale/tsp-ts-client-models", (options ?? {}) as Record<string, unknown>);
}

export async function emitWithDiagnostics(
  code: string,
  options?: EmitterOptions,
): Promise<[Record<string, string>, readonly Diagnostic[]]> {
  const [{ outputs }, diagnostics] = await testerFor(options).compileAndDiagnose(code);
  return [outputs, diagnostics];
}

export async function emit(code: string, options?: EmitterOptions): Promise<Record<string, string>> {
  const [result, diagnostics] = await emitWithDiagnostics(code, options);
  expectDiagnosticEmpty(diagnostics);
  return result;
}

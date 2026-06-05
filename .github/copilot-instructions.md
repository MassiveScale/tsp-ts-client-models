# Project Instructions

This file is the **single source of truth** for AI assistant guidance in this repository. All project conventions, architecture notes, and development instructions live here. `CLAUDE.md` at the repo root points to this file.

---

## Project Overview

`@massivescale/tsp-ts-client-models` is a [TypeSpec](https://typespec.io) emitter that generates TypeScript API client models. Given a TypeSpec definition, it produces an npm package with models for each HTTP operation (`GET`, `POST`, `PATCH`, `DELETE`), including version-aware client generation.

The emitter generates TypeScript models and enums. See `src/emitter.ts` for the implementation.

---

## Commands

```powershell
npm run build          # Compile TypeScript → dist/
npm test               # Run tests (requires build first)
npm run lint           # Lint src/ and test/
npm run lint:fix       # Lint with auto-fix
npm run format         # Format all files with Prettier
npm run format:check   # Check formatting without writing
npm run watch          # Watch mode TypeScript compilation
```

**Important:** Tests run against compiled output in `dist/`. Always run `npm run build` before `npm test`, or chain them:

```powershell
npm run build && npm test
```

To run a single test file after building:

```powershell
node --test dist/test/emitter.test.js
```

---

## Architecture

### TypeSpec Emitter Pattern

TypeSpec discovers this emitter via two required exports in `src/index.ts`:

- **`$lib`** (`src/lib.ts`) — Registers the library name (`"@massivescale/tsp-refit-client"`) and declares compiler diagnostics via `createTypeSpecLibrary`. Add new diagnostic codes here before using `reportDiagnostic` or `createDiagnostic`.
- **`$onEmit`** (`src/emitter.ts`) — The emitter entry point called by the TypeSpec compiler. Receives an `EmitContext` containing the program's type graph. All code generation logic lives here or is called from here.

### Test Infrastructure

`test/test-host.ts` sets up a TypeSpec test harness using `createTester` pointed at the repo root, with `@massivescale/tsp-refit-client` as the loaded library. It exports two helpers:

- `emit(code)` — Compiles inline TypeSpec, asserts no diagnostics, returns `Record<string, string>` mapping output file paths to their string content.
- `emitWithDiagnostics(code)` — Same but also returns compiler diagnostics for testing error cases.

Tests use Node.js native test runner (`node:test` / `node:assert`) — no external test framework.

### Example

`example/versioned-api/` contains a versioned Pet Store TypeSpec API used for manual end-to-end validation. Its `package.json` currently references `@massivescale/tsp-aspnetcore-api` (a sibling emitter project) — this needs updating to reference `@massivescale/tsp-refit-client` once the emitter is functional. Run the example builds via `example/versioned-api/build.ps1`.

---

## Conventions

### ESM and Import Extensions

The project uses ESM (`"type": "module"`). All internal imports must use `.js` extensions — TypeScript resolves them to `.ts` at compile time, Node.js resolves to `.js` at runtime.

### TypeSpec Peer Dependency

`@typespec/compiler` is declared as a peer dependency at `latest`. Keep it in sync with any TypeSpec packages used in tests or the example.

### Diagnostics

Declare all diagnostic codes in `src/lib.ts` inside the `diagnostics` map passed to `createTypeSpecLibrary`. Use `reportDiagnostic` (for non-fatal) or `createDiagnostic` (to return a diagnostic value) from the destructured exports of `$lib`.

### Linting

ESLint uses the flat config format (`eslint.config.js`) with `typescript-eslint`. Unused variables prefixed with `_` are allowed by convention.

---

## After Every Change

After being asked to cleanup the codebase, or making any change to the codebase:

1. **Rebuild and test the package:**

   ```powershell
   npm run build && npm test
   ```

2. **Rebuild all TypeSpec examples:**

   ```powershell
   cd example/simple-api && npm install && tsp compile .
   cd example/versioned-api && npm install && ./build.ps1
   ```

   Run this for every subdirectory under `example/` that contains a `build.ps1`.

3. **Update documentation and changelog**
   - Update `README.md`
   - Update `CHANGELOG.md`
   - When `README.md` exceeds reasonable size for readability, break into multiple files under `/docs`
4. **Lint and format**

   ```powershell
   npm run format
   ```

All steps must pass before a change is considered complete.

## Maintenance

- **CLAUDE.md** — Redirects to this file. Do not add content there.
- **README.md** — User-facing documentation. Update it alongside user-visible feature changes.
- **CHANGELOG.md** — Keep a changelog following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format. Update it for every meaningful change.

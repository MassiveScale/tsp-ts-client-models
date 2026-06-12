# Using in an Nx Monorepo

In an Nx workspace, the generated client package is best consumed as a **publishable library** — either checked in as source and built locally, or published to a registry and installed as a regular npm dependency.

## Option A — Local publishable library (source in the monorepo)

This is the most common approach. The TypeSpec emitter writes to a library folder, and Nx builds it as part of your workspace.

### Step 1: Create a library target

If the emitter outputs to `libs/my-api-client/`, register a build target in `libs/my-api-client/project.json`:

```json
{
  "name": "my-api-client",
  "targets": {
    "tsp-compile": {
      "executor": "nx:run-commands",
      "options": {
        "command": "tsp compile .",
        "cwd": "apps/my-api"
      }
    },
    "build": {
      "executor": "@nx/js:tsc",
      "options": {
        "outputPath": "dist/libs/my-api-client",
        "tsConfig": "libs/my-api-client/tsconfig.json",
        "assets": []
      },
      "dependsOn": ["tsp-compile"]
    }
  }
}
```

### Step 2: Configure TypeSpec output directory

In your TypeSpec project's `tspconfig.yaml`, point `emitter-output-dir` to the library root:

```yaml
emit:
  - "@massivescale/tsp-ts-client-models"
options:
  "@massivescale/tsp-ts-client-models":
    emitter-output-dir: "{workspaceRoot}/libs/my-api-client"
    npm-package-name: "@my-org/my-api-client"
```

### Step 3: Add path alias

In the root `tsconfig.base.json`, add a path alias so consuming apps can import by package name:

```json
{
  "compilerOptions": {
    "paths": {
      "@my-org/my-api-client": ["libs/my-api-client/dist/index.d.ts"],
      "@my-org/my-api-client/*": ["libs/my-api-client/dist/*"]
    }
  }
}
```

> During development, point to the TypeScript source directly:
>
> ```json
> "@my-org/my-api-client": ["libs/my-api-client/index.ts"]
> ```

### Step 4: Declare project dependency

In `project.json` for any app that consumes the client, list the library as an implicit dependency:

```json
{
  "name": "my-app",
  "implicitDependencies": ["my-api-client"]
}
```

Nx uses this to order builds correctly with `nx affected`.

## Option B — Installed npm package

If you publish the generated package to a registry (npm, GitHub Packages, Verdaccio), simply install it:

```bash
npm install @my-org/my-api-client
```

No special Nx configuration is needed beyond a standard `package.json` dependency.

## Running the emitter as an Nx target

Add a `tsp-compile` target to run the TypeSpec emitter from the monorepo root:

```bash
nx run my-api:tsp-compile
```

Or trigger it before builds with `dependsOn` (see Step 1 above).

## Affected builds

Because the library output is checked in, `nx affected` can determine which apps need rebuilding when the TypeSpec definition changes — as long as you keep the Nx project graph updated with `implicitDependencies`.

## Example workspace layout

```
my-workspace/
├── apps/
│   ├── my-api/           ← TypeSpec definition lives here
│   │   ├── main.tsp
│   │   └── tspconfig.yaml
│   └── my-web-app/       ← Consumes the generated client
├── libs/
│   └── my-api-client/    ← emitter-output-dir → TypeSpec writes here
│       ├── models.ts
│       ├── endpoints/
│       ├── client/
│       ├── index.ts
│       ├── package.json
│       └── tsconfig.json
├── nx.json
└── tsconfig.base.json    ← path alias "@my-org/my-api-client"
```

## Linting and formatting

The emitter sets `"sideEffects": false` and `"type": "module"` in the generated `package.json`. Add the generated library to your ESLint and Prettier ignore patterns to avoid linting auto-generated files:

```json
// .eslintignore
libs/my-api-client/
```

```
# .prettierignore
libs/my-api-client/
```

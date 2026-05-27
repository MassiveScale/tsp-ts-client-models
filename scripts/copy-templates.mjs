/**
 * @file copy-templates.mjs
 *
 * Build script that copies all `.hbs` template files from `src/templates/` to
 * `dist/templates/` so that the compiled package can locate them at runtime.
 *
 * Run automatically as part of `npm run build` after `tsc` compiles the
 * TypeScript sources.
 */

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the repository root. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Source templates directory. */
const src = resolve(root, "src/templates");

/** Destination templates directory (inside the compiled output). */
const dest = resolve(root, "dist/templates");

mkdirSync(dest, { recursive: true });

for (const file of readdirSync(src)) {
  if (file.endsWith(".hbs")) {
    copyFileSync(resolve(src, file), resolve(dest, file));
  }
}

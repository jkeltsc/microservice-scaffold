// Image-tree assembler: builds the staging tree the runtime image overlays.
//
// Design intent: "only what was built exists". The assembler stages ONLY
// workspace packages into `/out`; minimality is established by CONSTRUCTION —
// nothing is ever deleted from the image after the fact. A Specific_Container
// therefore cannot ship a microservice it did not select (Requirements R6.2,
// R6.3), because that microservice is never compiled and never copied.
//
// Third-party runtime dependencies are NOT staged here. They are produced by a
// separate `prod-deps` Docker stage (`npm ci --omit=dev`), and the runtime
// stage composes the two: it copies `node_modules/` from prod-deps first, then
// overlays `/out` from the build stage.
//
// Target layout (relative to `outDir`):
//
//   node_modules/@scaffold/contracts/   REAL directory: package.json + dist
//   node_modules/@scaffold/<selected>/  REAL directories, selected services only
//   packages/overseer/                   package.json + dist
//
// Two layout decisions matter:
//
//   1. Microservices live ONLY under `node_modules/@scaffold/`, because the
//      generated registry imports them by package name. `packages/microservices/`
//      is deliberately absent from the image.
//   2. They are REAL directories, not npm's workspace symlinks: a symlink into
//      `packages/microservices/` would dangle the moment that tree is absent.
//      Overlaying `/out` after the prod-deps `node_modules/` also replaces any
//      dangling workspace-scope symlinks the prod-deps install may leave behind.
//
// The Overseer stays at `packages/overseer/` because it is invoked by path
// (`ENTRYPOINT ["node", "packages/overseer/dist/index.js"]`).
//
// Paths are relative, i.e. resolved against cwd, which is the build stage's
// `/app` (the repo root). Errors propagate: Node prints them and exits non-zero.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  generateRegistry,
  listMicroserviceDirectories,
} from "./generate-registry.js";
import { resolveSelected } from "./selector.js";

/** Workspace scope; materialized as real directories, so never copied as-is. */
const SCAFFOLD_SCOPE = "@scaffold";

/** Run a command with inherited stdio; abort the process on any failure. */
function run(command: string, args: readonly string[]): void {
  const { error, status } = spawnSync(command, [...args], { stdio: "inherit" });
  if (error) {
    throw error;
  }
  if (status !== 0) {
    throw new Error(
      `[image-tree] "${command} ${args.join(" ")}" failed with exit code ${String(status)}`,
    );
  }
}

/** Copy a workspace package's runtime surface (manifest + compiled output). */
function copyPackage(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));
  cpSync(join(sourceDir, "dist"), join(targetDir, "dist"), {
    recursive: true,
    dereference: true,
  });
}

/**
 * Generate the registry for `MICROSERVICES`, build only the projects the image
 * needs, and assemble `outDir` with the workspace packages.
 *
 * Build order is explicit rather than left to project references: the Overseer's
 * generated registry imports `@scaffold/<identifier>`, and those microservice
 * packages are not references of the Overseer project, so their declarations
 * must exist before the Overseer compiles. `packages/contracts` likewise comes
 * first because the microservice projects resolve it through `node_modules`.
 */
export function buildImageTree(outDir = "/out"): void {
  const selector = process.env.MICROSERVICES;
  generateRegistry(selector);
  const selected = resolveSelected(selector, listMicroserviceDirectories());

  run("npx", [
    "tsc",
    "--build",
    "packages/contracts",
    ...selected.map((identifier) => `packages/microservices/${identifier}`),
    "packages/overseer",
  ]);

  rmSync(outDir, { recursive: true, force: true });

  copyPackage(
    "packages/contracts",
    join(outDir, "node_modules", SCAFFOLD_SCOPE, "contracts"),
  );
  for (const identifier of selected) {
    copyPackage(
      join("packages", "microservices", identifier),
      join(outDir, "node_modules", SCAFFOLD_SCOPE, identifier),
    );
  }

  copyPackage("packages/overseer", join(outDir, "packages", "overseer"));

  // Post-assemble integrity check: no unselected microservice may have leaked
  // into the image tree. This catches assembler bugs at build time, locally and
  // in CI, rather than in a post-build pipeline step.
  const allMicroservices = listMicroserviceDirectories();
  const selectedSet = new Set(selected);
  for (const name of allMicroservices) {
    if (
      !selectedSet.has(name) &&
      existsSync(join(outDir, "node_modules", SCAFFOLD_SCOPE, name))
    ) {
      throw new Error(
        `[image-tree] unselected microservice "${name}" found in ${outDir}/node_modules/@scaffold/ — the image tree must contain only selected microservices`,
      );
    }
  }
}

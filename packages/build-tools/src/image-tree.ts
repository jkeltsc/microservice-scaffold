// Image-tree assembler: builds the single staging tree a runtime image copies.
//
// Design intent: "only what was built exists". The runtime stage does one
// `COPY --from=build /out ./`, so minimality is established by CONSTRUCTION —
// nothing is ever deleted from the image after the fact. A Specific_Container
// therefore cannot ship a microservice it did not select (Requirements R6.2,
// R6.3), because that microservice is never compiled and never copied.
//
// Target layout (relative to `outDir`):
//
//   node_modules/                       third-party RUNTIME deps only
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
//
// The Overseer stays at `packages/overseer/` because it is invoked by path
// (`ENTRYPOINT ["node", "packages/overseer/dist/index.js"]`).
//
// Paths are relative, i.e. resolved against cwd, which is the build stage's
// `/app` (the repo root). Errors propagate: Node prints them and exits non-zero.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  generateRegistry,
  listMicroserviceDirectories,
} from "./generate-registry.js";
import { resolveSelected } from "./selector.js";

/** Workspace scope; materialized as real directories, so never copied as-is. */
const SCAFFOLD_SCOPE = "@scaffold";

/** Executable shims: build-time only, and their symlinks dangle after pruning. */
const BIN_DIR = ".bin";

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
 * Copy the installed third-party dependency tree, skipping the workspace scope
 * (materialized separately as real directories), the bin shims, and the empty
 * scope directories `npm prune` leaves behind once it has removed the
 * devDependencies inside them.
 *
 * `dereference` turns any remaining symlink into a real file, so nothing in the
 * image can point outside it.
 */
function copyThirdPartyDependencies(targetNodeModules: string): void {
  mkdirSync(targetNodeModules, { recursive: true });
  for (const entry of readdirSync("node_modules", { withFileTypes: true })) {
    if (entry.name === SCAFFOLD_SCOPE || entry.name === BIN_DIR) {
      continue;
    }

    const source = join("node_modules", entry.name);
    if (entry.isDirectory() && readdirSync(source).length === 0) {
      continue;
    }

    cpSync(source, join(targetNodeModules, entry.name), {
      recursive: true,
      dereference: true,
    });
  }
}

/**
 * Generate the registry for `MICROSERVICES`, build only the projects that image
 * needs, drop devDependencies, and assemble `outDir`.
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

  // Everything is compiled, so the build-only dependency tree (typescript,
  // vitest, eslint, ...) has served its purpose. Pruning here — before the
  // assemble step reads `node_modules` — is what keeps devDependencies out of
  // the image without any post-copy deletion.
  run("npm", ["prune", "--omit=dev"]);

  rmSync(outDir, { recursive: true, force: true });
  copyThirdPartyDependencies(join(outDir, "node_modules"));

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

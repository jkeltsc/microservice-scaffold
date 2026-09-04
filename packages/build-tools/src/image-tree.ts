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
//   node_modules/@microservices/<shared>/    REAL directories, required shared packages only
//   node_modules/@microservices/<selected>/  REAL directories, selected services only
//   packages/overseer/                   package.json + dist
//
// The staged shared packages are exactly the Required_Shared_Packages: the
// transitive `@microservices`-scoped dependency closure of the selected
// microservices plus the Overseer (`discoverSharedPackages` +
// `requiredSharedPackages`). No shared package is special-cased —
// `@microservices/contracts` re-enters the closure like any other, because the
// Overseer (and the microservices) depend on it. A Specific_Container therefore
// never ships a shared package none of its selected microservices consume.
//
// Two layout decisions matter:
//
//   1. Microservices and shared packages live ONLY under
//      `node_modules/@microservices/`, because the generated registry (and the
//      consumers) import them by package name. `packages/microservices/` and the
//      shared packages' `packages/<name>/` source trees are deliberately absent
//      from the image.
//   2. They are REAL directories, not npm's workspace symlinks: a symlink into
//      `packages/microservices/` (or a shared package's `packages/<name>/`) would
//      dangle the moment that tree is absent. Overlaying `/out` after the
//      prod-deps `node_modules/` also replaces any dangling workspace-scope
//      symlinks the prod-deps install may leave behind.
//
// The Overseer stays at `packages/overseer/` because it is invoked by path
// (`ENTRYPOINT ["node", "packages/overseer/dist/index.js"]`).
//
// Paths are relative, i.e. resolved against cwd, which is the build stage's
// `/app` (the repo root). Errors propagate: Node prints them and exits non-zero.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import {
  generateRegistry,
  listMicroserviceDirectories,
} from "./generate-registry.js";
import { resolveSelected } from "./selector.js";
import {
  discoverSharedPackages,
  requiredSharedPackages,
  type SharedPackage,
} from "./shared-packages.js";

/** Workspace scope; materialized as real directories, so never copied as-is. */
const WORKSPACE_SCOPE = "@microservices";

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

/**
 * Read the `@microservices`-scoped `dependencies` keys of a workspace manifest
 * at `packageDir` (e.g. "packages/overseer"). This is the {@link ReadDependencies}
 * reader `requiredSharedPackages` uses for its microservice and Overseer roots;
 * shared-package edges come from discovery instead. An absent or unparsable
 * manifest, or one with no `dependencies`, yields an empty list.
 */
function readSharedDeps(packageDir: string): readonly string[] {
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
  } catch {
    return [];
  }
  return Object.keys(manifest.dependencies ?? {}).filter((dep) =>
    dep.startsWith(`${WORKSPACE_SCOPE}/`),
  );
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
 * generated registry imports `@microservices/<identifier>`, and those microservice
 * packages are not references of the Overseer project, so their declarations
 * must exist before the Overseer compiles. The Required_Shared_Packages come
 * first, in topological order (every shared package before its dependents), so
 * `@microservices/contracts` and any other shared package the microservices and
 * Overseer resolve through `node_modules` exist before they compile.
 */
export function buildImageTree(outDir = "/out"): void {
  const selector = process.env.MICROSERVICES;
  generateRegistry(selector);
  const selected = resolveSelected(selector, listMicroserviceDirectories());

  const shared = discoverSharedPackages();
  const required = requiredSharedPackages(selected, shared, readSharedDeps);

  run("npx", [
    "tsc",
    "--build",
    ...required.map((pkg) => pkg.packageDir),
    ...selected.map((identifier) => `packages/microservices/${identifier}`),
    "packages/overseer",
  ]);

  rmSync(outDir, { recursive: true, force: true });

  for (const pkg of required) {
    copyPackage(
      pkg.packageDir,
      join(outDir, "node_modules", WORKSPACE_SCOPE, pkg.dirName),
    );
  }
  for (const identifier of selected) {
    copyPackage(
      join("packages", "microservices", identifier),
      join(outDir, "node_modules", WORKSPACE_SCOPE, identifier),
    );
  }

  copyPackage("packages/overseer", join(outDir, "packages", "overseer"));

  // Post-assemble integrity checks. Minimality holds by construction — only
  // selected microservices and Required_Shared_Packages are ever copied — so
  // these guards can never fire under the current assembler. They exist as
  // defense in depth: any future regression turns into a non-zero build failure
  // locally and in CI, rather than a silently bloated image.
  assertNoUnselectedMicroservice(outDir, selected);
  assertNoNonRequiredSharedPackage(outDir, shared, required);
}

/**
 * Fail the build if any unselected microservice leaked into the image tree.
 * Iterates every discovered microservice directory and asserts that none
 * outside `selected` is present under `node_modules/@microservices/`.
 *
 * @param outDir the assembled image-tree root.
 * @param selected the selected microservice identifiers.
 * @throws when an unselected microservice is present, naming the offender.
 */
export function assertNoUnselectedMicroservice(
  outDir: string,
  selected: readonly string[],
): void {
  const allMicroservices = listMicroserviceDirectories();
  const selectedSet = new Set(selected);
  for (const name of allMicroservices) {
    if (
      !selectedSet.has(name) &&
      existsSync(join(outDir, "node_modules", WORKSPACE_SCOPE, name))
    ) {
      throw new Error(
        `[image-tree] unselected microservice "${name}" found in ${outDir}/node_modules/@microservices/ — the image tree must contain only selected microservices`,
      );
    }
  }
}

/**
 * Fail the build if any discovered-but-not-required shared package leaked into
 * the image tree. Iterates the discovered shared-package map and asserts that
 * no package outside `required` is present under `node_modules/@microservices/`
 * (R7.2). A Specific_Container therefore never ships a shared package none of
 * its selected microservices consume.
 *
 * @param outDir the assembled image-tree root.
 * @param shared the discovered shared packages keyed by `@microservices/<name>`.
 * @param required the Required_Shared_Packages closure that was staged.
 * @throws when a non-required shared package is present, naming the offender.
 */
export function assertNoNonRequiredSharedPackage(
  outDir: string,
  shared: ReadonlyMap<string, SharedPackage>,
  required: readonly SharedPackage[],
): void {
  const requiredNames = new Set(required.map((pkg) => pkg.name));
  for (const pkg of shared.values()) {
    if (
      !requiredNames.has(pkg.name) &&
      existsSync(join(outDir, "node_modules", WORKSPACE_SCOPE, pkg.dirName))
    ) {
      throw new Error(
        `[image-tree] non-required shared package "${pkg.name}" found in ${outDir}/node_modules/@microservices/ — the image tree must contain only required shared packages`,
      );
    }
  }
}

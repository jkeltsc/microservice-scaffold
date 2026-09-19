// This module names the scaffold's own four packages by their scope-free
// directory facts and checks their directories exist.
//
// The check is step 1 of the build pipeline, called by image-tree.ts's
// `buildImageTree` before anything else runs. Every other module under
// `packages/build-tools/src/` takes category directories and the Overseer
// entrypoint from here (R10.2-R10.5); the scope-composed framework NAMES live on
// the project context, not here (R3.7).
//
// Framework packages are known by their directories, and declared here. The
// packages a template user writes are named nowhere: discovery.ts finds those by
// location, under the configured Discovery_Roots (R1.2, R5.1).
//
// `scripts/emit-effective-dockerfile.sh` repeats the category directories and
// the top-level exclusion names as shell literals: it runs on a fresh clone
// before anything is compiled, so it cannot import this module (R11.7).
//
// Neither the scope nor the three Consumer_Category root paths are declared
// here. Their single declaration site is `project-config.ts` (SCOPE_DEFAULT and
// ROOT_DEFAULTS, R1.8, R12.4). This module holds only scope-free, root-free
// directory facts: after config-driven-discovery task 8, no reader of a scope or
// a Discovery_Root reaches through framework.ts — they read the project context
// instead. The four framework directory names come from the leaf `categories.ts`
// (which imports nothing), so framework.ts declares no scope or root literal and
// this module imports project-config.ts for nothing.

import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_DIR_NAMES,
  PACKAGES_DIR,
  type ConsumerCategory,
} from "./categories.js";

export { CONSUMER_CATEGORIES, PACKAGES_DIR, type ConsumerCategory };

/** Where image-tree.ts copies a framework package into an image, if at all. */
export type FrameworkStaging =
  /** A real directory at `<outDir>/node_modules/@microservices/<dirName>`. */
  | "scoped-node-modules"
  /** A real directory at `<outDir>/<packageDir>` (the Overseer, invoked by path). */
  | "package-dir"
  /** Never staged into an image. */
  | "none";

/** A package of the scaffold itself, described scope-free and root-free: the
 *  directory facts a module needs when it wants a path, never a name. The
 *  composed `name` (a function of the Configured_Scope, and so per run) lives on
 *  the project context's `FrameworkSingleton`, not here (R3.7). */
export interface FrameworkDirectory {
  /** Directory name under `packages/`, e.g. "contracts". */
  readonly dirName: string;
  /** Repo-relative package directory, e.g. "packages/contracts". */
  readonly packageDir: string;
  readonly staging: FrameworkStaging;
}

/** Builds one framework directory record; `packageDir` is composed from
 *  `PACKAGES_DIR` and the directory name, so each is declared once (R10.5). No
 *  `name` is composed here — that is per run and lives on the project context. */
function frameworkDirectory(
  dirName: string,
  staging: FrameworkStaging,
): FrameworkDirectory {
  return {
    dirName,
    packageDir: `${PACKAGES_DIR}/${dirName}`,
    staging,
  };
}

// The four directory names come from `categories.ts`'s FRAMEWORK_DIR_NAMES (the
// single source), in its fixed contracts/overseer/build-tools/integration-tests
// order; each `singleton()` pairs the name at that index with its staging.
const [
  CONTRACTS_DIR,
  OVERSEER_DIR,
  BUILD_TOOLS_DIR,
  INTEGRATION_TESTS_DIR,
] = FRAMEWORK_DIR_NAMES;

/** The scaffold's shared type surface: always built, always the first build root
 *  (Build_Sequence statement 1), always staged, whatever the selector and whatever
 *  depends on it (R5.4-R5.6). */
export const CONTRACTS: FrameworkDirectory = frameworkDirectory(
  CONTRACTS_DIR!,
  "scoped-node-modules",
);

/** The routing frontend. Staged at its package directory because the entrypoint
 *  invokes it by path; its generated registry imports the microservices, so the
 *  Build_Sequence emits it after them. */
export const OVERSEER: FrameworkDirectory = frameworkDirectory(
  OVERSEER_DIR!,
  "package-dir",
);

/** The Build_System itself. Compiled by the image's bootstrap step, never a root
 *  of the selector-driven build, never shipped in a runtime image (R2.10). */
export const BUILD_TOOLS: FrameworkDirectory = frameworkDirectory(
  BUILD_TOOLS_DIR!,
  "none",
);

/** The cross-package test suite. Never built for, never shipped in, an image. */
export const INTEGRATION_TESTS: FrameworkDirectory = frameworkDirectory(
  INTEGRATION_TESTS_DIR!,
  "none",
);

/** All four framework directories, in fixed order; iterate this, never a copy
 *  (R10.6). Scope-free: the single source of the four packages' directory facts,
 *  read by every module that wants a directory. The project context composes each
 *  one's scoped `name` on top of these records (R3.7). */
export const FRAMEWORK_DIRECTORIES: readonly FrameworkDirectory[] = [
  CONTRACTS,
  OVERSEER,
  BUILD_TOOLS,
  INTEGRATION_TESTS,
];

/** The directory names an image may hold under `node_modules/@microservices/` on
 *  framework grounds alone; read by image-tree.ts's integrity check (R5.10, R7.7). */
export const ALWAYS_STAGED_SCOPED_ENTRIES: readonly string[] =
  FRAMEWORK_DIRECTORIES.filter(
    (entry) => entry.staging === "scoped-node-modules",
  ).map((entry) => entry.dirName);

/** The Overseer's compiled entrypoint, `packages/overseer/dist/index.js`. POSIX
 *  separators: this is a build and spawn argument, not a host path (R10.1). */
export const OVERSEER_ENTRYPOINT = `${OVERSEER.packageDir}/dist/index.js`;

/**
 * Builds the error for absent framework directories: one clause per offender, so
 * one failure names them all (R10.7).
 *
 * The clause names the framework package by its scope-free directory name — the
 * scope-composed name is a per-run value this scope-free module does not hold.
 *
 * @param absent the absent packages, in {@link FRAMEWORK_DIRECTORIES} order.
 */
function missingFrameworkDirectoriesError(
  absent: readonly FrameworkDirectory[],
): Error {
  const clauses = absent
    .map(
      (entry) =>
        `Framework_Singleton "${entry.dirName}" declares directory "${entry.packageDir}", which is absent from the repository`,
    )
    .join("; ");
  return new Error(`[framework:missing] ${clauses}`);
}

/**
 * Step 1 of the build pipeline — fails when a framework package's declared
 * directory is missing from the repository (R10.7).
 *
 * Called by image-tree.ts's `buildImageTree`, which passes `existsSync`; every
 * absent package is collected before it throws.
 *
 * @param exists true when the repo-relative package directory is present.
 * @throws `[framework:missing]` naming every absent package and its directory.
 */
export function assertFrameworkDirectoriesPresent(
  exists: (packageDir: string) => boolean,
): void {
  const absent = FRAMEWORK_DIRECTORIES.filter(
    (entry) => !exists(entry.packageDir),
  );
  if (absent.length > 0) {
    throw missingFrameworkDirectoriesError(absent);
  }
}

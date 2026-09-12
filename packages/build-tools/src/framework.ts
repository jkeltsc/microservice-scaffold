// This module names the scaffold's own four packages and checks their
// directories exist.
//
// The check is step 1 of the build pipeline, called by image-tree.ts's
// `buildImageTree` before anything else runs. Every other module under
// `packages/build-tools/src/` takes framework names, category directories, the
// workspace scope, and the Overseer entrypoint from here (R10.2-R10.5).
//
// Framework packages are known by name, and named here. The packages a template
// user writes are named nowhere: discovery.ts finds those by location, under the
// category directories at the end of this file (R1.2, R5.1).
//
// `scripts/emit-effective-dockerfile.sh` repeats those category directories and
// the four top-level exclusion names as shell literals: it runs on a fresh clone
// before anything is compiled, so it cannot import this module (R11.7). Rename a
// directory here and update the script in the same change.

/** The npm scope every workspace package of this repository lives under. */
export const WORKSPACE_SCOPE = "@microservices";

/** The directory every workspace package lives under, repo-relative. */
export const PACKAGES_DIR = "packages";

/** Where image-tree.ts copies a framework package into an image, if at all. */
export type FrameworkStaging =
  /** A real directory at `<outDir>/node_modules/@microservices/<dirName>`. */
  | "scoped-node-modules"
  /** A real directory at `<outDir>/<packageDir>` (the Overseer, invoked by path). */
  | "package-dir"
  /** Never staged into an image. */
  | "none";

/** Where a framework package sits among the ordered `tsc --build` roots. */
export type FrameworkBuildPosition =
  /** Always the first root, ahead of every other Tsc_Project (R5.5). */
  | "first"
  /** Always the last root; its generated registry imports the microservices. */
  | "last"
  /** Never a root of the image/dev build (bootstrap or test-only tooling). */
  | "excluded";

/** A package of the scaffold itself, known to the Build_System by name. */
export interface FrameworkSingleton {
  /** Declared package name, e.g. "@microservices/contracts". */
  readonly name: string;
  /** Directory name under `packages/`, e.g. "contracts". */
  readonly dirName: string;
  /** Repo-relative package directory, e.g. "packages/contracts". */
  readonly packageDir: string;
  readonly staging: FrameworkStaging;
  readonly buildPosition: FrameworkBuildPosition;
}

/** Builds one framework package record; composing `name` and `packageDir` from
 *  the two prefixes above keeps each declared once (R10.5). */
function singleton(
  dirName: string,
  staging: FrameworkStaging,
  buildPosition: FrameworkBuildPosition,
): FrameworkSingleton {
  return {
    name: `${WORKSPACE_SCOPE}/${dirName}`,
    dirName,
    packageDir: `${PACKAGES_DIR}/${dirName}`,
    staging,
    buildPosition,
  };
}

/** The scaffold's shared type surface: always built, always the first root, always
 *  staged, whatever the selector and whatever depends on it (R5.4-R5.6). */
export const CONTRACTS: FrameworkSingleton = singleton(
  "contracts",
  "scoped-node-modules",
  "first",
);

/** The routing frontend. Staged at its package directory because the entrypoint
 *  invokes it by path; built last because its registry imports the microservices. */
export const OVERSEER: FrameworkSingleton = singleton(
  "overseer",
  "package-dir",
  "last",
);

/** The Build_System itself. Compiled by the image's bootstrap step, never a root
 *  of the selector-driven build, never shipped in a runtime image (R2.10). */
export const BUILD_TOOLS: FrameworkSingleton = singleton(
  "build-tools",
  "none",
  "excluded",
);

/** The cross-package test suite. Never built for, never shipped in, an image. */
export const INTEGRATION_TESTS: FrameworkSingleton = singleton(
  "integration-tests",
  "none",
  "excluded",
);

/** All four framework packages, in fixed order; iterate this, never a copy (R10.6). */
export const FRAMEWORK_SINGLETONS: readonly FrameworkSingleton[] = [
  CONTRACTS,
  OVERSEER,
  BUILD_TOOLS,
  INTEGRATION_TESTS,
];

/** Resolution index over {@link FRAMEWORK_SINGLETONS}, built once. */
const BY_NAME: ReadonlyMap<string, FrameworkSingleton> = new Map(
  FRAMEWORK_SINGLETONS.map((entry) => [entry.name, entry]),
);

/** Looks up a framework package by declared name: exact, case-sensitive (R3.7). */
export function frameworkSingletonByName(
  name: string,
): FrameworkSingleton | undefined {
  return BY_NAME.get(name);
}

/** The directory names an image may hold under `node_modules/@microservices/` on
 *  framework grounds alone; read by image-tree.ts's integrity check (R5.10, R7.7). */
export const ALWAYS_STAGED_SCOPED_ENTRIES: readonly string[] =
  FRAMEWORK_SINGLETONS.filter(
    (entry) => entry.staging === "scoped-node-modules",
  ).map((entry) => entry.dirName);

/** The Overseer's compiled entrypoint, `packages/overseer/dist/index.js`. POSIX
 *  separators: this is a build and spawn argument, not a host path (R10.1). */
export const OVERSEER_ENTRYPOINT = `${OVERSEER.packageDir}/dist/index.js`;

/** The kind of package a user of the template writes. */
export type ConsumerCategory = "microservice" | "common" | "spa";

/** Every Consumer_Category, in a fixed order, for exhaustive iteration. */
export const CONSUMER_CATEGORIES: readonly ConsumerCategory[] = [
  "microservice",
  "common",
  "spa",
];

/** The parent directory of each category, its Namespace_Container (R10.1). The
 *  parent is no package itself; its direct subdirectories are the category (R1.4). */
export const NAMESPACE_CONTAINER: Readonly<Record<ConsumerCategory, string>> = {
  microservice: `${PACKAGES_DIR}/microservices`,
  common: `${PACKAGES_DIR}/common`,
  spa: `${PACKAGES_DIR}/spa`,
};

/**
 * Builds the error for absent framework directories: one clause per offender, so
 * one failure names them all (R10.7).
 *
 * @param absent the absent packages, in {@link FRAMEWORK_SINGLETONS} order.
 */
function missingFrameworkDirectoriesError(
  absent: readonly FrameworkSingleton[],
): Error {
  const clauses = absent
    .map(
      (entry) =>
        `Framework_Singleton "${entry.name}" declares directory "${entry.packageDir}", which is absent from the repository`,
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
  const absent = FRAMEWORK_SINGLETONS.filter(
    (entry) => !exists(entry.packageDir),
  );
  if (absent.length > 0) {
    throw missingFrameworkDirectoriesError(absent);
  }
}

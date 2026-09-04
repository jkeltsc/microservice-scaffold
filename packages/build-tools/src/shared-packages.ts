// Shared-package discovery and the Required_Shared_Packages closure (design
// "1. packages/build-tools/src/shared-packages.ts"; Requirements R1.1, R1.2,
// R1.3, R3.2, R3.3, R6.3, R6.4, R7.1, R7.3).
//
// A Shared_Package is a non-microservice workspace directly under `packages/`
// whose `package.json` declares an `@microservices`-scoped `name` with both
// `main` and `types` (the barrel contract from structure.md), and that is not
// the Overseer. Discovery is grounded entirely in each candidate's manifest —
// there is no second hand-maintained exclusion list that could drift from the
// emit script's list. Classification therefore excludes, by construction:
//
//   - the `packages/microservices/` namespace container (not @microservices-scoped),
//   - the Overseer (`@microservices/overseer`, explicitly),
//   - bin-only tooling such as `build-tools` (no `main`/`types` barrel), and
//   - test-only packages such as `integration-tests` (not @microservices-scoped).
//
// The logic is pure over injected inputs (a directory listing + a `readManifest`
// reader) so it is unit- and property-testable against in-memory layouts without
// touching the real filesystem. `discoverSharedPackages()` and
// `requiredSharedPackages()` supply real-filesystem defaults for production.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Workspace scope shared packages live under. */
const WORKSPACE_SCOPE = "@microservices";

/** The Overseer's package name, never a shared package. */
const OVERSEER_NAME = "@microservices/overseer";

/** The namespace-container directory, never itself a shared package. */
const MICROSERVICES_DIR = "microservices";

/**
 * The repo-relative directory shared packages live under. Used both to list
 * candidate directories and to build each candidate's repo-relative
 * `packageDir` — the single source for the `packages/` prefix so the listing
 * root and the emitted path can never drift.
 */
const PACKAGES_DIR = "packages";

/** A discovered shared package, keyed elsewhere by its package name. */
export interface SharedPackage {
  /** Declared package name, e.g. "@microservices/config". */
  readonly name: string;
  /** Directory name under packages/, e.g. "config". */
  readonly dirName: string;
  /** Relative package dir, e.g. "packages/config". */
  readonly packageDir: string;
  /** @microservices-scoped keys of this package's `dependencies`. */
  readonly sharedDependencies: readonly string[];
}

/**
 * The subset of a workspace `package.json` discovery reads. Every field is
 * optional so a malformed or unrelated manifest classifies cleanly as "not a
 * shared package" rather than throwing.
 */
export interface PackageManifest {
  readonly name?: string;
  readonly main?: string;
  readonly types?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** Read a workspace manifest given its package directory (e.g. "packages/config"). */
export type ReadManifest = (packageDir: string) => PackageManifest | undefined;

/** The `@microservices`-scoped keys of a manifest's `dependencies`, sorted. */
function scopedDependencies(manifest: PackageManifest): string[] {
  return Object.keys(manifest.dependencies ?? {})
    .filter((dep) => dep.startsWith(`${WORKSPACE_SCOPE}/`))
    .sort();
}

/**
 * Classify a single candidate directory. Returns the `SharedPackage` when the
 * candidate's manifest declares an `@microservices`-scoped `name` with both
 * `main` and `types` and is not the Overseer; otherwise `undefined`.
 *
 * The `packages/microservices/` namespace container is rejected by name before
 * its manifest is even consulted (it has none); everything else is decided by
 * the manifest, so bin-only tooling (no `main`/`types`) and non-scoped
 * test-only packages fall out without a name list.
 */
function classify(
  dirName: string,
  readManifest: ReadManifest,
): SharedPackage | undefined {
  if (dirName === MICROSERVICES_DIR) {
    return undefined;
  }

  const packageDir = `${PACKAGES_DIR}/${dirName}`;
  const manifest = readManifest(packageDir);
  if (manifest === undefined) {
    return undefined;
  }

  const { name, main, types } = manifest;
  if (
    name === undefined ||
    !name.startsWith(`${WORKSPACE_SCOPE}/`) ||
    name === OVERSEER_NAME ||
    main === undefined ||
    types === undefined
  ) {
    return undefined;
  }

  return {
    name,
    dirName,
    packageDir,
    sharedDependencies: scopedDependencies(manifest),
  };
}

/**
 * Discover shared packages from a top-level `packages/` directory listing and a
 * manifest reader. Pure over its inputs. Returns a map keyed by package name
 * ("@microservices/<name>").
 *
 * @param directories the direct subdirectory names of `packages/`.
 * @param readManifest reads a candidate's `package.json`; returns `undefined`
 *   when the candidate has no readable manifest.
 */
export function discoverSharedPackagesFrom(
  directories: readonly string[],
  readManifest: ReadManifest,
): Map<string, SharedPackage> {
  const shared = new Map<string, SharedPackage>();
  for (const dirName of directories) {
    const candidate = classify(dirName, readManifest);
    if (candidate !== undefined) {
      shared.set(candidate.name, candidate);
    }
  }
  return shared;
}

/**
 * List the direct subdirectory names of `packages/`, sorted lexicographically.
 */
function listPackageDirectories(packagesDir: string): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read a workspace manifest from disk; `undefined` when absent or unparsable. */
function readManifestFromDisk(packageDir: string): PackageManifest | undefined {
  try {
    return JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as PackageManifest;
  } catch {
    return undefined;
  }
}

/**
 * Discover shared packages under the real `packages/` directory. This is the
 * impure wrapper: it links the two filesystem I/O implementations —
 * {@link listPackageDirectories} (the directory listing) and
 * {@link readManifestFromDisk} (the manifest reader) — to the pure,
 * property-tested {@link discoverSharedPackagesFrom}, which carries the
 * classification logic. Tests exercise that pure core with in-memory fakes and
 * skip this wrapper, so keeping the disk access here is what keeps the logic
 * testable without touching the filesystem.
 */
export function discoverSharedPackages(): Map<string, SharedPackage> {
  return discoverSharedPackagesFrom(
    listPackageDirectories(PACKAGES_DIR),
    (packageDir) => readManifestFromDisk(packageDir),
  );
}

/** Read the `@microservices`-scoped `dependencies` keys of a workspace at `packageDir`. */
export type ReadDependencies = (packageDir: string) => readonly string[];

/**
 * The unresolvable-shared-dependency error (R6.4). Mirrors the selector
 * module's `[selector:unmatched]` message style: it names the consumer and the
 * deduplicated, sorted set of `@microservices` dependency names that resolve to
 * no discovered shared package. A plain `Error` — the message is the whole
 * contract, so nothing needs to `instanceof` a subclass.
 *
 * @param consumer the package whose manifest declares the dangling dep(s).
 * @param unresolved deduplicated and sorted by the caller.
 */
function unresolvedSharedDependencyError(
  consumer: string,
  unresolved: readonly string[],
): Error {
  const named = unresolved.map((name) => `"${name}"`).join(", ");
  return new Error(
    `[shared:unresolved] "${consumer}" depends on unknown @microservices package(s): ${named}`,
  );
}

/**
 * The transitive `@microservices` dependency closure of the selected
 * microservices plus the Overseer, restricted to discovered shared packages,
 * returned in topological order — every package precedes its dependents.
 *
 * The roots are the consumers: each selected microservice
 * (`packages/microservices/<id>`) and the Overseer (`packages/overseer`). Their
 * `@microservices`-scoped dependency names are read through the injected
 * {@link ReadDependencies} reader; each such name MUST resolve to a discovered
 * shared package, otherwise the dependency is dangling and the build fails
 * (R6.4). A shared package's own `sharedDependencies` (from discovery) are
 * followed the same way, so `config → contracts` and `overseer → contracts`
 * edges pull `contracts` into the closure for every selector.
 *
 * A depth-first post-order emits each package only after all its dependencies,
 * which is a topological order for the acyclic shared-package graph (R6.3,
 * R7.3). A `visited` set makes the walk total: a malformed cycle terminates
 * instead of looping.
 *
 * @param selectedIdentifiers the selected microservice directory names.
 * @param shared the discovered shared packages keyed by `@microservices/<name>`.
 * @param readDependencies reads the `@microservices`-scoped `dependencies` keys
 *   of a workspace given its package dir (used for the microservice and Overseer
 *   roots; shared-package edges come from {@link SharedPackage.sharedDependencies}).
 * @throws {@link unresolvedSharedDependencyError} when a consumer declares an
 *   `@microservices` dependency that resolves to no discovered shared package.
 */
export function requiredSharedPackages(
  selectedIdentifiers: readonly string[],
  shared: ReadonlyMap<string, SharedPackage>,
  readDependencies: ReadDependencies,
): SharedPackage[] {
  const ordered: SharedPackage[] = [];
  const visited = new Set<string>();

  /**
   * Resolve a consumer's declared `@microservices` dependency names against the
   * discovered shared map, throwing when any is dangling. `consumer` names the
   * declaring package for the error message.
   */
  const resolveDependencies = (
    consumer: string,
    dependencyNames: readonly string[],
  ): SharedPackage[] => {
    const resolved: SharedPackage[] = [];
    const unresolved: string[] = [];
    for (const name of dependencyNames) {
      const pkg = shared.get(name);
      if (pkg === undefined) {
        unresolved.push(name);
      } else {
        resolved.push(pkg);
      }
    }
    if (unresolved.length > 0) {
      throw unresolvedSharedDependencyError(
        consumer,
        [...new Set(unresolved)].sort(),
      );
    }
    return resolved;
  };

  /**
   * Post-order visit of a discovered shared package: emit its dependencies
   * first (so they precede it), then the package itself, guarded by `visited`
   * so each package is emitted once and a cycle terminates.
   */
  const visit = (pkg: SharedPackage): void => {
    if (visited.has(pkg.name)) {
      return;
    }
    visited.add(pkg.name);
    for (const dep of resolveDependencies(pkg.name, pkg.sharedDependencies)) {
      visit(dep);
    }
    ordered.push(pkg);
  };

  // Roots: every selected microservice, then the Overseer. Their @microservices
  // deps are read from disk (via the injected reader) and must all resolve.
  const roots: readonly string[] = [
    ...selectedIdentifiers.map((id) => `packages/microservices/${id}`),
    "packages/overseer",
  ];

  for (const packageDir of roots) {
    for (const dep of resolveDependencies(
      packageDir,
      readDependencies(packageDir),
    )) {
      visit(dep);
    }
  }

  return ordered;
}

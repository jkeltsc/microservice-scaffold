// This module finds every package a user of the template has written, and holds
// each one to the rules of its category.
//
// It is step 2 of the build pipeline, and every entry path starts with it:
// image-tree.ts, build-plan.ts, dev-supervisor.ts, workspace-build-order.ts, and
// repo-invariants.ts all call `discoverPackages()` first.
//
// Membership is decided by location alone: a package belongs to the microservice,
// common, or spa category because it is a direct subdirectory of that category's
// parent directory under `packages/`. No manifest field takes part (R1.3, R1.5,
// R2.8, R2.9). Manifests are read afterwards, and a package that breaks its
// category's contract fails the build instead of dropping out of the set.
//
// The scaffold's own packages sit directly under `packages/`, so this never
// reaches them (R1.6, R5.2); their names, the category directories, and the
// workspace scope all come from framework.ts (R10.4, R10.5).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "./framework.js";

/** How a package's build output is produced (R6.1, R6.2). */
export type BuildKind = "tsc-project" | "bundler-project";

/** A discovered Consumer_Package: one a user of the template wrote. */
export interface ConsumerPackage {
  readonly category: ConsumerCategory;
  /** Directory name inside its category's parent directory, e.g. "config". */
  readonly dirName: string;
  /** Repo-relative package directory, e.g. "packages/common/config". */
  readonly packageDir: string;
  /** The exact `name` its own package.json declares (R3.1). */
  readonly name: string;
  /** `@microservices`-scoped `dependencies` keys, sorted (R3.10). */
  readonly dependencySpecifiers: readonly string[];
  /** Derived from `category` alone (R6.1, R6.2). */
  readonly buildKind: BuildKind;
}

/** The result of one discovery run. */
export interface Discovery {
  /** Members of each category, ordered by ascending code point of dirName (R2.5). */
  readonly byCategory: Readonly<
    Record<ConsumerCategory, readonly ConsumerPackage[]>
  >;
  /** Declared name of each package, keyed by package directory (R3.1). */
  readonly nameByDir: ReadonlyMap<string, string>;
  /** Declared name -> package, what a specifier resolves against (R3.2, R3.3);
   *  injective, because stage 4 rejects a duplicate (R3.9). */
  readonly byName: ReadonlyMap<string, ConsumerPackage>;
}

/** One direct entry of a category's parent directory, as the lister reports it. */
export interface ContainerEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/** Lists the direct entries of a category's parent directory. `undefined` means
 *  absent: tolerated for `common` and `spa` (R2.6), fatal for the other (R2.7). */
export type ListContainer = (
  containerDir: string,
) => readonly ContainerEntry[] | undefined;

/** The outcome of reading one manifest. The three failures stay apart because
 *  R3.4 wants the error to say which occurred. */
export type ManifestRead =
  | { readonly kind: "ok"; readonly manifest: PackageManifest }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unparsable" };

/** The manifest fields discovery reads. None of them decides membership. */
export interface PackageManifest {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly types?: unknown;
  readonly scripts?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

export type ReadManifest = (packageDir: string) => ManifestRead;

/** The one category whose parent directory must exist (R2.7). */
const REQUIRED_CONTAINER_CATEGORY: ConsumerCategory = "microservice";

/** How each category names itself in a validation failure. */
const CATEGORY_LABEL: Readonly<Record<ConsumerCategory, string>> = {
  microservice: "Microservice_Package",
  common: "Common_Package",
  spa: "Spa_Package",
};

/** Maps a category to its build kind, reading no manifest (R6.1, R6.2). */
export function buildKindOf(category: ConsumerCategory): BuildKind {
  return category === "spa" ? "bundler-project" : "tsc-project";
}

/** A directory member, before its manifest has been read. */
interface Candidate {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  readonly packageDir: string;
}

/** A candidate whose manifest was read successfully (stage 1 passed). */
interface ManifestedCandidate extends Candidate {
  readonly manifest: PackageManifest;
}

/** A candidate with a usable declared name (stage 2 passed). */
interface NamedCandidate extends ManifestedCandidate {
  /** The declared `name`, byte-exact: no trimming or case folding (R3.1). */
  readonly name: string;
}

/**
 * Formats one validation failure: a bracketed tag, a headline counting the
 * offenders, then one indented line each. Every stage below reports through this
 * one shape, so a run says as much as it can and repeats byte-identically (R4.7).
 *
 * @param lines one line per offender, already sorted by the caller.
 */
function offenderError(
  prefix: string,
  headline: string,
  lines: readonly string[],
): Error {
  return new Error(
    `[${prefix}] ${headline}\n${lines.map((line) => `  ${line}`).join("\n")}`,
  );
}

/** Compares two candidates by `packageDir`, the tiebreak-free stage ordering. */
function byPackageDir(a: Candidate, b: Candidate): number {
  return a.packageDir < b.packageDir ? -1 : a.packageDir > b.packageDir ? 1 : 0;
}

/** Says whether a manifest value is a declared, non-empty string: `name` (R3.5),
 *  `main`/`types` (R4.1), `scripts.build` (R4.3). Whitespace-only counts as
 *  empty, so `" "` fails rather than passing as a path or a command. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Collects a manifest's `@microservices`-scoped `dependencies` keys, sorted;
 *  other keys are ignored uninspected (R3.10). A manifest is arbitrary parsed
 *  JSON, so a non-object `dependencies` yields nothing rather than throwing. */
function scopedDependencySpecifiers(manifest: PackageManifest): string[] {
  const dependencies: unknown = manifest.dependencies;
  if (dependencies === null || typeof dependencies !== "object") {
    return [];
  }
  return Object.keys(dependencies)
    .filter((key) => key.startsWith(`${WORKSPACE_SCOPE}/`))
    .sort();
}

/**
 * Filters the entries of one category's parent directory down to the
 * subdirectories that count as packages. Called once per category from
 * `discoverPackagesFrom`'s loop, before any manifest is read.
 *
 * An entry counts when it resolves to a directory and its name does not start
 * with `.` (R2.4); everything else, files included, is ignored, and ignoring it
 * is not an error (R1.10, R9.8). Only *direct* entries are listed, so anything
 * deeper stays private content of the package above it (R1.4, R9.6). Survivors
 * sort by directory name, so two runs over an unchanged tree agree (R2.5).
 *
 * @throws `[discovery:container-missing]` when `packages/microservices` is absent
 *   (R2.7); an absent `common` or `spa` yields no candidates instead (R2.6).
 */
function candidatesOf(
  category: ConsumerCategory,
  listContainer: ListContainer,
): Candidate[] {
  const containerDir = NAMESPACE_CONTAINER[category];
  const entries = listContainer(containerDir);
  if (entries === undefined) {
    if (category === REQUIRED_CONTAINER_CATEGORY) {
      throw new Error(
        `[discovery:container-missing] no such Microservice_Namespace: "${containerDir}"`,
      );
    }
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
    .map((entry) => ({
      category,
      dirName: entry.name,
      packageDir: `${containerDir}/${entry.name}`,
    }))
    .sort((a, b) =>
      a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0,
    );
}

/** Validation stage 1 — checks every discovered package has a readable,
 *  parseable `package.json`, naming the condition that failed (R3.4). */
function readManifests(
  candidates: readonly Candidate[],
  readManifest: ReadManifest,
): ManifestedCandidate[] {
  const manifested: ManifestedCandidate[] = [];
  const offenders: { candidate: Candidate; condition: string }[] = [];

  for (const candidate of candidates) {
    const read = readManifest(candidate.packageDir);
    switch (read.kind) {
      case "ok":
        manifested.push({ ...candidate, manifest: read.manifest });
        break;
      case "absent":
        offenders.push({ candidate, condition: "package.json is absent" });
        break;
      case "unreadable":
        offenders.push({ candidate, condition: "package.json is unreadable" });
        break;
      case "unparsable":
        offenders.push({
          candidate,
          condition: "package.json is not parseable as JSON",
        });
        break;
    }
  }

  if (offenders.length > 0) {
    offenders.sort((a, b) => byPackageDir(a.candidate, b.candidate));
    throw offenderError(
      "discovery:manifest",
      `cannot read the package.json of ${String(offenders.length)} discovered package(s):`,
      offenders.map(
        ({ candidate, condition }) =>
          `"${candidate.packageDir}" — ${condition}`,
      ),
    );
  }

  return manifested;
}

/** Validation stage 2 — checks every discovered package declares a usable `name`
 *  and records it byte for byte; missing, non-string, and blank fail (R3.5). */
function readDeclaredNames(
  candidates: readonly ManifestedCandidate[],
): NamedCandidate[] {
  const named: NamedCandidate[] = [];
  const offenders: ManifestedCandidate[] = [];

  for (const candidate of candidates) {
    const declared: unknown = candidate.manifest.name;
    if (isNonEmptyString(declared)) {
      named.push({ ...candidate, name: declared });
    } else {
      offenders.push(candidate);
    }
  }

  if (offenders.length > 0) {
    offenders.sort(byPackageDir);
    throw offenderError(
      "discovery:name",
      `${String(offenders.length)} discovered package(s) declare no usable "name":`,
      offenders.map(
        (candidate) =>
          `"${candidate.packageDir}" — the declared name is missing or empty`,
      ),
    );
  }

  return named;
}

/**
 * Validation stage 3 — checks every discovered package's declared name mirrors
 * its directory: exactly `@microservices/` plus the directory name, character for
 * character (R3.6).
 *
 * Microservices are checked too: the directory name is the identifier, so a
 * divergent declared name is a build that cannot resolve — npm links one name
 * while the registry and the assembler use the other. It is also what stops a
 * package claiming a framework name (R1.6, R5.2).
 */
function assertNamesMirrorDirectories(
  candidates: readonly NamedCandidate[],
): void {
  const offenders = candidates
    .filter(
      (candidate) =>
        candidate.name !== `${WORKSPACE_SCOPE}/${candidate.dirName}`,
    )
    .sort(byPackageDir);

  if (offenders.length > 0) {
    throw offenderError(
      "discovery:mirror",
      `${String(offenders.length)} discovered package(s) declare a name that does not mirror the directory:`,
      offenders.map(
        (candidate) =>
          `"${candidate.packageDir}" — declared "${candidate.name}", expected "${WORKSPACE_SCOPE}/${candidate.dirName}"`,
      ),
    );
  }
}

/**
 * Validation stage 4 — checks no package name is declared twice, which is what
 * makes `byName` injective and so usable as an index (R3.9).
 *
 * The claim map is seeded with the framework names, so a package claiming one
 * collides with that directory instead of shadowing it (R1.6, R2.10, R5.2).
 */
function assertNamesUnique(candidates: readonly NamedCandidate[]): void {
  const dirsByName = new Map<string, string[]>();
  const claim = (name: string, packageDir: string): void => {
    const dirs = dirsByName.get(name);
    if (dirs === undefined) {
      dirsByName.set(name, [packageDir]);
    } else {
      dirs.push(packageDir);
    }
  };

  for (const singleton of FRAMEWORK_SINGLETONS) {
    claim(singleton.name, singleton.packageDir);
  }
  for (const candidate of candidates) {
    claim(candidate.name, candidate.packageDir);
  }

  const duplicated = [...dirsByName.entries()]
    .filter(([, dirs]) => dirs.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (duplicated.length > 0) {
    throw offenderError(
      "discovery:duplicate",
      `${String(duplicated.length)} package name(s) are declared by more than one package:`,
      duplicated.map(
        ([name, dirs]) =>
          `"${name}" — ${[...dirs]
            .sort()
            .map((dir) => `"${dir}"`)
            .join(", ")}`,
      ),
    );
  }
}

/**
 * Reports what one candidate is missing from its category's contract, or
 * `undefined` when it satisfies it.
 *
 * A common package's barrel is its whole public API, so `main` and `types` must
 * both be non-empty (R4.1). A spa package is built by its own bundler, so it owes
 * `scripts.build` and no barrel instead (R4.2, R4.3); a microservice owes neither
 * (R4.5), with no per-package override (R4.4).
 */
function contractViolation(candidate: NamedCandidate): string | undefined {
  if (candidate.category === "common") {
    const missing = (["main", "types"] as const).filter(
      (field) => !isNonEmptyString(candidate.manifest[field]),
    );
    return missing.length > 0
      ? `${CATEGORY_LABEL.common} is missing ${missing.map((field) => `"${field}"`).join(", ")}`
      : undefined;
  }

  if (candidate.category === "spa") {
    return isNonEmptyString(candidate.manifest.scripts?.build)
      ? undefined
      : `${CATEGORY_LABEL.spa} is missing a non-empty "scripts.build"`;
  }

  return undefined;
}

/**
 * Validation stage 5 — checks every discovered package satisfies its category's
 * manifest contract, as {@link contractViolation} defines it. Missing barrels and
 * missing build scripts share one failure, because R4.7 wants them in one.
 * Offenders sort by directory name, `packageDir` as tiebreak.
 */
function assertCategoryContracts(candidates: readonly NamedCandidate[]): void {
  const offenders = candidates
    .flatMap((candidate) => {
      const violation = contractViolation(candidate);
      return violation === undefined ? [] : [{ candidate, violation }];
    })
    .sort(
      (a, b) =>
        (a.candidate.dirName < b.candidate.dirName
          ? -1
          : a.candidate.dirName > b.candidate.dirName
            ? 1
            : 0) || byPackageDir(a.candidate, b.candidate),
    );

  if (offenders.length > 0) {
    throw offenderError(
      "barrel:invalid",
      `${String(offenders.length)} discovered package(s) do not satisfy their category's manifest contract:`,
      offenders.map(
        ({ candidate, violation }) =>
          `"${candidate.packageDir}" — ${violation}`,
      ),
    );
  }
}

/**
 * Runs all of step 2: finds every consumer-written package by location, records
 * its declared name, and validates its category's contract.
 *
 * Pure over its two injected readers, which is what makes it property-testable
 * against in-memory layouts; {@link discoverPackages} is the filesystem caller.
 * The five stages run in a fixed order — manifest, name, mirror, duplicate,
 * contract — each collecting every offender before it fails, and nothing
 * downstream is emitted until all five pass (R4.8).
 *
 * @param listContainer lists one category directory's direct entries.
 * @param readManifest reads one package's manifest.
 * @throws `[discovery:container-missing]` when `packages/microservices` is absent (R2.7).
 * @throws `[discovery:manifest]` for absent/unreadable/unparsable manifests (R3.4).
 * @throws `[discovery:name]` for a missing, non-string, or blank `name` (R3.5).
 * @throws `[discovery:mirror]` when a declared name does not mirror its directory (R3.6).
 * @throws `[discovery:duplicate]` when two packages declare the same name (R3.9).
 * @throws `[barrel:invalid]` for a missing barrel or build script (R4.1, R4.3, R4.7).
 */
export function discoverPackagesFrom(
  listContainer: ListContainer,
  readManifest: ReadManifest,
): Discovery {
  // Enumerate all three categories before validating any of them, so the stages
  // see every offender in the repository, not just the first category's.
  const candidates = CONSUMER_CATEGORIES.flatMap((category) =>
    candidatesOf(category, listContainer),
  );

  const named = readDeclaredNames(readManifests(candidates, readManifest));
  assertNamesMirrorDirectories(named);
  assertNamesUnique(named);
  assertCategoryContracts(named);

  const packages: ConsumerPackage[] = named.map((candidate) => ({
    category: candidate.category,
    dirName: candidate.dirName,
    packageDir: candidate.packageDir,
    name: candidate.name,
    dependencySpecifiers: scopedDependencySpecifiers(candidate.manifest),
    buildKind: buildKindOf(candidate.category),
  }));

  // Group by iterating the categories rather than naming the three here, so every
  // category gets an entry — an absent or empty directory yields an empty array,
  // never a missing key (R2.6) — which is what makes the cast below sound.
  const grouped: Partial<Record<ConsumerCategory, readonly ConsumerPackage[]>> =
    {};
  for (const category of CONSUMER_CATEGORIES) {
    grouped[category] = packages.filter((pkg) => pkg.category === category);
  }
  const byCategory = grouped as Record<
    ConsumerCategory,
    readonly ConsumerPackage[]
  >;

  return {
    byCategory,
    nameByDir: new Map(packages.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
  };
}

/** Says whether a filesystem error means "this path does not exist". */
function isAbsent(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Lists a category directory's direct entries from the real filesystem.
 *  `undefined` means absent; any other failure propagates. A symlink is resolved
 *  first, since R2.4 asks what an entry resolves to. */
function listContainerFromDisk(
  containerDir: string,
): readonly ContainerEntry[] | undefined {
  let entries;
  try {
    entries = readdirSync(containerDir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) {
      return undefined;
    }
    throw error;
  }

  return entries.map((entry) => ({
    name: entry.name,
    isDirectory:
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        resolvesToDirectory(join(containerDir, entry.name))),
  }));
}

/** Says whether `path`, following symlinks, is a directory; false when broken. */
function resolvesToDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Reads one package's manifest from the real filesystem. JSON that parses to
 *  something other than an object counts as unparsable: it is not a manifest. */
function readManifestFromDisk(packageDir: string): ManifestRead {
  let text: string;
  try {
    text = readFileSync(join(packageDir, "package.json"), "utf8");
  } catch (error) {
    return isAbsent(error) ? { kind: "absent" } : { kind: "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unparsable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unparsable" };
  }
  return { kind: "ok", manifest: parsed as PackageManifest };
}

/**
 * Runs discovery against the real filesystem. This is the entry point every other
 * module calls; it only wires the two filesystem readers into
 * {@link discoverPackagesFrom}, which holds the logic.
 */
export function discoverPackages(): Discovery {
  return discoverPackagesFrom(listContainerFromDisk, readManifestFromDisk);
}

/**
 * Reads the `@microservices`-scoped `dependencies` keys of any workspace package,
 * sorted. Other keys are ignored without resolution and without failing (R3.10).
 *
 * THE single dependency reader of the Build_System: required-dependencies.ts,
 * the dev path, the workspace order, and the invariant check all reach manifests
 * through it, so no two paths read dependencies differently. An absent or
 * unparsable manifest yields an empty list — a leniency discovered packages never
 * meet, since their specifiers come from `ConsumerPackage.dependencySpecifiers`.
 */
export function readDependencySpecifiers(
  packageDir: string,
): readonly string[] {
  const read = readManifestFromDisk(packageDir);
  return read.kind === "ok" ? scopedDependencySpecifiers(read.manifest) : [];
}

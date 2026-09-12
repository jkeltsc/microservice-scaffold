// Step 5 of the build pipeline: works out which packages a build needs.
//
// Returns two sets. The BUILD set is everything that must compile; the STAGE set
// is the narrower list that ships inside an image. Step 6 (`build-plan.ts`) turns
// them into the `tsc` roots, the SPA builds, and the staging list.
//
// Which microservices a build includes comes from the `MICROSERVICES` value —
// `*` for all, or a comma-separated list.
//
// Three phases produce the sets. `reachableSubgraph` collects the graph and
// detects cycles, `topologicalOrder` orders the build set, `stagedSubset`
// narrows it to what ships.
//
// Either set holds discovered Consumer_Packages only, reached through
// `@microservices`-scoped Dependency_Specifiers; the roots and every
// Framework_Singleton are excluded (R7.1). Both come back in the
// lexicographically-least topological order — dependency before dependent,
// packages unrelated by dependency in directory-name order — so repeated runs
// are identical element for element (R7.2).
//
// Pure over its injected `readDependencies` reader and the `Discovery` it is
// handed. The real-filesystem wiring lives in `build-plan.ts`.
//
// (design "Components and Interfaces / 3. required-dependencies.ts"; R3.2, R3.3,
// R3.7, R3.8, R3.10, R5.3, R5.7, R6.14, R7.1, R7.2, R7.10, R7.12–R7.14, R8.13,
// R9.11, R13.11, R14.5.)

import type { ConsumerCategory } from "./framework.js";
import type { ConsumerPackage, Discovery } from "./discovery.js";
import {
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
  frameworkSingletonByName,
} from "./framework.js";
import {
  compareCodePoints,
  findCyclePath,
  leastTopologicalOrder,
} from "./topological-order.js";

/** Read the `@microservices`-scoped `dependencies` keys of a package dir. */
export type ReadDependencies = (packageDir: string) => readonly string[];

/**
 * Fails the resolve when a package depends on an `@microservices` package that
 * no discovered package declares (R3.8).
 *
 * The message is an operator-facing contract pinned byte for byte by R13.11: keep
 * the `[shared:` prefix and the wording, though every other failure uses `[deps:`.
 *
 * @param consumer repo-relative directory of the declaring package.
 * @param unresolved deduplicated and sorted by the caller.
 */
function unresolvedSpecifierError(
  consumer: string,
  unresolved: readonly string[],
): Error {
  const named = unresolved.map((name) => `"${name}"`).join(", ");
  return new Error(
    `[shared:unresolved] "${consumer}" depends on unknown ${WORKSPACE_SCOPE} package(s): ${named}`,
  );
}

/**
 * Fails the resolve when any package depends on a microservice (R7.1, R7.12,
 * R14.5). A Microservice_Package is never a dependency target, so one error
 * covers every kind of declarer and the message attributes no category to it.
 *
 * @param consumer repo-relative directory of the declaring package, any category.
 * @param specifier the specifier resolving to a Microservice_Package.
 */
function peerDependencyError(consumer: string, specifier: string): Error {
  return new Error(
    `[deps:peer] "${consumer}" depends on Microservice_Package "${specifier}"; a Microservice_Package is never a dependency target`,
  );
}

/**
 * Fails the resolve when a Common_Package depends on a Spa_Package (R8.13). A
 * Common_Package points downward only, and a Spa_Package is downward of nothing.
 *
 * @param consumer repo-relative directory of the declaring Common_Package.
 * @param specifier the specifier resolving to a Spa_Package.
 */
function commonToSpaError(consumer: string, specifier: string): Error {
  return new Error(
    `[deps:common-to-spa] Common_Package "${consumer}" depends on Spa_Package "${specifier}"; a Common_Package must point downward only and a Spa_Package exposes no importable API`,
  );
}

/**
 * Fails the resolve when one Spa_Package depends on another (R9.11). The message
 * names both directories and states the remedy, which is the point of it.
 *
 * @param consumer repo-relative directory of the declaring Spa_Package.
 * @param target repo-relative directory of the depended-on Spa_Package.
 */
function spaToSpaError(consumer: string, target: string): Error {
  return new Error(
    `[deps:spa-to-spa] Spa_Package "${consumer}" depends on Spa_Package "${target}"; code shared between two Spa_Packages belongs in a Common_Package that each of them declares a dependency on`,
  );
}

/**
 * Fails the resolve when the dependency graph contains a cycle, naming every
 * participant in cycle order (R7.10). The path is closed by its entry point:
 * `"a" -> "a"` for a self-dependency, `"a" -> "b" -> "a"` for a pair.
 *
 * @param participants the cycle in traversal order, closed by its entry point.
 */
function cycleError(participants: readonly string[]): Error {
  const path = participants.map((name) => `"${name}"`).join(" -> ");
  return new Error(
    `[deps:cycle] the ${WORKSPACE_SCOPE} dependency graph contains a cycle: ${path}`,
  );
}

/**
 * Orders two packages by directory name. Phase 2 uses this for packages that have
 * no dependency relation to each other (R7.2). The directory tiebreak only keeps
 * the comparator total; discovery's name-uniqueness stage makes it unreachable.
 */
function byDirName(a: ConsumerPackage, b: ConsumerPackage): number {
  return (
    compareCodePoints(a.dirName, b.dirName) ||
    compareCodePoints(a.packageDir, b.packageDir)
  );
}

/**
 * Lists the directories the walk starts from: each microservice this build
 * includes, in the order `selector.ts` resolved them, then the Overseer. These
 * are consumers only — none is itself a required dependency (R7.1); both
 * prefixes come from `framework.ts` (R10.5).
 */
function rootDirectories(selected: readonly string[]): readonly string[] {
  return [
    ...selected.map((id) => `${NAMESPACE_CONTAINER.microservice}/${id}`),
    OVERSEER.packageDir,
  ];
}

/**
 * Resolves one package's Dependency_Specifiers to the packages they name. Edges
 * the design forbids are rejected here. Called once per root and once per member
 * phase 1 visits.
 *
 * Per specifier:
 *
 *   1. a Framework_Singleton name -> resolved, not followed, never a required
 *      dependency (R3.7, R5.3, R5.7);
 *   2. a recorded declared name -> that discovered Consumer_Package, matched
 *      character for character, with no prefix, alias, version-range, or path
 *      matching (R3.2, R3.3);
 *   3. anything else -> unresolved (R3.8).
 *
 * Forbidden edges turn on the DECLARER's category: none may name a
 * Microservice_Package (R7.12, R14.5), a Common_Package may not name a Spa_Package
 * (R8.13), a Spa_Package not another (R9.11). `microservice -> spa` and
 * `overseer -> spa` are fine — phase 3 decides whether the Spa_Package ships.
 * Specifiers outside the `@microservices` scope are ignored (R3.10).
 *
 * Offenders are accumulated and sorted before anything throws, so one run names
 * every dangling specifier and is order-independent. Dangling is reported ahead of
 * forbidden (R13.11).
 *
 * @param declaringCategory selects between the two inbound-SPA rules; roots pass
 *   `"microservice"`, which forbids neither.
 * @param declaringDir repo-relative directory of the declaring package, named by
 *   every failure (R3.8).
 * @throws `[shared:unresolved]`, `[deps:peer]`, `[deps:common-to-spa]`,
 *   `[deps:spa-to-spa]`.
 */
function resolveSpecifiers(
  declaringCategory: ConsumerCategory,
  declaringDir: string,
  specifiers: readonly string[],
  discovery: Discovery,
): ConsumerPackage[] {
  const resolved: ConsumerPackage[] = [];
  const unresolved: string[] = [];
  const peers: string[] = [];
  const commonToSpa: string[] = [];
  const spaToSpa: ConsumerPackage[] = [];

  for (const specifier of specifiers) {
    if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) {
      continue;
    }
    if (frameworkSingletonByName(specifier) !== undefined) {
      continue;
    }

    const pkg = discovery.byName.get(specifier);
    if (pkg === undefined) {
      unresolved.push(specifier);
    } else if (pkg.category === "microservice") {
      peers.push(specifier);
    } else if (pkg.category === "spa" && declaringCategory === "common") {
      commonToSpa.push(specifier);
    } else if (pkg.category === "spa" && declaringCategory === "spa") {
      spaToSpa.push(pkg);
    } else {
      resolved.push(pkg);
    }
  }

  if (unresolved.length > 0) {
    throw unresolvedSpecifierError(
      declaringDir,
      [...new Set(unresolved)].sort(),
    );
  }
  if (peers.length > 0) {
    throw peerDependencyError(declaringDir, [...peers].sort()[0]);
  }
  if (commonToSpa.length > 0) {
    throw commonToSpaError(declaringDir, [...commonToSpa].sort()[0]);
  }
  if (spaToSpa.length > 0) {
    const target = [...spaToSpa].sort((a, b) =>
      compareCodePoints(a.packageDir, b.packageDir),
    )[0];
    throw spaToSpaError(declaringDir, target.packageDir);
  }

  return resolved;
}

/** Phase 1's output: the reachable part of the dependency graph. */
interface Subgraph {
  /** Every reachable Consumer_Package, keyed by its declared name. */
  readonly members: ReadonlyMap<string, ConsumerPackage>;
  /** Each member's deduplicated member dependencies, keyed by declared name. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /**
   * The members a root resolves DIRECTLY, deduplicated — phase 3's seed (R7.14),
   * recorded here because phase 1 resolves the roots' specifiers anyway.
   */
  readonly rootReached: readonly string[];
}

/**
 * Phase 1 — collects the reachable part of the dependency graph and its edges,
 * walking out from the microservices this build includes plus the Overseer, and
 * fails on a cycle. Every failure of the resolve is raised here; phases 2 and 3
 * cannot fail.
 *
 * Re-entering a `grey` (in-progress) package proves a cycle; `greyNodes` keeps
 * enough of the graph to name its participants in cycle order (R7.10).
 *
 * @throws `[shared:unresolved]`, `[deps:peer]`, `[deps:common-to-spa]`,
 *   `[deps:spa-to-spa]`, `[deps:cycle]`.
 */
function reachableSubgraph(
  selected: readonly string[],
  discovery: Discovery,
  readDependencies: ReadDependencies,
): Subgraph {
  const members = new Map<string, ConsumerPackage>();
  const dependencies = new Map<string, readonly string[]>();
  const rootReached = new Set<string>();
  const grey = new Set<string>();
  const black = new Set<string>();
  const greyNodes = new Map<string, ConsumerPackage>();

  const visit = (pkg: ConsumerPackage): void => {
    if (black.has(pkg.name)) {
      return;
    }
    if (grey.has(pkg.name)) {
      // Each grey node has its edges recorded before the recursion below, so the
      // shared `findCyclePath` can walk the live grey subgraph to name the cycle.
      const cyclic = [...greyNodes.values()];
      const participants =
        findCyclePath(
          cyclic,
          (node) => node.name,
          (node) => dependencies.get(node.name) ?? [],
        ) ?? [];
      throw cycleError(participants);
    }

    grey.add(pkg.name);
    greyNodes.set(pkg.name, pkg);

    const deps = resolveSpecifiers(
      pkg.category,
      pkg.packageDir,
      pkg.dependencySpecifiers,
      discovery,
    );
    dependencies.set(pkg.name, [...new Set(deps.map((dep) => dep.name))]);
    for (const dep of deps) {
      visit(dep);
    }

    grey.delete(pkg.name);
    greyNodes.delete(pkg.name);
    black.add(pkg.name);
    members.set(pkg.name, pkg);
  };

  for (const packageDir of rootDirectories(selected)) {
    // A root is a microservice or the Overseer, so neither inbound-SPA rule can
    // apply to it; `"microservice"` is the branch that forbids neither.
    const roots = resolveSpecifiers(
      "microservice",
      packageDir,
      readDependencies(packageDir),
      discovery,
    );
    for (const dep of roots) {
      rootReached.add(dep.name);
      visit(dep);
    }
  }

  return { members, dependencies, rootReached: [...rootReached] };
}

/**
 * Phase 2 — puts the build set into its final order: dependency before dependent,
 * packages unrelated by dependency in directory-name order (R7.2). Exactly one
 * order satisfies both, so it is identical across runs by construction. The Kahn
 * pass is the shared `leastTopologicalOrder`; this module supplies the domain.
 * Phase 1 has already failed on any cycle, so no member is ever stuck.
 */
function topologicalOrder(subgraph: Subgraph): readonly ConsumerPackage[] {
  const { members, dependencies } = subgraph;

  return leastTopologicalOrder(
    [...members.values()],
    (pkg) => pkg.name,
    (pkg) => dependencies.get(pkg.name) ?? [],
    byDirName,
  );
}

/**
 * Returns just the build set, in dependency order. That is the
 * Required_Dependencies in the lexicographically-least topological order (R7.1,
 * R7.2), for callers that do not need the stage set as well.
 *
 * @param selected the microservices this build includes.
 * @param discovery the discovery result; supplies members and the name index.
 * @param readDependencies reads the roots' specifiers; member edges come from
 *   discovery.
 * @throws `[shared:unresolved]`, `[deps:peer]`, `[deps:common-to-spa]`,
 *   `[deps:spa-to-spa]`, `[deps:cycle]`.
 */
export function requiredDependencies(
  selected: readonly string[],
  discovery: Discovery,
  readDependencies: ReadDependencies,
): readonly ConsumerPackage[] {
  return resolveDependencySets(selected, discovery, readDependencies).required;
}

/**
 * Phase 3 — narrows the build set to the Staged_Dependencies, the packages that
 * ship inside an image (R6.14, R7.13, R7.14). It re-walks the subgraph phase 1
 * already collected: no further manifest read, no I/O, no new failure mode.
 *
 * Seeded from `subgraph.rootReached`, it expands a member's edges only when that
 * member's category is not `"spa"`. A Spa_Package is arrived at and included but
 * never expanded, so a package reachable ONLY by way of a Spa_Package is left out
 * — its code is inlined into that self-contained bundle, where no runtime process
 * can reach it — while one also reachable through a non-SPA path stays in.
 *
 * The result is `required` filtered to the reached names, so it is a subsequence
 * of it and inherits its order with no second sort (R7.2, R7.13).
 *
 * @param subgraph phase 1's output, including `rootReached`.
 * @param required phase 2's output, which fixes the returned order.
 */
function stagedSubset(
  subgraph: Subgraph,
  required: readonly ConsumerPackage[],
): readonly ConsumerPackage[] {
  const { members, dependencies, rootReached } = subgraph;
  const reached = new Set<string>();
  const queue = [...rootReached];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (reached.has(name)) {
      continue;
    }
    reached.add(name);

    const member = members.get(name);
    if (member !== undefined && member.category !== "spa") {
      for (const dep of dependencies.get(name) ?? []) {
        if (!reached.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  return required.filter((pkg) => reached.has(pkg.name));
}

/**
 * The pair the rest of the Build_System consumes. Two sets, because "what is
 * built" and "what ships" are different questions.
 */
export interface DependencySets {
  /** The BUILD set: every reachable discovered Consumer_Package (R7.1, R7.2). */
  readonly required: readonly ConsumerPackage[];
  /**
   * The STAGE set: the subset reached without expanding a Spa_Package (R7.14).
   * A subsequence of `required`, so `staged ⊆ required` holds structurally (R7.13).
   */
  readonly staged: readonly ConsumerPackage[];
}

/**
 * Runs all three phases and returns both sets — the entry point `build-plan.ts`
 * calls. Every failure below is raised in phase 1 ({@link reachableSubgraph}).
 *
 * @param selected the microservices this build includes.
 * @param discovery the discovery result; supplies members and the name index.
 * @param readDependencies reads the root consumers' specifiers.
 * @throws `[shared:unresolved]`, `[deps:peer]`, `[deps:common-to-spa]`,
 *   `[deps:spa-to-spa]`, `[deps:cycle]`.
 */
export function resolveDependencySets(
  selected: readonly string[],
  discovery: Discovery,
  readDependencies: ReadDependencies,
): DependencySets {
  const subgraph = reachableSubgraph(selected, discovery, readDependencies);
  const required = topologicalOrder(subgraph);
  const staged = stagedSubset(subgraph, required);
  return { required, staged };
}

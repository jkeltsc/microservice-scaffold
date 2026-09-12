// This module builds every workspace package in the repository. It works out the
// order the packages must be built in, then runs each package's own `build`
// script in that order.
//
// It is the repository-wide build path, reached through the `build-workspaces`
// bin and the root `build` script. It shares package discovery (discovery.ts)
// with the image-building path and then diverges: no registry, no build plan,
// nothing staged. It never consults the selector — the `MICROSERVICES` value
// saying which microservices a build includes — so it builds every package,
// always.
//
// The order comes from the `@microservices`-scoped `dependencies` each package
// already declares, over the graph machinery in topological-order.ts. A
// specifier naming one of the scaffold's own packages counts as an ordering edge
// too, which is why `packages/contracts` comes out first and
// `packages/integration-tests` last with neither position hard-coded.
//
// No dependency-direction rule is applied here, on purpose:
// `packages/integration-tests` legitimately depends on nearly everything.
// repo-invariants.ts and required-dependencies.ts check direction instead.
//
// (Requirements R12.1–R12.10, R12.13.)

import { spawnSync } from "node:child_process";

import type { ConsumerPackage, Discovery } from "./discovery.js";
import { discoverPackages, readDependencySpecifiers } from "./discovery.js";
import type { ConsumerCategory } from "./framework.js";
import { FRAMEWORK_SINGLETONS, WORKSPACE_SCOPE } from "./framework.js";
import type { ReadDependencies } from "./required-dependencies.js";
import {
  compareCodePoints,
  findCyclePath,
  leastTopologicalOrder,
} from "./topological-order.js";

/**
 * One package in the build order. Any workspace package is one of these.
 *
 * One type covers both the scaffold's own packages and the ones a template user
 * writes, so the ordering rule needs no special case for either (R12.3).
 */
export interface WorkspaceNode {
  /** Repo-relative package directory: node identity and the sort key (R12.5). */
  readonly packageDir: string;
  /** Declared package name — what a dependency specifier resolves against. */
  readonly name: string;
  /** This package's own `@microservices`-scoped `dependencies` keys (R12.4). */
  readonly dependencySpecifiers: readonly string[];
  /** Framework tier, or the Consumer_Category. Diagnostics only; no rule reads it. */
  readonly tier: "framework" | ConsumerCategory;
}

/**
 * Builds the error for a dependency specifier that names no known package.
 *
 * The wording matches required-dependencies.ts's message for the same defect, so
 * a typo'd specifier reads the same wherever it is caught (R13.11).
 *
 * @param consumer the repo-relative directory of the declaring package.
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
 * Builds the error that names every package in a dependency cycle (R12.6).
 *
 * The path {@link findCyclePath} returns is closed, so a self-dependency reads
 * `"a" -> "a"` and a two-node cycle `"a" -> "b" -> "a"`.
 *
 * @param participants the cycle in traversal order, closed by its entry point.
 */
function cycleError(participants: readonly string[]): Error {
  const path = participants.map((name) => `"${name}"`).join(" -> ");
  return new Error(
    `[build-order:cycle] the ${WORKSPACE_SCOPE} workspace dependency graph contains a cycle: ${path}`,
  );
}

/**
 * Builds the error for a package whose `build` script exited non-zero (R12.8).
 *
 * @param packageDir the repo-relative directory of the package whose build failed.
 * @param status the non-zero exit status the runner reported.
 */
function orderedBuildFailedError(packageDir: string, status: number): Error {
  return new Error(
    `[build-order:failed] "npm run build" for "${packageDir}" failed with exit code ${String(status)}; no subsequent package was built`,
  );
}

/**
 * Collects every workspace package as a node of the build graph (R12.1).
 *
 * That is the four packages the scaffold owns, named in framework.ts, plus every
 * package discovery found under the three category directories. Called from
 * {@link runOrderedBuildCli}.
 *
 * @param discovery the discovery result; supplies every Consumer_Package.
 * @param readDependencies reads a Framework_Singleton's own specifiers, which
 *   discovery never records.
 */
export function workspaceNodesFrom(
  discovery: Discovery,
  readDependencies: ReadDependencies,
): readonly WorkspaceNode[] {
  const frameworkNodes: WorkspaceNode[] = FRAMEWORK_SINGLETONS.map(
    (singleton) => ({
      packageDir: singleton.packageDir,
      name: singleton.name,
      dependencySpecifiers: readDependencies(singleton.packageDir),
      tier: "framework",
    }),
  );

  const consumerNodes: WorkspaceNode[] = [
    ...discovery.byName.values(),
  ].map((pkg: ConsumerPackage) => ({
    packageDir: pkg.packageDir,
    name: pkg.name,
    dependencySpecifiers: pkg.dependencySpecifiers,
    tier: pkg.category,
  }));

  return [...frameworkNodes, ...consumerNodes];
}

/**
 * Collects the package names a dependency specifier may resolve against.
 *
 * Both tiers go into the one set: a scaffold package's name is an ordering edge
 * like any other (R12.3).
 */
function declaredNames(nodes: readonly WorkspaceNode[]): ReadonlySet<string> {
  return new Set(nodes.map((node) => node.name));
}

/**
 * Resolves one package's dependency specifiers to the packages it must follow.
 *
 * Called once per node from {@link workspaceBuildOrder}, as the graph walk asks
 * for that node's edges. A specifier resolving to nothing fails the run rather
 * than being dropped (R12.3).
 *
 * @throws `[shared:unresolved]` for an `@microservices`-scoped specifier matching
 *   no declared package name.
 */
function dependencyKeysOf(
  node: WorkspaceNode,
  names: ReadonlySet<string>,
): readonly string[] {
  const keys: string[] = [];
  const unresolved: string[] = [];

  for (const specifier of node.dependencySpecifiers) {
    // Both suppliers already filter by scope; the guard keeps the rule true of
    // this function on its own account (R3.10).
    if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) {
      continue;
    }
    if (names.has(specifier)) {
      keys.push(specifier);
    } else {
      unresolved.push(specifier);
    }
  }

  if (unresolved.length > 0) {
    throw unresolvedSpecifierError(
      node.packageDir,
      [...new Set(unresolved)].sort(),
    );
  }

  return keys;
}

/**
 * Sorts the workspace packages into the order they must be built in.
 *
 * Every package comes out once (R12.1), after every package it declares a
 * dependency on (R12.2); unrelated packages are ordered by `packageDir`, so two
 * runs over an unchanged repository agree (R12.5). Called from
 * {@link runOrderedBuildCli}; {@link runOrderedBuild} walks the result.
 *
 * The cycle search runs before the ordering pass, whose leftover set also holds
 * packages merely downstream of a cycle and would over-report them.
 *
 * @throws `[build-order:cycle]` naming every participating package, having
 *   computed no order (R12.6) — the caller therefore invokes no `build` script.
 * @throws `[shared:unresolved]` for an unresolvable specifier.
 */
export function workspaceBuildOrder(
  nodes: readonly WorkspaceNode[],
): readonly WorkspaceNode[] {
  const names = declaredNames(nodes);
  const dependenciesOf = (node: WorkspaceNode): readonly string[] =>
    dependencyKeysOf(node, names);
  const keyOf = (node: WorkspaceNode): string => node.name;

  const cycle = findCyclePath(nodes, keyOf, dependenciesOf);
  if (cycle !== undefined) {
    // Report directories, not declared names, as every build-order failure does.
    const dirByName = new Map(nodes.map((node) => [node.name, node.packageDir]));
    throw cycleError(cycle.map((name) => dirByName.get(name) ?? name));
  }

  return leastTopologicalOrder(nodes, keyOf, dependenciesOf, (a, b) =>
    compareCodePoints(a.packageDir, b.packageDir),
  );
}

/**
 * Runs one command. Injected so the executor is testable without spawning.
 *
 * It returns the exit status rather than throwing, leaving
 * {@link runOrderedBuild} to own the stop-at-first-failure decision.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => { readonly status: number };

/** Runs a command for real, via `spawnSync` with inherited stdio. */
const spawnRunner: CommandRunner = (
  command: string,
  args: readonly string[],
): { readonly status: number } => {
  const { status } = spawnSync(command, [...args], { stdio: "inherit" });
  // A `null` status means killed by a signal or never spawned; both are failures.
  return { status: status ?? 1 };
};

/**
 * Runs each package's own `build` script once, in the order given (R12.7).
 *
 * Called from {@link runOrderedBuildCli}. The first non-zero exit stops the run,
 * and no later package is built (R12.8). Because each package builds itself, a
 * SPA is built by its own bundler, needing no separate phase here (R12.9,
 * R12.10).
 *
 * @param order the build order, as {@link workspaceBuildOrder} returns it.
 * @param runner injected command runner; defaults to a real `spawnSync`.
 * @throws `[build-order:failed]` naming the package directory and the exit status.
 */
export function runOrderedBuild(
  order: readonly WorkspaceNode[],
  runner: CommandRunner = spawnRunner,
): void {
  for (const node of order) {
    const { status } = runner("npm", [
      "run",
      "build",
      "--workspace",
      node.name,
    ]);
    if (status !== 0) {
      throw orderedBuildFailedError(node.packageDir, status);
    }
  }
}

/**
 * Derives the order over the real repository and runs the ordered build.
 *
 * This is what bin/build-workspaces.ts imports and calls; all CLI policy lives
 * here so that bin stays a shebang, one import and one call. Any failure is
 * written to stderr and exits 1.
 */
export function runOrderedBuildCli(): void {
  try {
    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);
    runOrderedBuild(order);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

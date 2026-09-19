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
// The order comes from the Build_Sequence primitive (build-sequence.ts), the one
// place the seven-statement order is written. `packages/contracts` comes out
// first because it is statement 1 and `packages/integration-tests` next-to-last
// because it is statement 6 — those positions are the sequence's, not a
// consequence of a declared dependency. A package's declared `@microservices`
// dependency is honoured by the Verification_Pass, not by the ordering sort: the
// pass rejects any produced order that places a package ahead of one of its own
// Compile_Time_Prerequisites, and runs before any `build` script is spawned.
//
// No dependency-direction rule is applied here, on purpose:
// `packages/integration-tests` legitimately depends on nearly everything.
// repo-invariants.ts and required-dependencies.ts check direction instead.
//
// (Requirements R12.1–R12.10, R12.13.)

import { spawnSync } from "node:child_process";

import {
  assertBuildOrder,
  buildSequence,
  prerequisiteEdges,
} from "./build-sequence.js";
import type { SequencedPackage } from "./build-sequence.js";
import type { ConsumerPackage, Discovery } from "./discovery.js";
import {
  buildKindOf,
  discoverPackages,
  readDependencySpecifiers,
} from "./discovery.js";
import { requireProjectContext } from "./config-loader.js";
import type { ConsumerCategory } from "./framework.js";
import { type ProjectContext } from "./project-context.js";
import type { ReadDependencies } from "./required-dependencies.js";

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
  /** Framework tier, or the Consumer_Category. Partitions the nodes into the
   *  Build_Sequence's statements — its `common`, `spa`, and microservice members. */
  readonly tier: "framework" | ConsumerCategory;
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
 * That is the four packages the scaffold owns, plus every package discovery
 * found under the three category directories. Called from
 * {@link runOrderedBuildCli}.
 *
 * @param context the run's per-run derivation of its Effective_Config; supplies
 *   the four Framework_Singletons with their scope-composed names (R1.9, R3.7).
 * @param discovery the discovery result; supplies every Consumer_Package.
 * @param readDependencies reads a Framework_Singleton's own specifiers, which
 *   discovery never records.
 */
export function workspaceNodesFrom(
  context: ProjectContext,
  discovery: Discovery,
  readDependencies: ReadDependencies,
): readonly WorkspaceNode[] {
  const frameworkNodes: WorkspaceNode[] = context.framework.all.map(
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
 * Sorts the workspace packages into the order they must be built in.
 *
 * The order is the Build_Sequence primitive over the full workspace: every
 * package takes part, so `buildTools` and `testOnly` are both true, and no
 * Selector narrows the membership — the repository-wide build always builds every
 * package (R12.1). `contracts` leads as statement 1 and `integration-tests`
 * follows the microservices and the Overseer as statement 6; within a statement,
 * members are ordered by `packageDir`, so two runs over an unchanged repository
 * agree (R12.5).
 *
 * A declared dependency (R12.2) is honoured by the Verification_Pass, not by the
 * ordering sort: {@link assertBuildOrder} rejects any produced order placing a
 * package ahead of one of its own Compile_Time_Prerequisites, and runs before
 * {@link runOrderedBuild} spawns a single `build` script (R12.6). Called from
 * {@link runOrderedBuildCli}; {@link runOrderedBuild} walks the result.
 *
 * @throws `[build-order:cycle]` naming every participating package, having
 *   computed no order (R12.6) — the caller therefore invokes no `build` script.
 * @throws `[build-order:prerequisite]` when the produced order places a package
 *   ahead of one of its own prerequisites.
 * @throws `[shared:unresolved]` for an unresolvable specifier.
 */
export function workspaceBuildOrder(
  context: ProjectContext,
  nodes: readonly WorkspaceNode[],
): readonly WorkspaceNode[] {
  // Partition the workspace by tier and category. Statement 3 (common) and
  // statement 7 (spa) want ConsumerPackage-shaped members; reconstruct the fields
  // buildSequence reads from each node — its category is its tier, and its
  // buildKind derives from that category alone (discovery.ts). Statement 4 wants
  // the microservice directory names, which are the last path segment of each
  // microservice node's packageDir.
  const consumerPackageOf = (
    node: WorkspaceNode,
    category: ConsumerCategory,
  ): ConsumerPackage => ({
    category,
    dirName: node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1),
    packageDir: node.packageDir,
    name: node.name,
    dependencySpecifiers: node.dependencySpecifiers,
    buildKind: buildKindOf(category),
  });

  const common = nodes
    .filter((node) => node.tier === "common")
    .map((node) => consumerPackageOf(node, "common"));
  const spa = nodes
    .filter((node) => node.tier === "spa")
    .map((node) => consumerPackageOf(node, "spa"));
  const microserviceIdentifiers = nodes
    .filter((node) => node.tier === "microservice")
    .map((node) => node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1));

  // The Build_Sequence derivation runs against the run's context (R1.9): no part
  // of the order comes from the `workspaces` entry order.
  const order = buildSequence(context, {
    common,
    microservices: microserviceIdentifiers,
    spa,
    buildTools: true,
    testOnly: true,
  });

  // The Verification_Pass runs before any `build` script is spawned: it resolves
  // every declared specifier (raising `[shared:unresolved]`), rejects a cyclic
  // Prerequisite_Graph (`[build-order:cycle]`), and rejects an order placing a
  // package ahead of one of its prerequisites (`[build-order:prerequisite]`).
  // Every discovered microservice is a Selected_Microservice for this path.
  assertBuildOrder(
    context,
    order,
    prerequisiteEdges(context, nodes, microserviceIdentifiers),
  );

  // Map each SequencedPackage back to its input WorkspaceNode by packageDir, so
  // the return type stays `readonly WorkspaceNode[]` for `runOrderedBuild` and
  // the suites that consume it (D5).
  const nodeByDir = new Map(nodes.map((node) => [node.packageDir, node]));
  return order.map((sequenced: SequencedPackage) => {
    const node = nodeByDir.get(sequenced.packageDir);
    if (node === undefined) {
      throw new Error(
        `[build-order:internal] the Build_Sequence produced "${sequenced.packageDir}", which is not a discovered workspace node`,
      );
    }
    return node;
  });
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
  // requireProjectContext reports any Config_Diagnostic to stderr and exits 1
  // before any order is derived (R1.10); on success it returns the run's context.
  const context = requireProjectContext();
  try {
    const nodes = workspaceNodesFrom(
      context,
      discoverPackages(context),
      readDependencySpecifiers(context),
    );
    const order = workspaceBuildOrder(context, nodes);
    runOrderedBuild(order);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

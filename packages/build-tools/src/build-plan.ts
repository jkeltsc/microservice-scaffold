// This module works out what a build has to compile, bundle, and ship.
//
// Step 6 of the build pipeline, plan derivation: `buildPlanFrom` takes the
// MICROSERVICES value — `*` or a list such as `microservice1,microservice2` —
// plus one discovery run, and returns a BuildPlan carrying `spaBuilds`,
// `tscRoots`, and `stage`. Selection (selector.ts) and the two dependency sets
// (required-dependencies.ts) are composed, never reimplemented, so their errors
// surface identically wherever a plan is derived (R13.10, R13.11).
// (R5.4–R5.6, R6.3, R6.4, R6.6, R6.7, R7.3–R7.5, R13.1–R13.7, R13.9)
//
// One asymmetry is worth remembering: root membership comes from the BUILD set,
// staging from the STAGE set. A Common_Package reached only through a
// Spa_Package is therefore compiled — its `dist/` is what the bundler inlines —
// yet ships nowhere, since after bundling no runtime process can reach it
// (R6.14, R7.13). With no Spa_Package present the two sets are equal and the
// asymmetry is invisible.

import {
  assertBuildOrder,
  buildSequence,
  prerequisiteEdges,
} from "./build-sequence.js";
import type { ConsumerPackage, Discovery } from "./discovery.js";
import { discoverPackages, readDependencySpecifiers } from "./discovery.js";
import {
  resolveDependencySets,
  type ReadDependencies,
} from "./required-dependencies.js";
import {
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  WORKSPACE_SCOPE,
  type FrameworkSingleton,
} from "./framework.js";
import { resolveSelected } from "./selector.js";
import { workspaceNodesFrom } from "./workspace-build-order.js";

/**
 * The Image_Tree directory holding the workspace scope's real package
 * directories. Exported so the Integrity_Assertion (image-tree.ts) enumerates
 * the same directory this module targets (R10.5).
 */
export const SCOPE_DIR = `node_modules/${WORKSPACE_SCOPE}`;

/** One package to stage, and why it is justified. */
export interface StagedPackage {
  /** Repo-relative source directory, e.g. "packages/common/config". */
  readonly sourceDir: string;
  /** Image_Tree-relative target, e.g. "node_modules/@microservices/config". */
  readonly targetDir: string;
  /** The `node_modules/@microservices/` entry name, when that is where it lands. */
  readonly scopedEntry: string | undefined;
  readonly justification:
    | "framework-singleton" // R5.6, R5.10, R7.7
    | "required-dependency" // R7.3, R7.4
    | "selected-microservice"; // R7.5
}

/** Everything one build consists of, for one MICROSERVICES value. */
export interface BuildPlan {
  /** The microservices this build includes, in selector order (R13.1). */
  readonly selected: readonly string[];
  /** The BUILD set: every package to compile, topologically ordered (R7.1, R7.2). */
  readonly requiredDependencies: readonly ConsumerPackage[];
  /**
   * The STAGE set: the Common and Spa packages that ship, a subsequence of
   * {@link requiredDependencies} (R6.14, R7.3, R7.4, R7.13, R7.14).
   */
  readonly stagedDependencies: readonly ConsumerPackage[];
  /** Required Spa_Packages, each built by its own `npm run build` (R6.4). */
  readonly spaBuilds: readonly ConsumerPackage[];
  /**
   * The ordered roots of the single `tsc --build` invocation, holding no
   * Spa_Package and each root once (R6.3, R6.6, R13.3–R13.6). It is the
   * Build_Sequence over the Selector-scoped membership: statement 1 (`contracts`),
   * statement 3 (the required Common_Packages), statement 4 (the
   * Selected_Microservices), statement 5 (the Overseer). Statements 2, 6, and 7
   * contribute no root on the image path (2.5).
   */
  readonly tscRoots: readonly string[];
  /** Everything to stage, in the order it is written (R7.3–R7.5, R5.6). */
  readonly stage: readonly StagedPackage[];
}

/** The repo-relative directory of the microservice with this identifier. */
function microserviceDir(identifier: string): string {
  return `${NAMESPACE_CONTAINER.microservice}/${identifier}`;
}

/**
 * The Framework_Singletons that ship under the workspace scope whatever the
 * build includes — today exactly `contracts` (R5.6, R5.10). Filtered on what
 * each record in framework.ts declares, so this module names no singleton.
 */
const ALWAYS_STAGED_SCOPED: readonly FrameworkSingleton[] =
  FRAMEWORK_SINGLETONS.filter(
    (entry) => entry.staging === "scoped-node-modules",
  );

/**
 * The Framework_Singletons that ship at their own package directory — today
 * exactly the Overseer, which the container entrypoint invokes by path.
 */
const ALWAYS_STAGED_AT_PACKAGE_DIR: readonly FrameworkSingleton[] =
  FRAMEWORK_SINGLETONS.filter((entry) => entry.staging === "package-dir");

/** A package landing at `node_modules/@microservices/<entry>` as a real directory. */
function scopedStage(
  sourceDir: string,
  entry: string,
  justification: StagedPackage["justification"],
): StagedPackage {
  return {
    sourceDir,
    targetDir: `${SCOPE_DIR}/${entry}`,
    scopedEntry: entry,
    justification,
  };
}

/**
 * This function lists everything to stage, in the order it is written.
 *
 * Four groups: the always-staged Framework_Singletons under the scope, the STAGE
 * set (Common and Spa members alike), the selected microservices, then the
 * Overseer at its own directory (R7.3–R7.5, R5.6). Every entry records why it is
 * there, so the Integrity_Assertion (image-tree.ts) can justify an Image_Tree
 * entry from the plan alone, and nothing reaches the list except through the
 * group that justifies it — minimality needs no prune step (R7.6).
 */
function stageOf(
  selected: readonly string[],
  staged: readonly ConsumerPackage[],
): readonly StagedPackage[] {
  return [
    ...ALWAYS_STAGED_SCOPED.map((entry) =>
      scopedStage(entry.packageDir, entry.dirName, "framework-singleton"),
    ),
    ...staged.map((pkg) =>
      scopedStage(pkg.packageDir, pkg.dirName, "required-dependency"),
    ),
    ...selected.map((identifier) =>
      scopedStage(
        microserviceDir(identifier),
        identifier,
        "selected-microservice",
      ),
    ),
    ...ALWAYS_STAGED_AT_PACKAGE_DIR.map((entry) => ({
      sourceDir: entry.packageDir,
      targetDir: entry.packageDir,
      scopedEntry: undefined,
      justification: "framework-singleton" as const,
    })),
  ];
}

/**
 * This function derives the complete plan for one MICROSERVICES value.
 *
 * Both `buildImageTree` (image-tree.ts), which executes the plan, and
 * `projectListFrom` (dev-supervisor.ts), which takes only `tscRoots`, call this
 * one function, so the dev project list and the image `tsc --build` roots cannot
 * drift apart (R13.8). Both dependency sets come from a single
 * `resolveDependencySets` call, so the two cannot disagree about which packages
 * were reached (R13.1, R13.2, R13.9).
 *
 * @param selector the raw MICROSERVICES value; `undefined` means all.
 * @param discovery one discovery run's result.
 * @param readDependencies reads the root consumers' Dependency_Specifiers.
 * @throws `[selector:empty]`, `[selector:unmatched]`, `[shared:unresolved]`,
 *   `[deps:peer]`, `[deps:cycle]`.
 */
export function buildPlanFrom(
  selector: string | undefined,
  discovery: Discovery,
  readDependencies: ReadDependencies,
): BuildPlan {
  const selected = resolveSelected(
    selector,
    discovery.byCategory.microservice.map((pkg) => pkg.dirName),
  );
  const { required, staged } = resolveDependencySets(
    selected,
    discovery,
    readDependencies,
  );

  // The Tsc_Root_Order is the Build_Sequence primitive over the Selector-scoped
  // membership: statement 1 (`contracts`) and statement 5 (the Overseer) are named
  // by the sequence, statement 3 the required Common_Packages, statement 4 the
  // Selected_Microservices. Both `false` values are a stated decision, not the
  // emergent consequence F4 describes: `build-tools` (statement 2) and
  // `integration-tests` (statement 6) are Framework_Singletons that never ship in
  // an image and are excluded from the image `tsc --build` here on purpose (3.15).
  // `spa: []` because on the image path statement 7 is handed no members: a
  // Spa_Package is not a `tsc --build` root, so its Spa_Packages live in
  // `plan.spaBuilds` and are built by their own `npm run build`. Statement 7's
  // placement and `spaBuilds`' phase are two independent facts that agree, not one
  // claim expressed twice (D7).
  const tscSequence = buildSequence({
    common: required.filter((pkg) => pkg.category === "common"),
    microservices: selected,
    spa: [],
    buildTools: false,
    testOnly: false,
  });

  // Derive the repository-wide order from the discovery and readDependencies this
  // function already holds, and run the Verification_Pass's divergence check
  // (2.14) with `workspaceOrder` as the counterpart. The check runs on the image
  // path and the dev path over the real Selector, at the cost of three extra
  // manifest reads and no spawned process (D2). `workspaceOrder` is the
  // SequencedPackage[] over the full workspace membership, and `edges` the
  // Prerequisite_Graph over the same nodes and this Selector.
  const workspaceNodes = workspaceNodesFrom(discovery, readDependencies);
  const workspaceOrder = buildSequence({
    common: workspaceNodes
      .filter((node) => node.tier === "common")
      .map((node) => ({
        category: "common" as const,
        dirName: node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1),
        packageDir: node.packageDir,
        name: node.name,
        dependencySpecifiers: node.dependencySpecifiers,
        buildKind: "tsc-project" as const,
      })),
    microservices: workspaceNodes
      .filter((node) => node.tier === "microservice")
      .map((node) => node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1)),
    spa: workspaceNodes
      .filter((node) => node.tier === "spa")
      .map((node) => ({
        category: "spa" as const,
        dirName: node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1),
        packageDir: node.packageDir,
        name: node.name,
        dependencySpecifiers: node.dependencySpecifiers,
        buildKind: "bundler-project" as const,
      })),
    buildTools: true,
    testOnly: true,
  });
  const edges = prerequisiteEdges(workspaceNodes, selected);
  assertBuildOrder(tscSequence, edges, workspaceOrder);

  return {
    selected,
    requiredDependencies: required,
    stagedDependencies: staged,
    // Mirrors the Build_Sequence's positive Build_Kind partition: `spaBuilds` is
    // the bundler-project half of the BUILD set and `tscRoots` the tsc-project
    // half, so the two `buildKind` filters partition the BUILD set and no
    // Spa_Package can reach `tscRoots` (R6.3, R13.4).
    spaBuilds: required.filter((pkg) => pkg.buildKind === "bundler-project"),
    tscRoots: tscSequence.map((pkg) => pkg.packageDir),
    stage: stageOf(selected, staged),
  };
}

/**
 * This function derives the plan for the current MICROSERVICES value from the
 * real filesystem.
 *
 * It is the effect shell around {@link buildPlanFrom}: it supplies the two
 * filesystem-backed inputs, holds no logic, and discovers exactly once.
 */
export function buildPlan(selector = process.env.MICROSERVICES): BuildPlan {
  return buildPlanFrom(selector, discoverPackages(), readDependencySpecifiers);
}

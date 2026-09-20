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
import type { FrameworkSingleton, ProjectContext } from "./project-context.js";
import {
  resolveDependencySets,
  type ReadDependencies,
} from "./required-dependencies.js";
import { resolveSelected } from "./selector.js";
import { workspaceNodesFrom } from "./workspace-build-order.js";

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
    | "selected-microservice" // R7.5
    | "entry-package"; // registry-inversion R9.6, R9.7, R9.9
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
   * Selected_Microservices), statement 5 (the Overseer_Library), statement 6 (the
   * Entry_Package). Statements 2, 7, and 8 contribute no root on the image path
   * (2.5).
   */
  readonly tscRoots: readonly string[];
  /** Everything to stage, in the order it is written (R7.3–R7.5, R5.6). */
  readonly stage: readonly StagedPackage[];
}

/** The repo-relative directory of the microservice with this identifier. */
function microserviceDir(context: ProjectContext, identifier: string): string {
  return `${context.roots.microservice}/${identifier}`;
}

/**
 * The Framework_Singletons that ship under the workspace scope whatever the
 * build includes — today `contracts` and the Overseer_Library (R5.6, R5.10,
 * registry-inversion R3.7, R9.4). Filtered on what each record the context
 * carries declares, so this module names no singleton: the Overseer joined this
 * group by changing its own `staging`, with no change here.
 */
function alwaysStagedScoped(
  context: ProjectContext,
): readonly FrameworkSingleton[] {
  return context.framework.all.filter(
    (entry) => entry.staging === "scoped-node-modules",
  );
}

/**
 * The one package staged at a package directory rather than under the scope
 * directory: the Entry_Package, at the Entry_Root, so that the Entry_Point_Path
 * `<Entry_Root>/dist/index.js` resolves inside the image (registry-inversion
 * R9.6, R7.7).
 *
 * Not a Framework_Singleton record and not a `FrameworkStaging` value — the
 * Entry_Package belongs to the consumer, and no Framework_Singleton is staged at
 * its package directory any more. Both paths come from `context.entryRoot`, the
 * single derivation, so this module composes no path of its own.
 *
 * `scopedEntry: undefined` is what keeps the Integrity_Assertion silent about it
 * (registry-inversion R9.7): the entry is neither enumerated under the scope
 * directory nor a member of the justified set, so the check does not range over
 * it rather than exempting it. `copyPackage` stages `package.json` plus `dist`
 * for every package whatever its category, so no `src` of it is staged and the
 * Generated_Registry's source file never reaches an Image_Tree (R9.5) while its
 * compiled form ships inside `dist`.
 */
function entryPackageStage(context: ProjectContext): StagedPackage {
  return {
    sourceDir: context.entryRoot,
    targetDir: context.entryRoot,
    scopedEntry: undefined,
    justification: "entry-package",
  };
}

/** A package landing at `node_modules/@microservices/<entry>` as a real directory. */
function scopedStage(
  context: ProjectContext,
  sourceDir: string,
  entry: string,
  justification: StagedPackage["justification"],
): StagedPackage {
  return {
    sourceDir,
    targetDir: `${context.scopeDir}/${entry}`,
    scopedEntry: entry,
    justification,
  };
}

/**
 * This function lists everything to stage, in the order it is written.
 *
 * Four groups: the always-staged Framework_Singletons under the scope
 * (`contracts`, then the Overseer_Library, in `framework.all` order), the STAGE
 * set (Common and Spa members alike), the selected microservices, then the
 * Entry_Package at the Entry_Root (R7.3–R7.5, R5.6, registry-inversion R3.7,
 * R9.2–R9.4, R9.6). Every entry records why it is there, so the
 * Integrity_Assertion (image-tree.ts) can justify an Image_Tree entry from the
 * plan alone, and nothing reaches the list except through the group that
 * justifies it — minimality needs no prune step (R7.6).
 *
 * `build-tools`, `integration-tests`, and the microservice Discovery_Root reach
 * no group, so they are staged into no Image_Tree (registry-inversion R9.5): the
 * two singletons declare `"none"` staging, and a microservice is staged from its
 * identifier into the scope directory, never from its Discovery_Root.
 *
 * The recording of an Image_Tree sorts its entries, so this group order is
 * unobservable in a baseline; it is stated so the list has one definition.
 */
function stageOf(
  context: ProjectContext,
  selected: readonly string[],
  staged: readonly ConsumerPackage[],
): readonly StagedPackage[] {
  return [
    ...alwaysStagedScoped(context).map((entry) =>
      scopedStage(
        context,
        entry.packageDir,
        entry.dirName,
        "framework-singleton",
      ),
    ),
    ...staged.map((pkg) =>
      scopedStage(context, pkg.packageDir, pkg.dirName, "required-dependency"),
    ),
    ...selected.map((identifier) =>
      scopedStage(
        context,
        microserviceDir(context, identifier),
        identifier,
        "selected-microservice",
      ),
    ),
    entryPackageStage(context),
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
 * @param context the per-run derivation of this run's Effective_Config (R1.9).
 * @param selector the raw MICROSERVICES value; `undefined` means all.
 * @param discovery one discovery run's result.
 * @param readDependencies reads the root consumers' Dependency_Specifiers.
 * @throws `[selector:empty]`, `[selector:unmatched]`, `[shared:unresolved]`,
 *   `[deps:peer]`, `[deps:cycle]`.
 */
export function buildPlanFrom(
  context: ProjectContext,
  selector: string | undefined,
  discovery: Discovery,
  readDependencies: ReadDependencies,
): BuildPlan {
  const selected = resolveSelected(
    selector,
    discovery.byCategory.microservice.map((pkg) => pkg.dirName),
  );
  const { required, staged } = resolveDependencySets(
    context,
    selected,
    discovery,
    readDependencies,
  );

  // The Tsc_Root_Order is the Build_Sequence primitive over the Selector-scoped
  // membership: statement 1 (`contracts`) and statement 5 (the Overseer_Library)
  // are named by the sequence, statement 3 the required Common_Packages, statement
  // 4 the Selected_Microservices, statement 6 the Entry_Package — unconditionally,
  // since every Order_Producing_Path compiles it. Both `false` values are a stated
  // decision, not the emergent consequence F4 describes: `build-tools` (statement
  // 2) and `integration-tests` (statement 7) are Framework_Singletons that never
  // ship in an image and are excluded from the image `tsc --build` here on purpose
  // (3.15). `spa: []` because on the image path statement 8 is handed no members: a
  // Spa_Package is not a `tsc --build` root, so its Spa_Packages live in
  // `plan.spaBuilds` and are built by their own `npm run build`. Statement 8's
  // placement and `spaBuilds`' phase are two independent facts that agree, not one
  // claim expressed twice (D7).
  const tscSequence = buildSequence(context, {
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
  const workspaceNodes = workspaceNodesFrom(
    context,
    discovery,
    readDependencies,
  );
  const workspaceOrder = buildSequence(context, {
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
      .map((node) =>
        node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1),
      ),
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
  const edges = prerequisiteEdges(context, workspaceNodes, selected);
  assertBuildOrder(context, tscSequence, edges, workspaceOrder);

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
    stage: stageOf(context, selected, staged),
  };
}

/**
 * This function derives the plan for the current MICROSERVICES value from the
 * real filesystem.
 *
 * It is the effect shell around {@link buildPlanFrom}: it supplies the two
 * filesystem-backed inputs, holds no logic, and discovers exactly once.
 */
export function buildPlan(
  context: ProjectContext,
  selector = process.env.MICROSERVICES,
): BuildPlan {
  return buildPlanFrom(
    context,
    selector,
    discoverPackages(context),
    readDependencySpecifiers(context),
  );
}

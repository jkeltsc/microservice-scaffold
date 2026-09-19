// Feature: unified-build-order, Property 1: Bug Condition - No produced order contains an Ordering_Violation
//
// This is the BUGFIX exploration test of Task 1. It is written BEFORE the fix
// and is EXPECTED TO FAIL on unfixed code — its failure is the evidence that the
// Ordering_Violation of bugfix.md 1.2 is live on the committed tree. It must not
// be rewritten by a later task: once the fix lands (task 4), the same test flips
// from red to green with no edit, because it drives only the two PUBLIC
// derivations whose signatures the fix preserves (design D5):
//
//   - the Workspace_Build_Order via
//       workspaceBuildOrder(workspaceNodesFrom(discovery, readDependencies))
//   - the Tsc_Root_Order via
//       buildPlanFrom(selector, discovery, readDependencies).tscRoots
//
// It never imports the new build-sequence.ts module, and its prerequisite oracle
// is written straight from `isCompileTimePrerequisite` in the Bug Condition — it
// does NOT call `prerequisiteEdges`, which does not exist yet and which the
// property is meant to check independently (task 1 direction, 2.13).
//
// The Ordering_Violation (bugfix.md Bug Condition): a produced order holds a pair
// (a, b) where b is a Compile_Time_Prerequisite of a yet a sits at an earlier
// position. `isCompileTimePrerequisite(b, a)` holds when:
//   - a declares an `@microservices`-scoped specifier resolving to b, AND b is
//     NOT a Spa_Package (a Spa_Package is excluded unconditionally — 2.6); or
//   - a is the Overseer and b is one of the Selected_Microservices its generated
//     Microservice_Registry statically imports (the edge no manifest may declare
//     — 1.8, 1.9).
//
// EXPECTED OUTCOME on unfixed code: FAIL. Over the committed tree the derived
// Workspace_Build_Order is contracts, build-tools, common/config,
// common/extended-config, microservice2, microservice3, overseer (7), spa/demo
// (8), microservice1 (9), integration-tests (10). microservice1 is a
// Compile_Time_Prerequisite of the Overseer through the registry, yet it sits at
// 9 while the Overseer sits at 7 — the Overseer (dependent) precedes its own
// prerequisite. bugfix.md 1.3 turns that into `error TS2307: Cannot find module
// '@microservices/microservice1'` and 1.10 explains why nothing downstream
// repairs the root order.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.10, 1.14, 2.8, 2.13

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ReadDependencies } from "../src/required-dependencies.js";
import { buildPlanFrom } from "../src/build-plan.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";

import { type ConsumerCategory } from "../src/framework.js";

/** Default-config context; scope and roots equal the pre-context baseline. */
const CONTEXT = projectContext(defaultEffectiveConfig());

// Scope, per-category roots, and the four Framework_Singletons (each with its
// scope-composed name) come from the run's context, not from framework.ts's
// scope-free surface (R3.7).
const WORKSPACE_SCOPE = CONTEXT.config.scope;
const NAMESPACE_CONTAINER = CONTEXT.roots;
const FRAMEWORK_SINGLETONS = CONTEXT.framework.all;
const { contracts: CONTRACTS, overseer: OVERSEER } = CONTEXT.framework;

// ---------------------------------------------------------------------------
// In-memory layout model (shared shape with build-plan.property.test.ts)
// ---------------------------------------------------------------------------
//
// A layout is a set of discovered Consumer_Packages — Common and Spa libraries
// plus Microservice_Packages — together with the Overseer's declared specifiers.
// Library-to-library edges only ever point at an EARLIER Common_Package, so the
// generated graph is acyclic, every specifier resolves, and no forbidden inbound
// -SPA edge (`common → spa`, `spa → spa`) is ever produced. A Microservice_Package
// or the Overseer may point at a Spa_Package, since `microservice → spa` and
// `overseer → spa` are legal — those are exactly the edges that reproduce the
// defect.

interface Layout {
  /** Library packages (Common and Spa), in dependency order (each depends only on earlier ones). */
  readonly libraries: readonly ConsumerPackage[];
  /** Microservice_Packages; their specifiers double as the root specifiers. */
  readonly microservices: readonly ConsumerPackage[];
  /** The Overseer's declared specifiers (always includes `contracts`). */
  readonly overseerDeps: readonly string[];
}

const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

const LIBRARY_CATEGORIES: readonly ConsumerCategory[] = ["common", "spa"];

/** A discovered Consumer_Package placed in its category's Namespace_Container. */
function consumerPackage(
  category: ConsumerCategory,
  dirName: string,
  dependencySpecifiers: readonly string[],
): ConsumerPackage {
  return {
    category,
    dirName,
    packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
    name: `${WORKSPACE_SCOPE}/${dirName}`,
    dependencySpecifiers: [...dependencySpecifiers].sort(),
    buildKind: buildKindOf(category),
  };
}

/** Every discovered package of a layout, in a single list. */
function allPackages(layout: Layout): readonly ConsumerPackage[] {
  return [...layout.libraries, ...layout.microservices];
}

/** Ascending code-point comparison of directory name. */
function byDirName(a: ConsumerPackage, b: ConsumerPackage): number {
  return a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;
}

/**
 * The `Discovery` a layout presents. Each category is sorted by directory name,
 * the order Package_Discovery guarantees (R2.5) and therefore the order an
 * all-Selector resolves to.
 */
function discoveryOf(layout: Layout): Discovery {
  const all = [...allPackages(layout)];
  const of = (category: ConsumerCategory): readonly ConsumerPackage[] =>
    all.filter((pkg) => pkg.category === category).sort(byDirName);

  return {
    byCategory: {
      microservice: of("microservice"),
      common: of("common"),
      spa: of("spa"),
    },
    nameByDir: new Map(all.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(all.map((pkg) => [pkg.name, pkg])),
  };
}

/** A `ReadDependencies` reader over a layout's root consumers. */
function readerFor(layout: Layout): ReadDependencies {
  const prefix = `${NAMESPACE_CONTAINER.microservice}/`;
  return (packageDir) => {
    if (packageDir === OVERSEER.packageDir) return layout.overseerDeps;
    if (packageDir.startsWith(prefix)) {
      const dirName = packageDir.slice(prefix.length);
      return (
        layout.microservices.find((pkg) => pkg.dirName === dirName)
          ?.dependencySpecifiers ?? []
      );
    }
    return [];
  };
}

/** The Microservice_Identifiers a layout discovers, in discovery order. */
function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

/** The repo-relative package directory of a Microservice_Identifier. */
function microserviceDir(identifier: string): string {
  return `${NAMESPACE_CONTAINER.microservice}/${identifier}`;
}

// ---------------------------------------------------------------------------
// The Compile_Time_Prerequisite oracle — straight from isCompileTimePrerequisite
// ---------------------------------------------------------------------------
//
// A directed edge `prerequisite → dependent` over repo-relative package
// directories: the compiled output of `prerequisite` is read by the compilation
// of `dependent`. Written from the Bug Condition, NOT by calling
// prerequisiteEdges (which does not exist yet).

interface PrereqEdge {
  /** The package that must be built first. */
  readonly prerequisite: string;
  /** The package that reads the prerequisite's compiled output. */
  readonly dependent: string;
}

/**
 * The Prerequisite_Graph of a layout for one set of Selected_Microservices,
 * expressed over package directories.
 *
 * Two edge kinds, exactly as `isCompileTimePrerequisite` defines them:
 *   1. every declared `@microservices`-scoped specifier resolving to a NON-Spa
 *      package (a Spa_Package target is excluded unconditionally — 2.6);
 *   2. `Overseer → each Selected_Microservice` — the edge the generated registry
 *      creates and no manifest may declare.
 *
 * The declarers considered are every library, every Selected_Microservice, and
 * the Overseer. A specifier resolving to `contracts` becomes an edge from the
 * Framework_Singleton's directory, so the contracts-first obligation is checked
 * over real edges too.
 */
function prerequisiteEdgesOracle(
  layout: Layout,
  selected: readonly string[],
): readonly PrereqEdge[] {
  const all = allPackages(layout);
  const byName = new Map<string, ConsumerPackage>(
    all.map((pkg) => [pkg.name, pkg]),
  );
  const dirByName = new Map<string, string>([
    ...all.map((pkg) => [pkg.name, pkg.packageDir] as const),
    [CONTRACTS.name, CONTRACTS.packageDir],
  ]);

  const edges: PrereqEdge[] = [];

  const addDeclaredEdges = (
    specifiers: readonly string[],
    dependent: string,
  ): void => {
    for (const specifier of specifiers) {
      if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) continue;
      const prerequisiteDir = dirByName.get(specifier);
      if (prerequisiteDir === undefined) continue; // dangling; not generated here
      // 2.6: a Spa_Package is never a Compile_Time_Prerequisite.
      const resolved = byName.get(specifier);
      if (resolved !== undefined && resolved.category === "spa") continue;
      edges.push({ prerequisite: prerequisiteDir, dependent });
    }
  };

  for (const library of layout.libraries) {
    addDeclaredEdges(library.dependencySpecifiers, library.packageDir);
  }
  for (const identifier of selected) {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === identifier,
    );
    if (microservice !== undefined) {
      addDeclaredEdges(microservice.dependencySpecifiers, microservice.packageDir);
    }
  }
  addDeclaredEdges(layout.overseerDeps, OVERSEER.packageDir);

  // Overseer → each Selected_Microservice: the registry import edge.
  for (const identifier of selected) {
    edges.push({
      prerequisite: microserviceDir(identifier),
      dependent: OVERSEER.packageDir,
    });
  }

  return edges;
}

/**
 * Reports every Ordering_Violation in a produced order for a Prerequisite_Graph:
 * an edge whose prerequisite sits at a LATER position than its dependent (or is
 * absent from the order while its dependent is present). An empty result means
 * the order is sound. The check is symmetric — it does not assume which of the
 * two comes first.
 */
function orderingViolations(
  order: readonly string[],
  edges: readonly PrereqEdge[],
): readonly PrereqEdge[] {
  const position = new Map(order.map((dir, index) => [dir, index]));
  return edges.filter((edge) => {
    const prerequisitePos = position.get(edge.prerequisite);
    const dependentPos = position.get(edge.dependent);
    // Only meaningful when both endpoints appear in this order.
    if (prerequisitePos === undefined || dependentPos === undefined) {
      return false;
    }
    return prerequisitePos > dependentPos;
  });
}

// ---------------------------------------------------------------------------
// Selector resolution oracle — the identifiers a raw MICROSERVICES value selects
// ---------------------------------------------------------------------------

function referenceSelected(
  selector: string | undefined,
  discovered: readonly string[],
): readonly string[] {
  const raw = selector ?? "";
  if (raw.trim() === "*") return [...discovered];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? [...discovered] : entries;
}

// ---------------------------------------------------------------------------
// Generators — sample freely, and scope to the concrete failing shape
// ---------------------------------------------------------------------------

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter((s) => s.length > 0 && s.length <= 12);

const arbIdentifier: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]*$/)
  .filter((s) => s.length > 0 && s.length <= 12);

const arbLibraryEntry: fc.Arbitrary<{
  dirName: string;
  category: ConsumerCategory;
}> = fc.record({
  dirName: arbDirName,
  category: fc.constantFrom(...LIBRARY_CATEGORIES),
});

/** Per library position, a subarray of the EARLIER Common_Package names. */
function arbEarlierCommonSubsets(
  entries: readonly { dirName: string; category: ConsumerCategory }[],
): fc.Arbitrary<string[][]> {
  if (entries.length === 0) return fc.constant<string[][]>([]);
  return fc.tuple(
    ...entries.map((_, i) => {
      const earlierCommonNames = entries
        .slice(0, i)
        .filter((entry) => entry.category === "common")
        .map((entry) => `${WORKSPACE_SCOPE}/${entry.dirName}`);
      return fc.subarray(earlierCommonNames);
    }),
  );
}

/** Microservice_Packages, each depending on an arbitrary subset of the libraries. */
function arbMicroservices(
  libraryNames: readonly string[],
  libraryDirNames: readonly string[],
): fc.Arbitrary<ConsumerPackage[]> {
  return fc
    .uniqueArray(arbIdentifier, { minLength: 1, maxLength: 4 })
    .filter((ids) =>
      ids.every(
        (id) =>
          !libraryDirNames.includes(id) && !FRAMEWORK_DIR_NAMES.includes(id),
      ),
    )
    .chain((ids) =>
      fc
        .tuple(...ids.map(() => fc.subarray([...libraryNames])))
        .map((depsPerId) =>
          ids.map((id, i) => consumerPackage("microservice", id, depsPerId[i])),
        ),
    );
}

/**
 * A random layout: Common and Spa libraries in a DAG, at least one
 * Microservice_Package, and an Overseer always declaring `@microservices/contracts`.
 * Microservices and the Overseer may name any library, including a Spa_Package,
 * so `microservice → spa` and `overseer → spa` edges arise — the very edges that
 * (before the fix) pull a Microservice_Package past the Overseer.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .uniqueArray(arbLibraryEntry, {
    minLength: 0,
    maxLength: 5,
    selector: (entry) => entry.dirName,
  })
  .filter((entries) =>
    entries.every((entry) => !FRAMEWORK_DIR_NAMES.includes(entry.dirName)),
  )
  .chain((entries) => {
    const libraryNames = entries.map(
      (entry) => `${WORKSPACE_SCOPE}/${entry.dirName}`,
    );
    const libraryDirNames = entries.map((entry) => entry.dirName);

    return arbEarlierCommonSubsets(entries).chain((depsPerLibrary) => {
      const libraries = entries.map((entry, i) =>
        consumerPackage(entry.category, entry.dirName, depsPerLibrary[i]),
      );

      return arbMicroservices(libraryNames, libraryDirNames).chain(
        (microservices) =>
          fc.subarray([...libraryNames]).map((extraOverseerDeps) => ({
            libraries,
            microservices,
            overseerDeps: [
              ...new Set([CONTRACTS.name, ...extraOverseerDeps]),
            ].sort(),
          })),
      );
    });
  });

/**
 * The concrete failing shape, scoped rather than sampled: a Microservice_Package
 * declares a Spa_Package whose `packageDir` sorts AFTER `packages/overseer`.
 *
 * This is exactly the committed tree's `microservice1 → @microservices/demo` at
 * `packages/spa/demo` (`s` > `o`). The Spa_Package declares nothing, so the sort
 * would hold it to the end were it not pulled forward by its microservice
 * dependent; the microservice, waiting on the Spa_Package, is thereby pushed past
 * the Overseer — and the Overseer's registry names that microservice, so the
 * Overseer precedes its own prerequisite. The `spaDirName` is chosen to sort
 * after `overseer` so the pull is guaranteed.
 */
const arbSpaAfterOverseerCase: fc.Arbitrary<Layout> = fc
  .record({
    // A directory name that sorts after "overseer": start with a letter > 'o'.
    spaDirName: fc
      .stringMatching(/^[p-z][a-z0-9-]*$/)
      .filter((s) => s.length > 0 && s.length <= 12),
    microserviceId: arbIdentifier.filter((id) => !FRAMEWORK_DIR_NAMES.includes(id)),
  })
  .filter(
    ({ spaDirName, microserviceId }) =>
      spaDirName !== microserviceId &&
      !FRAMEWORK_DIR_NAMES.includes(spaDirName) &&
      // The Spa_Package directory must sort strictly after packages/overseer.
      `${NAMESPACE_CONTAINER.spa}/${spaDirName}` > OVERSEER.packageDir,
  )
  .map(({ spaDirName, microserviceId }) => {
    const spa = consumerPackage("spa", spaDirName, []);
    const microservice = consumerPackage("microservice", microserviceId, [
      CONTRACTS.name,
      spa.name,
    ]);
    return {
      libraries: [spa],
      microservices: [microservice],
      overseerDeps: [CONTRACTS.name],
    };
  });

// ---------------------------------------------------------------------------
// The committed-tree example — reproducible without a seed (non-generated)
// ---------------------------------------------------------------------------
//
// A hand-built layout mirroring the committed tree at 35156ce: microservice1
// declares @microservices/demo (a Spa_Package at packages/spa/demo, `s` > `o`).
// It is here so the counterexample is reproducible with no PBT seed.

const committedTreeLayout: Layout = {
  libraries: [
    consumerPackage("common", "config", [CONTRACTS.name]),
    consumerPackage("common", "extended-config", [
      CONTRACTS.name,
      `${WORKSPACE_SCOPE}/config`,
    ]),
    consumerPackage("spa", "demo", []),
  ],
  microservices: [
    consumerPackage("microservice", "microservice1", [
      CONTRACTS.name,
      `${WORKSPACE_SCOPE}/demo`,
    ]),
    consumerPackage("microservice", "microservice2", [
      CONTRACTS.name,
      `${WORKSPACE_SCOPE}/config`,
    ]),
    consumerPackage("microservice", "microservice3", [
      CONTRACTS.name,
      `${WORKSPACE_SCOPE}/extended-config`,
    ]),
  ],
  overseerDeps: [CONTRACTS.name],
};

// ---------------------------------------------------------------------------
// Property 1: Bug Condition — no produced order contains an Ordering_Violation
// ---------------------------------------------------------------------------

/** The Workspace_Build_Order over a layout, as the CLI shell would derive it. */
function workspaceOrderOf(layout: Layout): readonly string[] {
  const nodes = workspaceNodesFrom(
    CONTEXT,
    discoveryOf(layout),
    readerFor(layout),
  );
  return workspaceBuildOrder(CONTEXT, nodes).map((node) => node.packageDir);
}

/** The Tsc_Root_Order for a layout and a raw Selector value. */
function tscRootsOf(
  layout: Layout,
  selector: string | undefined,
): readonly string[] {
  return buildPlanFrom(CONTEXT, selector, discoveryOf(layout), readerFor(layout))
    .tscRoots;
}

/**
 * Asserts both public derivations are free of Ordering_Violations for a layout.
 *
 * The Workspace_Build_Order carries every workspace package and every Selector's
 * microservices; the all-Selector's Prerequisite_Graph is the widest, so the
 * repository-wide order is checked against it. The Tsc_Root_Order is checked
 * against the graph for the Selector it was built with.
 */
function assertNoViolations(layout: Layout, selector: string | undefined): void {
  const allSelected = discoveredIdentifiers(layout);
  const wideEdges = prerequisiteEdgesOracle(layout, allSelected);

  const workspaceOrder = workspaceOrderOf(layout);
  const workspaceViolations = orderingViolations(workspaceOrder, wideEdges);
  expect(
    workspaceViolations,
    `Workspace_Build_Order Ordering_Violation(s): ${JSON.stringify(
      workspaceViolations,
    )}\norder: ${JSON.stringify(workspaceOrder)}`,
  ).toEqual([]);

  const selected = referenceSelected(selector, allSelected);
  const scopedEdges = prerequisiteEdgesOracle(layout, selected);
  const tscRoots = tscRootsOf(layout, selector);
  const tscViolations = orderingViolations(tscRoots, scopedEdges);
  expect(
    tscViolations,
    `Tsc_Root_Order Ordering_Violation(s): ${JSON.stringify(
      tscViolations,
    )}\nselector: ${JSON.stringify(selector)}\nroots: ${JSON.stringify(
      tscRoots,
    )}`,
  ).toEqual([]);

  // In particular, every Selected_Microservice precedes packages/overseer in both.
  const overseerInWorkspace = workspaceOrder.indexOf(OVERSEER.packageDir);
  for (const identifier of allSelected) {
    const msIdx = workspaceOrder.indexOf(microserviceDir(identifier));
    if (msIdx >= 0 && overseerInWorkspace >= 0) {
      expect(
        msIdx,
        `Selected_Microservice "${identifier}" must precede the Overseer in the Workspace_Build_Order`,
      ).toBeLessThan(overseerInWorkspace);
    }
  }
  const overseerInRoots = tscRoots.indexOf(OVERSEER.packageDir);
  for (const identifier of selected) {
    const msIdx = tscRoots.indexOf(microserviceDir(identifier));
    if (msIdx >= 0 && overseerInRoots >= 0) {
      expect(
        msIdx,
        `Selected_Microservice "${identifier}" must precede the Overseer in the Tsc_Root_Order`,
      ).toBeLessThan(overseerInRoots);
    }
  }
}

describe("Property 1: Bug Condition — no produced order contains an Ordering_Violation", () => {
  it("holds for the committed tree (microservice1 → @microservices/demo at packages/spa/demo)", () => {
    // Non-generated example so the counterexample reproduces without a seed.
    // On unfixed code this FAILS: the derived order is contracts, build-tools,
    // common/config, common/extended-config, microservice2, microservice3,
    // overseer (7), spa/demo (8), microservice1 (9), and the Overseer's registry
    // makes microservice1 a Compile_Time_Prerequisite of the Overseer — yet
    // microservice1 sits after it.
    assertNoViolations(committedTreeLayout, "*");
  });

  it("holds for the scoped failing shape: a microservice declaring a Spa_Package that sorts after the Overseer", () => {
    fc.assert(
      fc.property(arbSpaAfterOverseerCase, (layout) => {
        assertNoViolations(layout, "*");
      }),
      { numRuns: 100 },
    );
  });

  it("holds for freely sampled layouts and Selectors", () => {
    fc.assert(
      fc.property(
        arbLayout.chain((layout) =>
          fc
            .constantFrom<string | undefined>(
              undefined,
              "",
              "*",
              ...discoveredIdentifiers(layout),
            )
            .map((selector) => ({ layout, selector })),
        ),
        ({ layout, selector }) => {
          assertNoViolations(layout, selector);
        },
      ),
      { numRuns: 200 },
    );
  });
});

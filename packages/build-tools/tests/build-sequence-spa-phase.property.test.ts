// Feature: unified-build-order, Property 6: Every Spa_Package follows every Tsc_Project, on both paths
// Feature: unified-build-order, Property 7: A Spa_Package is never a Compile_Time_Prerequisite
//
// The Spa half of the Build_Sequence: statement 7 is a trailing bundler phase in
// the Workspace_Build_Order, and a Spa_Package is absent from the Tsc_Root_Order
// and from the Prerequisite_Graph entirely (2.4, 2.6). Both properties run over
// the widened in-memory layout model — every Consumer_Category, the four
// Framework_Singletons as nodes, an optional planted `microservice → spa` /
// `overseer → spa` edge — pure over an injected `Discovery` and
// `ReadDependencies`, no filesystem, no `process` (2.13).
//
// Property 6 drives three surfaces:
//   - the Workspace_Build_Order via
//     `workspaceBuildOrder(workspaceNodesFrom(...))`, checking no Tsc_Project
//     follows a Spa_Package;
//   - the Tsc_Root_Order via `buildPlanFrom(...).tscRoots`, checking no
//     Spa_Package appears at all;
//   - `executeBuildPlan(plan, outDir, runner, stage)` with a recording runner,
//     checking every bundler `npm run build` runs strictly after the single
//     `npx tsc --build`. This last seam is the one
//     `spa-build-sequencing.property.test.ts` already drives (D7); it is left
//     untouched, and Property 6 reuses only its shape here.
//
// Property 7 builds layouts that DO carry a `microservice → spa` or
// `overseer → spa` edge and confirms the Spa exclusion of 2.6: no prerequisite
// edge names the Spa_Package, the pass reports no violation for the legal edge
// (whichever way its endpoints appear), and the Spa_Package is nonetheless a
// Required_Dependency, in the stage set, and in `plan.spaBuilds`.
//
// Validates: Requirements 2.4, 2.5, 2.6, 2.11, 2.14, 3.15

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildPlanFrom, type BuildPlan } from "../src/build-plan.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import {
  prerequisiteEdges,
  verifyBuildOrder,
  buildSequence,
} from "../src/build-sequence.js";
import {
  executeBuildPlan,
  type CommandRunner,
} from "../src/image-tree.js";
import {
  BUILD_TOOLS,
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
  INTEGRATION_TESTS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";

/** Framework directory names as data, so no generator collides with one. */
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

// ---------------------------------------------------------------------------
// The widened in-memory layout model (same shape as build-sequence.property.test.ts)
// ---------------------------------------------------------------------------

interface Layout {
  readonly commons: readonly ConsumerPackage[];
  readonly microservices: readonly ConsumerPackage[];
  readonly spas: readonly ConsumerPackage[];
  readonly frameworkDeps: Readonly<Record<string, readonly string[]>>;
}

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
    dependencySpecifiers: [...new Set(dependencySpecifiers)].sort(),
    buildKind: buildKindOf(category),
  };
}

function allConsumers(layout: Layout): readonly ConsumerPackage[] {
  return [...layout.commons, ...layout.microservices, ...layout.spas];
}

function byDirName(a: ConsumerPackage, b: ConsumerPackage): number {
  return a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;
}

function discoveryOf(layout: Layout): Discovery {
  const all = [...allConsumers(layout)];
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

function readerFor(layout: Layout): ReadDependencies {
  const specifiersByDir = new Map<string, readonly string[]>([
    ...Object.entries(layout.frameworkDeps),
    ...allConsumers(layout).map(
      (pkg) => [pkg.packageDir, pkg.dependencySpecifiers] as const,
    ),
  ]);
  return (packageDir) => specifiersByDir.get(packageDir) ?? [];
}

function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

/** No-contracts default framework specifiers. */
function frameworkDepsWithContractsMaybe(
  overseerNamesContracts: boolean,
): Record<string, readonly string[]> {
  return {
    [CONTRACTS.packageDir]: [],
    [BUILD_TOOLS.packageDir]: [],
    [OVERSEER.packageDir]: overseerNamesContracts ? [CONTRACTS.name] : [],
    [INTEGRATION_TESTS.packageDir]: [],
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]*$/)
  .filter((s) => s.length >= 1 && s.length <= 8);

/**
 * A base layout: 0..k commons, 1..k microservices, 0..k spas, unique directory
 * names. Base edges point backwards across the statement structure only, so the
 * graph is a sound DAG (see build-sequence.property.test.ts for the full
 * rationale). Used by Property 6, where any layout — with or without a Spa — is
 * legal.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .record({
    commons: fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 3 }),
    microservices: fc.uniqueArray(arbDirName, { minLength: 1, maxLength: 3 }),
    spas: fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 2 }),
  })
  .filter(({ commons, microservices, spas }) => {
    const all = [...commons, ...microservices, ...spas];
    return (
      new Set(all).size === all.length &&
      all.every((d) => !FRAMEWORK_DIR_NAMES.includes(d))
    );
  })
  .chain(({ commons, microservices, spas }) => {
    const commonNames = commons.map((d) => `${WORKSPACE_SCOPE}/${d}`);
    const commonBackEdges = commons.map((_, i) =>
      fc.subarray(commonNames.slice(0, i)),
    );
    const microserviceBackEdges = microservices.map(() =>
      fc.subarray([...commonNames]),
    );
    const spaBackEdges = spas.map(() => fc.subarray([...commonNames]));

    return fc
      .tuple(
        fc.tuple(...commonBackEdges),
        fc.tuple(...microserviceBackEdges),
        fc.tuple(...spaBackEdges),
        fc.boolean(),
      )
      .map(([commonDeps, microserviceDeps, spaDeps, ovContracts]) => ({
        commons: commons.map((d, i) =>
          consumerPackage("common", d, commonDeps[i]),
        ),
        microservices: microservices.map((d, i) =>
          consumerPackage("microservice", d, microserviceDeps[i]),
        ),
        spas: spas.map((d, i) => consumerPackage("spa", d, spaDeps[i])),
        frameworkDeps: frameworkDepsWithContractsMaybe(ovContracts),
      }));
  });

/**
 * A layout guaranteed to carry a `microservice → spa` or `overseer → spa` edge,
 * with the Spa_Package REACHABLE (so it becomes a required dependency): one Spa
 * package, one microservice pointed at it, the Overseer optionally also pointed
 * at it, and that microservice as the Selector.
 */
const arbSpaEdgeCase: fc.Arbitrary<{
  layout: Layout;
  selector: string;
  spaDirName: string;
  edge: "microservice" | "overseer";
}> = fc
  .record({
    serviceName: arbDirName,
    spaName: arbDirName,
    edge: fc.constantFrom<"microservice" | "overseer">(
      "microservice",
      "overseer",
    ),
  })
  .filter(
    ({ serviceName, spaName }) =>
      serviceName !== spaName &&
      !FRAMEWORK_DIR_NAMES.includes(serviceName) &&
      !FRAMEWORK_DIR_NAMES.includes(spaName),
  )
  .map(({ serviceName, spaName, edge }) => {
    const spa = consumerPackage("spa", spaName, []);
    // The microservice always reaches the spa when the edge is microservice→spa;
    // when the edge is overseer→spa the microservice reaches it too (so it is a
    // required dependency of the selected microservice OR the Overseer), keeping
    // the Spa in the Required_Dependencies for both edge kinds.
    const serviceDeps = edge === "microservice" ? [spa.name] : [];
    const service = consumerPackage("microservice", serviceName, serviceDeps);
    const overseerDeps =
      edge === "overseer" ? [CONTRACTS.name, spa.name] : [CONTRACTS.name];

    const layout: Layout = {
      commons: [],
      microservices: [service],
      spas: [spa],
      frameworkDeps: {
        [CONTRACTS.packageDir]: [],
        [BUILD_TOOLS.packageDir]: [],
        [OVERSEER.packageDir]: overseerDeps,
        [INTEGRATION_TESTS.packageDir]: [],
      },
    };
    return { layout, selector: serviceName, spaDirName: spaName, edge };
  });

const NUM_RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// Recording runner for executeBuildPlan (the D7 seam)
// ---------------------------------------------------------------------------

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

/** Records every invocation before returning; never throws (all builds pass). */
function recordingRunner(): { run: CommandRunner; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const run: CommandRunner = (command, args, options) => {
    invocations.push({ command, args, cwd: options?.cwd });
  };
  return { run, invocations };
}

/** A staging spy that records nothing but that it ran, so no filesystem is touched. */
function noopStage(): (plan: BuildPlan, outDir: string) => void {
  return () => {
    /* intentionally empty: Property 6 does not stage */
  };
}

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 6: Every Spa_Package follows every Tsc_Project, on both paths
describe("Property 6: every Spa_Package follows every Tsc_Project, on both paths", () => {
  it("places no Tsc_Project after any Spa_Package in the Workspace_Build_Order", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const nodes = workspaceNodesFrom(discoveryOf(layout), readerFor(layout));
        const order = workspaceBuildOrder(nodes).map((n) => n.packageDir);

        const spaDirs = new Set(layout.spas.map((pkg) => pkg.packageDir));
        // Every non-Spa workspace node is a Tsc_Project (the four singletons,
        // every common, every microservice). The first Spa position must be
        // after the last Tsc_Project position.
        const firstSpaIndex = order.findIndex((dir) => spaDirs.has(dir));
        if (firstSpaIndex === -1) return; // no Spa: nothing to order after

        for (let i = 0; i < order.length; i += 1) {
          if (!spaDirs.has(order[i])) {
            // A Tsc_Project. It must not sit after any Spa_Package: so its index
            // is before the first Spa index.
            expect(i).toBeLessThan(firstSpaIndex);
          }
        }
        // And every Spa_Package sits at or after the first Spa index — i.e. the
        // Spa_Packages form a contiguous trailing block.
        for (let i = firstSpaIndex; i < order.length; i += 1) {
          expect(spaDirs.has(order[i])).toBe(true);
        }
      }),
      NUM_RUNS,
    );
  });

  it("puts no Spa_Package in the Tsc_Root_Order at all, for any Selector", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const spaDirs = new Set(layout.spas.map((pkg) => pkg.packageDir));
        const selectors: readonly (string | undefined)[] = [
          undefined,
          "*",
          discoveredIdentifiers(layout).join(","),
        ];
        for (const selector of selectors) {
          const tscRoots = buildPlanFrom(
            selector,
            discoveryOf(layout),
            readerFor(layout),
          ).tscRoots;
          for (const dir of tscRoots) {
            expect(spaDirs.has(dir)).toBe(false);
          }
        }
      }),
      NUM_RUNS,
    );
  });

  it("runs every bundler npm run build strictly after the single npx tsc --build (executeBuildPlan)", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const plan = buildPlanFrom(
          "*",
          discoveryOf(layout),
          readerFor(layout),
        );
        const { run, invocations } = recordingRunner();

        executeBuildPlan(plan, "/out", run, noopStage());

        // Exactly one `npx tsc --build …tscRoots`, at position 0.
        const tscIndices = invocations
          .map((inv, i) => (inv.command === "npx" ? i : -1))
          .filter((i) => i >= 0);
        expect(tscIndices).toEqual([0]);
        expect([
          invocations[0].command,
          ...invocations[0].args,
        ]).toEqual(["npx", "tsc", "--build", ...plan.tscRoots]);

        // Every `npm run build` bundler invocation is strictly after it, one per
        // required Spa_Package in its own directory.
        const npmIndices = invocations
          .map((inv, i) => (inv.command === "npm" ? i : -1))
          .filter((i) => i >= 0);
        expect(npmIndices.length).toBe(plan.spaBuilds.length);
        expect(npmIndices.every((i) => i > 0)).toBe(true);
        const npmCwds = npmIndices.map((i) => invocations[i].cwd);
        expect([...npmCwds].sort()).toEqual(
          [...plan.spaBuilds.map((s) => s.packageDir)].sort(),
        );
      }),
      NUM_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 7: A Spa_Package is never a Compile_Time_Prerequisite
describe("Property 7: a Spa_Package is never a Compile_Time_Prerequisite", () => {
  it("produces no prerequisite edge whose prerequisite is the Spa_Package, and the pass reports no violation for the legal edge", () => {
    fc.assert(
      fc.property(arbSpaEdgeCase, ({ layout, selector, spaDirName }) => {
        const nodes = workspaceNodesFrom(discoveryOf(layout), readerFor(layout));
        const selected = [selector];
        const edges = prerequisiteEdges(nodes, selected);

        const spaDir = `${NAMESPACE_CONTAINER.spa}/${spaDirName}`;
        // No edge names the Spa_Package as a prerequisite (2.6): the declared
        // `microservice → spa` / `overseer → spa` edge is a staging fact, never
        // an ordering one.
        expect(edges.some((e) => e.prerequisite === spaDir)).toBe(false);

        // The Workspace_Build_Order over these nodes verifies clean — the legal
        // Spa edge produces no violation whichever way its endpoints fall (the
        // Spa follows every Tsc_Project as statement 7, so even a positional
        // check has nothing to complain about).
        const order = buildSequence({
          common: layout.commons,
          microservices: layout.microservices.map((pkg) => pkg.dirName),
          spa: layout.spas,
          buildTools: true,
          testOnly: true,
        });
        expect(verifyBuildOrder(order, edges)).toEqual([]);

        // workspaceBuildOrder (which runs the throwing pass) succeeds too.
        expect(() => workspaceBuildOrder(nodes)).not.toThrow();
      }),
      NUM_RUNS,
    );
  });

  it("still makes the Spa_Package a Required_Dependency, a stage-set member, and a plan.spaBuilds member", () => {
    fc.assert(
      fc.property(arbSpaEdgeCase, ({ layout, selector, spaDirName }) => {
        const plan = buildPlanFrom(
          selector,
          discoveryOf(layout),
          readerFor(layout),
        );
        const spaDir = `${NAMESPACE_CONTAINER.spa}/${spaDirName}`;

        // In the Required_Dependencies (the BUILD set).
        expect(
          plan.requiredDependencies.some((pkg) => pkg.packageDir === spaDir),
        ).toBe(true);

        // In `plan.spaBuilds` (built by its own `npm run build`).
        expect(plan.spaBuilds.some((pkg) => pkg.packageDir === spaDir)).toBe(
          true,
        );

        // In the stage set: a Spa_Package ships as node_modules/@microservices/<name>.
        expect(
          plan.stage.some((staged) => staged.scopedEntry === spaDirName),
        ).toBe(true);

        // But NOT a tsc --build root — its ordering force is nil (2.6, 2.4).
        expect(plan.tscRoots.includes(spaDir)).toBe(false);

        // Sanity: the Spa is not a prerequisite even under the plan's Selector.
        const nodes = workspaceNodesFrom(
          discoveryOf(layout),
          readerFor(layout),
        );
        const edges = prerequisiteEdges(nodes, plan.selected);
        expect(edges.some((e) => e.prerequisite === spaDir)).toBe(false);
      }),
      NUM_RUNS,
    );
  });
});

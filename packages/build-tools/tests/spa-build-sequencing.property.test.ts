// Feature: package-categories, Property 18: The Bundler_Build_Phase is exactly the required Spa_Packages, each built once in its own directory, entirely after the Tsc_Build_Pass
//
// The property test for the build half of the Image_Assembler's order of
// operations. It replaces the retired `spa-build-sequencing.test.ts`, whose
// hand-written examples pinned the PRE-correction order (every Spa build first,
// then the single `tsc --build`). That order asserted the bug — a Spa_Package
// is a sink in the import graph, so its bundler build can only run AFTER the
// Tsc_Build_Pass has produced the `dist/` of every Common_Package it inlines
// (R6.12, R6.13) — and so the old file could not be amended into correctness.
//
// Task 13.3 inverted `executeBuildPlan`: it now runs the single
//   npx tsc --build …plan.tscRoots
// FIRST (the Tsc_Build_Pass, R6.5), then one `npm run build` per
// `plan.spaBuilds` member in that member's own directory (the
// Bundler_Build_Phase, R6.4), then the injected `stage` step. Because both
// build phases precede staging and the runner throws on the first non-zero
// exit, a failed build aborts with the Image_Tree still empty: a non-zero `tsc
// --build` yields ZERO bundler invocations and no staging (R6.10); a non-zero
// Spa build yields no staging (R6.9).
//
// `executeBuildPlan(plan, outDir, runner, stage)` is the seam. This suite drives
// it with a recording `CommandRunner` — capturing every invocation's command,
// args, and cwd IN ORDER — and an injected `stage` step that records whether it
// ran. No real `spawnSync`, no real filesystem, no real `tsc`. The recording
// runner models the real `run`'s failure the same way: `run` throws an `Error`
// on a non-zero exit, so the recording runner throws (after recording) when told
// to fail a chosen invocation, and `executeBuildPlan` aborts exactly as
// production would. The recording-runner / failing-runner design is the one the
// design's Testing Strategy names.
//
// Only `plan.tscRoots`, `plan.spaBuilds`, and `plan.stage` are read by
// `executeBuildPlan`, so the generated plans populate those three and leave the
// rest of the `BuildPlan` shape as inert filler. Varying over Selectors × Spa
// member counts means: an arbitrary set of `tsc --build` roots (the derivation
// that produced them is out of scope here — Property 16 owns it) crossed with
// 0..k required Spa_Packages. The "no non-required Spa_Package is built"
// obligation is enforced by construction: the recording runner can only ever
// invoke what the plan names, so the multiset of `npm run build` cwds is exactly
// `plan.spaBuilds`' directories.
//
// Validates: Requirements R6.5, R6.9, R6.10

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  SCOPE_DIR,
  type BuildPlan,
  type StagedPackage,
} from "../src/build-plan.js";
import type { ConsumerPackage } from "../src/discovery.js";
import { executeBuildPlan, type CommandRunner } from "../src/image-tree.js";

/** One recorded runner invocation, captured before any throw. */
interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

/**
 * A recording runner. Every invocation is pushed to `invocations` BEFORE any
 * throw, so the sequence up to and including a failing step is observable.
 *
 * `failOn` names a command whose FIRST matching invocation throws the way the
 * real {@link run} does on a non-zero exit (an `Error` whose message carries the
 * exit code): `"npx"` fails the single `tsc --build`, `"npm"` fails a Spa build.
 * Only the first matching invocation throws, which is enough — `executeBuildPlan`
 * aborts on it and never reaches a later one.
 */
function recordingRunner(failOn?: { command: string; exitCode: number }): {
  run: CommandRunner;
  invocations: Invocation[];
} {
  const invocations: Invocation[] = [];
  let thrown = false;
  const run: CommandRunner = (command, args, options) => {
    invocations.push({ command, args, cwd: options?.cwd });
    if (failOn && !thrown && command === failOn.command) {
      thrown = true;
      throw new Error(
        `[image-tree] "${command} ${args.join(" ")}" failed with exit code ${String(failOn.exitCode)}`,
      );
    }
  };
  return { run, invocations };
}

/** A staging spy: records how many times the injected `stage` step ran. */
function stagingSpy(): {
  stage: (plan: BuildPlan, outDir: string) => void;
  readonly calls: number;
} {
  let calls = 0;
  return {
    stage: (): void => {
      calls += 1;
    },
    get calls(): number {
      return calls;
    },
  };
}

/** One required Spa_Package the plan will build via `npm run build` in its own cwd. */
function spa(dirName: string): ConsumerPackage {
  return {
    category: "spa",
    dirName,
    packageDir: `packages/spa/${dirName}`,
    name: `@microservices/${dirName}`,
    dependencySpecifiers: [],
    buildKind: "bundler-project",
  };
}

/** A staged Microservice_Package landing under the workspace scope. */
function scoped(entry: string): StagedPackage {
  return {
    sourceDir: `packages/microservices/${entry}`,
    targetDir: `${SCOPE_DIR}/${entry}`,
    scopedEntry: entry,
    justification: "selected-microservice",
  };
}

/**
 * A plan populated only in the three fields `executeBuildPlan` reads —
 * `tscRoots`, `spaBuilds`, `stage`. `stage` is non-empty so a real staging step
 * would have something to copy; here the injected spy asserts it is NEVER
 * reached on failure, so its contents matter only as evidence that "nothing
 * staged" is a real abort and not an empty plan.
 */
function planWith(
  spaBuilds: readonly ConsumerPackage[],
  tscRoots: readonly string[],
): BuildPlan {
  return {
    selected: ["microservice1"],
    requiredDependencies: [],
    stagedDependencies: [],
    spaBuilds,
    tscRoots,
    stage: [scoped("microservice1")],
  };
}

/** The index of the single `tsc --build` invocation, or -1 if it never ran. */
function tscIndex(invocations: readonly Invocation[]): number {
  return invocations.findIndex((i) => i.command === "npx");
}

/** The indices of the `npm run build` (Spa) invocations, in recorded order. */
function spaIndices(invocations: readonly Invocation[]): number[] {
  return invocations
    .map((i, idx) => (i.command === "npm" ? idx : -1))
    .filter((idx) => idx >= 0);
}

// --- Generators: Selectors × Spa member counts ---------------------------

/**
 * An arbitrary, non-empty, duplicate-free set of `tsc --build` roots. The exact
 * derivation that produces them (contracts first, required Common_Packages, the
 * Selected_Microservices, the Overseer last) is Property 16's business; here
 * they are opaque strings the single `tsc --build` is passed verbatim, so any
 * distinct set exercises the same contract.
 */
const tscRootsArb: fc.Arbitrary<readonly string[]> = fc
  .uniqueArray(
    fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() !== ""),
    { minLength: 1, maxLength: 6 },
  )
  .map((roots) => roots);

/**
 * 0..k required Spa_Packages with distinct directory names. Zero members models
 * a Selector/layout with no Spa_Package (the two build phases collapse to just
 * the `tsc --build`); up to k models several, whose build ORDER among
 * themselves is deliberately unconstrained.
 */
const spaBuildsArb: fc.Arbitrary<readonly ConsumerPackage[]> = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-z0-9-]+$/.test(s)), {
    minLength: 0,
    maxLength: 5,
  })
  .map((names) => names.map(spa));

const planArb: fc.Arbitrary<BuildPlan> = fc
  .tuple(spaBuildsArb, tscRootsArb)
  .map(([spaBuilds, tscRoots]) => planWith(spaBuilds, tscRoots));

const NUM_RUNS = { numRuns: 200 } as const;

describe("Property 18: the Bundler_Build_Phase runs entirely after the Tsc_Build_Pass", () => {
  it("runs exactly one tsc --build over plan.tscRoots, then one npm run build per required Spa_Package in its own cwd — every bundler invocation strictly after the tsc invocation, and stages once (R6.5)", () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const { run, invocations } = recordingRunner();
        const staging = stagingSpy();

        executeBuildPlan(plan, "/out", run, staging.stage);

        // Total invocations: the one tsc --build plus one per required Spa build.
        expect(invocations).toHaveLength(1 + plan.spaBuilds.length);

        // Exactly one `npx tsc --build …plan.tscRoots`.
        const tsc = invocations.filter((i) => i.command === "npx");
        expect(tsc).toHaveLength(1);
        expect([tsc[0].command, ...tsc[0].args]).toEqual([
          "npx",
          "tsc",
          "--build",
          ...plan.tscRoots,
        ]);
        expect(tsc[0].cwd).toBeUndefined();

        // Every bundler invocation is `npm run build` with no ordering
        // required among them: the invocation MULTISET of cwds is exactly the
        // required Spa_Packages' own directories (R6.4). No non-required
        // Spa_Package is built — the runner can only invoke what the plan names.
        const npm = invocations.filter((i) => i.command === "npm");
        expect(npm).toHaveLength(plan.spaBuilds.length);
        for (const inv of npm) {
          expect([inv.command, ...inv.args]).toEqual(["npm", "run", "build"]);
        }
        expect([...npm.map((i) => i.cwd)].sort()).toEqual(
          [...plan.spaBuilds.map((s) => s.packageDir)].sort(),
        );
        // Each required Spa_Package built exactly once.
        const uniqueCwds = new Set(npm.map((i) => i.cwd));
        expect(uniqueCwds.size).toBe(plan.spaBuilds.length);

        // Every Spa build strictly AFTER the single tsc --build (R6.5).
        const t = tscIndex(invocations);
        expect(t).toBe(0);
        expect(spaIndices(invocations).every((idx) => idx > t)).toBe(true);

        // All builds succeeded, so staging ran exactly once.
        expect(staging.calls).toBe(1);
      }),
      NUM_RUNS,
    );
  });

  it("a non-zero tsc --build exit yields zero bundler invocations and no staging (R6.10)", () => {
    fc.assert(
      fc.property(planArb, fc.integer({ min: 1, max: 255 }), (plan, exitCode) => {
        const { run, invocations } = recordingRunner({ command: "npx", exitCode });
        const staging = stagingSpy();

        expect(() => executeBuildPlan(plan, "/out", run, staging.stage)).toThrow(
          /\[image-tree\] "npx tsc --build.*" failed with exit code/,
        );

        // The tsc --build ran first and failed: it is the only invocation, so
        // ZERO bundler builds ran and nothing was staged.
        expect(invocations).toHaveLength(1);
        expect(invocations[0].command).toBe("npx");
        expect(invocations.some((i) => i.command === "npm")).toBe(false);
        expect(staging.calls).toBe(0);
      }),
      NUM_RUNS,
    );
  });

  it("a non-zero Spa build stages nothing (R6.9)", () => {
    // Only meaningful when the plan has at least one Spa build to fail on.
    const planWithSpaArb = planArb.filter((plan) => plan.spaBuilds.length > 0);

    fc.assert(
      fc.property(planWithSpaArb, fc.integer({ min: 1, max: 255 }), (plan, exitCode) => {
        const { run, invocations } = recordingRunner({ command: "npm", exitCode });
        const staging = stagingSpy();

        expect(() => executeBuildPlan(plan, "/out", run, staging.stage)).toThrow(
          /\[image-tree\] "npm run build" failed with exit code/,
        );

        // The tsc --build ran and succeeded (it precedes the bundler phase),
        // then the FIRST Spa build ran and failed, aborting before any later
        // Spa build and before staging.
        expect(invocations[0].command).toBe("npx");
        const firstNpm = invocations.findIndex((i) => i.command === "npm");
        expect(firstNpm).toBe(1);
        // Nothing after the failing Spa build ran.
        expect(invocations).toHaveLength(2);
        expect(staging.calls).toBe(0);
      }),
      NUM_RUNS,
    );
  });
});

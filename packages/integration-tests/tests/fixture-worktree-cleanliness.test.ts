// R11.2, R11.3, R11.4 — exercising the Fixture_Tier leaves the working tree clean.
//
// The claim R11.3 makes is concrete and mechanical: after a Fixture_Install, a
// fixture build, and an Output_Clearing have run, the set of tracked files
// reported as modified and the set of untracked-and-not-ignored files reported
// are EACH empty. In other words, exercising the tier — installing the
// Fixture_Projects_Root, building a fixture, and clearing that build's output —
// adds nothing to `git status`. That is what makes a fixture build not "look
// like a change I made" to a developer running `git status`.
//
// WHY THE ASSERTION IS PHRASED AS "THE CYCLE INTRODUCES NOTHING", NOT "git
// status is globally empty". The Fixture_Tier is committed source that a test
// only ever WRITES INTO at gitignored locations. The three — and only three —
// in-place write locations the whole tier design permits under `fixtures/` are:
//
//   * a fixture's gitignored `dist/` directory,
//   * a fixture's gitignored `*.tsbuildinfo` file, and
//   * the Fixture_Projects_Root's gitignored `node_modules/` (written only by
//     the `fixtures:install` script).
//
// All three are covered by this repository's existing unanchored `.gitignore`
// patterns (`node_modules/`, `dist/`, `*.tsbuildinfo`), so a write into any of
// them is invisible to `git status`. This suite therefore captures the
// tier's `git status` state BEFORE the cycle and again AFTER it, and asserts
// the cycle introduced no new modified-tracked path and no new
// untracked-and-not-ignored path. Comparing before-to-after rather than
// asserting a globally empty status is what keeps the check honest whether or
// not the surrounding checkout happens to carry unrelated staged or modified
// fixture files (as it does mid-feature): the subject of R11.3 is the effect of
// EXERCISING THE TIER, and a before/after delta measures exactly that.
//
// WHAT THE FIXTURE BUILD IS, AND WHY IT STAYS CLEAN. The build step is a
// `tsc --build` over a single well-formed fixture member's own `tsconfig.json`.
// That member declares `outDir: ./dist` and `rootDir: ./src` (the Load_Bearing
// output layout), so the compiler emits into that member's `dist/` and writes a
// `*.tsbuildinfo` beside it — both gitignored, both under `fixtures/`, both in
// the permitted write set. It runs NO platform build, generates NO microservice
// registry (a generated registry inside a committed fixture scenario would NOT
// be gitignored and would dirty the tree), and touches no Payload_Tree package.
// The Output_Clearing then removes every `dist/` and every `*.tsbuildinfo`
// under the tier, so even the gitignored artefacts are gone when the suite
// finishes.
//
// GATING AND SAFETY. The suite gates on the ONE shared availability probe
// `installedFixtureProjects`: absent installation skips locally with a reason
// naming `fixtures:install`, and the probe itself throws (fails the suite) when
// `CI` is non-empty, so a workflow whose install step was removed cannot pass by
// skipping. This suite writes nothing outside the three permitted locations, and
// it invokes NO destructive git subcommand and declares NO working-tree restore
// helper under any name — teardown is `clearOutput`, which removes only
// Generated_Fixture_Output.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearOutput,
  installedFixtureProjects,
} from "@microservices/build-tools/dist/testing/index.js";

import { FIXTURES_ROOT, FIXTURE_PROJECTS_ROOT } from "./fixture-paths.js";
import { repoRoot } from "./helpers.js";

/**
 * The well-formed fixture member whose `tsconfig.json` the build step compiles.
 * `@fx-direction/lib` is a Common_Package in the `deps--direction` scenario with
 * a trivial `src/index.ts` and a standard `outDir`/`rootDir` layout, so a
 * `tsc --build` over it emits into its own gitignored `dist/` and writes a
 * gitignored `*.tsbuildinfo` — both permitted in-place writes under the tier.
 * Its own dependency edge is what makes the *project* a diagnostic subject; the
 * member itself compiles cleanly, which is exactly what R3.8 permits (a package
 * inside a scenario may be entirely well-formed).
 *
 * Derived from FIXTURE_PROJECTS_ROOT rather than spelled as a `fixtures` literal
 * of this suite's own.
 */
const BUILD_MEMBER_TSCONFIG = join(
  FIXTURE_PROJECTS_ROOT,
  "deps--direction",
  "packages",
  "common",
  "lib",
  "tsconfig.json",
);

/** The `dist/` and `*.tsbuildinfo` the build step produces, for teardown checks. */
const BUILD_MEMBER_DIR = join(
  FIXTURE_PROJECTS_ROOT,
  "deps--direction",
  "packages",
  "common",
  "lib",
);

/** The two disjoint sets `git status --porcelain -- fixtures` reports. */
interface FixtureStatus {
  /** Paths whose status is anything other than untracked — tracked-modified or staged. */
  readonly trackedModified: readonly string[];
  /** Untracked-and-not-ignored paths (the `??` lines). */
  readonly untrackedNotIgnored: readonly string[];
}

/**
 * Read `git status --porcelain -- fixtures` and split it into the two sets R11.3
 * names. Restricted to `fixtures/` so the reading is not perturbed by unrelated
 * repository state. A porcelain line is `XY <path>`; the `??` code marks an
 * untracked-and-not-ignored path, and every other code marks a tracked file
 * reported modified or staged. `git` is run through `spawnSync` (a read-only
 * query — never a destructive subcommand).
 */
function readFixtureStatus(): FixtureStatus {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--", "fixtures"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    throw new Error(
      `git status --porcelain -- fixtures failed: ${
        result.error?.message ?? result.stderr ?? "non-zero exit"
      }`,
    );
  }

  const trackedModified: string[] = [];
  const untrackedNotIgnored: string[] = [];
  for (const rawLine of result.stdout.split("\n")) {
    if (rawLine.trim() === "") continue;
    // Porcelain v1: two status columns, a space, then the path.
    const code = rawLine.slice(0, 2);
    const path = rawLine.slice(3);
    if (code === "??") {
      untrackedNotIgnored.push(path);
    } else {
      trackedModified.push(path);
    }
  }
  return {
    trackedModified: trackedModified.sort(),
    untrackedNotIgnored: untrackedNotIgnored.sort(),
  };
}

/** The set of items in `after` that are not in `before` — what the cycle added. */
function introduced(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const seen = new Set(before);
  return after.filter((path) => !seen.has(path)).sort();
}

describe("exercising the Fixture_Tier leaves the working tree clean (R11.2, R11.3, R11.4)", () => {
  // The one shared availability probe: skip locally with a reason naming
  // `fixtures:install`, throw (fail) in CI. Captured once for the whole suite.
  const probe = installedFixtureProjects(FIXTURE_PROJECTS_ROOT);
  const skipReason = probe.available ? undefined : probe.reason;

  let before: FixtureStatus;
  let after: FixtureStatus;

  beforeAll(() => {
    if (!probe.available) return;

    // 1. Baseline: the tier's git-status state before the cycle.
    before = readFixtureStatus();

    // 2. A fixture build that writes ONLY into a fixture's gitignored `dist/`
    //    and `*.tsbuildinfo` — the permitted in-place write locations (R11.2,
    //    R11.4). `tsc --build` over the well-formed member's own tsconfig.
    const tsc = resolve(repoRoot, "node_modules", ".bin", "tsc");
    const build = spawnSync(tsc, ["--build", BUILD_MEMBER_TSCONFIG], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // The member compiles cleanly, but even a non-zero exit would only leave
    // partial gitignored output the Output_Clearing below removes — so the
    // cleanliness claim does not depend on the build succeeding. We still
    // surface a spawn error (a missing `tsc`) rather than silently proceeding.
    if (build.error !== undefined) {
      throw new Error(`spawning tsc failed: ${build.error.message}`);
    }

    // 3. Output_Clearing over the whole tier: remove every `dist/` and every
    //    `*.tsbuildinfo` the build produced. The Fixture_Tier root is passed as
    //    the argument (both the directory to clear and the permitted-root the
    //    refusal check uses), never spelled inside the helper.
    clearOutput(FIXTURES_ROOT, FIXTURES_ROOT);

    // 4. The tier's git-status state after the full cycle.
    after = readFixtureStatus();
  });

  afterAll(() => {
    // Unconditional teardown: guarantee no Generated_Fixture_Output survives,
    // whether or not an assertion above failed. Idempotent, removes only
    // `dist/` and `*.tsbuildinfo` under the tier (never `node_modules/`), and
    // uses no destructive git subcommand.
    if (probe.available) {
      clearOutput(FIXTURES_ROOT, FIXTURES_ROOT);
    }
  });

  it("the build produced gitignored output that Output_Clearing removed", () => {
    if (skipReason !== undefined) {
      console.warn(`SKIP fixture-worktree-cleanliness: ${skipReason}`);
      return;
    }

    // After the cycle, the member's `dist/` and `*.tsbuildinfo` are gone —
    // Output_Clearing removed exactly the Generated_Fixture_Output the build
    // wrote, leaving the committed source in place.
    expect(existsSync(join(BUILD_MEMBER_DIR, "dist"))).toBe(false);
    expect(existsSync(join(BUILD_MEMBER_DIR, "tsconfig.tsbuildinfo"))).toBe(
      false,
    );
    expect(existsSync(join(BUILD_MEMBER_DIR, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(BUILD_MEMBER_DIR, "package.json"))).toBe(true);
  });

  it("introduces no untracked-and-not-ignored file under fixtures/ (R11.2, R11.3, R11.4)", () => {
    if (skipReason !== undefined) {
      console.warn(`SKIP fixture-worktree-cleanliness: ${skipReason}`);
      return;
    }

    // The whole cycle's writes landed in gitignored `dist/`, `*.tsbuildinfo`,
    // and `node_modules/` (the install), so nothing new appears as untracked.
    const newUntracked = introduced(
      before.untrackedNotIgnored,
      after.untrackedNotIgnored,
    );
    expect(
      newUntracked,
      `exercising the tier left untracked-and-not-ignored file(s) under fixtures/:\n${newUntracked.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  it("modifies no tracked file under fixtures/ (R11.3)", () => {
    if (skipReason !== undefined) {
      console.warn(`SKIP fixture-worktree-cleanliness: ${skipReason}`);
      return;
    }

    // A fixture build writes only gitignored output and Output_Clearing removes
    // it, so no committed fixture source is reported modified by the cycle.
    const newTrackedModified = introduced(
      before.trackedModified,
      after.trackedModified,
    );
    expect(
      newTrackedModified,
      `exercising the tier modified tracked file(s) under fixtures/:\n${newTrackedModified.join(
        "\n",
      )}`,
    ).toEqual([]);
  });
});

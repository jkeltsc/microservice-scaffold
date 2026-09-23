// @microservices/build-tools/dist/testing — the mutating-call fragment
// generator for Property 9 (Fixture_Tier spec, task 9.2; R9.3, R9.4,
// R16.10).
//
// WHAT THIS GENERATES, AND WHY THE VERDICT IS ATTACHED
// ---------------------------------------------------------------------------
// Each generated fragment is a single source LINE of a mutating fs call whose
// destination expression joins a generated ANCHOR with a generated TAIL:
//
//     writeFileSync(resolve(FIXTURES_ROOT, "trees", "x", "dist"), data)
//     ^call       ^anchor                                ^tail
//
// The generator KNOWS the verdict for each fragment it emits — whether the
// Worktree_Guard flags it or not — because it chose the anchor and the tail. So
// Property 9 asserts `flagWriteSpan(span, …) === (verdict === "flagged")`
// directly, never re-deriving the flagging predicate in the assertion.
//
// THE SIX CASES (design Property 9)
// ---------------------------------------------------------------------------
//   permitted, fixture anchor:
//     - a `dist/` tail under a fixture anchor       → location 4
//     - a `*.tsbuildinfo` tail under a fixture anchor → location 5
//     - a `node_modules` tail under FIXTURE_PROJECTS_ROOT → location 6
//   permitted, non-fixture anchor:
//     - a `dist/` or `*.tsbuildinfo` tail under repoRoot/TESTS_DIR/__dirname
//       → locations 1/2 apply anywhere in the checked-out tree
//   flagged, fixture anchor:
//     - a non-permitted tail (a manifest, a Scenario_Manifest, a source file)
//       under a fixture anchor → checked-out via the fixture anchor, R9.3
//   flagged, non-fixture anchor:
//     - a non-permitted tail under repoRoot/TESTS_DIR/__dirname, AND — the R9.4
//       asymmetry — a `node_modules` tail under a NON-fixture anchor, which
//       location 6 does NOT permit because it requires a fixture anchor.
//
// TOKEN FRAGMENTATION (R9.8-style discipline)
// ---------------------------------------------------------------------------
// The `writeFileSync`/`resolve`/`repoRoot` tokens the fragment lines carry are
// assembled from string fragments at RUNTIME (`"write" + "FileSync"`), so this
// module's own SOURCE never holds a contiguous `writeFileSync(… repoRoot …)`
// pattern. This module is not a `*.test.ts` and is reached only by the compiled
// package path, so it is not a Platform_Test_Set member and the Worktree_Guard
// never scans it — but the discipline is kept anyway, matching the guard's own
// and `migration-facts`', so a future rename cannot turn its fragment strings
// into a self-trip.
//
// R1.7 / [scope:literal]. Under `packages/build-tools/src/`: spells no
// Scope_Default and no Fixture_Tier path literal. The fixture-anchor NAMES it
// embeds (`FIXTURES_ROOT`, …) are identifiers, not path literals, and are the
// same constants the classifier recognises.

import * as fc from "fast-check";

import { MUTATING_FS } from "./worktree-classifier.js";

/** Whether the Worktree_Guard flags a fragment. Attached by the generator. */
export type WriteVerdict = "flagged" | "permitted";

/** One generated mutating-call fragment with its KNOWN verdict. */
export interface MutatingCallFragment {
  /** The full fragment source: a single physical line. */
  readonly line: string;
  /** The call's argument span — the balanced text between its parentheses. */
  readonly span: string;
  /**
   * Whether the fragment's file contains a temp-CREATING call. For a fixture- or
   * repo-anchored fragment the verdict does not depend on this (the anchor is a
   * fixture constant or `repoRoot`, not a bare `dir`/`root`), so it is generated
   * freely to exercise both settings.
   */
  readonly fileHasTempCreator: boolean;
  /** The verdict the generator knows for this fragment. */
  readonly verdict: WriteVerdict;
  /** A short label naming the case, for a legible counterexample. */
  readonly label: string;
}

// Tokens assembled at runtime so this source never holds a mutating call whole.
const RESOLVE = "res" + "olve";
const REPO_ROOT_TOKEN = "repo" + "Root";

/** The non-fixture Checked_Out_Anchors a fragment may use. `repoRoot` is
 *  assembled; the other two are plain identifiers the classifier matches. */
const NON_FIXTURE_ANCHORS: readonly string[] = [
  REPO_ROOT_TOKEN,
  "TESTS_DIR",
  "__dirname",
];

/** The fixture path constants a fragment may anchor at. */
const FIXTURE_ANCHORS: readonly string[] = [
  "FIXTURES_ROOT",
  "FIXTURE_TREES_ROOT",
  "FIXTURE_PROJECTS_ROOT",
];

/** Tails naming a permitted `dist/` output location. */
const DIST_TAILS: readonly string[][] = [
  ["dist"],
  ["packages", "x", "dist", "index.js"],
  ["trees", "x", "dist"],
];

/** Tails naming a permitted `*.tsbuildinfo` output. */
const TSBUILDINFO_TAILS: readonly string[][] = [
  ["tsconfig.tsbuildinfo"],
  ["packages", "x", "tsconfig.tsbuildinfo"],
];

/** A `node_modules` tail — permitted only under a fixture anchor (location 6). */
const NODE_MODULES_TAILS: readonly string[][] = [
  ["node_modules"],
  ["node_modules", "x", "package.json"],
];

/** Tails naming a non-permitted checked-out destination: a manifest, a
 *  Scenario_Manifest, a source file, a config. None contains `dist` or
 *  `tsbuildinfo` or `node_modules`, and none names the Generated_Registry. */
const NON_PERMITTED_TAILS: readonly string[][] = [
  ["fixture.json"],
  ["package.json"],
  ["packages", "microservice1", "src", "index.ts"],
  ["scaffold.config.json"],
  ["config--unparsable", "fixture.json"],
  ["barrel--invalid", "packages", "lib", "package.json"],
];

/** Renders a tail's segments as quoted `resolve` arguments: `"a", "b"`. */
function renderTail(tail: readonly string[]): string {
  return tail.map((segment) => JSON.stringify(segment)).join(", ");
}

/** Builds a mutating call fragment from a chosen mutating fs name, an anchor,
 *  and a tail. The call name is chosen from the mutating set; a single trailing
 *  data argument is added for the calls that take one so the line reads like a
 *  real write. The span is the exact `(…)` text the classifier will see. */
function buildFragment(params: {
  readonly call: string;
  readonly anchor: string;
  readonly tail: readonly string[];
  readonly fileHasTempCreator: boolean;
  readonly verdict: WriteVerdict;
  readonly label: string;
}): MutatingCallFragment {
  const { call, anchor, tail, fileHasTempCreator, verdict, label } = params;
  const destination = `${RESOLVE}(${anchor}, ${renderTail(tail)})`;
  // A mutating call's first argument is always the destination; a second
  // argument (payload) is harmless to the destination scan and is omitted so the
  // span stays a single clause the balanced-paren capture reads cleanly.
  const span = `(${destination})`;
  const line = `${call}${span};`;
  return { line, span, fileHasTempCreator, verdict, label };
}

/**
 * The Property 9 generator: a mutating-call fragment whose destination joins a
 * generated fixture-or-checked-out anchor with a generated tail, tagged with the
 * verdict the generator knows. Ranges over all six cases the design names.
 */
export function mutatingCallFragment(): fc.Arbitrary<MutatingCallFragment> {
  const call = fc.constantFrom(...MUTATING_FS);
  const tempFlag = fc.boolean();

  // Case A — permitted: a dist/ or tsbuildinfo tail under a FIXTURE anchor
  // (locations 4/5). Its text names the Fixture_Tier, so R9.4's in-fixture
  // permission applies.
  const fixturePermittedOutput = fc
    .tuple(
      call,
      fc.constantFrom(...FIXTURE_ANCHORS),
      fc.constantFrom(...DIST_TAILS, ...TSBUILDINFO_TAILS),
      tempFlag,
    )
    .map(([c, anchor, tail, temp]) =>
      buildFragment({
        call: c,
        anchor,
        tail,
        fileHasTempCreator: temp,
        verdict: "permitted",
        label: "fixture anchor + dist/tsbuildinfo tail (loc 4/5)",
      }),
    );

  // Case B — permitted: a node_modules tail under FIXTURE_PROJECTS_ROOT
  // (location 6). Permitted only because the anchor is a fixture constant.
  const fixtureNodeModules = fc
    .tuple(call, fc.constantFrom(...NODE_MODULES_TAILS), tempFlag)
    .map(([c, tail, temp]) =>
      buildFragment({
        call: c,
        anchor: "FIXTURE_PROJECTS_ROOT",
        tail,
        fileHasTempCreator: temp,
        verdict: "permitted",
        label: "FIXTURE_PROJECTS_ROOT + node_modules tail (loc 6)",
      }),
    );

  // Case C — permitted: a dist/ or tsbuildinfo tail under a NON-fixture
  // checked-out anchor (locations 1/2 apply anywhere in the checked-out tree).
  const nonFixturePermittedOutput = fc
    .tuple(
      call,
      fc.constantFrom(...NON_FIXTURE_ANCHORS),
      fc.constantFrom(...DIST_TAILS, ...TSBUILDINFO_TAILS),
      tempFlag,
    )
    .map(([c, anchor, tail, temp]) =>
      buildFragment({
        call: c,
        anchor,
        tail,
        fileHasTempCreator: temp,
        verdict: "permitted",
        label: "non-fixture anchor + dist/tsbuildinfo tail (loc 1/2)",
      }),
    );

  // Case D — flagged: a non-permitted tail under a FIXTURE anchor. A fixture
  // path is checked-out (R9.3), and the tail names no permitted location.
  const fixtureFlagged = fc
    .tuple(
      call,
      fc.constantFrom(...FIXTURE_ANCHORS),
      fc.constantFrom(...NON_PERMITTED_TAILS),
      tempFlag,
    )
    .map(([c, anchor, tail, temp]) =>
      buildFragment({
        call: c,
        anchor,
        tail,
        fileHasTempCreator: temp,
        verdict: "flagged",
        label: "fixture anchor + non-permitted tail (R9.3)",
      }),
    );

  // Case E — flagged: a non-permitted tail under a NON-fixture checked-out
  // anchor. The classic pre-feature violation shape.
  const nonFixtureFlagged = fc
    .tuple(
      call,
      fc.constantFrom(...NON_FIXTURE_ANCHORS),
      fc.constantFrom(...NON_PERMITTED_TAILS),
      tempFlag,
    )
    .map(([c, anchor, tail, temp]) =>
      buildFragment({
        call: c,
        anchor,
        tail,
        fileHasTempCreator: temp,
        verdict: "flagged",
        label: "non-fixture anchor + non-permitted tail",
      }),
    );

  // Case F — flagged, the R9.4 ASYMMETRY: a node_modules tail under a NON-fixture
  // anchor. Location 6 permits node_modules ONLY under a fixture anchor, so the
  // repository's own node_modules is still a violation. The text does NOT name
  // the Fixture_Tier, so the in-fixture permission does not apply.
  const nonFixtureNodeModules = fc
    .tuple(
      call,
      fc.constantFrom(...NON_FIXTURE_ANCHORS),
      fc.constantFrom(...NODE_MODULES_TAILS),
      tempFlag,
    )
    .map(([c, anchor, tail, temp]) =>
      buildFragment({
        call: c,
        anchor,
        tail,
        fileHasTempCreator: temp,
        verdict: "flagged",
        label: "non-fixture anchor + node_modules tail (R9.4 asymmetry)",
      }),
    );

  return fc.oneof(
    fixturePermittedOutput,
    fixtureNodeModules,
    nonFixturePermittedOutput,
    fixtureFlagged,
    nonFixtureFlagged,
    nonFixtureNodeModules,
  );
}

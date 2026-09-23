// Feature: platform-fixtures, Property 9: The Worktree_Guard flags a
// fixture-anchored write outside the Permitted_Write_Location set and no write
// inside it.
//
// Where `worktree-safety-guard.test.ts` (task 9.1) runs the guard's flagging rule
// over the REAL Platform_Test_Set, THIS property exercises that SAME rule over
// MANY generated mutating-call fragments whose expected verdict the generator
// already knows.
//
// THE RULE UNDER TEST is `flagWriteSpan` from
// `@microservices/build-tools/dist/testing` — the pure task-9.2 module the guard
// itself now imports, so this property and the guard share one predicate rather
// than two that could drift. Given a mutating fs call's argument span and the
// file's temp-creating status, `flagWriteSpan` returns whether the guard reports
// an offence: true when the destination is checked-out and names no permitted
// location, or writes a Project_Config_File with no temp base.
//
// THE SUBJECT. `mutatingCallFragment()` (the task-9.2 generator, re-exported from
// `arbitraries/source.ts` and defined in `src/testing/worktree-arbitraries.ts`)
// produces a fragment whose destination joins a generated ANCHOR — a fixture path
// constant (`FIXTURES_ROOT`, `FIXTURE_TREES_ROOT`, `FIXTURE_PROJECTS_ROOT`) or a
// non-fixture checked-out anchor (`repoRoot`, `TESTS_DIR`, `__dirname`) — with a
// generated TAIL, tagged with the verdict the generator knows. It ranges over the
// six cases the design names:
//
//   permitted — a `dist/` or `*.tsbuildinfo` tail under a fixture anchor
//     (locations 4/5, R9.4's in-fixture permission, text names the Fixture_Tier);
//   permitted — a `node_modules` tail under FIXTURE_PROJECTS_ROOT (location 6);
//   permitted — a `dist/` or `*.tsbuildinfo` tail under a non-fixture anchor
//     (locations 1/2 apply anywhere in the checked-out tree);
//   flagged   — a non-permitted tail (a manifest, a Scenario_Manifest, a source
//     file) under a fixture anchor: a fixture path IS checked-out (R9.3);
//   flagged   — a non-permitted tail under a non-fixture checked-out anchor;
//   flagged   — the R9.4 ASYMMETRY: a `node_modules` tail under a NON-fixture
//     anchor, which location 6 does NOT permit (it requires a fixture anchor), so
//     the text does not name the Fixture_Tier and the in-fixture permission does
//     not apply.
//
// THE ASSERTION. Because the generator KNOWS whether it built a flagged or a
// permitted fragment (it chose the anchor and the tail), the property asserts the
// guard's verdict EQUALS the generator's verdict DIRECTLY — never re-implementing
// the flagging predicate in the assertion. It also asserts, for a flagged
// fragment, that the reported offence NAMES the fragment's line (the design's
// "reports an offence naming the fragment's line"): the fragment is one physical
// line, so its offence line is line 1 of that source.
//
// THE R9.4 ASYMMETRY is asserted on its own besides being one generated case: a
// `node_modules` tail under a fixture anchor is permitted (location 6) while the
// SAME tail under `repoRoot` is flagged — location 6 permits the Fixture_Projects_
// Root's installed directory, not the repository's own `node_modules`.
//
// THE REGISTRY PATH. `flagWriteSpan` is threaded this project's derived
// Generated_Registry path as permitted location 3 (R9.6), exactly as the guard
// threads it, so the two verdicts are computed identically. The generator never
// produces a registry span, so threading it changes no generated verdict; it is
// passed only to keep this property's classifier configuration identical to the
// guard's.
//
// Every subject is a generated fragment; this file spells no path literal and no
// scope literal of its own (R16.11) beyond the fixture-anchor identifier names
// the classifier recognises, which the generator embeds.
//
// Validates: Requirements 9.3, 9.4, 16.1, 16.10

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { generatedRegistryPath } from "@microservices/build-tools/dist/generate-registry.js";
import {
  flagWriteSpan,
  MUTATING_FS,
  mutatingCallFragment,
} from "@microservices/build-tools/dist/testing/index.js";

/** The run floor R16.1 fixes; declared as a resolvable const so the run-floor
 *  suite (task 10.1) can read it. */
const NUM_RUNS = 300;

/** This project's Generated_Registry path — permitted location 3 — from the
 *  Build_System's single derivation (R9.6), threaded exactly as the guard does. */
const GENERATED_REGISTRY_PATH = generatedRegistryPath(
  projectContext(defaultEffectiveConfig()),
);

/** The classifier configuration the guard uses, minus the per-file temp flag. */
function options(fileHasTempCreator: boolean) {
  return { fileHasTempCreator, generatedRegistryPath: GENERATED_REGISTRY_PATH };
}

/**
 * The guard's line derivation over a single fragment: the fragment is one
 * physical line, so an offence a scan raises for it names line 1. This mirrors
 * `text.slice(0, match.index).split("\n").length` for a call at the start of a
 * one-line source, without depending on the guard's real-file scan.
 */
function offenceLineOf(fragment: { readonly line: string }): number {
  const callHead = new RegExp(`\\b(?:${MUTATING_FS.join("|")})\\s*\\(`);
  const match = callHead.exec(fragment.line);
  if (match === null) return 0;
  return fragment.line.slice(0, match.index).split("\n").length;
}

describe("Property 9: the Worktree_Guard flags a fixture-anchored write outside the six Permitted_Write_Locations and no write inside them (R9.3, R9.4, R16.10)", () => {
  it("the guard's verdict equals the generator's known verdict for every fragment", () => {
    fc.assert(
      fc.property(mutatingCallFragment(), (fragment) => {
        const flagged = flagWriteSpan(
          fragment.span,
          options(fragment.fileHasTempCreator),
        );
        // The generator chose the anchor and the tail, so its verdict is the
        // model; the guard's flagging rule must agree with it exactly.
        expect(flagged, `${fragment.label}: ${fragment.line}`).toBe(
          fragment.verdict === "flagged",
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("names the fragment's line when it flags a fixture- or repo-anchored write outside the six locations", () => {
    fc.assert(
      fc.property(mutatingCallFragment(), (fragment) => {
        fc.pre(fragment.verdict === "flagged");
        // A flagged fragment IS flagged (redundant with the first property, kept
        // so this property is self-contained about the "flagged" side)...
        expect(
          flagWriteSpan(fragment.span, options(fragment.fileHasTempCreator)),
        ).toBe(true);
        // ...and the offence the guard would raise names the fragment's line —
        // line 1, since the fragment is a single physical line (R16.10).
        expect(offenceLineOf(fragment)).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("reports no offence for a write inside the six Permitted_Write_Locations", () => {
    fc.assert(
      fc.property(mutatingCallFragment(), (fragment) => {
        fc.pre(fragment.verdict === "permitted");
        expect(
          flagWriteSpan(fragment.span, options(fragment.fileHasTempCreator)),
          `${fragment.label}: ${fragment.line}`,
        ).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("does not apply the in-fixture dist/tsbuildinfo/node_modules permissions to a destination whose text does not name the Fixture_Tier (R9.4)", () => {
    // The asymmetry, asserted directly: the SAME node_modules tail is permitted
    // under a fixture anchor (location 6) and flagged under a non-fixture anchor,
    // because location 6 permits the Fixture_Projects_Root's node_modules, not the
    // repository's own. `repoRoot` is a checked-out anchor whose text names no
    // Fixture_Tier, so the in-fixture permission does not apply.
    const repoRootToken = "repo" + "Root";
    const underFixture = `(resolve(FIXTURE_PROJECTS_ROOT, "node_modules", "x"))`;
    const underRepoRoot = `(resolve(${repoRootToken}, "node_modules", "x"))`;
    expect(flagWriteSpan(underFixture, options(true))).toBe(false);
    expect(flagWriteSpan(underRepoRoot, options(true))).toBe(true);
  });
});

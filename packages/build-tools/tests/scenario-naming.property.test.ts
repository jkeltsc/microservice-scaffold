// Feature: platform-fixtures, Property 6: Scenario_Directory_Name and Diagnostic_Tag round-trip, and the derivation is injective
//
// The Scenario_Directory_Name derivation pair is the reversible encoding that
// lets a scenario's directory name and its Scenario_Manifest be checked against
// each other. This property pins three facts about that pair over generated
// inputs (R4.1, R4.2):
//
//   1. ROUND-TRIP (R4.1/R4.2): for any generated Diagnostic_Tag `tag` and any
//      generated qualifier `qualifier` (present or absent),
//      `expectedDiagnosticOf(scenarioDirectoryName(tag, qualifier))` === `tag`.
//      The qualifier lives after the `.` and is discarded on recovery, so it
//      never affects the recovered tag.
//
//   2. INJECTIVITY (the derivation from tag -> base name is one-to-one): two
//      DISTINCT tags never produce the same base name (their
//      `scenarioDirectoryName(tag)` with no qualifier differ), and the SAME tag
//      always produces the same base name (the function is deterministic).
//      Stated as the biconditional the design phrases it in: for tags a, b,
//      `scenarioDirectoryName(a) === scenarioDirectoryName(b)` iff `a === b`.
//
//   3. MALFORMED NAMES THROW (R4.2): a directory name whose base part (before
//      any `.` qualifier) holds no `--`, or holds more than one, makes
//      `expectedDiagnosticOf` throw an Error whose message names the directory.
//
// The generators come from this package's own `arbitraries/fixtures.ts`
// (`arbDiagnosticTag`, `arbScenarioQualifier`), which re-exports them from the
// shared `@microservices/build-tools/dist/testing` module; the functions under
// test come from this package's `src/testing/scenario-name.ts`, imported by
// relative path the way this package's suites reach their testing helpers.
//
// Validates: Requirements 4.1, 4.2, 16.1, 16.7

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  expectedDiagnosticOf,
  scenarioDirectoryName,
} from "../src/testing/scenario-name.js";

import {
  arbDiagnosticTag,
  arbScenarioQualifier,
} from "./arbitraries/fixtures.js";

const NUM_RUNS = 200;

// Feature: platform-fixtures, Property 6: Scenario_Directory_Name and Diagnostic_Tag round-trip, and the derivation is injective
describe("Property 6: Scenario_Directory_Name and Diagnostic_Tag round-trip, and the derivation is injective", () => {
  it("round-trips any generated tag through scenarioDirectoryName/expectedDiagnosticOf, with or without a qualifier (R4.1, R4.2)", () => {
    fc.assert(
      fc.property(
        arbDiagnosticTag(),
        arbScenarioQualifier(),
        (tag: string, qualifier: string | undefined) => {
          const name = scenarioDirectoryName(tag, qualifier);
          // The qualifier is discarded on recovery, so the recovered tag equals
          // the tag regardless of whether a qualifier was appended.
          expect(expectedDiagnosticOf(name)).toBe(tag);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("derives distinct base names from distinct tags and equal base names from equal tags (injectivity) (R4.1)", () => {
    fc.assert(
      fc.property(
        arbDiagnosticTag(),
        arbDiagnosticTag(),
        (a: string, b: string) => {
          // The tag -> base-name map (no qualifier) is injective and
          // deterministic: names are equal exactly when the tags are equal.
          const namesEqual =
            scenarioDirectoryName(a) === scenarioDirectoryName(b);
          expect(namesEqual).toBe(a === b);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("throws naming the directory when the base part holds no `--` or more than one (R4.2)", () => {
    // A generated well-formed base name has exactly one `--` (a valid tag maps to
    // exactly one). Perturb it into a base that violates the exactly-one rule:
    //   * zero `--` : replace the single `--` with a single `-`;
    //   * two-plus `--` : inject a second `--` at a generated split point.
    // An optional qualifier is appended after a `.`, which recovery discards, so
    // the malformed BASE is what must trigger the throw.
    fc.assert(
      fc.property(
        arbDiagnosticTag(),
        arbScenarioQualifier(),
        fc.boolean(),
        (tag: string, qualifier: string | undefined, tooMany: boolean) => {
          const validBase = scenarioDirectoryName(tag); // exactly one `--`
          const malformedBase = tooMany
            ? // Two occurrences: duplicate the `--` in place.
              validBase.replace("--", "----")
            : // Zero occurrences: collapse the `--` to a single `-`.
              validBase.replace("--", "-");
          const directoryName =
            qualifier === undefined
              ? malformedBase
              : `${malformedBase}.${qualifier}`;

          // Guard: our construction really did violate the exactly-one rule for
          // the BASE part (the part before any `.`).
          const occurrences = malformedBase.split("--").length - 1;
          expect(occurrences === 1).toBe(false);

          let thrown: unknown;
          try {
            expectedDiagnosticOf(directoryName);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(Error);
          // The message names the offending directory, so a stale name is a loud
          // failure rather than a silent misreading.
          expect((thrown as Error).message).toContain(directoryName);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

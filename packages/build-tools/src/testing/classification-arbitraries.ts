// @microservices/build-tools/dist/testing — the shared Classification_Guard
// generators (platform-tier spec, task 8.4; R16.8, R16.11).
//
// These generators cross the package boundary the sanctioned way: they live under
// `packages/build-tools/src/`, compile to `dist/testing/`, and are imported by
// compiled path from `@microservices/build-tools/dist/testing/index.js`. They
// live here rather than in a package-private `tests/arbitraries/` module because
// their only consumer, Property 7
// (`packages/integration-tests/tests/classification-guard.property.test.ts`,
// task 8.4), is in `packages/integration-tests`, and the design's cross-package
// rule sends a generator two packages COULD share through `src/testing/` rather
// than through another package's private `tests/`.
//
// TWO GENERATORS
// ---------------------------------------------------------------------------
//   1. `arbPathList` — a Platform_Test_Set-shaped list of at least two plausible
//      repo-relative test paths (the non-vacuity floor R12.9 fixes is two).
//   2. `arbCandidateRecord` — a candidate Classification_Record over such a list,
//      producing BOTH well-formed records AND each malformation Property 7 names.
//      Each generated value carries a `wellFormed` flag stating whether the
//      generator produced an accepting record, so the property can assert
//      accept-iff-well-formed DIRECTLY (the generator knows the answer because it
//      chose the malformation) rather than reimplementing the acceptance predicate
//      it is testing.
//
// R1.7 / [scope:literal]. This module lives under `packages/build-tools/src/`.
// The generated paths are test-path-SHAPED strings (`packages/<seg>/tests/<seg>.test.ts`)
// composed from generated segments — never the Fixture_Tier path token and never
// the Scope_Default. The generators are pure over descriptions and reach no
// filesystem and no scope. (The raw R1.7 scan is a token match, so this comment
// names neither token contiguously.)

import * as fc from "fast-check";

import {
  TEST_CLASSES,
  type ClassificationEntry,
  type TestClass,
} from "./classification-validator.js";

// ---------------------------------------------------------------------------
// The path-list generator (Platform_Test_Set-shaped paths)
// ---------------------------------------------------------------------------

/** A path segment: 1 to 10 lowercase-alphanumeric-or-hyphen chars starting with
 *  a letter, so a composed path reads like a real repo-relative test path. */
const arbSegment: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.stringMatching(/^[a-z0-9-]*$/).map((s) => s.slice(0, 9)),
  )
  .map(([head, tail]) => head + tail);

/** The three test-source suffixes the Platform_Test_Set keeps. A generated path
 *  ends with one of these so it is Platform_Test_Set-SHAPED. */
const arbTestSuffix: fc.Arbitrary<string> = fc.constantFrom(
  ".test.ts",
  ".property.test.ts",
  ".test-d.ts",
);

/** One Platform_Test_Set-shaped repo-relative POSIX path,
 *  `packages/<seg>/tests/<seg><suffix>` — a plausible platform test source path,
 *  composed from generated segments so no path literal is written here. */
const arbTestPath: fc.Arbitrary<string> = fc
  .tuple(arbSegment, arbSegment, arbTestSuffix)
  .map(([pkg, file, suffix]) => `packages/${pkg}/tests/${file}${suffix}`);

/**
 * A Platform_Test_Set-shaped path list: at least two DISTINCT plausible
 * repo-relative test paths (R12.9's non-vacuity floor is two; a list must be able
 * to hold the whole population, so it ranges up to a modest size). Distinctness
 * matters — the validator treats a duplicated path as a single-valuedness
 * offence, and the well-formed case must be able to classify each path exactly
 * once.
 */
export function arbPathList(): fc.Arbitrary<readonly string[]> {
  return fc
    .uniqueArray(arbTestPath, { minLength: 2, maxLength: 8 })
    .map((paths) => [...paths]);
}

// ---------------------------------------------------------------------------
// The candidate-record generator
// ---------------------------------------------------------------------------

/**
 * The malformations Property 7 names, plus `well-formed` for the accepting case.
 * Each malformed variant violates exactly one clause of the acceptance predicate,
 * so a rejected record has a single, identifiable reason and the property's
 * accept-iff-well-formed assertion is unambiguous.
 */
export type RecordMalformation =
  | "well-formed"
  /** Omit one listed path from the record (totality: a listed path unclassified). */
  | "omit-path"
  /** Add an entry naming a path OUTSIDE the list (totality: a foreign path). */
  | "path-outside-list"
  /** One entry declares no `class` at all. */
  | "no-class"
  /** One entry carries BOTH per-class fields (structural single-valuedness). */
  | "more-than-one-class"
  /** One entry declares a `class` string that is not one of the three. */
  | "unknown-class"
  /** A Payload_Coupled_Test entry names no `fixtureEquivalent`. */
  | "coupled-no-fixture"
  /** A Payload_Coupled_Test entry names a `fixtureEquivalent` OUTSIDE the list. */
  | "coupled-fixture-outside-list";

/** Every malformation and the well-formed case — the axis the generator ranges
 *  over so each of Property 7's named malformations is exercised. */
export const RECORD_MALFORMATIONS: readonly RecordMalformation[] = [
  "well-formed",
  "omit-path",
  "path-outside-list",
  "no-class",
  "more-than-one-class",
  "unknown-class",
  "coupled-no-fixture",
  "coupled-fixture-outside-list",
];

/** A generated candidate record over a path list, carrying the flag stating
 *  whether it is well-formed (accepting). The property asserts the validator's
 *  verdict equals `wellFormed`. */
export interface CandidateRecord {
  /** The path list the record was generated over. */
  readonly pathList: readonly string[];
  /** The candidate record entries (malformations included). */
  readonly record: readonly ClassificationEntry[];
  /** Which malformation (or `well-formed`) the generator produced. */
  readonly malformation: RecordMalformation;
  /** True iff the generator produced an accepting record — the validator's
   *  offence list must be empty exactly when this is true. */
  readonly wellFormed: boolean;
}

/**
 * A per-path class assignment used to build the well-formed baseline: each listed
 * path gets one of the three classes. `Payload_Coupled_Test` additionally needs a
 * `fixtureEquivalent` that is a member of the list — the generator picks one from
 * the list itself — and `Drift_Detector` needs a `retainedReason`.
 */
type ClassAssignment = readonly TestClass[];

/** A retention-reason string for a Drift_Detector entry: any non-empty text. */
const arbRetainedReason: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => (s.trim().length > 0 ? s : "retained pending relocation"));

/**
 * Build a WELL-FORMED record over `pathList`: every path classified exactly once,
 * each Payload_Coupled_Test naming an in-list `fixtureEquivalent`, each
 * Drift_Detector naming a `retainedReason`, and no path outside the list. This is
 * the accepting baseline every malformed variant is derived from by breaking
 * exactly one clause.
 */
function buildWellFormedRecord(
  pathList: readonly string[],
  classes: ClassAssignment,
  fixtureChoices: readonly number[],
  reasons: readonly string[],
): ClassificationEntry[] {
  return pathList.map((path, index) => {
    const cls = classes[index] ?? "Payload_Independent_Test";
    if (cls === "Payload_Coupled_Test") {
      // The fixtureEquivalent must be an IN-LIST member; pick one by generated
      // index (any listed path is a valid equivalent for the structural check).
      const choice = fixtureChoices[index] ?? 0;
      const fixtureEquivalent = pathList[choice % pathList.length] as string;
      return { path, class: cls, fixtureEquivalent };
    }
    if (cls === "Drift_Detector") {
      return {
        path,
        class: cls,
        retainedReason: reasons[index] ?? "retained pending relocation",
      };
    }
    return { path, class: cls };
  });
}

/**
 * A candidate Classification_Record over a generated path list (R16.8). Produces
 * BOTH well-formed records AND each malformation Property 7 names, tagging the
 * result with `wellFormed` so the property asserts accept-iff-well-formed
 * directly.
 *
 * The well-formed baseline is built first over a generated per-path class
 * assignment; a malformed variant then breaks EXACTLY ONE clause of the
 * acceptance predicate, so a rejected record has a single identifiable cause and
 * the property's IFF is unambiguous. A malformation whose precondition the drawn
 * assignment does not meet — e.g. `coupled-no-fixture` when the assignment happens
 * to contain no Payload_Coupled_Test — is turned into one that does by
 * classifying the mutated entry as the class the malformation needs, so every
 * generated `malformation` really is malformed.
 */
export function arbCandidateRecord(): fc.Arbitrary<CandidateRecord> {
  return arbPathList().chain((pathList) =>
    fc
      .record({
        classes: fc.array(fc.constantFrom(...TEST_CLASSES), {
          minLength: pathList.length,
          maxLength: pathList.length,
        }),
        fixtureChoices: fc.array(fc.nat(), {
          minLength: pathList.length,
          maxLength: pathList.length,
        }),
        reasons: fc.array(arbRetainedReason, {
          minLength: pathList.length,
          maxLength: pathList.length,
        }),
        malformation: fc.constantFrom(...RECORD_MALFORMATIONS),
        // An index into pathList for the single entry a per-entry malformation
        // mutates, and a foreign path / foreign fixtureEquivalent for the
        // out-of-list malformations.
        targetIndex: fc.nat(),
        foreignPath: arbTestPath,
        unknownClass: fc.oneof(
          fc.constant(""),
          fc.constant("NotAClass"),
          fc.constant("payload_coupled_test"),
          arbSegment,
        ),
      })
      .map(
        ({
          classes,
          fixtureChoices,
          reasons,
          malformation,
          targetIndex,
          foreignPath,
          unknownClass,
        }): CandidateRecord => {
          const baseline = buildWellFormedRecord(
            pathList,
            classes,
            fixtureChoices,
            reasons,
          );
          const at = pathList.length === 0 ? 0 : targetIndex % pathList.length;

          switch (malformation) {
            case "well-formed":
              return {
                pathList,
                record: baseline,
                malformation,
                wellFormed: true,
              };

            case "omit-path": {
              // Drop the entry at `at` — a listed path now goes unclassified.
              const record = baseline.filter((_, index) => index !== at);
              return { pathList, record, malformation, wellFormed: false };
            }

            case "path-outside-list": {
              // `foreignPath` must genuinely lie outside the list; if the draw
              // collided with a listed path, suffix it so it does not.
              const foreign = pathList.includes(foreignPath)
                ? `${foreignPath}.extra.test.ts`
                : foreignPath;
              const record = [
                ...baseline,
                { path: foreign, class: "Payload_Independent_Test" },
              ];
              return { pathList, record, malformation, wellFormed: false };
            }

            case "no-class": {
              // Strip `class` from the entry at `at`.
              const record = baseline.map((entry, index) =>
                index === at ? { path: entry.path } : entry,
              );
              return { pathList, record, malformation, wellFormed: false };
            }

            case "more-than-one-class": {
              // Carry BOTH per-class fields on the entry at `at` — the structural
              // single-valuedness violation the guard detects.
              const record = baseline.map((entry, index) =>
                index === at
                  ? {
                      path: entry.path,
                      class: "Payload_Coupled_Test",
                      fixtureEquivalent: pathList[0] as string,
                      retainedReason: "also a drift detector",
                    }
                  : entry,
              );
              return { pathList, record, malformation, wellFormed: false };
            }

            case "unknown-class": {
              // Replace the class of the entry at `at` with a string that is not
              // one of the three, carrying no per-class field.
              const record = baseline.map((entry, index) =>
                index === at
                  ? { path: entry.path, class: unknownClass }
                  : entry,
              );
              return { pathList, record, malformation, wellFormed: false };
            }

            case "coupled-no-fixture": {
              // Make the entry at `at` a Payload_Coupled_Test with NO
              // fixtureEquivalent — malformed regardless of the drawn assignment.
              const record = baseline.map((entry, index) =>
                index === at
                  ? { path: entry.path, class: "Payload_Coupled_Test" }
                  : entry,
              );
              return { pathList, record, malformation, wellFormed: false };
            }

            case "coupled-fixture-outside-list": {
              // A Payload_Coupled_Test whose fixtureEquivalent is NOT a list
              // member. Compose a foreign equivalent that cannot collide.
              const foreignEquivalent = pathList.includes(foreignPath)
                ? `${foreignPath}.equivalent.test.ts`
                : foreignPath;
              const record = baseline.map((entry, index) =>
                index === at
                  ? {
                      path: entry.path,
                      class: "Payload_Coupled_Test",
                      fixtureEquivalent: foreignEquivalent,
                    }
                  : entry,
              );
              return { pathList, record, malformation, wellFormed: false };
            }
          }
        },
      ),
  );
}

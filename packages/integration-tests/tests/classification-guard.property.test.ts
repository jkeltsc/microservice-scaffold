// Feature: platform-fixtures, Property 7: The Classification_Guard accepts
// exactly the total, single-valued, fixture-complete records.
//
// Where `platform-test-classification.test.ts` (task 8.3) holds the guard to the
// REAL committed record over the REAL derived Platform_Test_Set, THIS property
// exercises the guard's ACCEPT/REJECT LOGIC over MANY generated (path-list,
// candidate-record) pairs — including every malformation the requirement names.
// It tests the predicate, not the committed record.
//
// THE PREDICATE UNDER TEST is `classifyRecordAgainstSet` from
// `@microservices/build-tools/dist/testing` — the SAME pure structural predicate
// the task-8.3 guard delegates its structural half to, so this property and the
// guard share one predicate rather than two that could drift. The predicate
// returns an offence list; an EMPTY list is acceptance.
//
// THE ACCEPTANCE CRITERION (design Property 7; R12.5, R12.6). The predicate
// accepts a record over a path list IF AND ONLY IF the record:
//   - assigns every path in the list exactly one of the three Test_Classes
//     (totality + single-valuedness, single-valuedness checked structurally so
//     an entry carrying both `fixtureEquivalent` and `retainedReason` fails);
//   - names an in-list `fixtureEquivalent` for every Payload_Coupled_Test entry;
//   - names a `retainedReason` for every Drift_Detector entry;
//   - names no path outside the list.
// The generated malformations break exactly one of these clauses each: omitting
// a path, naming a path outside the list, an entry with no class, an entry with
// more than one class (both per-class fields), an unknown class string, a
// Payload_Coupled_Test with no `fixtureEquivalent`, and a Payload_Coupled_Test
// whose `fixtureEquivalent` lies outside the list.
//
// THE ASSERTION. Because the candidate-record generator KNOWS whether it produced
// a well-formed or a malformed record (it chose the malformation), the property
// asserts accept-iff-well-formed DIRECTLY: the predicate's offence list is empty
// exactly when `wellFormed` is true. And for every rejected record it asserts the
// requirement's second clause — every reported offence names a path (a non-empty
// string, never left blank), and every offence's path is one the record or the
// list actually names, so a rejection points at the offending path rather than a
// bare "invalid".
//
// GENERATORS come from `@microservices/build-tools/dist/testing` (`arbPathList`,
// `arbCandidateRecord`): this suite lives in `packages/integration-tests`, and the
// design's cross-package rule sends a generator across the boundary through
// `src/testing/` rather than through another package's private
// `tests/arbitraries/`. Every subject is derived from a generated configuration
// (a generated path list and a generated record over it); this file spells no
// path literal and no scope literal of its own (R16.11).
//
// Validates: Requirements 12.5, 12.6, 16.1, 16.8, 16.11

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  arbCandidateRecord,
  classifyRecordAgainstSet,
} from "@microservices/build-tools/dist/testing/index.js";

/** The run floor R16.1 fixes; declared as a resolvable const so the run-floor
 *  suite (task 10.1) can read it. */
const NUM_RUNS = 300;

describe("Property 7: the Classification_Guard accepts exactly the total, single-valued, fixture-complete records (R12.5, R12.6, R16.8)", () => {
  it("accepts a record if and only if it is well-formed by the acceptance criterion", () => {
    fc.assert(
      fc.property(arbCandidateRecord(), ({ pathList, record, wellFormed }) => {
        const offences = classifyRecordAgainstSet(pathList, record);
        const accepted = offences.length === 0;
        // Accept IFF well-formed: the generator's own verdict is the model, and
        // the predicate must agree with it exactly.
        expect(accepted).toBe(wellFormed);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("names the offending path in every offence of a rejected record", () => {
    fc.assert(
      fc.property(arbCandidateRecord(), ({ pathList, record, wellFormed }) => {
        fc.pre(!wellFormed); // only rejected records have offences to inspect
        const offences = classifyRecordAgainstSet(pathList, record);
        // A rejected record must report at least one offence, and every offence
        // must NAME a path — a non-empty string, so the failure points at the
        // offending path rather than a bare verdict.
        expect(offences.length).toBeGreaterThan(0);
        const listSet = new Set(pathList);
        const recordPaths = new Set(
          record
            .map((entry) => entry.path)
            .filter((p): p is string => typeof p === "string"),
        );
        for (const offence of offences) {
          expect(typeof offence.path).toBe("string");
          expect(offence.path.length).toBeGreaterThan(0);
          // The named path is one the list or the record actually names (or the
          // `<no path>` sentinel for an entry that declared none) — never an
          // invented path, so a reviewer can locate it.
          const isNamed =
            offence.path === "<no path>" ||
            listSet.has(offence.path) ||
            recordPaths.has(offence.path);
          expect(
            isNamed,
            `offence path "${offence.path}" is neither in the list, in the record, nor the <no path> sentinel`,
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

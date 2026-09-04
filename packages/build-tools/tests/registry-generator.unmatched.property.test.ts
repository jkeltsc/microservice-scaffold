// Feature: microservice-scaffold, Property 4: Unmatched-identifier error.
// For any selector string s that names a list of identifiers L and any namespace
// n such that L \ D(n) is non-empty (where D(n) is the set of directory names
// present in the namespace), selection throws an unmatched-identifier error
// whose unmatched-identifier set equals L \ D(n).
//
// The property is exercised through `resolveSelected(selector, directories)`,
// the pure selection function `generateRegistry` composes with the namespace
// listing to determine the registry's identifiers.
//
// The assertion is made against the thrown error's MESSAGE rather than against a
// structured field on a bespoke error class. The message is the operator-facing
// contract — it is the line printed by the failing build, and design "Error
// message shape" pins its wording, prefix, quoting and ordering — so it is the
// right thing to hold exactly. The error class that used to carry an
// `unmatched: string[]` field existed only so this test could read the set back;
// nothing caught it and nothing else inspected it.
//
// Exactness is preserved, not weakened: the quoted identifiers are PARSED out of
// the message and compared as a whole, so the assertion is set equality in both
// directions (no missing identifier, no extra one, and no duplicate) plus the
// documented dedup-and-sort ordering. A substring check would not be enough and
// is deliberately not what this does.
//
// Validates: Requirements R5.4, R6.4, R10.4

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { resolveSelected } from "../src/selector.js";
import { arbIdentifier } from "@microservices/contracts/testing";

/** The documented message shape: fixed prefix, then the quoted identifiers. */
const MESSAGE_SHAPE =
  /^\[selector:unmatched\] MICROSERVICES names unknown identifier\(s\): (.+)$/;

/** Run the selection and return the message of the error it threw. */
function unmatchedMessage(
  selector: string,
  directories: readonly string[],
): string {
  try {
    resolveSelected(selector, directories);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(
    "expected resolveSelected to throw for unmatched identifiers",
  );
}

/**
 * The identifiers the message names, in the order it names them. Asserts the
 * full message shape first, so a changed prefix or a mangled list fails here
 * rather than silently yielding an empty set. Identifiers cannot contain a
 * double quote, so the quoted-token scan recovers them exactly.
 */
function namedIdentifiers(message: string): string[] {
  const shape = MESSAGE_SHAPE.exec(message);
  expect(
    shape,
    `message did not match the documented shape: ${message}`,
  ).not.toBeNull();

  const list = shape![1];
  const named = [...list.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  // Nothing but the quoted identifiers and their `, ` separators may appear in
  // the list portion — otherwise an extra unquoted name could hide there.
  expect(named.map((id) => `"${id}"`).join(", ")).toBe(list);
  return named;
}

describe("Property 4: unmatched-identifier error via resolveSelected", () => {
  it("names the exact set difference L \\ D(n) for list selectors with absent identifiers", () => {
    fc.assert(
      fc.property(
        // discovered directory names D(n)
        fc.array(arbIdentifier, { minLength: 0, maxLength: 6 }),
        // extra identifiers guaranteed to be requested
        fc.array(arbIdentifier, { minLength: 1, maxLength: 5 }),
        // how many of those extras the selector repeats: L may legitimately
        // contain duplicates, and the reported difference must still be a SET,
        // so the generator has to produce repeats rather than leave dedup
        // untested (a large identifier space makes accidental repeats vanishing).
        fc.nat({ max: 5 }),
        (discoveredArr, extraArr, repeatCount) => {
          const discovered = new Set(discoveredArr);

          // The "absent" identifiers are those extras not in the discovered set.
          const absent = extraArr.filter((id) => !discovered.has(id));
          // Precondition for Property 4: at least one requested identifier must
          // be absent. Skip runs where every extra happened to be discovered.
          fc.pre(absent.length > 0);

          // Requested list L: discovered ids that exist (subset of D) plus the
          // extras (some absent), plus a repeat of the first few extras. Order
          // is arbitrary and repeats are allowed; the message dedups and sorts
          // the reported difference.
          const requested = [
            ...discoveredArr,
            ...extraArr,
            ...extraArr.slice(0, repeatCount),
          ];
          const selector = requested.join(",");

          const message = unmatchedMessage(selector, [...discoveredArr].sort());

          // Expected difference: dedup(L \ D(n)), sorted (message contract).
          const expectedDiff = [...new Set(absent)].sort();
          expect(namedIdentifiers(message)).toEqual(expectedDiff);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("names a single absent identifier in the difference set", () => {
    const message = unmatchedMessage("microservice1,microservice4", [
      "microservice1",
      "microservice2",
    ]);
    expect(message).toBe(
      '[selector:unmatched] MICROSERVICES names unknown identifier(s): "microservice4"',
    );
    expect(namedIdentifiers(message)).toEqual(["microservice4"]);
  });
});

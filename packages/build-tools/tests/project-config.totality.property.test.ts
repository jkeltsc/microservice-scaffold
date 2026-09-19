// Feature: config-driven-discovery, Property 1: Config parsing is total
//
// For any input string — including the empty string, a whitespace-only string,
// a string containing no JSON, the JSON text of a value of any JSON type, a JSON
// object text mixing recognised keys with unrecognised keys and wrong-typed
// values, and a string of 1,048,576 characters or more — the Config_Parser
// returns exactly one of a ParsedConfig or a non-empty list of
// Config_Diagnostics, raises no exception, terminates no process, and returns
// every Config_Diagnostic with all four of its parts present and non-empty; and
// for an input that is not parseable as JSON the returned list holds exactly one
// Config_Diagnostic, tagged `[config:unparsable]`.
//
// The property is expressed over the parser's whole observable input — a single
// `string` plus the config path it names in diagnostics — so drawing that string
// from the union of `pathologicalText()` (the totality pool of Requirement 14.1:
// empty, whitespace-only, non-JSON, every JSON type, mixed keys, and one
// megabyte string) and `configText()` (well-formed JSON object texts the parser
// may still reject on scope/root/overlap grounds) covers both the "never a
// throw, however malformed" edge and the "structured rejection" middle.
//
// Totality has two halves, both asserted here: the call NEVER throws (a throw
// would escape `fc.property` and fail the run), and its return is EXACTLY one of
// the two outcomes — a discriminated union whose `kind` is checked to be one of
// `"parsed"` / `"rejected"` and never both, never neither. The four-non-empty
// obligation of Requirement 2.13 is checked on every diagnostic of every
// rejection. The `[config:unparsable]` singleton of Requirement 2.3 is checked
// against clearly-unparsable inputs, drawn as their own arbitrary so the single
// diagnostic is exercised directly rather than left to chance.
//
// Validates: Requirements 2.1, 2.3, 2.13, 14.1

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  type ParseOutcome,
  type ConfigDiagnostic,
} from "../src/project-config.js";
import { configText, pathologicalText } from "./arbitraries/config.js";

/**
 * Every string the totality property must range over: the Requirement 14.1
 * pool, plus well-formed JSON object texts (so the "parsed" outcome and the
 * structured-rejection outcomes are both reached, not only the malformed edge).
 */
function anyInput(): fc.Arbitrary<string> {
  return fc.oneof(pathologicalText(), configText());
}

/**
 * Asserts the outcome is EXACTLY one of the two shapes — never both, never
 * neither — and that every diagnostic of a rejection has all four parts present
 * as a non-empty string (Requirement 2.13).
 */
function assertExactlyOneOutcome(outcome: ParseOutcome): void {
  const isParsed = outcome.kind === "parsed";
  const isRejected = outcome.kind === "rejected";

  // Exactly one: the discriminant is one of the two values and not the other.
  expect(isParsed !== isRejected).toBe(true);

  if (outcome.kind === "rejected") {
    // A non-empty list (Requirement 2.1): at least one diagnostic.
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
    for (const d of outcome.diagnostics) {
      assertFourPartsNonEmpty(d);
    }
  } else {
    // The parsed outcome carries a ParsedConfig with a fully-defaulted config.
    expect(typeof outcome.parsed.config.scope).toBe("string");
    expect(typeof outcome.parsed.config.roots.microservice).toBe("string");
    expect(typeof outcome.parsed.config.roots.common).toBe("string");
    expect(typeof outcome.parsed.config.roots.spa).toBe("string");
  }
}

/** Each of the four parts a Config_Diagnostic names is a non-empty string. */
function assertFourPartsNonEmpty(d: ConfigDiagnostic): void {
  expect(typeof d.tag).toBe("string");
  expect(d.tag.length).toBeGreaterThan(0);
  expect(typeof d.at).toBe("string");
  expect(d.at.length).toBeGreaterThan(0);
  expect(typeof d.found).toBe("string");
  expect(d.found.length).toBeGreaterThan(0);
  expect(typeof d.reason).toBe("string");
  expect(d.reason.length).toBeGreaterThan(0);
}

describe("Property 1: config parsing is total", () => {
  it("returns exactly one outcome, never throws, and every diagnostic has four non-empty parts", () => {
    fc.assert(
      fc.property(anyInput(), (text) => {
        // A throw here escapes the property and fails the run — this call is the
        // "raises no exception" half of totality.
        const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);
        assertExactlyOneOutcome(outcome);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a clearly-unparsable input with exactly one [config:unparsable] diagnostic", () => {
    // Strings guaranteed not to be parseable as JSON: JSON.parse throws on each,
    // so the parser must funnel every one to a single [config:unparsable]
    // diagnostic and nothing else (Requirement 2.3).
    const unparsable = fc.oneof(
      fc.constantFrom(
        "", // empty string
        "   \t\n ", // whitespace only
        "not json at all",
        "{ unquoted: 1 }",
        "{", // truncated object
        "[1, 2,", // truncated array
        "'single quoted'",
        "undefined",
        "NaN",
        "{ \"a\": }", // missing value
      ),
      // Constructively-unparsable: a bare identifier-ish run that is never valid
      // JSON on its own.
      fc.stringMatching(/^[a-z]{1,12}$/).filter(
        (s) => s !== "true" && s !== "false" && s !== "null",
      ),
    );

    fc.assert(
      fc.property(unparsable, (text) => {
        const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind !== "rejected") return;
        expect(outcome.diagnostics.length).toBe(1);
        expect(outcome.diagnostics[0].tag).toBe("config:unparsable");
        assertFourPartsNonEmpty(outcome.diagnostics[0]);
      }),
      { numRuns: 200 },
    );
  });
});

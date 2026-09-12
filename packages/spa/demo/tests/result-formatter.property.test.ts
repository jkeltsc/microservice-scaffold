// Property-based tests for the Result_Formatter (Requirement 10).
//
// This suite covers the property-shaped acceptance criteria of Requirement 10 —
// the determinism, totality, purity, metamorphic, and round-trip properties —
// through the treatment Requirement 11 criterion 8 prescribes: a criterion that
// constrains the VALUE one of the Result_Formatter's three functions returns is
// covered by a fast-check property that calls that function directly, over
// Request_Line, status code and reason text, and response body.
//
// The suite references NEITHER `document` NOR `window`, so it runs in the
// repository's default Node environment (R11.3), which is itself the whole of
// the purity property's assertion (R10.18): the functions are callable with no
// DOM and no browser global present.
//
// Task 8.5 covers the example-based branch-outcome criteria (R10.6, R10.7,
// R10.11, R10.12, R10.13); this file covers only the property-based ones.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  formatBody,
  formatRequestLine,
  formatStatus,
} from "../src/result-formatter.js";

// ---------------------------------------------------------------------------
// Shared generators, constrained to the input domain R10.15 declares.
// ---------------------------------------------------------------------------

/**
 * A Request_Line of 0 to 2,048 characters (R10.15). The generator includes the
 * empty string (minLength 0), the 2,048-character bound, unicode, embedded
 * newlines, and the two concrete request paths the Demo_Page actually composes,
 * so Property 15's metamorphic reading — the requested path survives verbatim —
 * is exercised on real shapes as well as the extremes.
 */
const arbRequestLine: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 2048 }),
  fc.constant(""),
  fc.constant("A".repeat(2048)),
  fc.constant("GET http://localhost:3000/microservice1"),
  fc.constant("GET http://localhost:3000/microservice3"),
  fc.constant("GET http://host/path\nwith\r\nnewlines"),
  fc.fullUnicodeString({ maxLength: 2048 }),
);

/** A status code that is an integer from 100 to 599 inclusive (R10.15). */
const arbStatusCode: fc.Arbitrary<number> = fc.integer({ min: 100, max: 599 });

/**
 * A reason text that is absent or a string of 0 to 2,048 characters (R10.15).
 */
const arbReason: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 0, maxLength: 2048 }),
  { nil: undefined },
);

/**
 * A response body that is absent or a string. The domain of R10.15 runs to
 * 1,048,576 characters; the generator caps generated sizes at a few KB for
 * per-run performance while still including the empty string and a large-ish
 * value, and includes the absent case.
 */
const arbBody: fc.Arbitrary<string | undefined> = fc.option(
  fc.oneof(
    fc.string({ minLength: 0, maxLength: 4096 }),
    fc.constant(""),
    fc.constant("x".repeat(4096)),
    fc.fullUnicodeString({ maxLength: 2048 }),
  ),
  { nil: undefined },
);

/**
 * A tagged call shape drawn from the three functions — a Request_Line, a status
 * code together with a reason text, or a body — each argument drawn from the
 * domain of its own function including its absent case. Shared by the
 * determinism (Property 21) and totality (Property 26) properties, so one
 * generator covers all three functions rather than three near-identical tests.
 */
type CallShape =
  | { readonly fn: "request"; readonly requestLine: string }
  | {
      readonly fn: "status";
      readonly status: number | undefined;
      readonly reason: string | undefined;
    }
  | { readonly fn: "body"; readonly body: string | undefined };

const arbCallShape: fc.Arbitrary<CallShape> = fc.oneof(
  arbRequestLine.map((requestLine) => ({
    fn: "request" as const,
    requestLine,
  })),
  fc
    .record({
      status: fc.option(arbStatusCode, { nil: undefined }),
      reason: arbReason,
    })
    .map(({ status, reason }) => ({ fn: "status" as const, status, reason })),
  arbBody.map((body) => ({ fn: "body" as const, body })),
);

/** Invoke the function a tagged call shape names, with its arguments. */
function invoke(shape: CallShape): string {
  switch (shape.fn) {
    case "request":
      return formatRequestLine(shape.requestLine);
    case "status":
      return formatStatus(shape.status, shape.reason);
    case "body":
      return formatBody(shape.body);
  }
}

// ---------------------------------------------------------------------------
// Property 15 — the Request_Line identity, over the whole domain (R10.3), and
// the Request_Field metamorphic property (R10.19).
// ---------------------------------------------------------------------------

// Feature: scaffold-demo-samples, Property 15: The Request_Line function is the identity on its whole domain
describe("Property 15: The Request_Line function is the identity on its whole domain", () => {
  it("returns the Request_Line character for character, over 0-2048 chars", () => {
    fc.assert(
      fc.property(arbRequestLine, (requestLine) => {
        expect(formatRequestLine(requestLine)).toBe(requestLine);
      }),
    );
  });

  it("holds the requested path char-for-char for the requests the Demo_Page composes (R10.19)", () => {
    // The metamorphic reading: whatever Request_Line is composed, the returned
    // text contains the requested path verbatim. Since the function is the
    // identity, equality to the input is the strongest form of "contains".
    fc.assert(
      fc.property(
        fc.constantFrom(
          "GET http://localhost:3000/microservice1",
          "GET http://localhost:3000/microservice3",
        ),
        (requestLine) => {
          const rendered = formatRequestLine(requestLine);
          expect(rendered).toBe(requestLine);
          expect(rendered).toContain(requestLine.slice(requestLine.indexOf(" ") + 1));
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16 — the status function names any received status code in decimal
// (R10.5), unconditionally across 100-599 including 200-299 (R10.20).
// ---------------------------------------------------------------------------

// Feature: scaffold-demo-samples, Property 16: The status function names any received status code in decimal
describe("Property 16: The status function names any received status code in decimal", () => {
  it("returns text containing the code in decimal for every code 100-599, any reason", () => {
    fc.assert(
      fc.property(arbStatusCode, arbReason, (status, reason) => {
        // R10.20: unconditional over 100-599, 200-299 included. The reason axis
        // is quantified over even though branch S1 ignores it — a reason must
        // not perturb the text a present status produces.
        expect(formatStatus(status, reason)).toContain(String(status));
      }),
    );
  });

  it("covers the 200-299 range explicitly (no longer excluded)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 299 }), arbReason, (status, reason) => {
        expect(formatStatus(status, reason)).toContain(String(status));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17 — a JSON body is rendered as that JSON indented with two spaces,
// the round-trip property (R10.12, R10.21). No status code appears anywhere.
// ---------------------------------------------------------------------------

// Feature: scaffold-demo-samples, Property 17: A JSON body is rendered as that JSON indented with two spaces
describe("Property 17: A JSON body is rendered as that JSON indented with two spaces", () => {
  it("formatBody(JSON.stringify(value)) equals JSON.stringify(value, null, 2) for any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const serialised = JSON.stringify(value);
        // fc.jsonValue never produces a value JSON.stringify drops to
        // undefined, so `serialised` is always a defined string body.
        expect(formatBody(serialised)).toBe(JSON.stringify(value, null, 2));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21 — all three functions are deterministic (R10.16): calling a
// function twice with equal input returns character-identical text both times.
// ---------------------------------------------------------------------------

// Feature: scaffold-demo-samples, Property 21: All three functions are deterministic
describe("Property 21: All three functions are deterministic", () => {
  it("returns character-identical text from two calls with equal input, for every function", () => {
    fc.assert(
      fc.property(arbCallShape, (shape) => {
        expect(invoke(shape)).toBe(invoke(shape));
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26 — all three functions are total over their domains (R10.17):
// each returns a string and raises no error over the full domain of R10.15.
// Executing in the Node environment with no DOM and no browser global present
// is itself the purity property's assertion (R10.18).
// ---------------------------------------------------------------------------

// Feature: scaffold-demo-samples, Property 26: All three Result_Formatter functions are total over their domains
describe("Property 26: All three Result_Formatter functions are total over their domains", () => {
  it("returns a string and raises no error for every input in the R10.15 domain (R10.17, R10.18)", () => {
    fc.assert(
      fc.property(arbCallShape, (shape) => {
        // "returns a string", deliberately not "returns a non-empty string":
        // formatRequestLine returns the empty string for an empty Request_Line
        // under R10.3, and R10.17 asks for a string, not a non-empty one.
        expect(() => {
          const result = invoke(shape);
          expect(typeof result).toBe("string");
        }).not.toThrow();
      }),
    );
  });
});

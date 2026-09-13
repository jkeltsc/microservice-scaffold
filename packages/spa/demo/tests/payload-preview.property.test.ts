// Property-based tests for the Payload_Preview (Requirement 3).
//
// This suite covers the property-shaped acceptance criteria of Requirement 3 —
// the round-trip, metamorphic, purity, and determinism properties — by calling
// the Payload_Preview's single exported function directly over adversarial
// name/path inputs. The Expected_Payload_Text is NEVER restated as a literal:
// every assertion computes it from `buildExtendedConfigPayload`, imported from
// the Extended_Config_Package by package name.
//
// The suite references NEITHER `document` NOR `window`, so it runs in the
// repository's Vitest default `node` environment (R3.7) with no DOM present.
//
// Later tasks add Property 4 (metamorphic, task 2.4) and Properties 1 and 2
// (purity and determinism, task 2.5) to THIS file; each slots in as its own
// top-level `describe` block below without touching Property 3.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

import { buildExtendedConfigPayload } from "@microservices/extended-config";

import { expectedPayloadText } from "../src/payload-preview.js";
import { formatBody } from "../src/result-formatter.js";

// ---------------------------------------------------------------------------
// Shared generators, constrained to the input domain R3.8 declares: name and
// path strings of 0 to 2,048 characters drawn from the full Unicode range.
// ---------------------------------------------------------------------------

/**
 * A name or path string of 0 to 2,048 characters, drawn from the full Unicode
 * range (R3.8) and mixed with explicit constants so the JSON-hostile shapes and
 * the concrete Microservice3 literals appear with no seed:
 *
 *   - `""` — the empty string (R3.8's lower bound);
 *   - `'"'` and `"\\"` — the two characters `JSON.stringify` must escape;
 *   - `"\u0000"` — a control character, likewise escaped;
 *   - an astral surrogate pair (a character outside the Basic Multilingual
 *     Plane), which must survive the round trip intact;
 *   - a 2,048-character string (R3.8's upper bound);
 *   - `"microservice3"` and `"/microservice3"` — so the concrete criterion R3.5
 *     reproduces without a seed when the generator draws the two together.
 */
const arbNameOrPath: fc.Arbitrary<string> = fc.oneof(
  fc.fullUnicodeString({ maxLength: 2048 }),
  fc.constant(""),
  fc.constant('"'),
  fc.constant("\\"),
  fc.constant("\u0000"),
  fc.constant("\u{1F600}"), // astral surrogate pair (outside the BMP)
  fc.constant("A".repeat(2048)),
  fc.constant("microservice3"),
  fc.constant("/microservice3"),
);

// ---------------------------------------------------------------------------
// Property 3 — the Expected_Payload_Text round-trips through JSON (R3.8, R3.5,
// R3.2, R3.1): for any name/path pair, the function returns a non-empty string,
// throws no error, and JSON.parse of it deep-equals buildExtendedConfigPayload.
// ---------------------------------------------------------------------------

// Feature: spa-common-consumption, Property 3: The Expected_Payload_Text round-trips through JSON
describe("Feature: spa-common-consumption, Property 3: The Expected_Payload_Text round-trips through JSON", () => {
  it("returns a non-empty string that JSON.parses back to buildExtendedConfigPayload(name, path)", () => {
    fc.assert(
      fc.property(arbNameOrPath, arbNameOrPath, (name, path) => {
        let text!: string;

        // Throws no error (R3.8) and returns a string of 1+ characters (R3.1).
        expect(() => {
          text = expectedPayloadText(name, path);
        }).not.toThrow();
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThanOrEqual(1);

        // JSON.parse of the text deep-equals the payload the package builds for
        // that same name and path (R3.8, R3.5) — the value is computed here from
        // buildExtendedConfigPayload, never restated as a literal.
        expect(JSON.parse(text)).toEqual(buildExtendedConfigPayload(name, path));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — the Expected_Payload_Text equals what the Result_Formatter would
// render (R3.10, R3.6): for any name/path pair, the string the Payload_Preview
// returns equals, character for character, what the Result_Formatter's
// `formatBody` produces from the JSON text of the Extended_Config_Payload for
// that same name and path.
//
// This is a metamorphic check: `expectedPayloadText` and `formatBody` are
// written independently — neither is defined in terms of the other — yet they
// must agree, because both re-serialise a parsed value with a two-space indent
// and `JSON.parse` preserves this payload's key order (no key is integer-like).
// No HTTP request is issued and no Microservice3 process is started; the two
// pure functions are simply called and compared.
// ---------------------------------------------------------------------------

// Feature: spa-common-consumption, Property 4: The Expected_Payload_Text equals what the Result_Formatter would render
describe("Feature: spa-common-consumption, Property 4: The Expected_Payload_Text equals what the Result_Formatter would render", () => {
  it("equals formatBody(JSON.stringify(buildExtendedConfigPayload(name, path))) character for character", () => {
    // The concrete R3.6 pair, checked explicitly so it reproduces with no seed.
    expect(expectedPayloadText("microservice3", "/microservice3")).toBe(
      formatBody(
        JSON.stringify(
          buildExtendedConfigPayload("microservice3", "/microservice3"),
        ),
      ),
    );

    fc.assert(
      fc.property(arbNameOrPath, arbNameOrPath, (name, path) => {
        // The Payload_Preview and the Result_Formatter agree character for
        // character (R3.10, R3.6). Each operand is computed here from its own
        // function; neither is restated as a literal, and neither function is
        // written in terms of the other.
        expect(expectedPayloadText(name, path)).toBe(
          formatBody(JSON.stringify(buildExtendedConfigPayload(name, path))),
        );
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1 — the Payload_Preview is pure (R3.3, R3.1): for any name/path
// pair, calling the function in the `node` environment — with no DOM, no
// browser global, and no network available — returns a string and throws no
// error, and performs no network, filesystem, or console access.
//
// Purity is checked observationally: every `console` method is replaced with a
// spy, and `globalThis.fetch` is replaced with a stand-in that fails the test
// if it is ever invoked. After the property runs, both are asserted never to
// have been called, then restored in an `afterEach`/`finally` so the
// replacements leak into none of the other properties in this file. No
// `document` or `window` is referenced anywhere, so the check holds in the
// Vitest default `node` environment with no DOM present.
// ---------------------------------------------------------------------------

// Feature: spa-common-consumption, Property 1: The Payload_Preview is pure
describe("Feature: spa-common-consumption, Property 1: The Payload_Preview is pure", () => {
  // The originals, captured so the replacements can be restored cleanly and
  // never leak into a later property in this file.
  const originalFetch = globalThis.fetch;
  const consoleMethods = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "dir",
    "table",
  ] as const;
  const originalConsoleMethods = new Map<string, unknown>(
    consoleMethods.map((method) => [
      method,
      (console as unknown as Record<string, unknown>)[method],
    ]),
  );

  // A fetch stand-in that records any invocation. It is installed for the whole
  // property run; the assertion that it was never called is what makes "no
  // network access" observable.
  let fetchCalls = 0;
  // Spies over every console method, so any console access during the run is
  // observable as a call count greater than zero.
  const consoleSpies = new Map<string, ReturnType<typeof vi.fn>>();

  beforeEach(() => {
    fetchCalls = 0;
    (globalThis as { fetch: unknown }).fetch = (() => {
      fetchCalls += 1;
      throw new Error("Payload_Preview must not touch the network (fetch)");
    }) as unknown as typeof fetch;

    consoleSpies.clear();
    for (const method of consoleMethods) {
      const spy = vi.fn();
      consoleSpies.set(method, spy);
      (console as unknown as Record<string, unknown>)[method] = spy;
    }
  });

  afterEach(() => {
    // Restore the originals unconditionally, so no replacement survives into a
    // later property in this file.
    (globalThis as { fetch: unknown }).fetch = originalFetch;
    for (const method of consoleMethods) {
      (console as unknown as Record<string, unknown>)[method] =
        originalConsoleMethods.get(method);
    }
  });

  it("returns a string, throws no error, and touches no console or network", () => {
    fc.assert(
      fc.property(arbNameOrPath, arbNameOrPath, (name, path) => {
        let text!: string;

        // Returns a string and throws no error (R3.1, R3.3).
        expect(() => {
          text = expectedPayloadText(name, path);
        }).not.toThrow();
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThanOrEqual(1);

        // No network access: the fetch stand-in was never invoked (R3.3).
        expect(fetchCalls).toBe(0);
        expect(globalThis.fetch).not.toBe(originalFetch); // the stand-in is installed

        // No console access on any method (R3.3).
        for (const spy of consoleSpies.values()) {
          expect(spy).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — the Payload_Preview is deterministic (R3.4): for a generated
// repeat count of 2 or more, every call with equal arguments returns a string
// character-identical to the first call's result. Determinism follows from
// purity: the function reads nothing outside its two arguments and the values
// bundled from the Extended_Config_Package, so repeated calls with the same
// arguments cannot diverge.
// ---------------------------------------------------------------------------

// Feature: spa-common-consumption, Property 2: The Payload_Preview is deterministic
describe("Feature: spa-common-consumption, Property 2: The Payload_Preview is deterministic", () => {
  it("returns character-identical strings across repeated calls with equal arguments", () => {
    fc.assert(
      fc.property(
        arbNameOrPath,
        arbNameOrPath,
        // A repeat count from 2 upward (R3.4 quantifies over 2 to 1,000 calls);
        // capped well below that bound to keep each example fast.
        fc.integer({ min: 2, max: 50 }),
        (name, path, repeats) => {
          const first = expectedPayloadText(name, path);
          for (let i = 1; i < repeats; i += 1) {
            // Character-identical to the first result on every subsequent call
            // (R3.4).
            expect(expectedPayloadText(name, path)).toBe(first);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

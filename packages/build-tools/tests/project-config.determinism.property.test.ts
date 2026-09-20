// Feature: config-driven-discovery, Property 9: Diagnostics are deterministic
// and identically ordered.
//
// For any input string, two runs of `parseProjectConfig(text, path)` return
// Config_Diagnostic lists of equal length carrying byte-identical text in an
// identical order (R2.8), and the diagnostics of any rejection are ordered by
// ascending code-point comparison of diagnostic tag and then of key path, with
// at most one diagnostic per distinct tag-and-key-path pair — a total order,
// carrying no duplicate pair (R2.8, R14.10).
//
// The determinism half is a pure idempotence claim: the parser reads only its
// two arguments (R2.2), so a second call on the same text must return a
// deep-equal outcome AND, when rejected, byte-identical rendered text in the
// same order. The ordering half is checked structurally: the returned order is
// compared against an order recomputed independently by this test — a code-point
// `<`/`>` sort on `(tag, at)`, never `localeCompare` — and the returned list is
// checked to hold no two diagnostics sharing a `(tag, at)` pair.
//
// Inputs are drawn from the union of `configText()` (well-formed JSON object
// texts the parser may reject on scope/root/overlap grounds) and
// `pathologicalText()` (the totality pool: empty, whitespace-only, non-JSON,
// every JSON type, a mixed-key object, and one megabyte string), plus a
// dedicated arbitrary that packs several independent problems into one object
// (unknown keys + a bad scope + bad roots + a bad `entry`) so multi-diagnostic
// rejections — the only inputs whose ordering is non-trivial — are exercised
// directly rather than left to chance. Since registry-inversion the pool also
// carries `arbEntryConfigText()`, so the fourth value's two tags take part in
// the ordering and the determinism claims.
//
// Validates: Requirements 2.8, 14.10
// Validates: registry-inversion Requirements 1.2

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  renderDiagnostic,
  type ConfigDiagnostic,
} from "../src/project-config.js";
import {
  arbEntryConfigText,
  configText,
  pathologicalText,
} from "./arbitraries/config.js";

/**
 * The union of the two shared pools, plus a generator of objects that trigger
 * SEVERAL diagnostics at once. A single unknown key and a single bad scope each
 * produce one diagnostic — an order of one is trivially sorted — so the
 * multi-problem arbitrary is what actually exercises the ordering: it mixes
 * unrecognised top-level keys, a wrong-typed or invalid scope, an unrecognised
 * `roots` member, and one or more invalid root paths, so a rejection carries
 * diagnostics spanning several tags and several key paths at once.
 */
function anyInput(): fc.Arbitrary<string> {
  return fc.oneof(
    configText(),
    pathologicalText(),
    multiProblemText(),
    // Texts that always declare `entry`, so the two tags the fourth value can
    // produce — `[config:entry-path]` and `[config:entry-overlap]` — take part in
    // the ordering and the determinism claims rather than only the seven older
    // tags. `[config:entry-overlap]` is the one tag that reports SEVERAL
    // diagnostics for a single value (one per colliding reserved path), so its
    // ordering is non-trivial on its own.
    arbEntryConfigText(),
  );
}

/**
 * A JSON object text engineered to fail on several independent grounds at once,
 * so the returned diagnostic list has more than one element and its order is
 * non-trivial. Each ingredient is optional, but at least the unknown key, a bad
 * scope, and a bad `entry` are always present, guaranteeing at least three
 * diagnostics spanning at least three tags.
 */
function multiProblemText(): fc.Arbitrary<string> {
  return fc
    .record({
      // Two unrecognised top-level keys -> two [config:unknown-key] at 'zzz'/'aaa'.
      unknownA: fc.constant(true),
      unknownB: fc.boolean(),
      // A scope that is present but invalid -> [config:scope] at 'scope'.
      badScope: fc.constantFrom("@Bad", "nope", "@", "@a/b", "  "),
      // An unrecognised roots member -> [config:unknown-key] at 'roots.bogus'.
      includeBogusRoot: fc.boolean(),
      // Invalid root paths -> [config:root-path] at 'roots.microservice' etc.
      badMicroservice: fc.constantFrom("/abs", "../up", "trail/", "a//b", "*glob"),
      includeBadCommon: fc.boolean(),
      // A rejected `entry` -> either one [config:entry-path] (an invalid path)
      // or one [config:entry-overlap] per colliding reserved path (a value equal
      // to, inside, or containing one of them). Both widen the tag span of the
      // returned list, which is what makes the ordering claim non-trivial.
      badEntry: fc.constantFrom(
        "/abs",
        "up/../down",
        "packages",
        "packages/contracts",
        "packages/microservices/inside",
      ),
    })
    .map((r) => {
      const roots: Record<string, unknown> = {
        microservice: r.badMicroservice,
      };
      if (r.includeBadCommon) roots["common"] = "bad\\seg";
      if (r.includeBogusRoot) roots["bogus"] = "packages/whatever";

      const obj: Record<string, unknown> = {
        // Deliberately unsorted key order in the source object; the parser must
        // still return a sorted diagnostic list regardless of input order.
        zzz: r.unknownA,
        aaa: r.unknownB,
        scope: r.badScope,
        entry: r.badEntry,
        roots,
      };
      return JSON.stringify(obj);
    });
}

/** The parser's own ordering key, recomputed independently by this test: a
 *  total order by ascending code-point comparison of `tag` then `at`, using
 *  raw `<`/`>` on the strings and never `localeCompare`. */
function compareDiagnostics(a: ConfigDiagnostic, b: ConfigDiagnostic): number {
  if (a.tag < b.tag) return -1;
  if (a.tag > b.tag) return 1;
  if (a.at < b.at) return -1;
  if (a.at > b.at) return 1;
  return 0;
}

/** The `(tag, at)` pair as a single comparable key. */
function pairKey(d: ConfigDiagnostic): string {
  return `${d.tag}\u0000${d.at}`;
}

describe("Property 9: diagnostics are deterministic and identically ordered", () => {
  it("returns deep-equal diagnostics and byte-identical rendered text across two runs", () => {
    fc.assert(
      fc.property(anyInput(), (text) => {
        const first = parseProjectConfig(text, PROJECT_CONFIG_FILE);
        const second = parseProjectConfig(text, PROJECT_CONFIG_FILE);

        // The outcome discriminant is stable.
        expect(second.kind).toBe(first.kind);

        if (first.kind === "rejected" && second.kind === "rejected") {
          // R2.8 determinism: deep-equal arrays...
          expect(second.diagnostics).toStrictEqual(first.diagnostics);
          // ...and byte-identical rendered text in identical order.
          const renderedFirst = first.diagnostics
            .map(renderDiagnostic)
            .join("\n");
          const renderedSecond = second.diagnostics
            .map(renderDiagnostic)
            .join("\n");
          expect(renderedSecond).toBe(renderedFirst);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("orders any rejection by code-point (tag, at) with no duplicate pair", () => {
    fc.assert(
      fc.property(anyInput(), (text) => {
        const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);
        if (outcome.kind !== "rejected") return;

        const diagnostics = outcome.diagnostics;

        // Ordering: recompute the sorted order independently and compare. A
        // stable copy sorted by the code-point comparator must equal the
        // returned order exactly.
        const independentlySorted = [...diagnostics].sort(compareDiagnostics);
        expect(diagnostics).toStrictEqual(independentlySorted);

        // The returned list is non-decreasing under the comparator, so no
        // adjacent pair is out of order (belt-and-braces alongside the equality
        // above).
        for (let i = 1; i < diagnostics.length; i += 1) {
          expect(
            compareDiagnostics(diagnostics[i - 1]!, diagnostics[i]!),
          ).toBeLessThanOrEqual(0);
        }

        // At most one diagnostic per distinct (tag, at) pair: a total order with
        // no duplicate pair.
        const pairs = diagnostics.map(pairKey);
        expect(new Set(pairs).size).toBe(pairs.length);
      }),
      { numRuns: 300 },
    );
  });

  it("exercises multi-diagnostic rejections so the ordering is non-trivial", () => {
    // A direct check that the multi-problem arbitrary really does produce
    // rejections with more than one diagnostic (so the ordering assertions above
    // are not vacuously passing on single-element lists).
    let sawMultiple = false;
    fc.assert(
      fc.property(multiProblemText(), (text) => {
        const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected" && outcome.diagnostics.length > 1) {
          sawMultiple = true;
        }
      }),
      { numRuns: 200 },
    );
    expect(sawMultiple).toBe(true);
  });
});

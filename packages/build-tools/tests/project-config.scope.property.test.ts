// Task 2.7 — Property 5: a scope is accepted exactly when it is a Valid_Scope.
//
// This is a biconditional over the `scope` value of a Project_Config. For a
// config text of the form `{"scope": <value>}`, where <value> is a JSON string
// spliced in with `JSON.stringify`, the Config_Parser:
//
//   - ACCEPTS the value if and only if it is a Valid_Scope — `@` followed by one
//     or more characters, each a lowercase ASCII letter, an ASCII digit, or a
//     hyphen (R3.1). On acceptance the outcome is `kind: "parsed"`, the
//     Effective_Config's `scope` is that value character for character (no
//     trimming, no case conversion, no `@` added or removed), and no
//     `[config:scope]` diagnostic is reported.
//
//   - REJECTS every other string value (R3.2, R3.3), returning `kind: "rejected"`
//     with exactly one `[config:scope]` diagnostic — one per rejected value, not
//     one per offending character — that names the key `scope`, reproduces the
//     value exactly as declared, and states the permitted character set. No
//     Effective_Config is produced for that input, and no second `[config:scope]`
//     diagnostic appears.
//
// Because the text is always `{"scope": <a JSON string>}`, the top level is a
// well-formed JSON object whose sole recognised key holds a string, so the only
// diagnostic the parser can raise for these inputs is `[config:scope]`: the
// `[config:unparsable]`, `[config:shape]`, and `[config:unknown-key]` paths are
// all unreachable here. That is what lets the rejected direction assert exactly
// one diagnostic overall, and specifically exactly one `[config:scope]`.
//
// The two `validScope()` / `invalidScope()` generators are the shared
// arbitraries; `invalidScope()` is pool-seeded with each spelling R3.3
// enumerates so the enumerated rejections are actually exercised, with a tail of
// constructively-invalid generated strings widening the exploration.
//
// Validates: Requirements 3.1, 3.2, 3.3

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  parseProjectConfig,
  PROJECT_CONFIG_FILE,
} from "../src/project-config.js";
import { invalidScope, validScope } from "./arbitraries/config.js";

/** A config text declaring exactly `scope`, with the value JSON-encoded. */
function scopeConfigText(value: string): string {
  return `{"scope": ${JSON.stringify(value)}}`;
}

describe("Property 5: a scope is accepted exactly when it is a Valid_Scope (R3.1, R3.2, R3.3)", () => {
  it("accepts every Valid_Scope and preserves it character for character (R3.1)", () => {
    fc.assert(
      fc.property(validScope(), (scope) => {
        const outcome = parseProjectConfig(
          scopeConfigText(scope),
          PROJECT_CONFIG_FILE,
        );

        expect(outcome.kind).toBe("parsed");
        if (outcome.kind !== "parsed") return;

        // The scope is preserved verbatim: no trimming, no case conversion, no
        // `@` added or removed (R3.1).
        expect(outcome.parsed.config.scope).toBe(scope);
      }),
    );
  });

  it("rejects every value that is not a Valid_Scope with exactly one [config:scope] diagnostic (R3.2, R3.3)", () => {
    fc.assert(
      fc.property(invalidScope(), (scope) => {
        const outcome = parseProjectConfig(
          scopeConfigText(scope),
          PROJECT_CONFIG_FILE,
        );

        // Rejected: no Effective_Config is produced for that input.
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind !== "rejected") return;

        // Exactly one [config:scope] diagnostic — one per rejected value, not
        // one per offending character (R3.2), and no second one.
        const scopeDiagnostics = outcome.diagnostics.filter(
          (d) => d.tag === "config:scope",
        );
        expect(scopeDiagnostics).toHaveLength(1);

        const [diagnostic] = scopeDiagnostics;
        // Names the key `scope`.
        expect(diagnostic!.at).toBe("scope");
        // Reproduces the rejected value exactly as declared. A value that is
        // empty or whitespace-only — both enumerated by R3.3 as rejectable —
        // is reproduced in JSON-quoted form so the `found` part is non-empty
        // (R2.13) and whitespace stays visible; every other value is verbatim.
        const expectedFound =
          scope.length === 0 || scope.trim().length === 0
            ? JSON.stringify(scope)
            : scope;
        expect(diagnostic!.found).toBe(expectedFound);
        // States the character set a scope permits.
        expect(diagnostic!.reason).toMatch(
          /lowercase ASCII letter.*ASCII digit.*hyphen/,
        );

        // For a `{"scope": <string>}` text the only possible diagnostic is
        // `[config:scope]`; assert that too so the "exactly one" claim covers
        // the whole returned list, not just the scope-tagged subset.
        expect(outcome.diagnostics).toHaveLength(1);
      }),
    );
  });
});

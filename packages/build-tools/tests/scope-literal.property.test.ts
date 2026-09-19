// Feature: config-driven-discovery, task 10.3 — Property 18 for the
// `[scope:literal]` check.
//
// Property 18: A scope literal is reported exactly when it is outside a comment.
//
// For any TypeScript source assembled from fragments placing the Scope_Default in
// a line comment, a block comment, a doc comment, a template substitution, a
// string literal, a template literal chunk, or an escaped spelling inside a
// string literal, `collectScopeLiterals` reports exactly the fragments that
// placed it in a string literal, a template chunk, or an escaped spelling — each
// with its 1-based line number — and reports nothing for the comment and
// substitution fragments.
//
// The verdict per fragment is fixed by its label in arbitraries/source.ts, so
// this property compares the checker's output against the labels rather than
// re-deriving what the checker should do.
//
// Validates: Requirements 12.4, 12.6, 12.7

import { describe, it } from "vitest";
import * as fc from "fast-check";

import { buildToolsSource } from "./arbitraries/source.js";
import { collectScopeLiterals } from "../src/scope-checks.js";

describe("Property 18: a scope literal is reported exactly when outside a comment", () => {
  it("reports exactly the string, template-chunk and escaped fragments, each at its line", () => {
    fc.assert(
      fc.property(buildToolsSource(), (assembled) => {
        const occurrences = collectScopeLiterals(() => [
          { file: assembled.file, text: assembled.text },
        ]);

        // The set of (file,line) pairs the checker reported.
        const reported = new Set(
          occurrences.map((o) => `${o.file}:${String(o.line)}`),
        );

        // The set of (file,line) pairs the labels say SHOULD be reported.
        const expected = new Set(
          assembled.fragments
            .filter((fragment) => fragment.verdict === "reported")
            .map((fragment) => `${assembled.file}:${String(fragment.lineNumber)}`),
        );

        // Exact match: every reported occurrence is expected and vice versa.
        if (reported.size !== expected.size) {
          return false;
        }
        for (const key of expected) {
          if (!reported.has(key)) {
            return false;
          }
        }
        // No comment or substitution fragment leaked in.
        for (const key of reported) {
          if (!expected.has(key)) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });
});

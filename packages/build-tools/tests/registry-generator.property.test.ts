// Feature: microservice-scaffold, Property 3: Registry selection.
// For any selector string s and namespace state n (the set of direct
// subdirectory names present in the Microservice_Namespace), let D(n) be that
// set of directory names. Then:
//  - If s selects "all" and D(n) is non-empty: selection succeeds and the
//    identifier set of the resulting registry equals D(n).
//  - If s names a list L and L subset of D(n): selection succeeds and the
//    identifier set equals set(L).
//  - If s selects "all" and D(n) is empty: selection throws an "empty
//    namespace" error.
//
// The all/list classification is computed by a local oracle (`referenceSelection`
// below) rather than by importing the parser: the parser is implementation detail
// of `resolveSelected` and not exported.
//
// The property is exercised through `resolveSelected(selector, directories)`,
// the pure selection function `generateRegistry` composes with the namespace
// listing to determine the registry's identifiers.
//
// Validates: Requirements R5.1, R5.3, R5.5, R6.1, R6.2, R10.2

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { resolveSelected } from "../src/selector.js";
import {
  arbSelectorString,
  arbNamespaceDirectories,
} from "@scaffold/contracts/testing";

/**
 * Reference classification of a raw selector, per design "Selector parsing".
 * Kept local and independent of the production parser (which is module-internal
 * to `selector.ts`), so the property checks against an oracle rather than
 * re-deriving the expected answer from the code under test.
 */
function referenceSelection(
  s: string,
): { kind: "all" } | { kind: "list"; identifiers: string[] } {
  const identifiers = s
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return s.trim() === "*" || identifiers.length === 0
    ? { kind: "all" }
    : { kind: "list", identifiers };
}

describe("Property 3: registry selection via resolveSelected", () => {
  it("resolves the identifier set correctly across selectors and namespaces", () => {
    fc.assert(
      fc.property(
        arbSelectorString,
        arbNamespaceDirectories,
        (selector, directories) => {
          const discovered = new Set(directories);
          const parsed = referenceSelection(selector);

          if (parsed.kind === "all") {
            if (directories.length === 0) {
              expect(() => resolveSelected(selector, directories)).toThrow(
                /\[selector:empty\]/,
              );
              return;
            }
            expect(new Set(resolveSelected(selector, directories))).toEqual(
              discovered,
            );
            return;
          }

          // list selector
          const requested = parsed.identifiers;
          const allPresent = requested.every((id) => discovered.has(id));

          if (allPresent) {
            // Identifier-set equality on success (order-independent).
            expect(new Set(resolveSelected(selector, directories))).toEqual(
              new Set(requested),
            );
          } else {
            expect(() => resolveSelected(selector, directories)).toThrow(
              /\[selector:unmatched\]/,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("throws an empty-namespace error for an all-selector over an empty namespace", () => {
    fc.assert(
      fc.property(fc.constantFrom("*", "", "   ", ",,,"), (selector) => {
        expect(() => resolveSelected(selector, [])).toThrow(
          /\[selector:empty\]/,
        );
      }),
      { numRuns: 100 },
    );
  });
});

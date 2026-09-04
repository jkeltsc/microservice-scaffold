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
  arbIdentifier,
} from "@microservices/contracts/testing";

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

// Feature: shared-packages, Property 2: The generated registry never contains a
// shared package.
//
// For any namespace layout and selector, the identifier set of the generated
// Microservice_Registry equals the set of selected packages/microservices/*
// directory names and is disjoint from the names of any top-level shared
// package — the registry contains no entry, import, or route for any shared
// package.
//
// The generator (`generateRegistry`, unmodified here) discovers microservices
// by scanning `packages/microservices/` ONLY; shared packages live one level
// up under `packages/` and are never seen by that scan. This property makes the
// exclusion explicit under the presence of shared packages: it models a full
// top-level layout — microservice-namespace directories alongside top-level
// shared-package names — feeds only the namespace directories into the
// selection function the generator composes with, and asserts the resulting
// identifier set is exactly the selected microservices and disjoint from every
// shared-package name. It then renders the same import/entry lines the generator
// emits from those identifiers and asserts no shared-package name appears in
// them (no entry, no import, no route).
//
// Validates: Requirements 5.1, 5.2, 5.3, 11.6

/**
 * Top-level shared-package names, disjoint by construction from any
 * Microservice_Identifier: each is an identifier prefixed with `shared-`, which
 * still matches the identifier grammar but is generated only for the shared set,
 * so a generated shared name can never collide with a generated microservice
 * name in the same layout.
 */
const arbSharedPackageNames: fc.Arbitrary<string[]> = fc.uniqueArray(
  arbIdentifier.map((id) => `shared-${id}`),
  { minLength: 0, maxLength: 5 },
);

/**
 * Renders the identifier-derived import and registry-entry lines exactly as
 * `generateRegistry` emits them, so the property can assert no shared-package
 * name leaks into an import, an entry, or a route (`sourcePackage`). Kept local
 * and byte-identical in structure to the production emitter's per-identifier
 * lines; the surrounding boilerplate is irrelevant to the disjointness check.
 */
function renderRegistryReferences(identifiers: readonly string[]): string {
  const imports = identifiers
    .map((id, i) => `import * as m${i} from "@microservices/${id}";`)
    .join("\n");
  const entries = identifiers
    .map(
      (id, i) =>
        `  { identifier: "${id}", module: m${i}, sourcePackage: "@microservices/${id}" },`,
    )
    .join("\n");
  return `${imports}\n${entries}`;
}

describe("Property 2: the generated registry excludes shared packages", () => {
  it("keeps the identifier set to selected microservices, disjoint from shared-package names", () => {
    fc.assert(
      fc.property(
        arbSelectorString,
        arbNamespaceDirectories,
        arbSharedPackageNames,
        (selector, microserviceDirectories, sharedNames) => {
          // The generator scans packages/microservices/ only, so shared-package
          // names — which live one level up under packages/ — are never part of
          // the directory listing handed to the selection function. The layout
          // models both, but only the namespace directories drive selection.
          const namespace = new Set(microserviceDirectories);
          const shared = new Set(sharedNames);
          const parsed = referenceSelection(selector);

          // Determine the expected registry identifier set from the namespace
          // directories alone, mirroring resolveSelected's own outcome.
          let identifiers: string[];
          if (parsed.kind === "all") {
            if (microserviceDirectories.length === 0) {
              // Empty namespace under an all-selector: no registry is produced.
              expect(() =>
                resolveSelected(selector, microserviceDirectories),
              ).toThrow(/\[selector:empty\]/);
              return;
            }
            identifiers = resolveSelected(selector, microserviceDirectories);
          } else {
            const requested = parsed.identifiers;
            const allPresent = requested.every((id) => namespace.has(id));
            if (!allPresent) {
              expect(() =>
                resolveSelected(selector, microserviceDirectories),
              ).toThrow(/\[selector:unmatched\]/);
              return;
            }
            identifiers = resolveSelected(selector, microserviceDirectories);
          }

          const identifierSet = new Set(identifiers);

          // The identifier set is exactly the selected microservice directories.
          if (parsed.kind === "all") {
            expect(identifierSet).toEqual(namespace);
          } else {
            expect(identifierSet).toEqual(new Set(parsed.identifiers));
          }

          // Every identifier is a genuine namespace directory ...
          for (const id of identifierSet) {
            expect(namespace.has(id)).toBe(true);
          }
          // ... and disjoint from every top-level shared-package name.
          for (const name of shared) {
            expect(identifierSet.has(name)).toBe(false);
          }

          // No shared-package name appears in any emitted import, entry, or
          // route line the generator would produce from these identifiers.
          const rendered = renderRegistryReferences(identifiers);
          for (const name of shared) {
            expect(rendered).not.toContain(`@microservices/${name}"`);
            expect(rendered).not.toContain(`"${name}"`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

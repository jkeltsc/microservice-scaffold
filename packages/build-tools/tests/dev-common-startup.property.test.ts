// Feature: api-dev-server, Property 10: Common_Startup yields one registry for both entry points
//
// Determinism half of Property 10. Common_Startup runs the Registry_Generator
// exactly once and both entry points (Production_Start and the Dev_Command)
// obtain their startup behavior from that single implementation (R11.1). For
// the two paths to be unable to drift apart, invoking the generator for the
// same Selector against the same discovered directory listing must produce the
// *same* Microservice_Registry every time — the content that ends up on disk is
// a pure function of (selector, discovered directories) (R11.3).
//
// This asserts that determinism directly: `generateRegistry(selector)` is
// invoked twice per generated selector over the real discovered directory
// listing, the emitted file is read after each invocation, and the two byte
// strings are required to be identical. The identifier set the file encodes is
// also required to equal `resolveSelected(selector, directories)`, so the
// generated registry is exactly the selection the two entry points share.
//
// Selectors are generated over the discovered directory listing itself
// (unset/blank/`*`, plus subsets and permutations of the real identifiers) so
// that `resolveSelected` always resolves — the determinism claim is about the
// success path both entry points exercise, not the unmatched-identifier error
// path, which sibling tests already cover.
//
// The generated registry at packages/overseer/src/generated/microservice-registry.ts
// is mutated by every invocation, so its original content is captured before
// the suite runs and restored afterwards, leaving the working tree as found.
//
// Validates: Requirements 11.3

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  generateRegistry,
  listMicroserviceDirectories,
} from "../src/generate-registry.js";
import { resolveSelected } from "../src/selector.js";

/** The well-known output path the generator writes and the Overseer imports. */
const REGISTRY_PATH = fileURLToPath(
  new URL(
    "../../overseer/src/generated/microservice-registry.ts",
    import.meta.url,
  ),
);

/** The real discovered microservice directory listing, resolved once. */
const directories = listMicroserviceDirectories();

/**
 * Selectors resolved over the discovered listing itself, so `resolveSelected`
 * always succeeds: the always-forms (unset, blank, whitespace, `*`) plus
 * subsets and permutations of the real identifiers, some padded with stray
 * whitespace and empty entries the parser tolerates.
 */
const arbResolvableSelector: fc.Arbitrary<string | undefined> = fc.oneof(
  // The "all" forms, including `undefined` for an unset MICROSERVICES.
  fc.constantFrom<(string | undefined)[]>(undefined, "", " ", "  ", "\t", "*"),
  // A non-empty subset of the real identifiers, shuffled, optionally padded
  // with surrounding whitespace and a stray empty entry.
  fc
    .subarray(directories, { minLength: 1 })
    .chain((ids) =>
      fc
        .tuple(
          fc.shuffledSubarray(ids, { minLength: ids.length }),
          fc.constantFrom("", " ", "  "),
          fc.constantFrom("", " ", "  "),
          fc.boolean(),
        )
        .map(([shuffled, lead, trail, addEmpty]) => {
          const parts = shuffled.map((id) => `${lead}${id}${trail}`);
          if (addEmpty) parts.push("");
          return parts.join(",");
        }),
    ),
);

/**
 * Parse the identifier set out of a generated registry's source. Each entry
 * line carries `identifier: "<id>"`, so the encoded set is recoverable without
 * importing the (untyped-at-runtime) module.
 */
function identifiersInRegistry(source: string): Set<string> {
  const ids = [...source.matchAll(/\bidentifier: "([^"]+)"/g)].map((m) => m[1]);
  return new Set(ids);
}

let originalRegistry: string;

describe("Property 10: Common_Startup yields one registry for both entry points (determinism)", () => {
  beforeAll(() => {
    // Capture the pre-existing generated registry so the suite can restore it.
    originalRegistry = readFileSync(REGISTRY_PATH, "utf8");
  });

  afterAll(() => {
    // Restore the working tree to the exact bytes we found, regardless of the
    // last selector the property left on disk.
    writeFileSync(REGISTRY_PATH, originalRegistry, "utf8");
  });

  it("produces byte-identical registry content on repeated generation for the same selector", () => {
    // Skip meaningfully rather than pass vacuously if the namespace is empty:
    // an all-selector would throw [selector:empty], which is not this property.
    expect(directories.length).toBeGreaterThan(0);

    fc.assert(
      fc.property(arbResolvableSelector, (selector) => {
        generateRegistry(selector);
        const first = readFileSync(REGISTRY_PATH, "utf8");

        generateRegistry(selector);
        const second = readFileSync(REGISTRY_PATH, "utf8");

        // Byte-identical content: the two entry points cannot drift.
        expect(second).toBe(first);

        // The encoded identifier set is exactly the shared selection outcome.
        const expected = new Set(resolveSelected(selector, directories));
        expect(identifiersInRegistry(first)).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});

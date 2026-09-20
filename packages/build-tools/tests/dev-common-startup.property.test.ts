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
// The Generated_Registry under the Entry_Root is mutated by every invocation, so
// its original bytes are captured before the suite runs and written back
// afterwards with a filesystem write — never through git — leaving the working
// tree as found. If no registry was present before the run, the file is removed
// instead. It is one of the three paths a test may write in place
// (registry-inversion R12.2, R12.3).
//
// Validates: Requirements 11.3

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { discoverPackages } from "../src/discovery.js";
import {
  generateRegistry,
  generatedRegistryPath,
} from "../src/generate-registry.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import { resolveSelected } from "../src/selector.js";

/**
 * The real discovered microservice directory listing, resolved once. Comes from
 * the Discovery, the same source `generateRegistry` now reads it from; like the
 * generator's own output path it is cwd-relative, so this suite runs from the
 * repo root as it already did.
 */
const CONTEXT = projectContext(defaultEffectiveConfig());

const directories = discoverPackages(CONTEXT).byCategory.microservice.map(
  (pkg) => pkg.dirName,
);

/**
 * The output path the generator writes and the Entry_Module imports, taken from
 * `generatedRegistryPath` — the single derivation every writer, guard, and test
 * reads from (registry-inversion R5.8) — rather than spelled as a literal here.
 * It is Project_Directory-relative, so it is resolved against the repository root
 * for a read that does not depend on the worker's cwd.
 */
const REGISTRY_PATH = resolve(
  // tests/ -> build-tools -> packages -> repo root
  fileURLToPath(new URL("../../..", import.meta.url)),
  generatedRegistryPath(CONTEXT),
);

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

/** The registry's bytes before the run, or `undefined` when it was absent. */
let originalRegistry: string | undefined;

describe("Property 10: Common_Startup yields one registry for both entry points (determinism)", () => {
  beforeAll(() => {
    // Capture the pre-existing Generated_Registry so the suite can restore it —
    // and record its absence, so an absent file is removed rather than left
    // behind (registry-inversion R12.3).
    originalRegistry = existsSync(REGISTRY_PATH)
      ? readFileSync(REGISTRY_PATH, "utf8")
      : undefined;
  });

  afterAll(() => {
    // Restore the working tree to exactly what we found, regardless of the last
    // selector the property left on disk and regardless of whether the
    // assertions passed. A filesystem write, never a git command.
    if (originalRegistry === undefined) {
      rmSync(REGISTRY_PATH, { force: true });
    } else {
      writeFileSync(REGISTRY_PATH, originalRegistry, "utf8");
    }
  });

  it("produces byte-identical registry content on repeated generation for the same selector", () => {
    // Skip meaningfully rather than pass vacuously if the namespace is empty:
    // an all-selector would throw [selector:empty], which is not this property.
    expect(directories.length).toBeGreaterThan(0);

    fc.assert(
      fc.property(arbResolvableSelector, (selector) => {
        generateRegistry(CONTEXT, selector);
        const first = readFileSync(REGISTRY_PATH, "utf8");

        generateRegistry(CONTEXT, selector);
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

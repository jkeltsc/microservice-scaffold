// Feature: registry-inversion, Property 5: Regenerating the registry is
// idempotent and replaces rather than accumulates.
//
// For any generated ProjectContext and Selector, two consecutive
// Registry_Generator runs write byte-identical Generated_Registry contents and
// each terminate with a zero exit status; a run over a path already holding a
// Generated_Registry of different contents leaves the file byte-identical to the
// file a run into a directory holding none produces; and a run creates every
// absent directory of that path.
//
// This is one of the TWO properties of this feature that genuinely touch disk —
// whole-file replacement and directory creation are claims about the filesystem,
// not about the emitted text, so the pure `registryText` composer cannot express
// them. Everything else about the emitted bytes is asserted in memory by
// Properties 1, 2 and 6.
//
// The worktree discipline (R12.4, R12.5): every byte this suite writes lands
// inside ONE temporary root created in `beforeAll` and removed in `afterAll`,
// whether the assertions passed or failed. The trees themselves come from
// `materializeEntryTree`, which refuses any destination outside the operating
// system's temporary directory, so the suite cannot write into the checked-out
// tree even by mistake. `generateRegistry` resolves its output path against `cwd`,
// so each input pins `cwd` to its own materialised tree and restores the previous
// value in a `finally` — nothing is ever generated into the repository.
//
// `materializeEntryTree` writes no `src/` directory, which is what makes the
// directory-creation half observable: `<Entry_Root>/src/generated/` is genuinely
// absent before the first run.
//
// Validates: Requirements 4.7, 13.5

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import {
  generateRegistry,
  generatedRegistryPath,
} from "../src/generate-registry.js";
import { projectContext } from "../src/project-context.js";
import {
  arbSynthesizedTreeWithEntry,
  consumerPackagesOf,
  effectiveConfigOf,
  materializeEntryTree,
  microserviceIdentifiersOf,
  removeMaterializedTree,
  type EntryTreeDescription,
} from "./arbitraries/tree.js";

/**
 * The `Discovery` a description denotes, built from the shared pure derivation
 * rather than assembled inline. `generateRegistry` reads
 * `discovery.byCategory.microservice` only, but the whole value is supplied so the
 * generator is handed the same view of the repository every other derivation gets.
 */
function discoveryOf(description: EntryTreeDescription): Discovery {
  const microservice = consumerPackagesOf(description, "microservice");
  const common = consumerPackagesOf(description, "common");
  const spa = consumerPackagesOf(description, "spa");
  const all: readonly ConsumerPackage[] = [...microservice, ...common, ...spa];
  return {
    byCategory: { microservice, common, spa },
    nameByDir: new Map(all.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(all.map((pkg) => [pkg.name, pkg])),
  };
}

/** The three Selector spellings, over one tree's own identifiers. */
function arbSelector(
  description: EntryTreeDescription,
): fc.Arbitrary<string> {
  const identifiers = microserviceIdentifiersOf(description);
  return fc.oneof(
    fc.constant("*"),
    fc.constant(""),
    fc
      .shuffledSubarray([...identifiers], { minLength: 1 })
      .map((subset) => subset.join(",")),
  );
}

describe("Feature: registry-inversion, Property 5: regenerating the registry is idempotent and replaces rather than accumulates", () => {
  let tempRoot: string;

  beforeAll(() => {
    // ONE temporary root for the whole suite; each input gets a subdirectory of it
    // through `materializeEntryTree`, so the cost is one `mkdtempSync` per input
    // and no `npm ci` at all.
    tempRoot = mkdtempSync(join(tmpdir(), "registry-write-prop-"));
  });

  afterAll(() => {
    // Runs whether the assertions passed or failed (R12.4). `removeMaterializedTree`
    // refuses a destination outside the OS temporary directory.
    removeMaterializedTree(tempRoot);
  });

  it("creates the absent directories, writes identical bytes twice, and replaces different contents wholesale", () => {
    fc.assert(
      fc.property(
        arbSynthesizedTreeWithEntry().chain((description) =>
          arbSelector(description).map((selector) => ({
            description,
            selector,
          })),
        ),
        ({ description, selector }) => {
          const materialized = materializeEntryTree(description, tempRoot);
          const previousCwd = process.cwd();
          try {
            // `generateRegistry` resolves its output path against `cwd`; pinning it
            // to this input's own tree is what keeps every write inside the
            // temporary directory.
            process.chdir(materialized.dir);

            const context = projectContext(effectiveConfigOf(description));
            const relativePath = generatedRegistryPath(context);
            const absolutePath = join(materialized.dir, relativePath);

            // R13.5, directory creation: `<Entry_Root>/src/generated/` is absent
            // before the first run — `materializeEntryTree` writes no `src/`.
            expect(existsSync(dirname(absolutePath))).toBe(false);

            // Run 1, into a directory holding no Generated_Registry. A thrown error
            // is the non-zero exit status, so returning normally IS the zero-status
            // half of R4.7.
            generateRegistry(context, selector, discoveryOf(description));
            expect(existsSync(absolutePath)).toBe(true);
            const clean = readFileSync(absolutePath);
            expect(clean.length).toBeGreaterThan(0);

            // Run 2, over the file run 1 wrote: byte-identical, zero status.
            generateRegistry(context, selector, discoveryOf(description));
            const second = readFileSync(absolutePath);
            expect(second.equals(clean)).toBe(true);

            // Run 3, over a path already holding DIFFERENT contents. The planted
            // text is deliberately longer than any registry this tree produces, so
            // an append or a truncate-and-extend would leave a longer file and fail
            // the byte comparison rather than passing by coincidence.
            writeFileSync(
              absolutePath,
              "// stale registry contents that must not survive\n".repeat(64),
              "utf8",
            );
            generateRegistry(context, selector, discoveryOf(description));
            const replaced = readFileSync(absolutePath);
            expect(replaced.equals(clean)).toBe(true);
            expect(replaced.length).toBe(clean.length);

            // No temporary sibling is left behind at the destination's directory.
            expect(existsSync(`${absolutePath}.tmp`)).toBe(false);
          } finally {
            process.chdir(previousCwd);
            removeMaterializedTree(materialized.dir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

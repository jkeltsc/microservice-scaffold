// Feature: registry-inversion, Property 9: Exactly one staged package sits at a
// package directory, and it holds the Entry_Point_Path.
//
// For any generated Selector over a generated Synthesized_Tree, exactly one entry
// of the Image_Assembler's plan stages a package at a target outside
// `node_modules/<Configured_Scope>/`, that target equals the Entry_Root, one staged
// target equals `node_modules/<Configured_Scope>/contracts` under every Selector,
// and staging the plan into an operating-system temporary directory produces a file
// at the Entry_Point_Path within that directory.
//
// This is the second of the two properties of this feature that touch disk, and it
// touches disk for one reason: the last clause is a claim about a real file at a
// real path. The three clauses before it are read off `plan.stage`, which is pure.
//
// The worktree discipline (R12.4, R12.5): ONE temporary root in `beforeAll`, one
// materialised tree per generated input inside it through `materializeEntryTree` —
// which refuses any destination outside the operating system's temporary directory
// — and removal of the root in `afterAll` whether the assertions passed or failed.
// `stageImageTree` resolves each staged package's source directory against `cwd`,
// so each input pins `cwd` to its own tree and restores the previous value in a
// `finally`. Nothing is written inside the checked-out repository, and the
// Image_Tree itself is assembled into a subdirectory of the materialised tree.
//
// `materializeEntryTree` seeds a one-line `dist/index.js` for every package it
// writes, the Entry_Package's being exactly the Entry_Point_Path, so
// `assertBuildOutputsPresent` passes and the staged file the last clause looks for
// has something to be copied from.
//
// Validates: Requirements 9.6, 13.9

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildPlanFrom } from "../src/build-plan.js";
import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import { stageImageTree } from "../src/image-tree.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import {
  arbSynthesizedTreeWithEntry,
  consumerPackagesOf,
  effectiveConfigOf,
  entryPointPathOf,
  materializeEntryTree,
  microserviceIdentifiersOf,
  removeMaterializedTree,
  type EntryTreeDescription,
} from "./arbitraries/tree.js";

/** Every Consumer_Package of a description, in one list. */
function allPackages(
  description: EntryTreeDescription,
): readonly ConsumerPackage[] {
  return [
    ...consumerPackagesOf(description, "microservice"),
    ...consumerPackagesOf(description, "common"),
    ...consumerPackagesOf(description, "spa"),
  ];
}

/** The `Discovery` a description denotes, from the shared pure derivation. */
function discoveryOf(description: EntryTreeDescription): Discovery {
  const all = allPackages(description);
  return {
    byCategory: {
      microservice: consumerPackagesOf(description, "microservice"),
      common: consumerPackagesOf(description, "common"),
      spa: consumerPackagesOf(description, "spa"),
    },
    nameByDir: new Map(all.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(all.map((pkg) => [pkg.name, pkg])),
  };
}

/**
 * The dependency reader for the packages discovery never records.
 *
 * The Entry_Package names the scoped `overseer` and `contracts` packages and no
 * Microservice_Package, exactly as the manifest `materializeEntryTree` writes
 * declares them (R1.10, R1.11). That is what makes the Entry_Package a root of the
 * Required_Dependencies walk which reaches the Overseer_Library through a declared
 * dependency rather than as a root of its own (R9.1).
 */
function readerFor(
  context: ProjectContext,
  description: EntryTreeDescription,
): ReadDependencies {
  const declaredByDir = new Map<string, readonly string[]>(
    allPackages(description).map(
      (pkg) => [pkg.packageDir, pkg.dependencySpecifiers] as const,
    ),
  );
  const { contracts, overseer } = context.framework;
  return (packageDir) => {
    if (packageDir === context.entryRoot) return [overseer.name, contracts.name];
    if (packageDir === contracts.packageDir) return [];
    return declaredByDir.get(packageDir) ?? [contracts.name];
  };
}

/** The three Selector spellings, over one tree's own identifiers. */
function arbSelector(description: EntryTreeDescription): fc.Arbitrary<string> {
  const identifiers = microserviceIdentifiersOf(description);
  return fc.oneof(
    fc.constant("*"),
    fc.constant(""),
    fc
      .shuffledSubarray([...identifiers], { minLength: 1 })
      .map((subset) => subset.join(",")),
  );
}

describe("Feature: registry-inversion, Property 9: exactly one staged package sits at a package directory, and it holds the Entry_Point_Path", () => {
  let tempRoot: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "entry-staging-prop-"));
  });

  afterAll(() => {
    removeMaterializedTree(tempRoot);
  });

  it("stages the Entry_Package alone at a package directory, always stages `contracts`, and assembles a file at the Entry_Point_Path", () => {
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
            // `stageImageTree` resolves each staged package's source directory
            // against `cwd`; pinning it to this input's own tree keeps every read
            // and every write inside the temporary directory.
            process.chdir(materialized.dir);

            const context = projectContext(effectiveConfigOf(description));
            const plan = buildPlanFrom(
              context,
              selector,
              discoveryOf(description),
              readerFor(context, description),
            );

            // R9.6 / R13.9, first clause: exactly one staged entry sits at a target
            // outside the scope directory. `scopedEntry === undefined` is precisely
            // that condition — it is also what keeps the Integrity_Assertion silent
            // about the Entry_Package (R9.7).
            const outside = plan.stage.filter(
              (staged) => staged.scopedEntry === undefined,
            );
            expect(outside).toHaveLength(1);
            const entryStage = outside[0] as (typeof plan.stage)[number];

            // Second clause: that target equals the Entry_Root.
            expect(entryStage.targetDir).toBe(description.entryRoot);
            expect(entryStage.targetDir).toBe(context.entryRoot);
            expect(entryStage.sourceDir).toBe(context.entryRoot);
            expect(entryStage.justification).toBe("entry-package");

            // Every OTHER staged package lands under the scope directory, which is
            // the complement of the first clause stated positively.
            for (const staged of plan.stage) {
              if (staged.scopedEntry === undefined) continue;
              expect(
                staged.targetDir.startsWith(`${context.scopeDir}/`),
              ).toBe(true);
              expect(staged.targetDir).toBe(
                `${context.scopeDir}/${staged.scopedEntry}`,
              );
            }

            // Third clause: `contracts` is staged under every Selector, on
            // Framework_Singleton grounds (R9.4).
            expect(plan.stage.map((staged) => staged.targetDir)).toContain(
              `${context.scopeDir}/contracts`,
            );

            // Fourth clause: staging the plan produces a real file at the
            // Entry_Point_Path within the assembled tree. `outDir` is a
            // subdirectory of this input's own materialised tree, so it is inside
            // the OS temporary directory like everything else here.
            const outDir = join(materialized.dir, "image-out");
            stageImageTree(plan, outDir);
            const stagedEntryPoint = join(
              outDir,
              ...context.entryPointPath.split("/"),
            );
            expect(existsSync(stagedEntryPoint)).toBe(true);
            // The path is the single derivation's, cross-checked against the test's
            // own statement of the rule (R7.1).
            expect(context.entryPointPath).toBe(entryPointPathOf(description));
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

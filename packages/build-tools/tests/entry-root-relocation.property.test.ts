// Feature: registry-inversion, Property 6: Every derived path differs only in the
// Entry_Root prefix.
//
// For any generated ordered pair of distinct Entry_Roots the Config_Parser
// accepts and any generated Selector, holding the Configured_Scope, the three
// Discovery_Roots and the Synthesized_Tree's packages fixed across the pair,
// replacing the first Entry_Root with the second in the Generated_Registry's
// written path, in the Entry_Point_Path, in the path the Dev_Supervisor spawns and
// in the Image_Assembler's staged entry path each yields the path derived for the
// second Entry_Root; and the emitted Generated_Registry text, the derived
// Project_List with the Entry_Package's entry removed, and the staged entry list
// with the Entry_Root entry removed are byte-identical across the pair.
//
// This is the METAMORPHIC property of the Entry_Root: one transformation
// (`entryRootRelocatedAs`, the third of the arbitraries module's three, alongside
// `relocatedAs` and `rescopedAs`) applied to one description, with the two
// derivations compared. It runs ENTIRELY IN MEMORY — the four paths are pure
// derivations off the ProjectContext, the registry text comes from the pure
// `registryText`, and the Project_List and the staged list come from
// `buildPlanFrom` over an in-memory `Discovery` and an injected dependency reader.
// Nothing is written, so no temporary directory is needed.
//
// Why a substitution rather than a recomputation: `substituteEntryRoot` states
// the claim as a STRING operation on the first derivation's output, so the
// assertion compares two independently obtained values — one substituted, one
// derived — rather than comparing a derivation with itself. A derivation that had
// smuggled a second copy of the Entry_Root into its output, or normalised it,
// would fail here.
//
// Validates: Requirements 13.6

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildPlanFrom, type StagedPackage } from "../src/build-plan.js";
import { projectListFrom } from "../src/dev-supervisor.js";
import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import {
  generatedRegistryPath,
  registryText,
} from "../src/generate-registry.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import { resolveSelected } from "../src/selector.js";
import {
  arbAcceptedEntryRoot,
  DEFAULT_RESERVED_ENTRY_PATHS,
} from "./arbitraries/config.js";
import {
  arbSynthesizedTreeWithEntry,
  consumerPackagesOf,
  effectiveConfigOf,
  entryPackageNameOf,
  entryPointPathOf,
  entryRootRelocatedAs,
  generatedRegistryPathOf,
  microserviceIdentifiersOf,
  type EntryTreeDescription,
} from "./arbitraries/tree.js";

/** The four Framework_Singleton directory names, spelled here as the layout rule
 *  rather than imported, the same way `config.ts` and `tree.ts` spell them. */
const FRAMEWORK_DIR_NAMES: readonly string[] = [
  "contracts",
  "overseer",
  "build-tools",
  "integration-tests",
];

/** The last `/`-separated segment of a path. */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Replaces the Entry_Root prefix of a derived path, code point for code point.
 *
 * Total only over paths that ARE the Entry_Root or lie inside it, which is exactly
 * the four paths Requirement 13.6 quantifies over; any other input is a failure of
 * the property's premise and throws rather than returning a silently unchanged
 * value.
 */
function substituteEntryRoot(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  throw new Error(
    `"${path}" is neither the Entry_Root "${from}" nor a path inside it`,
  );
}

/** The `Discovery` a description denotes, from the shared pure derivation. */
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

/**
 * The `ReadDependencies` a description presents for the packages discovery never
 * records: the four Framework_Singletons and the Entry_Package.
 *
 * The Entry_Package declares the scoped `overseer` and `contracts` packages and no
 * Microservice_Package, exactly as R1.10 and R1.11 require its manifest to, so the
 * `Overseer → Entry_Package` and `contracts → Entry_Package` Prerequisite_Edges
 * arrive as DECLARED edges (R8.5). `contracts` declares nothing, so no
 * self-dependency is ever synthesised for it.
 */
function readerFor(
  context: ProjectContext,
  description: EntryTreeDescription,
): ReadDependencies {
  const declaredByDir = new Map<string, readonly string[]>(
    [
      ...consumerPackagesOf(description, "microservice"),
      ...consumerPackagesOf(description, "common"),
      ...consumerPackagesOf(description, "spa"),
    ].map((pkg) => [pkg.packageDir, pkg.dependencySpecifiers] as const),
  );
  const { contracts, overseer } = context.framework;

  return (packageDir) => {
    if (packageDir === context.entryRoot) return [overseer.name, contracts.name];
    if (packageDir === contracts.packageDir) return [];
    const declared = declaredByDir.get(packageDir);
    if (declared !== undefined) return declared;
    // The remaining three Framework_Singletons name `contracts` and nothing else.
    return [contracts.name];
  };
}

/** The one staged entry the Entry_Package contributes to a plan. */
function entryStageOf(
  stage: readonly StagedPackage[],
): StagedPackage {
  const entries = stage.filter(
    (staged) => staged.justification === "entry-package",
  );
  expect(entries).toHaveLength(1);
  return entries[0] as StagedPackage;
}

/** A staged entry rendered as text, so "byte-identical" is a string comparison. */
function renderStage(staged: StagedPackage): string {
  return `${staged.sourceDir} -> ${staged.targetDir} [${staged.justification}] scoped=${staged.scopedEntry ?? "-"}`;
}

/** One generated input: a description, a second accepted Entry_Root distinct from
 *  its first, and a Selector over its own identifiers. */
interface RelocationCase {
  readonly description: EntryTreeDescription;
  readonly secondEntryRoot: string;
  readonly selector: string;
}

/**
 * The generated ordered pair of Entry_Roots, plus a Selector.
 *
 * The second Entry_Root is drawn from `config.ts`'s `arbAcceptedEntryRoot` — the
 * same generator `arbSynthesizedTreeWithEntry` draws the first from, never a
 * second entry-root generator written here — and filtered exactly as that
 * generator filters its own draw: distinct from the first, its last segment
 * matching no package directory name and no Framework_Singleton directory name, so
 * the relocated Entry_Package's composed name collides with nothing. A collision
 * would make two packages declare one name, which is a different failure from the
 * one this property is about.
 */
function arbRelocationCase(): fc.Arbitrary<RelocationCase> {
  return arbSynthesizedTreeWithEntry().chain((description) => {
    const dirNames = new Set(description.packages.map((spec) => spec.dirName));
    const identifiers = microserviceIdentifiersOf(description);
    return fc
      .tuple(
        arbAcceptedEntryRoot(DEFAULT_RESERVED_ENTRY_PATHS).filter(
          (entryRoot) =>
            entryRoot !== description.entryRoot &&
            !dirNames.has(lastSegment(entryRoot)) &&
            !FRAMEWORK_DIR_NAMES.includes(lastSegment(entryRoot)),
        ),
        fc.oneof(
          fc.constant("*"),
          fc.constant(""),
          fc
            .shuffledSubarray([...identifiers], { minLength: 1 })
            .map((subset) => subset.join(",")),
        ),
      )
      .map(([secondEntryRoot, selector]): RelocationCase => ({
        description,
        secondEntryRoot,
        selector,
      }));
  });
}

describe("Feature: registry-inversion, Property 6: every derived path differs only in the Entry_Root prefix", () => {
  it("maps every derived path by the Entry_Root substitution and leaves the registry text, the Project_List and the staged list unchanged", () => {
    fc.assert(
      fc.property(
        arbRelocationCase(),
        ({ description, secondEntryRoot, selector }) => {
          // The transformation: the Configured_Scope, the three Discovery_Roots and
          // the packages are held fixed; only the Entry_Root moves.
          const first = description;
          const second = entryRootRelocatedAs(description, secondEntryRoot);
          expect(second.scope).toBe(first.scope);
          expect(second.roots).toStrictEqual(first.roots);
          expect(second.packages).toStrictEqual(first.packages);

          const c1 = projectContext(effectiveConfigOf(first));
          const c2 = projectContext(effectiveConfigOf(second));
          const sub = (path: string): string =>
            substituteEntryRoot(path, first.entryRoot, second.entryRoot);

          // ---- the four derived paths -------------------------------------
          // 1. The Generated_Registry's written path.
          expect(sub(generatedRegistryPath(c1))).toBe(generatedRegistryPath(c2));
          // Cross-checked against the test's own statement of the rule, so the
          // comparison is not one derivation against itself.
          expect(generatedRegistryPath(c2)).toBe(generatedRegistryPathOf(second));

          // 2. The Entry_Point_Path, and 3. the path the Dev_Supervisor spawns —
          // one string, because `runDevSupervisorCli` spawns
          // `context.entryPointPath` and composes no path of its own (R7.1, R10.1).
          expect(sub(c1.entryPointPath)).toBe(c2.entryPointPath);
          expect(c2.entryPointPath).toBe(entryPointPathOf(second));

          // 4. The Image_Assembler's staged entry path.
          const plan1 = buildPlanFrom(
            c1,
            selector,
            discoveryOf(first),
            readerFor(c1, first),
          );
          const plan2 = buildPlanFrom(
            c2,
            selector,
            discoveryOf(second),
            readerFor(c2, second),
          );
          const entry1 = entryStageOf(plan1.stage);
          const entry2 = entryStageOf(plan2.stage);
          expect(sub(entry1.targetDir)).toBe(entry2.targetDir);
          expect(sub(entry1.sourceDir)).toBe(entry2.sourceDir);
          expect(entry2.targetDir).toBe(second.entryRoot);

          // The Entry_Package's composed name follows the new Entry_Root's last
          // segment, which is the one thing about it that is not a path.
          expect(entryPackageNameOf(second)).toBe(
            c2.scopedName(lastSegment(second.entryRoot)),
          );

          // ---- the three values held byte-identical ------------------------
          // The emitted Generated_Registry text. The Entry_Root reaches the
          // registry's PATH and never its CONTENTS, so relocation cannot change a
          // byte of it.
          const selected = resolveSelected(
            selector,
            microserviceIdentifiersOf(first),
          );
          expect(registryText(c2, selector, selected)).toBe(
            registryText(c1, selector, selected),
          );

          // The derived Project_List with the Entry_Package's entry removed.
          const list1 = projectListFrom(
            c1,
            selector,
            discoveryOf(first),
            readerFor(c1, first),
          );
          const list2 = projectListFrom(
            c2,
            selector,
            discoveryOf(second),
            readerFor(c2, second),
          );
          expect(list1).toContain(first.entryRoot);
          expect(list2).toContain(second.entryRoot);
          expect(list2.filter((dir) => dir !== second.entryRoot)).toStrictEqual(
            list1.filter((dir) => dir !== first.entryRoot),
          );

          // The staged entry list with the Entry_Root entry removed.
          const staged1 = plan1.stage
            .filter((staged) => staged.justification !== "entry-package")
            .map(renderStage);
          const staged2 = plan2.stage
            .filter((staged) => staged.justification !== "entry-package")
            .map(renderStage);
          expect(staged2).toStrictEqual(staged1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

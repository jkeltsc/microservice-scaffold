// Feature: registry-inversion, Property 7: The derived order places the
// Entry_Package last, invariantly under `workspaces` permutation.
//
// For any generated Synthesized_Tree whose Dependency_Specifier graph contains no
// cycle, any generated Selector, and any generated permutation of the Root_Manifest
// `workspaces` entries, the derived order places the Entry_Package at an index
// greater than that of every Selected_Microservice and greater than that of the
// Overseer, the Verification_Pass reports no violation, and the derived order and
// the derived Project_List are identical element for element to those derived from
// the unpermuted Root_Manifest.
//
// HOW THE PERMUTATION IS MADE OBSERVABLE, and why that is the point. No
// Order_Producing_Path reads the `workspaces` array to decide what builds first —
// that is the invariant `check:invariants`' `[workspaces:order-source]` check
// enforces — so a permutation cannot be fed to a derivation directly. What npm
// DOES use the array for is discovery: the order in which the workspace packages
// are enumerated. So the permuted array is expanded into the package directories it
// covers, in its own order, and that order becomes the order of the `WorkspaceNode`
// list and of each `Discovery` category. Those enumeration orders are the only
// channel through which the `workspaces` order could leak into a derived order, and
// the property asserts they do not: both derivations are compared element for
// element against the ones the baseline array produces.
//
// The suite runs ENTIRELY IN MEMORY: `buildSequence`, `verifyBuildOrder`,
// `prerequisiteEdges`, `workspaceBuildOrder` and `projectListFrom` are all pure
// over an injected `Discovery` and dependency reader, so no tree is materialised
// and nothing is written.
//
// `arbSynthesizedTreeWithEntry` draws its dependency edges so the graph is acyclic
// AND free of Ordering_Violations under the Build_Sequence's fixed statement order,
// which is exactly the premise Requirement 13.7 quantifies over.
//
// Validates: Requirements 8.1, 13.7

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  buildSequence,
  prerequisiteEdges,
  verifyBuildOrder,
  type SequencedPackage,
} from "../src/build-sequence.js";
import { projectListFrom } from "../src/dev-supervisor.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import type { ConsumerCategory } from "../src/framework.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import { resolveSelected } from "../src/selector.js";
import {
  workspaceBuildOrder,
  type WorkspaceNode,
} from "../src/workspace-build-order.js";
import {
  arbSynthesizedTreeWithEntry,
  arbWorkspacesPermutation,
  consumerPackagesOf,
  effectiveConfigOf,
  entryPackageNameOf,
  microserviceIdentifiersOf,
  workspacesEntriesOf,
  type EntryTreeDescription,
} from "./arbitraries/tree.js";

/** Every Consumer_Package of a description, in one list. */
function allConsumerPackages(
  description: EntryTreeDescription,
): readonly ConsumerPackage[] {
  return [
    ...consumerPackagesOf(description, "microservice"),
    ...consumerPackagesOf(description, "common"),
    ...consumerPackagesOf(description, "spa"),
  ];
}

/**
 * Expands a `workspaces` array into the package directories it covers, IN THE
 * ARRAY'S OWN ORDER — a glob contributing its members and a literal entry itself.
 *
 * This is the one place the permutation becomes observable: permuting the array
 * permutes this list, and every downstream enumeration order is taken from it.
 */
function membersOf(
  description: EntryTreeDescription,
  entries: readonly string[],
): readonly string[] {
  const byRoot = new Map<string, readonly string[]>(
    (["microservice", "common", "spa"] as const).map((category) => [
      description.roots[category],
      consumerPackagesOf(description, category).map((pkg) => pkg.packageDir),
    ]),
  );

  const members: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith("/*")) {
      members.push(...(byRoot.get(entry.slice(0, -2)) ?? []));
    } else {
      members.push(entry);
    }
  }
  return members;
}

/**
 * The `WorkspaceNode` list a description presents, enumerated in `order`.
 *
 * The same shape `workspaceNodesFrom` collects: the four Framework_Singletons at
 * tier `"framework"`, the Entry_Package at tier `"entry"` (named by its Entry_Root's
 * last segment, exactly as statement 6 names it), and every Consumer_Package at its
 * category's tier. Only the ORDER differs between the baseline and the permuted
 * call, which is the property's whole subject.
 */
function nodesIn(
  context: ProjectContext,
  description: EntryTreeDescription,
  order: readonly string[],
): readonly WorkspaceNode[] {
  const consumerByDir = new Map(
    allConsumerPackages(description).map((pkg) => [pkg.packageDir, pkg]),
  );
  const frameworkByDir = new Map(
    context.framework.all.map((entry) => [entry.packageDir, entry]),
  );
  const reader = readerFor(context, description);

  return order.map((packageDir): WorkspaceNode => {
    if (packageDir === context.entryRoot) {
      return {
        packageDir,
        name: entryPackageNameOf(description),
        dependencySpecifiers: reader(packageDir),
        tier: "entry",
      };
    }
    const framework = frameworkByDir.get(packageDir);
    if (framework !== undefined) {
      return {
        packageDir,
        name: framework.name,
        dependencySpecifiers: reader(packageDir),
        tier: "framework",
      };
    }
    const consumer = consumerByDir.get(packageDir);
    if (consumer === undefined) {
      throw new Error(`"${packageDir}" is not a workspace member of this tree`);
    }
    return {
      packageDir,
      name: consumer.name,
      dependencySpecifiers: consumer.dependencySpecifiers,
      tier: consumer.category,
    };
  });
}

/**
 * The `Discovery` a description presents with each category enumerated in `order`.
 *
 * Permuting the categories matters on its own account: an all-Selector resolves to
 * `discovery.byCategory.microservice` in ITS order, so a derived order that took
 * its statement-4 sequence from the Selector rather than from `packageDir` would
 * differ between the baseline and the permuted call.
 */
function discoveryIn(
  description: EntryTreeDescription,
  order: readonly string[],
): Discovery {
  const position = new Map(order.map((dir, index) => [dir, index]));
  const all = allConsumerPackages(description);
  const of = (category: ConsumerCategory): readonly ConsumerPackage[] =>
    all
      .filter((pkg) => pkg.category === category)
      .sort(
        (a, b) =>
          (position.get(a.packageDir) ?? 0) - (position.get(b.packageDir) ?? 0),
      );

  return {
    byCategory: {
      microservice: of("microservice"),
      common: of("common"),
      spa: of("spa"),
    },
    nameByDir: new Map(all.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(all.map((pkg) => [pkg.name, pkg])),
  };
}

/**
 * The dependency reader for the packages discovery never records — the four
 * Framework_Singletons and the Entry_Package.
 *
 * The Entry_Package names the scoped `overseer` and `contracts` packages and no
 * Microservice_Package (R1.10, R1.11), so its two Prerequisite_Edges are DECLARED
 * edges (R8.5) while the `Selected_Microservice → Entry_Package` edges are
 * synthesised (R8.4). `contracts` declares nothing, so no self-edge exists.
 */
function readerFor(
  context: ProjectContext,
  description: EntryTreeDescription,
): ReadDependencies {
  const declaredByDir = new Map<string, readonly string[]>(
    allConsumerPackages(description).map(
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

/**
 * The `SequencedPackage[]` a node list denotes over the full workspace membership,
 * partitioned the way `workspaceBuildOrder` partitions it. Needed because
 * `verifyBuildOrder` takes the sequenced order, while `workspaceBuildOrder` returns
 * the nodes.
 */
function sequenceOf(
  context: ProjectContext,
  nodes: readonly WorkspaceNode[],
): readonly SequencedPackage[] {
  const consumerOf = (
    node: WorkspaceNode,
    category: ConsumerCategory,
  ): ConsumerPackage => ({
    category,
    dirName: node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1),
    packageDir: node.packageDir,
    name: node.name,
    dependencySpecifiers: node.dependencySpecifiers,
    buildKind: buildKindOf(category),
  });

  return buildSequence(context, {
    common: nodes
      .filter((node) => node.tier === "common")
      .map((node) => consumerOf(node, "common")),
    microservices: nodes
      .filter((node) => node.tier === "microservice")
      .map((node) =>
        node.packageDir.slice(node.packageDir.lastIndexOf("/") + 1),
      ),
    spa: nodes
      .filter((node) => node.tier === "spa")
      .map((node) => consumerOf(node, "spa")),
    buildTools: true,
    testOnly: true,
  });
}

/** One generated input: a tree, a Selector over its own identifiers, and a
 *  permutation of its Root_Manifest `workspaces` entries (identity included). */
interface PermutationCase {
  readonly description: EntryTreeDescription;
  readonly selector: string;
  readonly permutedEntries: readonly string[];
}

function arbPermutationCase(): fc.Arbitrary<PermutationCase> {
  return arbSynthesizedTreeWithEntry().chain((description) => {
    const identifiers = microserviceIdentifiersOf(description);
    return fc
      .tuple(
        fc.oneof(
          fc.constant("*"),
          fc.constant(""),
          fc
            .shuffledSubarray([...identifiers], { minLength: 1 })
            .map((subset) => subset.join(",")),
        ),
        arbWorkspacesPermutation(workspacesEntriesOf(description)),
      )
      .map(([selector, permutedEntries]): PermutationCase => ({
        description,
        selector,
        permutedEntries,
      }));
  });
}

describe("Feature: registry-inversion, Property 7: the derived order places the Entry_Package last, invariantly under `workspaces` permutation", () => {
  it("places the Entry_Package after every Selected_Microservice and after the Overseer, reports no violation, and is unchanged by the permutation", () => {
    fc.assert(
      fc.property(
        arbPermutationCase(),
        ({ description, selector, permutedEntries }) => {
          const context = projectContext(effectiveConfigOf(description));
          const reader = readerFor(context, description);
          const identifiers = microserviceIdentifiersOf(description);
          const selected = resolveSelected(selector, identifiers);

          const baselineEntries = workspacesEntriesOf(description);
          // The permutation is a true permutation: same membership, some order.
          expect([...permutedEntries].sort()).toStrictEqual(
            [...baselineEntries].sort(),
          );

          const baselineMembers = membersOf(description, baselineEntries);
          const permutedMembers = membersOf(description, permutedEntries);
          expect([...permutedMembers].sort()).toStrictEqual(
            [...baselineMembers].sort(),
          );

          const baselineNodes = nodesIn(context, description, baselineMembers);
          const permutedNodes = nodesIn(context, description, permutedMembers);

          // ---- the derived order -------------------------------------------
          const baselineOrder = workspaceBuildOrder(context, baselineNodes).map(
            (node) => node.packageDir,
          );
          const permutedOrder = workspaceBuildOrder(context, permutedNodes).map(
            (node) => node.packageDir,
          );
          expect(permutedOrder).toStrictEqual(baselineOrder);

          // R8.1 / R13.7: the Entry_Package sits after every Selected_Microservice
          // and after the Overseer. Asserted over the PERMUTED derivation, which the
          // line above has already pinned to the baseline one.
          const entryIndex = permutedOrder.indexOf(context.entryRoot);
          expect(entryIndex).toBeGreaterThanOrEqual(0);
          for (const identifier of selected) {
            expect(
              permutedOrder.indexOf(
                `${context.roots.microservice}/${identifier}`,
              ),
              `Selected_Microservice "${identifier}" must precede the Entry_Package`,
            ).toBeLessThan(entryIndex);
          }
          expect(
            permutedOrder.indexOf(context.framework.overseer.packageDir),
          ).toBeLessThan(entryIndex);
          // Strictly before the test-only Framework_Singleton (statement 7).
          expect(entryIndex).toBeLessThan(
            permutedOrder.indexOf(
              context.framework.integrationTests.packageDir,
            ),
          );

          // The Verification_Pass reports no violation over the produced order.
          expect(
            verifyBuildOrder(
              context,
              sequenceOf(context, permutedNodes),
              prerequisiteEdges(context, permutedNodes, selected),
            ),
          ).toStrictEqual([]);

          // ---- the derived Project_List -------------------------------------
          const baselineList = projectListFrom(
            context,
            selector,
            discoveryIn(description, baselineMembers),
            reader,
          );
          const permutedList = projectListFrom(
            context,
            selector,
            discoveryIn(description, permutedMembers),
            reader,
          );
          expect(permutedList).toStrictEqual(baselineList);

          // The Entry_Package is in the Project_List under every Selector (R8.7),
          // and last of the three packages the property names.
          const listEntryIndex = permutedList.indexOf(context.entryRoot);
          expect(listEntryIndex).toBeGreaterThanOrEqual(0);
          expect(
            permutedList.indexOf(context.framework.overseer.packageDir),
          ).toBeLessThan(listEntryIndex);
          for (const identifier of selected) {
            expect(
              permutedList.indexOf(
                `${context.roots.microservice}/${identifier}`,
              ),
            ).toBeLessThan(listEntryIndex);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

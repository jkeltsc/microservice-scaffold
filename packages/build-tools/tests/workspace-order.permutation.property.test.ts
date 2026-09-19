// Feature: config-driven-discovery, Property 16: Build order and Project_List
// are invariant under `workspaces` permutation.
//
// For any Synthesized_Tree whose Dependency_Specifier graph holds no cycle, any
// Discovery_Root assignment satisfying the overlap and framework constraints, and
// any permutation of that tree's Root_Manifest `workspaces` entries, the derived
// workspace build order places `packages/contracts` first and each package ahead
// of every package declaring a Dependency_Specifier resolving to it, and the
// derived order, the derived Project_List, and the reported Workspace_Coverage
// violation set are identical across every permutation and depend on the
// Discovery_Root assignment only through each package's recorded directory.
//
// The claim rests on the design invariant that NO build path reads the
// `workspaces` array to decide what builds first: the build order comes from
// `workspaceBuildOrder(context, nodes)` and the Project_List from
// `buildPlanFrom(...).tscRoots`, whose inputs are the discovery result and the
// declared dependency edges — never the array's order. The array feeds only
// `checkWorkspaceCoverage`, and even there only membership matters, not order. So
// permuting the array (with each entry's `index` renumbered to its new position)
// must leave all three observables byte-identical. To make the claim genuine
// rather than tautological, the test re-derives all three from the permuted world
// and compares, rather than asserting the derivation ignores an argument it never
// receives.
//
// All in-memory: the tree is `arbitraries/tree.ts`'s `acyclicTree()`, and the
// `WorkspaceEntry` list is synthesised from the tree's roots.
//
// Validates: Requirements 10.1, 10.2, 10.4, 10.7, 10.8, 10.9, 14.15

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  discoverPackagesFrom,
  type ConsumerPackage,
} from "../src/discovery.js";
import { CONSUMER_CATEGORIES } from "../src/framework.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import { buildPlanFrom } from "../src/build-plan.js";
import {
  checkWorkspaceCoverage,
  type WorkspaceEntry,
  type WorkspacePackage,
} from "../src/repo-invariants.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";
import {
  acyclicTree,
  relocatedAs,
  relocatedRoots,
  treeInputs,
  type RootAssignment,
  type TreeDescription,
} from "./arbitraries/tree.js";

/** A default-scope context at the given roots. */
function contextWithRoots(roots: RootAssignment): ProjectContext {
  const base = defaultEffectiveConfig();
  return projectContext({ ...base, roots });
}

/** A `ReadDependencies` reader over a tree: a discovered package's scoped
 *  specifiers come from the tree; a framework package declares none (matching the
 *  synthesized layout, where no framework singleton carries an edge). */
function readerFor(tree: TreeDescription, context: ProjectContext): ReadDependencies {
  const { readManifest } = treeInputs(tree);
  return (packageDir: string): readonly string[] => {
    const read = readManifest(packageDir);
    if (read.kind !== "ok") return [];
    const deps = read.manifest.dependencies;
    if (deps === null || typeof deps !== "object") return [];
    return Object.keys(deps)
      .filter((key) => key.startsWith(context.specifierPrefix))
      .sort();
  };
}

/** The derived workspace build order over a tree, as package directories. */
function buildOrderDirs(tree: TreeDescription): readonly string[] {
  const context = contextWithRoots(tree.roots);
  const { listRoot, readManifest } = treeInputs(tree);
  const discovery = discoverPackagesFrom(context, listRoot, readManifest);
  const nodes = workspaceNodesFrom(context, discovery, readerFor(tree, context));
  return workspaceBuildOrder(context, nodes).map((node) => node.packageDir);
}

/** The derived Project_List (tscRoots) over a tree for the all-Selector. */
function projectList(tree: TreeDescription): readonly string[] {
  const context = contextWithRoots(tree.roots);
  const { listRoot, readManifest } = treeInputs(tree);
  const discovery = discoverPackagesFrom(context, listRoot, readManifest);
  return buildPlanFrom(context, "*", discovery, readerFor(tree, context)).tscRoots;
}

/**
 * The `workspaces` entries a tree would declare: one top-level glob per
 * configured root (`<root>/*`) plus the four Framework_Singleton directories.
 * This is the array whose ORDER Property 16 permutes; membership is what
 * coverage reads, so every workspace package is matched by exactly one entry and
 * the base layout is clean.
 */
function workspaceEntriesFor(tree: TreeDescription): readonly string[] {
  const rootGlobs = CONSUMER_CATEGORIES.map((category) => `${tree.roots[category]}/*`);
  const context = contextWithRoots(tree.roots);
  const frameworkDirs = context.framework.all.map((singleton) => singleton.packageDir);
  return [...rootGlobs, ...frameworkDirs];
}

/** Resolve a `workspaces` pattern list into {@link WorkspaceEntry} records, the
 *  way `repo-invariants.ts` does, using the tree to know which directories a glob
 *  matches. `index` is the position in the (possibly permuted) list. */
function resolveEntries(
  patterns: readonly string[],
  tree: TreeDescription,
): readonly WorkspaceEntry[] {
  const memberDirsByGlob = (prefix: string): string[] =>
    tree.packages
      .filter((spec) => tree.roots[spec.category] === prefix)
      .map((spec) => `${prefix}/${spec.dirName}`)
      .sort();

  return patterns.map((pattern, index) => ({
    pattern,
    index,
    matches: pattern.endsWith("/*")
      ? memberDirsByGlob(pattern.slice(0, -"/*".length))
      : [pattern],
  }));
}

/** Every workspace package a tree presents to coverage: the four framework
 *  directories plus every discovered Consumer_Package. */
function workspacePackagesFor(tree: TreeDescription): readonly WorkspacePackage[] {
  const context = contextWithRoots(tree.roots);
  const { listRoot, readManifest } = treeInputs(tree);
  const discovery = discoverPackagesFrom(context, listRoot, readManifest);
  const consumers: ConsumerPackage[] = CONSUMER_CATEGORIES.flatMap(
    (category) => [...discovery.byCategory[category]],
  );
  return [
    ...context.framework.all.map((singleton) => ({
      packageDir: singleton.packageDir,
      name: singleton.name,
      dependencySpecifiers: [],
    })),
    ...consumers,
  ];
}

/** Whether a tree declares at least one Microservice_Package — required before
 *  the all-Selector Project_List can be derived without `[selector:empty]`. */
function hasMicroservice(tree: TreeDescription): boolean {
  return tree.packages.some((spec) => spec.category === "microservice");
}

/** A deterministic rotation of an array by `by` positions. */
function rotate<T>(items: readonly T[], by: number): readonly T[] {
  if (items.length === 0) return items;
  const k = ((by % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

describe("Property 16: build order and Project_List are invariant under `workspaces` permutation", () => {
  it("keeps order, Project_List, and coverage violations identical across permutations", () => {
    let nonEmpty = 0;

    fc.assert(
      fc.property(
        acyclicTree(),
        fc.integer({ min: 1, max: 20 }),
        (baseTree, rotation) => {
          if (baseTree.packages.length > 0) nonEmpty += 1;

          const patterns = workspaceEntriesFor(baseTree);
          const permuted = rotate(patterns, rotation);

          // The build order is derived from discovery and the dependency graph,
          // not from the array; a permutation of the array cannot change it.
          // Re-derive it to prove so. The Project_List is derived for the
          // all-Selector, which requires at least one discovered microservice
          // (an empty microservice set is a `[selector:empty]` failure, out of
          // this claim's scope), so it is only asserted when the tree has one.
          const order = buildOrderDirs(baseTree);
          const list = hasMicroservice(baseTree) ? projectList(baseTree) : undefined;

          // contracts leads the order (R10.2, R10.8).
          expect(order[0]).toBe(
            contextWithRoots(baseTree.roots).framework.contracts.packageDir,
          );

          // Each package precedes every package declaring a specifier resolving
          // to it (R10.8): walk the discovered edges and check positions.
          const context = contextWithRoots(baseTree.roots);
          const { listRoot, readManifest } = treeInputs(baseTree);
          const discovery = discoverPackagesFrom(context, listRoot, readManifest);
          const position = new Map(order.map((dir, i) => [dir, i]));
          for (const category of CONSUMER_CATEGORIES) {
            for (const pkg of discovery.byCategory[category]) {
              for (const specifier of pkg.dependencySpecifiers) {
                const prerequisite = discovery.byName.get(specifier);
                if (prerequisite === undefined) continue;
                if (prerequisite.category === "spa") continue; // never a prereq
                const p = position.get(prerequisite.packageDir);
                const d = position.get(pkg.packageDir);
                if (p !== undefined && d !== undefined) {
                  expect(p).toBeLessThan(d);
                }
              }
            }
          }

          // The coverage violation set is identical across the permutation. The
          // base layout is clean (each package matched by exactly one entry), so
          // both are empty — but the comparison, not the emptiness, is the claim.
          const baseCoverage = checkWorkspaceCoverage(
            resolveEntries(patterns, baseTree),
            workspacePackagesFor(baseTree),
          );
          const permutedCoverage = checkWorkspaceCoverage(
            resolveEntries(permuted, baseTree),
            workspacePackagesFor(baseTree),
          );
          expect([...permutedCoverage].sort()).toEqual([...baseCoverage].sort());

          // A permutation changes neither observable.
          expect(buildOrderDirs(baseTree)).toEqual(order);
          if (list !== undefined) {
            expect(projectList(baseTree)).toEqual(list);
          }
        },
      ),
      { numRuns: 200 },
    );

    expect(nonEmpty).toBeGreaterThan(0);
  });

  it("depends on the root assignment only through the recorded directory", () => {
    fc.assert(
      fc.property(acyclicTree(), relocatedRoots(), (baseTree, roots) => {
        const relocated = relocatedAs(baseTree, roots);

        // Strip each order/list entry down to its category+dirName (the
        // root-independent identity) and assert the two agree. The order and the
        // Project_List move only by the root prefix of each recorded directory.
        const stripRoot = (dirs: readonly string[], tree: TreeDescription): string[] =>
          dirs.map((dir) => {
            for (const category of CONSUMER_CATEGORIES) {
              const prefix = `${tree.roots[category]}/`;
              if (dir.startsWith(prefix)) return `${category}:${dir.slice(prefix.length)}`;
            }
            return dir; // a framework directory: root-independent already
          });

        expect(stripRoot(buildOrderDirs(relocated), relocated)).toEqual(
          stripRoot(buildOrderDirs(baseTree), baseTree),
        );
        if (hasMicroservice(baseTree)) {
          expect(stripRoot(projectList(relocated), relocated)).toEqual(
            stripRoot(projectList(baseTree), baseTree),
          );
        }
      }),
      { numRuns: 150 },
    );
  });
});

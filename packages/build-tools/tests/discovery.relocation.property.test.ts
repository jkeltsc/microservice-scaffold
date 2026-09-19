// Feature: config-driven-discovery, Property 11: Discovery is invariant under
// relocating a Discovery_Root.
//
// For any Synthesized_Tree holding 0 to 5 Consumer_Packages per Consumer_Category
// and any two Discovery_Root assignments each satisfying the overlap and
// framework constraints, Package_Discovery over the tree re-rooted at the first
// assignment and over the same tree re-rooted at the second yields, for each
// Consumer_Category, sequences of equal length in the same order whose
// corresponding entries carry identical Consumer_Category, directory name,
// declared name, build kind, and Dependency_Specifier list, and whose recorded
// package directories differ only in that Consumer_Category's Discovery_Root
// prefix.
//
// The property is exercised through `discoverPackagesFrom(context, listRoot,
// readManifest)`, the pure core of Package_Discovery, over the in-memory
// Synthesized_Trees of `arbitraries/tree.ts`. No filesystem is touched: a tree is
// a description plus the two injected functions the core takes, and relocation is
// a pure transformation of the description's `roots` field (`relocatedAs`). The
// context threaded in is `projectContext(defaultEffectiveConfig())` with only its
// `roots` replaced, so scope-composed names stay identical across the two runs
// and the sole difference between them is where each root sits — which is exactly
// the variable the property isolates.
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.10, 14.5

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  discoverPackagesFrom,
  type ConsumerPackage,
} from "../src/discovery.js";
import { CONSUMER_CATEGORIES } from "../src/framework.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  DEFAULT_ROOTS,
  relocatedAs,
  relocatedRoots,
  synthesizedTree,
  treeInputs,
  type RootAssignment,
  type TreeDescription,
} from "./arbitraries/tree.js";

/** A context whose scope is the default and whose roots are the given assignment.
 *  Every scope-dependent value (names, specifier prefix) is therefore constant
 *  across relocation; only the roots move. */
function contextWithRoots(roots: RootAssignment) {
  const base = defaultEffectiveConfig();
  return projectContext({ ...base, roots });
}

/** Runs the pure discovery core over a description at its own declared roots. */
function discover(description: TreeDescription) {
  const { listRoot, readManifest } = treeInputs(description);
  return discoverPackagesFrom(
    contextWithRoots(description.roots),
    listRoot,
    readManifest,
  );
}

/** A discovered package projected onto everything relocation must preserve —
 *  every field except the root-prefixed `packageDir`. */
function invariantFields(pkg: ConsumerPackage) {
  return {
    category: pkg.category,
    dirName: pkg.dirName,
    name: pkg.name,
    buildKind: pkg.buildKind,
    dependencySpecifiers: [...pkg.dependencySpecifiers],
  };
}

/** The expected relocated package directory: the same directory name under the
 *  new root of that package's category. */
function relocatedDir(
  pkg: ConsumerPackage,
  roots: RootAssignment,
): string {
  return `${roots[pkg.category]}/${pkg.dirName}`;
}

describe("Property 11: discovery is invariant under relocating a Discovery_Root", () => {
  it("yields matching results, differing only in the root prefix of each recorded directory", () => {
    // Coverage guards: a vacuous pass (only empty trees, or roots that never
    // actually move) must fail. `nonEmpty` counts trees with at least one
    // package; `moved` counts relocations that changed at least one root.
    let nonEmpty = 0;
    let moved = 0;

    fc.assert(
      fc.property(
        synthesizedTree(),
        relocatedRoots(),
        (base, roots) => {
          const relocated = relocatedAs(base, roots);

          const baseDiscovery = discover(base);
          const relocatedDiscovery = discover(relocated);

          if (base.packages.length > 0) nonEmpty += 1;
          if (
            CONSUMER_CATEGORIES.some(
              (category) => roots[category] !== DEFAULT_ROOTS[category],
            )
          ) {
            moved += 1;
          }

          for (const category of CONSUMER_CATEGORIES) {
            const before = baseDiscovery.byCategory[category];
            const after = relocatedDiscovery.byCategory[category];

            // Equal length, same order (R6.5): compare positionally.
            expect(after).toHaveLength(before.length);

            for (const [index, pkg] of before.entries()) {
              const other = after[index] as ConsumerPackage;

              // Category, directory name, declared name, build kind, and
              // dependency-specifier list are all identical (R6.1-R6.4, R6.10).
              expect(invariantFields(other)).toEqual(invariantFields(pkg));

              // The recorded package directory differs ONLY in the root prefix
              // of that category (R6.1): the relocated directory is the same
              // directory name under the new root.
              expect(pkg.packageDir).toBe(
                relocatedDir(pkg, DEFAULT_ROOTS),
              );
              expect(other.packageDir).toBe(relocatedDir(other, roots));
            }
          }

          // The resolution indexes carry the same declared names (R6.4): a name
          // is a function of scope and directory, neither of which relocation
          // touches.
          expect([...relocatedDiscovery.byName.keys()].sort()).toEqual(
            [...baseDiscovery.byName.keys()].sort(),
          );
        },
      ),
      { numRuns: 200 },
    );

    expect(nonEmpty).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
  });

  it("re-roots a single package at the exact relocated directory (concrete)", () => {
    const base: TreeDescription = {
      packages: [
        {
          category: "common",
          dirName: "config",
          dependencyDirNames: [],
          defect: undefined,
        },
      ],
      roots: DEFAULT_ROOTS,
      scope: defaultEffectiveConfig().scope,
    };
    const roots: RootAssignment = {
      microservice: "svc",
      common: "shared/lib",
      spa: "frontends",
    };

    const before = discover(base).byCategory.common[0] as ConsumerPackage;
    const after = discover(relocatedAs(base, roots)).byCategory
      .common[0] as ConsumerPackage;

    expect(before.packageDir).toBe("packages/common/config");
    expect(after.packageDir).toBe("shared/lib/config");
    expect(invariantFields(after)).toEqual(invariantFields(before));
  });
});

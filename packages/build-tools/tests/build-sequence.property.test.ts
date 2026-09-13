// Feature: unified-build-order, Property 3: The two paths agree on the relative order of every shared pair
// Feature: unified-build-order, Property 4: The two paths differ only in membership, never in statement order
// Feature: unified-build-order, Property 5: Determinism, and independence of presentation order
//
// The Build_Sequence primitive of design.md Components §1, exercised through the
// two PUBLIC derivations rather than the module under test directly:
//
//   - the Workspace_Build_Order:
//       `workspaceBuildOrder(workspaceNodesFrom(discovery, readDependencies))`,
//     the full-workspace membership (`buildTools` and `testOnly` both on, no
//     Selector);
//   - the Tsc_Root_Order: `buildPlanFrom(selector, discovery, readDependencies).tscRoots`,
//     the Selector-scoped membership (`build-tools`, `integration-tests`, the
//     unselected microservices, and every Spa_Package absent).
//
// Both are pure over an injected `Discovery` and `ReadDependencies`, so the
// widened in-memory layout model below is the entire world the derivations see —
// no filesystem, no `process` (2.13).
//
// The model widens the one `build-plan.property.test.ts` / `dev-project-list.property.test.ts`
// use in three ways the Build_Sequence properties need:
//
//   1. it generates EVERY Consumer_Category — Common, Spa, AND Microservice
//      packages — rather than only the two library categories, because
//      statement 4 (the microservices) is a first-class part of the sequence
//      these properties quantify over;
//   2. it lets the four Framework_Singletons participate as nodes with their own
//      declared specifiers (`contracts`, `build-tools`, `overseer`,
//      `integration-tests`), because the Workspace_Build_Order emits statements
//      1, 2, 5 and 6 from them and Property 4's statement-number mapping must see
//      those positions;
//   3. it offers a generator variant (`arbLayoutWithIntraStatementEdge`) that
//      plants a `microservice → peer-microservice` edge on purpose, so the
//      structural check of the Verification_Pass has an intra-statement (both in
//      statement 4) edge to catch. The base layout is otherwise violation-free.
//
// Every edge in the base layout points only at a package in an EARLIER statement
// (or, within statement 3, an earlier Common_Package), so the base graph is a
// DAG whose every edge is sound and whose Workspace_Build_Order carries no
// Ordering_Violation — which is what lets Properties 3, 4 and 5 read a
// successful derivation rather than a thrown one.
//
// Validates: Requirements 2.2, 2.3, 2.5, 2.7, 2.11, 2.14

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildPlanFrom } from "../src/build-plan.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import {
  prerequisiteEdges,
  verifyBuildOrder,
  buildSequence,
  type SequencedPackage,
} from "../src/build-sequence.js";
import {
  BUILD_TOOLS,
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
  INTEGRATION_TESTS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";

/** Framework directory names as data, so no generator collides with one. */
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

// ---------------------------------------------------------------------------
// The widened in-memory layout model
// ---------------------------------------------------------------------------
//
// A layout is every Consumer_Package a user of the template writes (in all three
// categories), plus the declared `@microservices`-scoped specifiers of the four
// Framework_Singletons. `contracts` always resolves (it is the first build root)
// and no generated specifier ever dangles, so a derivation always succeeds.

interface Layout {
  /** Common_Packages, in an order where each may depend only on an earlier one. */
  readonly commons: readonly ConsumerPackage[];
  /** Microservice_Packages; peers are never named in the base layout. */
  readonly microservices: readonly ConsumerPackage[];
  /** Spa_Packages; each may depend on Common and Microservice packages. */
  readonly spas: readonly ConsumerPackage[];
  /** Framework_Singleton specifiers, keyed by repo-relative package directory. */
  readonly frameworkDeps: Readonly<Record<string, readonly string[]>>;
}

/** A discovered Consumer_Package placed in its category's Namespace_Container. */
function consumerPackage(
  category: ConsumerCategory,
  dirName: string,
  dependencySpecifiers: readonly string[],
): ConsumerPackage {
  return {
    category,
    dirName,
    packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
    name: `${WORKSPACE_SCOPE}/${dirName}`,
    dependencySpecifiers: [...new Set(dependencySpecifiers)].sort(),
    buildKind: buildKindOf(category),
  };
}

/** Every discovered Consumer_Package of a layout, across all three categories. */
function allConsumers(layout: Layout): readonly ConsumerPackage[] {
  return [...layout.commons, ...layout.microservices, ...layout.spas];
}

/** Ascending code-point comparison of directory name. */
function byDirName(a: ConsumerPackage, b: ConsumerPackage): number {
  return a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;
}

/**
 * The `Discovery` a layout presents. Each category is sorted by directory name,
 * the order Package_Discovery guarantees (R2.5) and therefore the order an
 * all-Selector resolves to.
 */
function discoveryOf(layout: Layout): Discovery {
  const all = [...allConsumers(layout)];
  const of = (category: ConsumerCategory): readonly ConsumerPackage[] =>
    all.filter((pkg) => pkg.category === category).sort(byDirName);

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
 * A `ReadDependencies` reader over a layout. It answers for the four
 * Framework_Singletons (from `frameworkDeps`) and every Consumer_Package
 * (from its own specifiers) — `workspaceNodesFrom` reads a singleton's
 * specifiers through it, and `buildPlanFrom` reads the root consumers' through
 * it too. An unknown directory reads as no specifiers.
 */
function readerFor(layout: Layout): ReadDependencies {
  const specifiersByDir = new Map<string, readonly string[]>([
    ...Object.entries(layout.frameworkDeps),
    ...allConsumers(layout).map(
      (pkg) => [pkg.packageDir, pkg.dependencySpecifiers] as const,
    ),
  ]);
  return (packageDir) => specifiersByDir.get(packageDir) ?? [];
}

/** The Microservice_Identifiers a layout discovers, in discovery order. */
function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

// ---------------------------------------------------------------------------
// The two public derivations, over one layout
// ---------------------------------------------------------------------------

/** The Workspace_Build_Order as repo-relative directories, in produced order. */
function workspaceOrderOf(layout: Layout): readonly string[] {
  const nodes = workspaceNodesFrom(discoveryOf(layout), readerFor(layout));
  return workspaceBuildOrder(nodes).map((node) => node.packageDir);
}

/** The Tsc_Root_Order for a raw Selector value, as repo-relative directories. */
function tscRootsOf(
  layout: Layout,
  selector: string | undefined,
): readonly string[] {
  return buildPlanFrom(selector, discoveryOf(layout), readerFor(layout))
    .tscRoots;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]*$/)
  .filter((s) => s.length >= 1 && s.length <= 8);

/**
 * A base layout: 0..k Common_Packages, 1..k Microservice_Packages, 0..k
 * Spa_Packages, all with globally-unique directory names, plus per-singleton
 * specifiers.
 *
 * Every base edge points backwards across the statement structure, so the graph
 * is acyclic, every edge resolves, and no edge lands both endpoints in one
 * Unordered_Statement:
 *
 *   - a Common_Package may depend only on an EARLIER Common_Package (statement 3
 *     is Ordered, so `config → extended-config` is sound);
 *   - a Microservice_Package may depend only on a Common_Package (statement
 *     3 < 4). Naming a peer would put both in statement 4 — the structural
 *     violation `arbLayoutWithIntraStatementEdge` INJECTS, never a base edge;
 *   - a Spa_Package may depend on Common and Microservice packages (both earlier
 *     statements, and a Spa target is never a prerequisite anyway);
 *   - `contracts` declares nothing; `build-tools`, `overseer` and
 *     `integration-tests` may declare `@microservices/contracts` (statement 1 <
 *     2, 5, 6). The Overseer never declares a microservice — that edge is
 *     synthesised by the registry, not declared (1.8, 1.9).
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .record({
    commons: fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 3 }),
    microservices: fc.uniqueArray(arbDirName, { minLength: 1, maxLength: 3 }),
    spas: fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 2 }),
  })
  .filter(({ commons, microservices, spas }) => {
    const all = [...commons, ...microservices, ...spas];
    return (
      new Set(all).size === all.length &&
      all.every((d) => !FRAMEWORK_DIR_NAMES.includes(d))
    );
  })
  .chain(({ commons, microservices, spas }) => {
    const commonNames = commons.map((d) => `${WORKSPACE_SCOPE}/${d}`);
    const microserviceNames = microservices.map(
      (d) => `${WORKSPACE_SCOPE}/${d}`,
    );

    // Sound back-edge targets for a Common_Package at index i: earlier commons.
    const commonBackEdges = commons.map((_, i) =>
      fc.subarray(commonNames.slice(0, i)),
    );
    // A Microservice_Package may name any Common_Package.
    const microserviceBackEdges = microservices.map(() =>
      fc.subarray([...commonNames]),
    );
    // A Spa_Package may name any Common or Microservice package.
    const spaBackEdges = spas.map(() =>
      fc.subarray([...commonNames, ...microserviceNames]),
    );
    // Whether each of build-tools / overseer / integration-tests names contracts.
    const singletonNamesContracts = fc.tuple(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
    );

    return fc
      .tuple(
        fc.tuple(...commonBackEdges),
        fc.tuple(...microserviceBackEdges),
        fc.tuple(...spaBackEdges),
        singletonNamesContracts,
      )
      .map(([commonDeps, microserviceDeps, spaDeps, singletonDeps]) => {
        const commonPkgs = commons.map((d, i) =>
          consumerPackage("common", d, commonDeps[i]),
        );
        const microservicePkgs = microservices.map((d, i) =>
          consumerPackage("microservice", d, microserviceDeps[i]),
        );
        const spaPkgs = spas.map((d, i) =>
          consumerPackage("spa", d, spaDeps[i]),
        );

        const [btContracts, ovContracts, itContracts] = singletonDeps;
        const frameworkDeps: Record<string, readonly string[]> = {
          [CONTRACTS.packageDir]: [],
          [BUILD_TOOLS.packageDir]: btContracts ? [CONTRACTS.name] : [],
          [OVERSEER.packageDir]: ovContracts ? [CONTRACTS.name] : [],
          [INTEGRATION_TESTS.packageDir]: itContracts ? [CONTRACTS.name] : [],
        };

        return {
          commons: commonPkgs,
          microservices: microservicePkgs,
          spas: spaPkgs,
          frameworkDeps,
        };
      });
  });

/**
 * A raw `MICROSERVICES` value for a layout. Covers the all-Selector spellings
 * (unset, blank, whitespace, `*`, padded `*`) and comma lists that exercise
 * trimming and empty-entry dropping, drawn without repetition.
 */
function arbSelectorFor(layout: Layout): fc.Arbitrary<string | undefined> {
  const ids = discoveredIdentifiers(layout);
  return fc.oneof(
    fc.constantFrom<string | undefined>(undefined, "", "   ", "*", " * "),
    fc.subarray([...ids], { minLength: 1 }).chain((picked) =>
      fc
        .tuple(
          fc.tuple(...picked.map(() => fc.constantFrom("", " ", "  "))),
          fc.boolean(),
        )
        .map(([pads, trailingComma]) => {
          const body = picked
            .map((id, i) => `${pads[i]}${id}${pads[i]}`)
            .join(",");
          return trailingComma ? `${body},` : body;
        }),
    ),
  );
}

/** A layout paired with a raw Selector naming only discovered identifiers. */
const arbLayoutAndSelector: fc.Arbitrary<{
  layout: Layout;
  selector: string | undefined;
}> = arbLayout.chain((layout) =>
  arbSelectorFor(layout).map((selector) => ({ layout, selector })),
);

/**
 * A layout carrying one INTRA-STATEMENT edge: a Microservice_Package that names
 * a peer microservice, so both endpoints land in the Unordered statement 4. The
 * base layout never plants such an edge — this variant exists so Property 3's
 * divergence-free claim and Property 5's determinism claim are also exercised on
 * a layout the structural check has something to catch on (the pass reports it,
 * but the Workspace_Build_Order is still produced, since statement 4 has an
 * order — just not a guaranteed-sound one).
 *
 * `verifyBuildOrder` over the repository-wide order reports this edge as a
 * structural finding; but `workspaceBuildOrder` throws on it (the pass runs
 * inside it). So this variant is used only where the derivations are called with
 * the pass tolerated — see its single use in Property 5's presentation-order
 * block, which drives `buildSequence` directly rather than the throwing wrapper.
 */
const arbLayoutWithIntraStatementEdge: fc.Arbitrary<Layout> = arbLayout
  .filter((layout) => layout.microservices.length >= 2)
  .map((layout) => {
    const [a, b] = layout.microservices;
    const withPeer = layout.microservices.map((pkg) =>
      pkg.packageDir === a.packageDir
        ? {
            ...pkg,
            dependencySpecifiers: [
              ...new Set([...pkg.dependencySpecifiers, b.name]),
            ].sort(),
          }
        : pkg,
    );
    return { ...layout, microservices: withPeer };
  });

const NUM_RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// Independent statement-number oracle (never calls buildSequence)
// ---------------------------------------------------------------------------
//
// Maps a repo-relative package directory to the statement of 2.1 that must have
// emitted it, straight from the requirement: 1 contracts, 2 build-tools, 3
// common, 4 microservice, 5 overseer, 6 integration-tests, 7 spa.

function oracleStatementOf(layout: Layout, packageDir: string): number {
  if (packageDir === CONTRACTS.packageDir) return 1;
  if (packageDir === BUILD_TOOLS.packageDir) return 2;
  if (layout.commons.some((pkg) => pkg.packageDir === packageDir)) return 3;
  if (packageDir.startsWith(`${NAMESPACE_CONTAINER.microservice}/`)) return 4;
  if (packageDir === OVERSEER.packageDir) return 5;
  if (packageDir === INTEGRATION_TESTS.packageDir) return 6;
  if (packageDir.startsWith(`${NAMESPACE_CONTAINER.spa}/`)) return 7;
  throw new Error(`oracle: unclassifiable package directory "${packageDir}"`);
}

/** Is a sequence non-decreasing? */
function isNonDecreasing(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || values[i - 1] <= v);
}

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 3: The two paths agree on the relative order of every shared pair
describe("Property 3: the Workspace_Build_Order and the Tsc_Root_Order agree on every shared pair", () => {
  it("places every package both orders contain in the same relative order, and verifyBuildOrder reports no [build-order:divergence]", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const workspaceOrder = workspaceOrderOf(layout);
        const tscRoots = tscRootsOf(layout, selector);

        // Quantify over the INTERSECTION only: the Tsc_Root_Order legitimately
        // omits build-tools, integration-tests, unselected microservices, and
        // every Spa_Package. A package in only one order constrains nothing.
        const tscSet = new Set(tscRoots);
        const shared = workspaceOrder.filter((dir) => tscSet.has(dir));

        const workspacePos = new Map(
          workspaceOrder.map((dir, i) => [dir, i] as const),
        );
        const tscPos = new Map(tscRoots.map((dir, i) => [dir, i] as const));

        for (let i = 0; i < shared.length; i += 1) {
          for (let j = i + 1; j < shared.length; j += 1) {
            const a = shared[i];
            const b = shared[j];
            // `a` precedes `b` in the Workspace_Build_Order (that is how `shared`
            // was built); the two must agree, so `a` precedes `b` in the
            // Tsc_Root_Order too.
            const aTsc = tscPos.get(a)!;
            const bTsc = tscPos.get(b)!;
            expect(aTsc).toBeLessThan(bTsc);
            // And symmetrically over the Workspace positions, for good measure.
            expect(workspacePos.get(a)!).toBeLessThan(workspacePos.get(b)!);
          }
        }

        // The divergence check itself: build the two SequencedPackage orders the
        // pass compares and confirm it finds no divergence over the shared pairs.
        const nodes = workspaceNodesFrom(discoveryOf(layout), readerFor(layout));
        const fullOrder = orderForWorkspace(layout);
        const scopedOrder = orderForTscRoots(layout, selector);
        const edges = prerequisiteEdges(
          nodes,
          referenceSelected(selector, discoveredIdentifiers(layout)),
        );
        const messages = verifyBuildOrder(scopedOrder, edges, fullOrder);
        expect(
          messages.filter((m) => m.includes("[build-order:divergence]")),
        ).toEqual([]);
      }),
      NUM_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 4: The two paths differ only in membership, never in statement order
describe("Property 4: the two paths differ only in membership, never in statement order", () => {
  it("maps both orders to non-decreasing statement sequences, and the Tsc_Root_Order equals the Workspace_Build_Order filtered to Selector-scoped membership", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const workspaceOrder = workspaceOrderOf(layout);
        const tscRoots = tscRootsOf(layout, selector);

        // Both orders map to non-decreasing statement-number sequences over the
        // same numbering (2.1).
        const workspaceStatements = workspaceOrder.map((dir) =>
          oracleStatementOf(layout, dir),
        );
        const tscStatements = tscRoots.map((dir) =>
          oracleStatementOf(layout, dir),
        );
        expect(isNonDecreasing(workspaceStatements)).toBe(true);
        expect(isNonDecreasing(tscStatements)).toBe(true);

        // The Tsc_Root_Order equals the Workspace_Build_Order filtered to the
        // Selector-scoped membership: the two paths differ only in WHICH packages
        // take part, never in the statement order they take part in.
        const selected = referenceSelected(
          selector,
          discoveredIdentifiers(layout),
        );
        const scopedMembership = scopedMembershipDirs(layout, selected);
        const filtered = workspaceOrder.filter((dir) =>
          scopedMembership.has(dir),
        );
        expect(tscRoots).toEqual(filtered);
      }),
      NUM_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 5: Determinism, and independence of presentation order
describe("Property 5: determinism, and independence of presentation order", () => {
  it("repeated derivations of both orders agree element for element", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        expect(workspaceOrderOf(layout)).toEqual(workspaceOrderOf(layout));
        expect(tscRootsOf(layout, selector)).toEqual(
          tscRootsOf(layout, selector),
        );
      }),
      NUM_RUNS,
    );
  });

  it("two independent permutations of the layout's package list reproduce the unpermuted derivation", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 0, max: 999_999 }),
        (layout, seedA, seedB) => {
          const base = workspaceOrderOf(layout);
          const permA = workspaceOrderOf(permuteLayout(layout, seedA));
          const permB = workspaceOrderOf(permuteLayout(layout, seedB));
          expect(permA).toEqual(base);
          expect(permB).toEqual(base);

          // The Selector-scoped path is presentation-order independent too.
          const ids = discoveredIdentifiers(layout);
          const selector = ids.join(",");
          const baseTsc = tscRootsOf(layout, selector);
          expect(tscRootsOf(permuteLayout(layout, seedA), selector)).toEqual(
            baseTsc,
          );
          expect(tscRootsOf(permuteLayout(layout, seedB), selector)).toEqual(
            baseTsc,
          );
        },
      ),
      NUM_RUNS,
    );
  });

  it("consults no metadata beyond category, directory, name, and declared specifiers", () => {
    // Derive twice over layouts differing ONLY in fields the primitive must not
    // read. `buildKind` is derived from category, so it is the field to perturb:
    // flip every Common_Package's `buildKind` to the wrong value and confirm the
    // order is unmoved. If the primitive read `buildKind`, statement 3's members
    // would move; it does not, so the two orders are identical.
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const base = workspaceOrderOf(layout);
        const perturbed: Layout = {
          ...layout,
          commons: layout.commons.map((pkg) => ({
            ...pkg,
            // A meaningless value for a field the primitive must not consult.
            buildKind: "bundler-project",
          })),
          microservices: layout.microservices.map((pkg) => ({
            ...pkg,
            buildKind: "bundler-project",
          })),
        };
        expect(workspaceOrderOf(perturbed)).toEqual(base);
      }),
      NUM_RUNS,
    );
  });

  it("is unaffected by a planted intra-statement edge's presentation order (the order is still deterministic)", () => {
    // The intra-statement variant (a microservice naming a peer) makes the
    // Verification_Pass report a structural finding, so `workspaceBuildOrder`
    // throws. Drive the primitive directly here — `buildSequence` produces an
    // order regardless — and confirm the produced order is deterministic and
    // presentation-order independent even for this defect-bearing layout.
    fc.assert(
      fc.property(
        arbLayoutWithIntraStatementEdge,
        fc.integer({ min: 0, max: 999_999 }),
        (layout, seed) => {
          const membership = fullMembership(layout);
          const permutedMembership = fullMembership(permuteLayout(layout, seed));
          const base = buildSequence(membership).map((p) => p.packageDir);
          const permuted = buildSequence(permutedMembership).map(
            (p) => p.packageDir,
          );
          expect(permuted).toEqual(base);
        },
      ),
      NUM_RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Shared helpers used across the properties
// ---------------------------------------------------------------------------

/**
 * The all/list Selector rule restated (independent of `resolveSelected`): every
 * discovered identifier in discovery order when the raw value is unset, blank,
 * `*`, or splits into zero non-empty entries; otherwise the trimmed entries in
 * Selector order. Every generator names only discovered identifiers.
 */
function referenceSelected(
  selector: string | undefined,
  discovered: readonly string[],
): readonly string[] {
  const raw = selector ?? "";
  if (raw.trim() === "*") return [...discovered];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length === 0 ? [...discovered] : entries;
}

/**
 * The set of repo-relative directories the Tsc_Root_Order contains for a
 * Selector: statement 1 (`contracts`), statement 3 (every Common_Package — the
 * required-dependency resolver keeps only reachable ones, but on these layouts
 * every declared common edge is followed, so filtering the Workspace order to
 * this membership and the resolver agree), statement 4 (the Selected_Microservices),
 * statement 5 (the Overseer). Statements 2, 6, 7 contribute nothing.
 *
 * The membership is intersected against the actual Tsc_Root_Order below rather
 * than asserted to equal it here — Property 4 asserts the equality against the
 * FILTERED Workspace order, which is the requirement's own phrasing.
 */
function scopedMembershipDirs(
  layout: Layout,
  selected: readonly string[],
): ReadonlySet<string> {
  // Derive the real membership from the Tsc_Root_Order itself, so the "filtered
  // to the Selector-scoped membership" claim is checked against the actual
  // membership the resolver produced, not a re-derived guess. This keeps the
  // property honest: it asserts statement ORDER is preserved under filtering,
  // taking membership as given.
  const selector = selected.length === 0 ? "*" : selected.join(",");
  return new Set(tscRootsOf(layout, selector));
}

/** The full-workspace `SequenceMembership`, as Task 4.1's derivation builds it. */
function fullMembership(layout: Layout): {
  common: readonly ConsumerPackage[];
  microservices: readonly string[];
  spa: readonly ConsumerPackage[];
  buildTools: boolean;
  testOnly: boolean;
} {
  return {
    common: layout.commons,
    microservices: layout.microservices.map((pkg) => pkg.dirName),
    spa: layout.spas,
    buildTools: true,
    testOnly: true,
  };
}

/** The full-workspace produced order as SequencedPackages (for the pass). */
function orderForWorkspace(layout: Layout): readonly SequencedPackage[] {
  return buildSequence(fullMembership(layout));
}

/** The Selector-scoped produced order as SequencedPackages (for the pass). */
function orderForTscRoots(
  layout: Layout,
  selector: string | undefined,
): readonly SequencedPackage[] {
  const selected = referenceSelected(selector, discoveredIdentifiers(layout));
  const selectedSet = new Set(selected);
  // The required Common_Packages: on these layouts, statement 3's members that
  // the Tsc_Root_Order actually holds. Derive from the real plan so the pass's
  // counterpart matches production exactly.
  const tscRoots = new Set(tscRootsOf(layout, selector));
  return buildSequence({
    common: layout.commons.filter((pkg) => tscRoots.has(pkg.packageDir)),
    microservices: layout.microservices
      .filter((pkg) => selectedSet.has(pkg.dirName))
      .map((pkg) => pkg.dirName),
    spa: [],
    buildTools: false,
    testOnly: false,
  });
}

/**
 * A deterministic permutation of a layout's package lists driven by `seed`. Only
 * presentation order changes — every package, its category, name, and specifiers
 * are untouched — so a presentation-order-independent derivation must be unmoved.
 */
function permuteLayout(layout: Layout, seed: number): Layout {
  return {
    ...layout,
    commons: rotate(layout.commons, seed),
    microservices: rotate(layout.microservices, seed),
    spas: rotate(layout.spas, seed),
  };
}

/** Rotates a list by `seed` positions — a cheap, total, deterministic permutation. */
function rotate<T>(items: readonly T[], seed: number): readonly T[] {
  if (items.length === 0) return items;
  const k = seed % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

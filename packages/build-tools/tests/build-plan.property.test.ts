// Feature: package-categories, Property 15: Build_Kind is total and determined by category alone
// Feature: package-categories, Property 16: The `tsc --build` roots are exactly the Selector-justified Tsc_Projects, correctly ordered
// Feature: package-categories, Property 32: Staged ⊆ Required, and the difference is built but never shipped
//
// Every property here is exercised through the two pure functions the design
// makes the single derivation of a build: `buildKindOf(category)` and
// `buildPlanFrom(selector, discovery, readDependencies)`. No filesystem is
// touched — the `Discovery` handed to the plan is assembled by `discoveryOf`
// below and the root specifiers come from `readerFor`, so the injected layout is
// the entire world the derivation sees.
//
// The layout model is the one `required-dependencies.property.test.ts` uses, with two
// additions the plan needs:
//
//   - `discoveryOf` sorts each category by directory name, modelling the
//     ascending code-point order Package_Discovery guarantees (R2.5). That order
//     is what an all-Selector resolves to, so the plan is a deterministic
//     function of the layout rather than of generator happenstance.
//   - the Selector is generated as a raw `MICROSERVICES` *string* (unset, blank,
//     `*`, whitespace-padded, comma lists with padding and empty entries),
//     because `buildPlanFrom` takes the raw value and resolves it itself.
//
// One layout shape is distinguished rather than sampled: `arbCommonViaSpaCase`
// builds a Common_Package reachable *only* through a Spa_Package, along a
// `microservice → spa → common` chain and no other edge. That layout is the
// witness the revised Properties 15/16 and the new Property 32 turn on — it is
// the only shape in which the build set and the stage set differ, so the
// asymmetry "built as a `tsc --build` root, staged nowhere" (R6.12, R6.14,
// R7.13) is invisible without it. The random `arbLayout` generators keep the
// general claims broad; this one pins the strict-subset case they would only hit
// by accident.
//
// A note on Property 18. This file used to also carry "The Spa build set equals
// the required Spa_Packages, each built once in its own directory" as Property
// 18. The design's Testing Strategy now assigns `build-plan.property.test.ts`
// exactly Properties 15, 16, and 32, and Property 18 has been *retitled* ("The
// Bundler_Build_Phase is exactly the required Spa_Packages, each built once in
// its own directory, entirely after the Tsc_Build_Pass") and *relocated* to
// `spa-build-sequencing.property.test.ts`, where it asserts one `npm run build`
// per required Spa_Package, each once, in its own directory, after the single
// `tsc --build` — the same set-equality and once-per-directory coverage this
// file's Property 18 block held, now framed as the Bundler_Build_Phase. Keeping
// the old block here would either duplicate that coverage under a title design.md
// no longer assigns to this file, or claim a property the design has moved. So
// the Property 18 block is removed from this file, not deleted from the suite:
// its coverage lives in `spa-build-sequencing.property.test.ts`. The plan-level
// Spa facts this file still needs — a Spa_Package is never a `tsc --build` root
// even when required or named by a `microservice → spa` edge — are Property 16
// clauses and remain here.
//
// Generated list-Selectors name each identifier at most once. A
// duplicate-bearing Selector is a documented property of selector resolution —
// `resolveSelected` preserves duplicates in Selector order, which
// `selector-semantics.property.test.ts` pins — and root uniqueness (R6.6) is
// stated over the *set of Tsc_Projects a Selector justifies*, so the generators
// stay inside that space rather than asserting a clause the Selector semantics
// do not support.
//
// The oracles are written from the requirements rather than from
// `build-plan.ts`:
//
//   - `expectedBuildKind` restates R6.1/R6.2 as a switch over the category
//     union, with no reference to a manifest field;
//   - `referenceSelected` restates the all/list Selector rule;
//   - `referenceRequiredNames` / `referenceOrderedRequired` restate R7.1/R7.2 as a
//     worklist reachability walk plus a Kahn walk with a sorted ready queue;
//   - `referenceTscRoots` restates R6.3/R6.6/R13.5 as a literal concatenation —
//     contracts, the required Common_Packages, the Selected_Microservices, the
//     Overseer — filtering the Required_Dependencies on `category === "common"` where
//     production filters on `buildKind === "tsc-project"`;
//   - `referenceSpaBuilds` restates R6.4 as the required Spa_Packages — used by
//     Property 32 to check that a Bundler_Project required dependency is a build
//     target via `spaBuilds`.
//
// Validates: Requirements 5.4, 5.5, 6.1, 6.2, 6.3, 6.6, 6.7, 6.12, 6.13, 6.14, 7.13, 9.9, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ReadDependencies } from "../src/required-dependencies.js";
import { buildPlanFrom } from "../src/build-plan.js";
import {
  buildKindOf,
  discoverPackagesFrom,
  type BuildKind,
  type ConsumerPackage,
  type ContainerEntry,
  type Discovery,
  type ListContainer,
  type ManifestRead,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";
import {
  BUILD_TOOLS,
  CONSUMER_CATEGORIES,
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
  INTEGRATION_TESTS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";

/** Framework directory names as data, so no generator collides with one. */
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

/** The Consumer_Categories eligible to be required dependencies: everything but `microservice`. */
const LIBRARY_CATEGORIES: readonly ConsumerCategory[] = ["common", "spa"];

// ---------------------------------------------------------------------------
// Oracle: Build_Kind from category alone
// ---------------------------------------------------------------------------

/**
 * R6.1 and R6.2 restated: Tsc_Project for a Microservice_Package and a
 * Common_Package (and, off the consumer union, for every Framework_Singleton),
 * Bundler_Project for a Spa_Package. Exhaustive over the union by construction —
 * a category added to `ConsumerCategory` fails to typecheck here.
 */
function expectedBuildKind(category: ConsumerCategory): BuildKind {
  switch (category) {
    case "spa":
      return "bundler-project";
    case "common":
    case "microservice":
      return "tsc-project";
  }
}

/** The two Build_Kinds, as data, for the totality assertion. */
const BUILD_KINDS: readonly BuildKind[] = ["tsc-project", "bundler-project"];

// ---------------------------------------------------------------------------
// In-memory layout model
// ---------------------------------------------------------------------------
//
// A layout is a set of discovered Consumer_Packages — library packages (Common
// and Spa) plus Microservice_Packages — together with the Overseer's declared
// specifiers. Library packages are laid out in a list and may depend only on
// packages *earlier* in the list, so the graph is always acyclic and every edge
// resolves: the failure paths belong to `required-dependencies.property.test.ts`, and these
// properties are about what a *successful* derivation contains and how it is
// ordered.

interface Layout {
  /** Library packages eligible to be required dependencies, in dependency order (each depends only on earlier ones). */
  readonly libraries: readonly ConsumerPackage[];
  /** Microservice_Packages; their specifiers double as the root specifiers. */
  readonly microservices: readonly ConsumerPackage[];
  /** The Overseer's declared specifiers (always includes `contracts`). */
  readonly overseerDeps: readonly string[];
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
    dependencySpecifiers: [...dependencySpecifiers].sort(),
    buildKind: buildKindOf(category),
  };
}

/** Every discovered package of a layout, in a single list. */
function allPackages(layout: Layout): readonly ConsumerPackage[] {
  return [...layout.libraries, ...layout.microservices];
}

/** Ascending code-point comparison of directory name. */
function byDirName(a: ConsumerPackage, b: ConsumerPackage): number {
  return a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;
}

/**
 * The `Discovery` a layout presents. Each category is sorted by directory name,
 * which is the order Package_Discovery guarantees (R2.5) and therefore the order
 * an all-Selector resolves to.
 */
function discoveryOf(layout: Layout): Discovery {
  const all = [...allPackages(layout)];
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

/** A `ReadDependencies` reader over a layout's root consumers. */
function readerFor(layout: Layout): ReadDependencies {
  const prefix = `${NAMESPACE_CONTAINER.microservice}/`;
  return (packageDir) => {
    if (packageDir === OVERSEER.packageDir) return layout.overseerDeps;
    if (packageDir.startsWith(prefix)) {
      const dirName = packageDir.slice(prefix.length);
      return (
        layout.microservices.find((pkg) => pkg.dirName === dirName)
          ?.dependencySpecifiers ?? []
      );
    }
    return [];
  };
}

/** The plan `buildPlanFrom` derives for a layout and a raw Selector value. */
function planOf(layout: Layout, selector: string | undefined) {
  return buildPlanFrom(selector, discoveryOf(layout), readerFor(layout));
}

/** The Microservice_Identifiers a layout discovers, in discovery order. */
function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

/** The repo-relative package directory of a Microservice_Identifier. */
function microserviceDir(identifier: string): string {
  return `${NAMESPACE_CONTAINER.microservice}/${identifier}`;
}

// ---------------------------------------------------------------------------
// Oracles: selection, required dependencies, roots, Spa builds
// ---------------------------------------------------------------------------

/**
 * The all/list Selector rule restated: every discovered identifier in discovery
 * order when the raw value is unset, blank, `*`, or splits into zero non-empty
 * entries; otherwise the trimmed entries in Selector order. Every generator
 * below names only discovered identifiers, so the unmatched branch is out of
 * scope here (it belongs to the selector suites).
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
 * R7.1 restated as a worklist reachability walk over the declared names: start
 * from the Selected_Microservices' and the Overseer's specifiers, ignore
 * anything not `@microservices`-scoped, resolve-but-do-not-follow a
 * Framework_Singleton name, and follow every discovered Consumer_Package edge.
 * The generators produce no peer edge and no dangling name, so nothing is
 * dropped silently.
 */
function referenceRequiredNames(
  layout: Layout,
  selected: readonly string[],
): Set<string> {
  const frameworkNames = FRAMEWORK_SINGLETONS.map((entry) => entry.name);
  const byName = new Map(allPackages(layout).map((pkg) => [pkg.name, pkg]));

  const queue: string[] = [...layout.overseerDeps];
  for (const dirName of selected) {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === dirName,
    );
    queue.push(...(microservice?.dependencySpecifiers ?? []));
  }

  const reached = new Set<string>();
  while (queue.length > 0) {
    const specifier = queue.shift()!;
    if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) continue;
    if (frameworkNames.includes(specifier)) continue;
    if (reached.has(specifier)) continue;
    const pkg = byName.get(specifier);
    if (pkg === undefined || pkg.category === "microservice") continue;
    reached.add(specifier);
    queue.push(...pkg.dependencySpecifiers);
  }
  return reached;
}

/**
 * R7.2 restated as Kahn's algorithm with a sorted ready queue: repeatedly emit
 * the lexicographically least member (by directory name) all of whose member
 * dependencies have been emitted. That greedy choice is the unique
 * lexicographically-least topological order, which is the order the plan's
 * Common roots and Spa builds inherit.
 */
function referenceOrderedRequired(
  layout: Layout,
  selected: readonly string[],
): readonly ConsumerPackage[] {
  const memberNames = referenceRequiredNames(layout, selected);
  const pending = allPackages(layout).filter((pkg) =>
    memberNames.has(pkg.name),
  );

  const emitted: ConsumerPackage[] = [];
  const done = new Set<string>();

  while (pending.length > 0) {
    const ready = pending
      .filter((pkg) =>
        pkg.dependencySpecifiers.every(
          (specifier) => !memberNames.has(specifier) || done.has(specifier),
        ),
      )
      .sort(byDirName);

    if (ready.length === 0) {
      throw new Error(
        "reference order oracle: the generated layout has a cycle",
      );
    }

    const next = ready[0];
    emitted.push(next);
    done.add(next.name);
    pending.splice(pending.indexOf(next), 1);
  }

  return emitted;
}

/**
 * R6.3, R6.6, and R13.5 restated as one concatenation: `packages/contracts`,
 * then the required Common_Packages in required-dependency order, then the
 * Selected_Microservices in Selector order, then `packages/overseer`. The
 * Required_Dependencies are filtered on `category === "common"` — an independent restatement of
 * "the Tsc_Projects the Selector justifies", where production filters on the
 * derived `buildKind`.
 */
function referenceTscRoots(
  layout: Layout,
  selector: string | undefined,
): readonly string[] {
  const selected = referenceSelected(selector, discoveredIdentifiers(layout));
  return [
    CONTRACTS.packageDir,
    ...referenceOrderedRequired(layout, selected)
      .filter((pkg) => pkg.category === "common")
      .map((pkg) => pkg.packageDir),
    ...selected.map(microserviceDir),
    OVERSEER.packageDir,
  ];
}

/** R6.4 restated: the required Spa_Packages, in required-dependency order. */
function referenceSpaBuilds(
  layout: Layout,
  selector: string | undefined,
): readonly ConsumerPackage[] {
  const selected = referenceSelected(selector, discoveredIdentifiers(layout));
  return referenceOrderedRequired(layout, selected).filter(
    (pkg) => pkg.category === "spa",
  );
}

/** One resolved dependency edge, as repo-relative package directories. */
interface Edge {
  readonly dependency: string;
  readonly dependent: string;
}

/**
 * Every dependency edge a layout declares, expressed over package directories:
 * library edges, the Selected_Microservices' edges, and the Overseer's. A
 * specifier naming `contracts` becomes an edge from the Framework_Singleton's
 * directory, so the R5.5/R13.6 "ahead of every Tsc_Project that names it" clause
 * is checked over real edges rather than assumed from contracts being first.
 */
function edgesOf(layout: Layout, selected: readonly string[]): readonly Edge[] {
  const dirByName = new Map<string, string>([
    ...allPackages(layout).map((pkg) => [pkg.name, pkg.packageDir] as const),
    [CONTRACTS.name, CONTRACTS.packageDir],
  ]);

  const edges: Edge[] = [];
  const add = (specifiers: readonly string[], dependent: string): void => {
    for (const specifier of specifiers) {
      const dependency = dirByName.get(specifier);
      if (dependency !== undefined) edges.push({ dependency, dependent });
    }
  };

  for (const library of layout.libraries) {
    add(library.dependencySpecifiers, library.packageDir);
  }
  for (const dirName of selected) {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === dirName,
    );
    if (microservice !== undefined) {
      add(microservice.dependencySpecifiers, microservice.packageDir);
    }
  }
  add(layout.overseerDeps, OVERSEER.packageDir);

  return edges;
}

// ---------------------------------------------------------------------------
// Generators: layouts and Selectors
// ---------------------------------------------------------------------------

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter((s) => s.length > 0 && s.length <= 12);

const arbIdentifier: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]*$/)
  .filter((s) => s.length > 0 && s.length <= 12);

const arbLibraryEntry: fc.Arbitrary<{
  dirName: string;
  category: ConsumerCategory;
}> = fc.record({
  dirName: arbDirName,
  category: fc.constantFrom(...LIBRARY_CATEGORIES),
});

/**
 * One "subset of the earlier COMMON names" arbitrary per library position.
 *
 * Two constraints are baked in at once:
 *
 *   - only names *earlier* in the list are eligible, which is what makes the
 *     generated library graph a DAG with every edge resolvable;
 *   - only *Common_Package* names are eligible, because a library-to-library
 *     edge is a `common → common` or `spa → common` edge — a Common_Package is
 *     the only downward target a library may name. `common → spa` and
 *     `spa → spa` are rejected by the Dependency_Resolver (task 13.1), so a
 *     generator that emitted either would make the whole plan throw before any
 *     assertion runs. Microservices and the Overseer, which *may* name a
 *     Spa_Package (`microservice → spa`, `overseer → spa` are legal), draw from
 *     the full library set elsewhere.
 */
function arbEarlierCommonSubsets(
  entries: readonly { dirName: string; category: ConsumerCategory }[],
): fc.Arbitrary<string[][]> {
  if (entries.length === 0) return fc.constant<string[][]>([]);
  return fc.tuple(
    ...entries.map((_, i) => {
      const earlierCommonNames = entries
        .slice(0, i)
        .filter((entry) => entry.category === "common")
        .map((entry) => `${WORKSPACE_SCOPE}/${entry.dirName}`);
      return fc.subarray(earlierCommonNames);
    }),
  );
}

/** Microservice_Packages, each depending on an arbitrary subset of the libraries. */
function arbMicroservices(
  libraryNames: readonly string[],
  libraryDirNames: readonly string[],
): fc.Arbitrary<ConsumerPackage[]> {
  return fc
    .uniqueArray(arbIdentifier, { minLength: 1, maxLength: 4 })
    .filter((ids) =>
      ids.every(
        (id) =>
          !libraryDirNames.includes(id) && !FRAMEWORK_DIR_NAMES.includes(id),
      ),
    )
    .chain((ids) =>
      fc
        .tuple(...ids.map(() => fc.subarray([...libraryNames])))
        .map((depsPerId) =>
          ids.map((id, i) => consumerPackage("microservice", id, depsPerId[i])),
        ),
    );
}

/**
 * A random layout: Common and Spa libraries in a DAG, at least one
 * Microservice_Package, and an Overseer that always declares
 * `@microservices/contracts` (the R5.3/R5.4 case — declared, resolved, never a
 * required dependency, still the first build root).
 *
 * Edge discipline follows task 13.1's landed rules. A library-to-library edge
 * only ever targets an earlier Common_Package (see `arbEarlierCommonSubsets`),
 * so neither of the two forbidden inbound-SPA edges (`common → spa`,
 * `spa → spa`) is ever generated. Microservices depend on an arbitrary subset of
 * ALL libraries — including Spa_Packages, since `microservice → spa` is legal —
 * and the Overseer's extra dependencies likewise draw from the full library set,
 * since `overseer → spa` is legal too. These `microservice → spa` and
 * `overseer → spa` edges are exactly what make a Spa_Package a required
 * dependency in the random runs.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .uniqueArray(arbLibraryEntry, {
    minLength: 0,
    maxLength: 5,
    selector: (entry) => entry.dirName,
  })
  .filter((entries) =>
    entries.every((entry) => !FRAMEWORK_DIR_NAMES.includes(entry.dirName)),
  )
  .chain((entries) => {
    const libraryNames = entries.map(
      (entry) => `${WORKSPACE_SCOPE}/${entry.dirName}`,
    );
    const libraryDirNames = entries.map((entry) => entry.dirName);

    return arbEarlierCommonSubsets(entries).chain((depsPerLibrary) => {
      const libraries = entries.map((entry, i) =>
        consumerPackage(entry.category, entry.dirName, depsPerLibrary[i]),
      );

      return arbMicroservices(libraryNames, libraryDirNames).chain(
        (microservices) =>
          fc.subarray([...libraryNames]).map((extraOverseerDeps) => ({
            libraries,
            microservices,
            overseerDeps: [
              ...new Set([CONTRACTS.name, ...extraOverseerDeps]),
            ].sort(),
          })),
      );
    });
  });

/**
 * A raw `MICROSERVICES` value for a layout. Covers the all-Selector spellings
 * (unset, blank, whitespace, `*`, padded `*`) and comma lists that exercise
 * trimming and empty-entry dropping. List entries are drawn without repetition:
 * see the header note on duplicate-bearing Selectors.
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

/** A layout paired with a raw Selector value naming only discovered identifiers. */
const arbLayoutAndSelector: fc.Arbitrary<{
  layout: Layout;
  selector: string | undefined;
}> = arbLayout.chain((layout) =>
  arbSelectorFor(layout).map((selector) => ({ layout, selector })),
);

/**
 * A layout and Selector whose Required_Dependencies is guaranteed to hold at least
 * one Spa_Package: one Spa library is picked, the first Microservice_Package is
 * pointed at it, and that microservice is the Selector. Without this the Spa
 * clauses of Properties 16 and 18 would only be exercised on the runs where a
 * Spa member happened to be reachable.
 */
const arbRequiredSpaCase: fc.Arbitrary<{
  layout: Layout;
  selector: string;
  spaDirName: string;
}> = arbLayout
  .filter((layout) => layout.libraries.some((pkg) => pkg.category === "spa"))
  .chain((layout) =>
    fc
      .constantFrom(
        ...layout.libraries
          .filter((pkg) => pkg.category === "spa")
          .map((pkg) => pkg.dirName),
      )
      .map((spaDirName) => {
        const spa = layout.libraries.find((pkg) => pkg.dirName === spaDirName)!;
        const entryPoint = layout.microservices[0];
        return {
          layout: {
            ...layout,
            microservices: layout.microservices.map((pkg) =>
              pkg.packageDir === entryPoint.packageDir
                ? {
                    ...pkg,
                    dependencySpecifiers: [
                      ...new Set([...pkg.dependencySpecifiers, spa.name]),
                    ].sort(),
                  }
                : pkg,
            ),
          },
          selector: entryPoint.dirName,
          spaDirName,
        };
      }),
  );

/**
 * The shape Properties 15 and 16 now turn on: a Common_Package reachable *only*
 * through a Spa_Package, and a `microservice → spa` edge that puts it there.
 *
 * This is not a mutation of `arbLayout` — a random layout's edges could hand the
 * hidden Common_Package a second, non-SPA reacher and quietly destroy the very
 * property under test — so the layout is built from nothing with exactly the
 * edges the case needs and no others:
 *
 *   - `hidden` is a Common_Package that depends only on `contracts` (a
 *     Framework_Singleton, resolved and not followed), so it declares no edge
 *     that could reach another library;
 *   - `frontend` is a Spa_Package whose only `@microservices` specifier is
 *     `hidden`, giving the single `spa → common` edge along which `hidden` is
 *     reached;
 *   - `entry` is the sole Microservice_Package and the Selector; its only
 *     specifier is `frontend`, giving the `microservice → spa` edge;
 *   - the Overseer declares only `contracts`, so it reaches neither `frontend`
 *     nor `hidden`.
 *
 * Therefore the ONLY path to `hidden` runs through a Spa_Package. `hidden` is a
 * required dependency and a `tsc --build` root (it is built — its `dist/` is what
 * the bundler inlines) yet it is absent from the Staged_Dependencies (after
 * bundling no runtime process can reach it), which is the strict-subset case
 * R6.12/R6.14/R7.13 exist for. The names are fixed rather than generated because
 * the case is a single distinguished shape, not a family; `numRuns` re-runs
 * assert its stability.
 */
const arbCommonViaSpaCase: fc.Arbitrary<{
  layout: Layout;
  selector: string;
  hiddenDirName: string;
  spaDirName: string;
}> = fc.constant(null).map(() => {
  const hidden = consumerPackage("common", "hidden-lib", [CONTRACTS.name]);
  const frontend = consumerPackage("spa", "frontend", [hidden.name]);
  const entry = consumerPackage("microservice", "entry", [frontend.name]);

  return {
    layout: {
      libraries: [hidden, frontend],
      microservices: [entry],
      overseerDeps: [CONTRACTS.name],
    },
    selector: entry.dirName,
    hiddenDirName: hidden.dirName,
    spaDirName: frontend.dirName,
  };
});

// ---------------------------------------------------------------------------
// Generators: synthetic manifests, for the "category alone" half of Property 15
// ---------------------------------------------------------------------------
//
// Build_Kind must be independent of every manifest field, so demonstrating it
// needs manifests: these generators feed `discoverPackagesFrom` two *different*
// manifest sets over one unchanged layout — including a Spa_Package that
// declares `main`/`types` like a library and a Common_Package that declares a
// `build` script like a bundler project — and the Build_Kinds must not move.

/** A manifest entry: a category, a directory name, and two rival manifests. */
interface ManifestEntry {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  readonly manifests: readonly [PackageManifest, PackageManifest];
}

const arbPathValue: fc.Arbitrary<string> = fc.constantFrom(
  "dist/index.js",
  "./dist/index.js",
  "dist/index.d.ts",
  "index.js",
);

const arbBuildCommand: fc.Arbitrary<string> = fc.constantFrom(
  "tsc",
  "vite build",
  "npm run bundle",
);

/** Arbitrary manifest keys that carry no meaning for discovery. */
const arbNoiseFields: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc
    .stringMatching(/^[a-z][a-zA-Z]*$/)
    .filter(
      (key) =>
        !["name", "main", "types", "scripts", "dependencies"].includes(key),
    ),
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  ) as fc.Arbitrary<unknown>,
  { maxKeys: 3 },
);

/**
 * One manifest for a category, valid under that category's contract (R4.1,
 * R4.3) and otherwise arbitrary: the fields the *other* categories care about
 * are free to be present or absent, which is exactly the confusion R6.1/R6.2
 * must be immune to.
 */
function arbManifestFor(
  category: ConsumerCategory,
  dirName: string,
): fc.Arbitrary<PackageManifest> {
  return fc
    .record({
      noise: arbNoiseFields,
      main: fc.option(arbPathValue, { nil: undefined }),
      types: fc.option(arbPathValue, { nil: undefined }),
      build: fc.option(arbBuildCommand, { nil: undefined }),
    })
    .map(({ noise, main, types, build }) => {
      const scripts: Record<string, unknown> = {};
      if (build !== undefined || category === "spa") {
        scripts.build = build ?? "vite build";
      }
      return {
        ...noise,
        name: `${WORKSPACE_SCOPE}/${dirName}`,
        // A Common_Package must declare both (R4.1); every other category may.
        main: category === "common" ? (main ?? "dist/index.js") : main,
        types: category === "common" ? (types ?? "dist/index.d.ts") : types,
        ...(Object.keys(scripts).length > 0 ? { scripts } : {}),
      } satisfies PackageManifest;
    });
}

const arbManifestEntry: fc.Arbitrary<ManifestEntry> = fc
  .record({
    category: fc.constantFrom(...CONSUMER_CATEGORIES),
    dirName: arbDirName,
  })
  .filter(({ dirName }) => !FRAMEWORK_DIR_NAMES.includes(dirName))
  .chain(({ category, dirName }) =>
    fc
      .tuple(
        arbManifestFor(category, dirName),
        arbManifestFor(category, dirName),
      )
      .map((manifests) => ({ category, dirName, manifests })),
  );

/** A repository skeleton: entries across all three Namespace_Containers. */
const arbManifestLayout: fc.Arbitrary<readonly ManifestEntry[]> =
  fc.uniqueArray(arbManifestEntry, {
    minLength: 1,
    maxLength: 6,
    selector: (entry) => entry.dirName,
  });

/** The container lister for a manifest layout; every container is present. */
function listContainerFor(entries: readonly ManifestEntry[]): ListContainer {
  const byContainer = new Map<string, ContainerEntry[]>(
    CONSUMER_CATEGORIES.map((category) => [NAMESPACE_CONTAINER[category], []]),
  );
  for (const entry of entries) {
    byContainer
      .get(NAMESPACE_CONTAINER[entry.category])!
      .push({ name: entry.dirName, isDirectory: true });
  }
  return (containerDir) => byContainer.get(containerDir);
}

/** The manifest reader for a manifest layout, taking manifest `which` of each pair. */
function readManifestFor(
  entries: readonly ManifestEntry[],
  which: 0 | 1,
): ReadManifest {
  const byDir = new Map<string, ManifestRead>(
    entries.map((entry) => [
      `${NAMESPACE_CONTAINER[entry.category]}/${entry.dirName}`,
      { kind: "ok", manifest: entry.manifests[which] } satisfies ManifestRead,
    ]),
  );
  return (packageDir) => byDir.get(packageDir) ?? { kind: "absent" };
}

// ---------------------------------------------------------------------------
// Property 15 — Build_Kind is total and determined by category alone
// ---------------------------------------------------------------------------
//
// Validates: Requirements 6.1, 6.2

describe("Property 15: Build_Kind is total and determined by category alone", () => {
  it("is defined for every Consumer_Category and is exactly one of the two kinds", () => {
    // Not a generated property: the category union is finite and small, so the
    // totality claim is checked exhaustively rather than sampled.
    for (const category of CONSUMER_CATEGORIES) {
      const kind = buildKindOf(category);
      expect(BUILD_KINDS).toContain(kind);
      expect(kind).toBe(expectedBuildKind(category));
    }
    expect(CONSUMER_CATEGORIES.length).toBe(3);
  });

  it("assigns the same Build_Kind under any manifest, for any category", () => {
    fc.assert(
      fc.property(arbManifestLayout, (entries) => {
        const list = listContainerFor(entries);
        const first = discoverPackagesFrom(list, readManifestFor(entries, 0));
        const second = discoverPackagesFrom(list, readManifestFor(entries, 1));

        const kindsOf = (discovery: Discovery): Map<string, BuildKind> =>
          new Map(
            CONSUMER_CATEGORIES.flatMap((category) =>
              discovery.byCategory[category].map(
                (pkg) => [pkg.packageDir, pkg.buildKind] as const,
              ),
            ),
          );

        // Each discovered package's Build_Kind is its category's, whatever its
        // manifest declared — a Spa_Package with `main`/`types` is still a
        // Bundler_Project and a Common_Package with a `build` script is still a
        // Tsc_Project.
        for (const category of CONSUMER_CATEGORIES) {
          for (const pkg of first.byCategory[category]) {
            expect(pkg.buildKind).toBe(expectedBuildKind(category));
          }
        }

        // And mutating every manifest moves nothing.
        expect(kindsOf(second)).toEqual(kindsOf(first));
      }),
      { numRuns: 200 },
    );
  });

  it("partitions the Required_Dependencies into tsc roots and Spa builds, with no member in both", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);

        const requiredDirs = plan.requiredDependencies.map(
          (pkg) => pkg.packageDir,
        );
        const rootMembers = requiredDirs.filter((dir) =>
          plan.tscRoots.includes(dir),
        );
        const spaDirs = plan.spaBuilds.map((pkg) => pkg.packageDir);

        // Every member is built by exactly one mechanism.
        expect(new Set([...rootMembers, ...spaDirs])).toEqual(
          new Set(requiredDirs),
        );
        expect(
          rootMembers.filter((dir) => spaDirs.includes(dir)),
        ).toStrictEqual([]);

        for (const pkg of plan.requiredDependencies) {
          const inRoots = plan.tscRoots.includes(pkg.packageDir);
          expect(inRoots).toBe(pkg.buildKind === "tsc-project");
          expect(pkg.buildKind).toBe(expectedBuildKind(pkg.category));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("treats every Framework_Singleton as a Tsc_Project, never a Bundler_Project", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const spaDirs = plan.spaBuilds.map((pkg) => pkg.packageDir);

        for (const singleton of FRAMEWORK_SINGLETONS) {
          // No Framework_Singleton is ever handed to a bundler.
          expect(spaDirs).not.toContain(singleton.packageDir);
          // A positioned singleton is a `tsc --build` root; an excluded one is
          // not a root of the Selector-driven build at all (R13.7).
          expect(plan.tscRoots.includes(singleton.packageDir)).toBe(
            singleton.buildPosition !== "excluded",
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16 — the `tsc --build` roots are exactly the Selector-justified
// Tsc_Projects, correctly ordered
// ---------------------------------------------------------------------------
//
// Validates: Requirements 5.4, 5.5, 6.3, 6.6, 6.7, 6.12, 6.13, 9.9, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9

describe("Property 16: the tsc --build roots equal the Selector-justified Tsc_Projects", () => {
  it("equals the oracle concatenation, element for element", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        expect(planOf(layout, selector).tscRoots).toEqual(
          referenceTscRoots(layout, selector),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("puts packages/contracts first and the Overseer last, for every Selector", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const roots = planOf(layout, selector).tscRoots;

        // R5.4/R5.5: contracts is a root for every Selector — including one
        // resolving to a single microservice and one under which nothing else
        // names it — and it is the first root.
        expect(roots[0]).toBe(CONTRACTS.packageDir);
        expect(roots[roots.length - 1]).toBe(OVERSEER.packageDir);
        expect(roots.indexOf(CONTRACTS.packageDir)).toBe(0);
        expect(roots.lastIndexOf(OVERSEER.packageDir)).toBe(roots.length - 1);
      }),
      { numRuns: 200 },
    );
  });

  it("contains every root exactly once, each a repo-relative package directory", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const roots = planOf(layout, selector).tscRoots;

        expect(new Set(roots).size).toBe(roots.length);
        for (const root of roots) {
          expect(root.startsWith("packages/")).toBe(true);
          expect(root.endsWith("/")).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("selects exactly the Selected_Microservices and the required Common_Packages", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const roots = new Set(plan.tscRoots);

        // A discovered Microservice_Package is a root iff it is selected.
        for (const microservice of layout.microservices) {
          expect(roots.has(microservice.packageDir)).toBe(
            plan.selected.includes(microservice.dirName),
          );
        }

        // A discovered Common_Package is a root iff it is a required dependency.
        const members = new Set(
          plan.requiredDependencies.map((pkg) => pkg.packageDir),
        );
        for (const library of layout.libraries) {
          if (library.category !== "common") continue;
          expect(roots.has(library.packageDir)).toBe(
            members.has(library.packageDir),
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("contains no Spa_Package, no packages/build-tools, and no packages/integration-tests", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const roots = planOf(layout, selector).tscRoots;

        for (const library of layout.libraries) {
          if (library.category === "spa") {
            expect(roots).not.toContain(library.packageDir);
          }
        }
        expect(roots).not.toContain(BUILD_TOOLS.packageDir);
        expect(roots).not.toContain(INTEGRATION_TESTS.packageDir);
      }),
      { numRuns: 200 },
    );
  });

  it("omits a Spa_Package even when the Required_Dependencies holds it", () => {
    fc.assert(
      fc.property(arbRequiredSpaCase, ({ layout, selector, spaDirName }) => {
        const plan = planOf(layout, selector);
        const spaDir = `${NAMESPACE_CONTAINER.spa}/${spaDirName}`;

        // The generator guarantees the interesting case: the Spa_Package IS a
        // required dependency, and still never a `tsc --build` root (R6.3, R13.4).
        expect(
          plan.requiredDependencies.map((pkg) => pkg.packageDir),
        ).toContain(spaDir);
        expect(plan.tscRoots).not.toContain(spaDir);
        expect(plan.tscRoots).toEqual(referenceTscRoots(layout, selector));
      }),
      { numRuns: 200 },
    );
  });

  it("makes a Common_Package reached only through a Spa_Package a root exactly once, decided by Build_Kind and not by the reaching path (R6.12)", () => {
    fc.assert(
      fc.property(
        arbCommonViaSpaCase,
        ({ layout, selector, hiddenDirName, spaDirName }) => {
          const plan = planOf(layout, selector);
          const hiddenDir = `${NAMESPACE_CONTAINER.common}/${hiddenDirName}`;
          const spaDir = `${NAMESPACE_CONTAINER.spa}/${spaDirName}`;

          // The generator's contract: the hidden Common_Package is reachable
          // ONLY through the Spa_Package. It is a required dependency (built) but
          // not a staged dependency (ships nowhere) — the strict-subset case.
          const requiredDirs = plan.requiredDependencies.map(
            (pkg) => pkg.packageDir,
          );
          const stagedDirs = plan.stagedDependencies.map(
            (pkg) => pkg.packageDir,
          );
          expect(requiredDirs).toContain(hiddenDir);
          expect(stagedDirs).not.toContain(hiddenDir);

          // R6.12: root membership is by Build_Kind alone, never by which root
          // reached the required dependency. The Common_Package is a
          // `tsc --build` root exactly as one reached from a microservice would
          // be, present exactly once — so its `dist/` exists before the
          // Bundler_Build_Phase inlines it.
          expect(plan.tscRoots).toContain(hiddenDir);
          expect(
            plan.tscRoots.filter((root) => root === hiddenDir),
          ).toHaveLength(1);

          // The full root list is still exactly the oracle concatenation: no
          // Spa root sneaks in, and the hidden Common root sits in
          // required-dependency order among the roots.
          expect(plan.tscRoots).toEqual(referenceTscRoots(layout, selector));
          expect(plan.tscRoots).not.toContain(spaDir);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("lets a microservice → spa edge add the Spa_Package to the Required_Dependencies for staging and linking while contributing no root and no tsc ordering constraint (R6.13, R9.9)", () => {
    fc.assert(
      fc.property(
        arbCommonViaSpaCase,
        ({ layout, selector, spaDirName }) => {
          const plan = planOf(layout, selector);
          const spaDir = `${NAMESPACE_CONTAINER.spa}/${spaDirName}`;

          // R9.9: the `microservice → spa` edge is legal and pulls the
          // Spa_Package into the Required_Dependencies — it is built (as a
          // Bundler_Project via `spaBuilds`), staged, and linked.
          expect(
            plan.requiredDependencies.map((pkg) => pkg.packageDir),
          ).toContain(spaDir);
          expect(plan.spaBuilds.map((pkg) => pkg.packageDir)).toContain(spaDir);
          expect(
            plan.stagedDependencies.map((pkg) => pkg.packageDir),
          ).toContain(spaDir);

          // R6.13: yet it contributes NO `tsc --build` root and imposes no
          // ordering constraint on `plan.tscRoots`. The roots are precisely the
          // oracle concatenation — the Spa_Package is not in it, so the edge into
          // it constrains nothing there.
          expect(plan.tscRoots).not.toContain(spaDir);
          expect(plan.tscRoots).toEqual(referenceTscRoots(layout, selector));

          // The one edge whose head is the Spa_Package has no root endpoint, so
          // it places no constraint among the roots.
          const position = new Map(
            plan.tscRoots.map((dir, index) => [dir, index] as const),
          );
          expect(position.has(spaDir)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("places every root ahead of every root that declares a specifier naming it", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const position = new Map(
          plan.tscRoots.map((dir, index) => [dir, index] as const),
        );

        // Only edges whose endpoints are both roots constrain the order; an
        // edge into a Spa_Package has no root endpoint.
        for (const { dependency, dependent } of edgesOf(
          layout,
          plan.selected,
        )) {
          const from = position.get(dependency);
          const to = position.get(dependent);
          if (from !== undefined && to !== undefined) {
            expect(from).toBeLessThan(to);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is identical across repeated derivations over unchanged input", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        // Each call builds a fresh Discovery and a fresh reader, so equality is
        // a statement about the derivation rather than about a cached result.
        const first = planOf(layout, selector);
        const second = planOf(layout, selector);

        expect(second.tscRoots).toEqual(first.tscRoots);
        expect(second.selected).toEqual(first.selected);
        expect(
          second.requiredDependencies.map((pkg) => pkg.packageDir),
        ).toEqual(first.requiredDependencies.map((pkg) => pkg.packageDir));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 32 — Staged ⊆ Required, and the difference is built but never shipped
// ---------------------------------------------------------------------------
//
// The build set (`requiredDependencies`) and the stage set
// (`stagedDependencies`) answer different questions — "what is built" versus
// "what ships". This property pins the three claims that relate them:
//
//   1. `stagedDependencies` is a SUBSEQUENCE of `requiredDependencies` — every
//      staged member is required and they appear in the same relative order
//      (R7.13), so `staged ⊆ required` holds structurally;
//   2. every required member is a BUILD TARGET — a Tsc_Project shows up in
//      `tscRoots`, a Bundler_Project in `spaBuilds` — so nothing required goes
//      unbuilt;
//   3. every required member NOT staged is a Tsc_Project that appears in
//      `tscRoots` and in NO `stage` entry: its `dist/` is produced (the bundler
//      inlines it) and then copied nowhere (R6.14, R7.13).
//
// The random `arbLayoutAndSelector` runs exercise the general subsequence and
// build-target claims — usually with `staged === required` element for element,
// since only a Spa_Package cuts the stage walk. The distinguished
// `arbCommonViaSpaCase` runs force the interesting third claim: a Common_Package
// reachable only through a Spa_Package, so `stagedDependencies` is a STRICT
// subset of `requiredDependencies` and there is a built-but-unshipped package to
// find.
//
// Validates: Requirements R6.14, R7.13

describe("Property 32: Staged ⊆ Required, and the difference is built but never shipped", () => {
  it("keeps stagedDependencies a subsequence of requiredDependencies", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const requiredDirs = plan.requiredDependencies.map(
          (pkg) => pkg.packageDir,
        );
        const stagedDirs = plan.stagedDependencies.map((pkg) => pkg.packageDir);

        // Every staged member is required...
        for (const dir of stagedDirs) {
          expect(requiredDirs).toContain(dir);
        }
        // ...and the staged sequence is `required` filtered to those members —
        // same relative order, no reshuffle (R7.13).
        expect(stagedDirs).toEqual(
          requiredDirs.filter((dir) => stagedDirs.includes(dir)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("makes every required dependency a build target: a Tsc_Project in tscRoots, a Bundler_Project in spaBuilds", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const spaDirs = new Set(plan.spaBuilds.map((pkg) => pkg.packageDir));
        const spaOracleDirs = new Set(
          referenceSpaBuilds(layout, selector).map((pkg) => pkg.packageDir),
        );

        for (const pkg of plan.requiredDependencies) {
          if (pkg.buildKind === "tsc-project") {
            expect(plan.tscRoots).toContain(pkg.packageDir);
            expect(spaDirs.has(pkg.packageDir)).toBe(false);
          } else {
            expect(pkg.buildKind).toBe("bundler-project");
            expect(spaDirs.has(pkg.packageDir)).toBe(true);
            // Cross-checked against the independent oracle for R6.4.
            expect(spaOracleDirs.has(pkg.packageDir)).toBe(true);
            expect(plan.tscRoots).not.toContain(pkg.packageDir);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("builds every unstaged required dependency as a tsc root and stages it nowhere (R6.14, R7.13)", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const stagedDirs = new Set(
          plan.stagedDependencies.map((pkg) => pkg.packageDir),
        );
        const stageSources = new Set(plan.stage.map((entry) => entry.sourceDir));

        for (const pkg of plan.requiredDependencies) {
          if (stagedDirs.has(pkg.packageDir)) continue;

          // A required dependency absent from the stage set can only be a
          // Tsc_Project — a Spa_Package always enters the stage set the moment it
          // is reached — and it is a `tsc --build` root: its output is produced.
          expect(pkg.buildKind).toBe("tsc-project");
          expect(plan.tscRoots).toContain(pkg.packageDir);

          // ...and it is copied NOWHERE: no `stage` entry sources from it.
          expect(stageSources.has(pkg.packageDir)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("exhibits the strict-subset case: a Common_Package reached only via a Spa_Package is built but shipped nowhere", () => {
    fc.assert(
      fc.property(
        arbCommonViaSpaCase,
        ({ layout, selector, hiddenDirName }) => {
          const plan = planOf(layout, selector);
          const hiddenDir = `${NAMESPACE_CONTAINER.common}/${hiddenDirName}`;

          const requiredDirs = plan.requiredDependencies.map(
            (pkg) => pkg.packageDir,
          );
          const stagedDirs = plan.stagedDependencies.map(
            (pkg) => pkg.packageDir,
          );

          // The stage set is a STRICT subset here — the whole point of the case.
          expect(stagedDirs.length).toBeLessThan(requiredDirs.length);

          // The hidden Common_Package is required and built (a tsc root)...
          expect(requiredDirs).toContain(hiddenDir);
          expect(plan.tscRoots).toContain(hiddenDir);

          // ...but absent from the stage set and from every `stage` entry, so
          // its compiled output is produced and copied nowhere (R6.14, R7.13).
          expect(stagedDirs).not.toContain(hiddenDir);
          expect(plan.stage.map((entry) => entry.sourceDir)).not.toContain(
            hiddenDir,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is identical across repeated derivations over unchanged input", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const first = planOf(layout, selector);
        const second = planOf(layout, selector);

        expect(
          second.stagedDependencies.map((pkg) => pkg.packageDir),
        ).toEqual(first.stagedDependencies.map((pkg) => pkg.packageDir));
        expect(second.stage).toEqual(first.stage);
      }),
      { numRuns: 200 },
    );
  });
});

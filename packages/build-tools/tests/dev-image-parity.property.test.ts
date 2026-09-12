// Feature: package-categories, Property 17: The dev Project_List equals the image `tsc --build` roots
//
// Property 17 — For any Selector value and any repository layout, the
// Project_List the Dev_Server derives (`projectListFrom` in
// `packages/build-tools/src/dev-supervisor.ts`) and the ordered `tsc --build`
// roots the Image_Assembler passes (`buildPlanFrom(...).tscRoots` in
// `packages/build-tools/src/build-plan.ts`) are equal element for element and
// in the same order. The design's claim is that they agree *because both are
// the same `BuildPlan.tscRoots` produced by one derivation* rather than by two
// implementations happening to match — so this test invokes BOTH derivation
// paths independently and asserts deep array equality between them (design
// "Correctness Properties / Property 17"; Requirements R13.1, R13.2, R13.8).
//
// Both paths are pure over their injected inputs, so no filesystem is touched:
// the `Discovery` built by `discoveryOf` and the root specifiers from
// `readerFor` are the entire world each derivation sees, and — critically — the
// SAME `discovery` and `readDependencies` are handed to both so any divergence
// would be a real disagreement between the two entry points, not an artefact of
// two different views of the repository.
//
// The in-memory layout model (Layout / discoveryOf / readerFor) is the one
// packages/build-tools/tests/build-plan.property.test.ts and
// dev-project-list.property.test.ts use: library packages eligible to be required dependencies
// (Common and Spa) are laid out in a list, each depending only on earlier ones
// so the graph is always a DAG with every edge resolvable, at least one
// Microservice_Package, and an Overseer that always declares
// `@microservices/contracts`. It is replicated here rather than imported because
// those suites export no generators.
//
// Selectors are generated as raw `MICROSERVICES` *string* values (unset, blank,
// whitespace, `*`, padded `*`, and comma lists with padding, empty entries, and
// a trailing comma), because both derivations take the raw value and resolve it
// themselves — the parity must hold across every spelling of a Selector, not
// only a pre-resolved id list.
//
// Validates: Requirements 13.1, 13.2, 13.8

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ReadDependencies } from "../src/required-dependencies.js";
import { buildPlanFrom } from "../src/build-plan.js";
import { projectListFrom } from "../src/dev-supervisor.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import {
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
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

const MICROSERVICE_PREFIX = `${NAMESPACE_CONTAINER.microservice}/`;

// ---------------------------------------------------------------------------
// In-memory layout model (mirrors build-plan.property.test.ts)
// ---------------------------------------------------------------------------

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
  return (packageDir) => {
    if (packageDir === OVERSEER.packageDir) return layout.overseerDeps;
    if (packageDir.startsWith(MICROSERVICE_PREFIX)) {
      const dirName = packageDir.slice(MICROSERVICE_PREFIX.length);
      return (
        layout.microservices.find((pkg) => pkg.dirName === dirName)
          ?.dependencySpecifiers ?? []
      );
    }
    return [];
  };
}

/** The Microservice_Identifiers a layout discovers, in discovery order. */
function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

// ---------------------------------------------------------------------------
// Generators: layouts and Selectors (mirrors build-plan.property.test.ts)
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
 *     the only downward target a library may name. The two forbidden
 *     inbound-SPA edges `common → spa` and `spa → spa` are rejected by the
 *     Dependency_Resolver (task 13.1), so a generator that emitted either would
 *     make the derivation throw before any assertion runs. Microservices and
 *     the Overseer, which *may* name a Spa_Package (`microservice → spa` and
 *     `overseer → spa` are legal), draw from the full library set elsewhere.
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
 * `@microservices/contracts`. Every directory name is distinct across every
 * category and distinct from every Framework_Singleton name.
 *
 * Edge discipline follows task 13.1's landed rules. A library-to-library edge
 * only ever targets an earlier Common_Package (see `arbEarlierCommonSubsets`),
 * so neither of the two forbidden inbound-SPA edges (`common → spa`,
 * `spa → spa`) is ever generated. Microservices depend on an arbitrary subset
 * of ALL libraries — including Spa_Packages, since `microservice → spa` is
 * legal — and the Overseer's extra dependencies likewise draw from the full
 * library set, since `overseer → spa` is legal too. These `microservice → spa`
 * and `overseer → spa` edges are exactly what make a Spa_Package a required
 * dependency, so the dev/image parity claim is still exercised on layouts where
 * a Spa_Package is reachable.
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
 * trimming, empty-entry dropping, and a trailing comma. List entries are drawn
 * without repetition.
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
 * pointed at it, and that microservice is the Selector. This exercises parity on
 * the runs where a Spa_Package is genuinely required — a member the
 * image path stages but neither path may place in `tscRoots`.
 */
const arbRequiredSpaCase: fc.Arbitrary<{
  layout: Layout;
  selector: string;
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
        };
      }),
  );

// ---------------------------------------------------------------------------
// The two derivations, invoked independently over one shared world
// ---------------------------------------------------------------------------

/**
 * The dev Project_List: what `packages/build-tools/src/dev-supervisor.ts`
 * derives for the Dev_Server. Built from a freshly-constructed `Discovery` and
 * reader so this path is exercised end to end, not handed the image path's
 * output.
 */
function devProjectListOf(
  layout: Layout,
  selector: string | undefined,
): readonly string[] {
  return projectListFrom(selector, discoveryOf(layout), readerFor(layout));
}

/**
 * The image `tsc --build` roots: `buildPlanFrom(...).tscRoots` from
 * `packages/build-tools/src/build-plan.ts`, the ordered roots the
 * Image_Assembler passes to the single `tsc --build`. Built from its OWN freshly
 * constructed `Discovery` and reader over the same layout, so a match is two
 * independent invocations agreeing rather than one array read twice.
 */
function imageTscRootsOf(
  layout: Layout,
  selector: string | undefined,
): readonly string[] {
  return buildPlanFrom(selector, discoveryOf(layout), readerFor(layout))
    .tscRoots;
}

// ---------------------------------------------------------------------------
// Property 17 — the dev Project_List equals the image `tsc --build` roots
// ---------------------------------------------------------------------------
//
// Validates: Requirements 13.1, 13.2, 13.8

describe("Property 17: the dev Project_List equals the image tsc --build roots", () => {
  it("are deep-equal element for element and in the same order, for any Selector and layout", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const devList = devProjectListOf(layout, selector);
        const imageRoots = imageTscRootsOf(layout, selector);

        // Deep array equality: same length, same elements, same order — not a
        // set comparison. `toStrictEqual` compares readonly arrays structurally.
        expect(devList).toStrictEqual(imageRoots);

        // Spelled out element for element as well, so a failure reports the
        // exact index at which the two derivations diverge.
        expect(devList.length).toBe(imageRoots.length);
        for (let i = 0; i < imageRoots.length; i += 1) {
          expect(devList[i]).toBe(imageRoots[i]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("stay equal when a Spa_Package is genuinely required", () => {
    // A required Spa_Package is staged by the image path but must not
    // appear in either derivation's `tscRoots`; the two must still agree exactly.
    fc.assert(
      fc.property(arbRequiredSpaCase, ({ layout, selector }) => {
        expect(devProjectListOf(layout, selector)).toStrictEqual(
          imageTscRootsOf(layout, selector),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("agree for the all-Selector spellings over a single layout", () => {
    // Every spelling of the all-Selector resolves to the same set, so all four
    // dev lists and all four image root lists must coincide across the board —
    // parity is not sensitive to how the caller spells "everything".
    fc.assert(
      fc.property(
        arbLayout,
        fc.constantFrom<string | undefined>(undefined, "", "   ", "*", " * "),
        (layout, selector) => {
          expect(devProjectListOf(layout, selector)).toStrictEqual(
            imageTscRootsOf(layout, selector),
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

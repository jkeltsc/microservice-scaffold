// Feature: api-dev-server, Property 1: Project_List membership and topological order
// Feature: api-dev-server, Property 2: Selector resolution is the existing behavior
//
// Property 1 — The Project_List handed to the solution builder contains exactly
// `packages/contracts`, the Common_Package members of the Required_Dependencies of
// the selected microservices plus the Overseer (each as its repo-relative
// `packages/common/<name>` dir), the selected microservices
// (`packages/microservices/<id>`), and `packages/overseer` — and nothing else.
// No Spa_Package is ever a member, whether or not it is a required dependency
// (R13.4), and `packages/build-tools` and `packages/integration-tests` are never
// members either (R13.7): both are Framework_Singletons with `buildPosition:
// "excluded"`, and neither sits inside a Namespace_Container, so neither can be
// discovered nor become a required dependency. For every dependency edge between two
// members the dependency appears strictly before its dependent (R13.6), and
// every selected microservice appears before `packages/overseer` (R13.5).
//
// Property 2 — The microservice members of the Project_List equal
// `resolveSelected(selector, discoveredIdentifiers)` exactly, for unset, blank,
// `*`, whitespace-padded and duplicate-bearing selectors, because
// `projectListFrom` composes `resolveSelected` (via `buildPlanFrom`) rather than
// reimplementing selection. An unmatched identifier surfaces as the existing
// `[selector:unmatched]` error naming every offender (R13.10).
//
// Both properties are stated over `projectListFrom(selector, discovery,
// readDependencies)`, which IS `buildPlanFrom(...).tscRoots` — so no filesystem
// is touched: the `Discovery` built by `discoveryOf` below plus the root
// specifiers from `readerFor` are the entire world the derivation sees.
//
// The in-memory layout model (Layout / discoveryOf / readerFor) is the one
// packages/build-tools/tests/required-dependencies.property.test.ts and
// build-plan.property.test.ts use: library packages eligible to be required dependencies (Common and
// Spa) are laid out in a list, each depending only on earlier ones so the graph
// is always a DAG with every edge resolvable, and `contracts` is not among them
// at all — it is a Framework_Singleton, resolved but never followed and never a
// required dependency, yet always the first build root. It is replicated here rather
// than imported because those suites export no generators.
//
// Validates: Requirements 13.3, 13.4, 13.5, 13.6, 13.7
// Validates: Requirements 2.1, 2.2, 2.4, 3.1, 3.6, 3.7 (api-dev-server)

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ReadDependencies } from "../src/required-dependencies.js";
import { projectListFrom } from "../src/dev-supervisor.js";
import { resolveSelected } from "../src/selector.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
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

/** The Project_List a layout and a raw Selector value derive. */
function listOf(
  layout: Layout,
  selector: string | undefined,
): readonly string[] {
  return projectListFrom(selector, discoveryOf(layout), readerFor(layout));
}

/** The Microservice_Identifiers a layout discovers, in discovery order. */
function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

/** The repo-relative package directory of a Microservice_Identifier. */
function microserviceDir(identifier: string): string {
  return `${MICROSERVICE_PREFIX}${identifier}`;
}

// ---------------------------------------------------------------------------
// Oracles: required dependencyship and Project_List membership
// ---------------------------------------------------------------------------

/**
 * The Required_Dependencies's declared names, computed by an independent worklist
 * reachability walk (R7.1): start from the Selected_Microservices' and the
 * Overseer's specifiers, ignore anything not `@microservices`-scoped,
 * resolve-but-do-not-follow a Framework_Singleton name, and follow every
 * discovered Consumer_Package edge. The generators produce no peer edge and no
 * dangling specifier, so nothing is dropped silently.
 */
function requiredNames(
  layout: Layout,
  selected: readonly string[],
): Set<string> {
  const frameworkNames = FRAMEWORK_SINGLETONS.map((entry) => entry.name);
  const byName = new Map(allPackages(layout).map((pkg) => [pkg.name, pkg]));

  const queue: string[] = [...layout.overseerDeps];
  for (const identifier of selected) {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === identifier,
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
 * The expected member SET of the Project_List for a layout and a resolved
 * identifier list, computed independently of the derivation: `packages/contracts`
 * (a Framework_Singleton, always a root — R5.4, R5.5), the required
 * Common_Packages, each selected microservice's directory, and
 * `packages/overseer`. The Required_Dependencies are filtered on `category === "common"` where
 * production filters on the derived `buildKind`, so the Spa exclusion (R13.4) is
 * restated here rather than inherited. Order is not asserted here — that is a
 * separate property.
 */
function expectedMembers(
  layout: Layout,
  selected: readonly string[],
): Set<string> {
  const names = requiredNames(layout, selected);
  const members = new Set<string>([CONTRACTS.packageDir]);
  for (const library of layout.libraries) {
    if (names.has(library.name) && library.category === "common") {
      members.add(library.packageDir);
    }
  }
  for (const identifier of selected) members.add(microserviceDir(identifier));
  members.add(OVERSEER.packageDir);
  return members;
}

/**
 * Every declared dependency edge of a layout, as (dependency dir, dependent dir)
 * pairs: each library → its specifiers, each selected microservice → its
 * specifiers, and the Overseer → its specifiers. A specifier naming `contracts`
 * becomes an edge from the Framework_Singleton's directory, so the "contracts
 * ahead of everything naming it" clause is checked over a real edge rather than
 * assumed from contracts being first. Used to assert R13.6 directly against the
 * layout.
 */
function edgesFor(
  layout: Layout,
  selected: readonly string[],
): Array<{ dependency: string; dependent: string }> {
  const dirByName = new Map<string, string>([
    ...allPackages(layout).map((pkg) => [pkg.name, pkg.packageDir] as const),
    [CONTRACTS.name, CONTRACTS.packageDir],
  ]);

  const edges: Array<{ dependency: string; dependent: string }> = [];
  const add = (specifiers: readonly string[], dependent: string): void => {
    for (const specifier of specifiers) {
      const dependency = dirByName.get(specifier);
      if (dependency !== undefined) edges.push({ dependency, dependent });
    }
  };

  for (const library of layout.libraries) {
    add(library.dependencySpecifiers, library.packageDir);
  }
  for (const identifier of selected) {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === identifier,
    );
    if (microservice !== undefined) {
      add(microservice.dependencySpecifiers, microservice.packageDir);
    }
  }
  add(layout.overseerDeps, OVERSEER.packageDir);

  return edges;
}

// ---------------------------------------------------------------------------
// Generators
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
    .uniqueArray(arbIdentifier, { minLength: 1, maxLength: 5 })
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
 * A random layout: Common and Spa libraries forming a DAG (each depends only on
 * earlier ones, so every edge resolves and no cycle exists), at least one
 * Microservice_Package, and an Overseer that always declares
 * `@microservices/contracts` — the Framework_Singleton case: declared, resolved,
 * never a required dependency, still the first build root. Every directory name is
 * distinct across every category and distinct from every Framework_Singleton
 * name, so the layout's declared names are unique the way discovery requires.
 *
 * Edge discipline follows task 13.1's landed rules. A library-to-library edge
 * only ever targets an earlier Common_Package (see `arbEarlierCommonSubsets`),
 * so neither of the two forbidden inbound-SPA edges (`common → spa`,
 * `spa → spa`) is ever generated. Microservices depend on an arbitrary subset
 * of ALL libraries — including Spa_Packages, since `microservice → spa` is
 * legal — and the Overseer's extra dependencies likewise draw from the full
 * library set, since `overseer → spa` is legal too. These `microservice → spa`
 * and `overseer → spa` edges are exactly what make a Spa_Package a required
 * dependency, so the "never includes a Spa_Package" property still has Spa
 * members reachable to exclude.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .uniqueArray(arbLibraryEntry, {
    minLength: 0,
    maxLength: 6,
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

/** A layout paired with a selected identifier subset (in selector order). */
const arbLayoutAndSelection: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
}> = arbLayout.chain((layout) =>
  fc
    .subarray([...discoveredIdentifiers(layout)])
    .map((selected) => ({ layout, selected })),
);

/**
 * A layout and Selector whose Required_Dependencies is guaranteed to hold at least
 * one Spa_Package: one Spa library is picked, the first Microservice_Package is
 * pointed at it, and that microservice alone is the Selector. Without this the
 * R13.4 Spa-exclusion clause would only be exercised on the runs where a Spa
 * member happened to be reachable.
 */
const arbRequiredSpaCase: fc.Arbitrary<{
  layout: Layout;
  selector: string;
  spa: ConsumerPackage;
}> = arbLayout
  .filter((layout) => layout.libraries.some((pkg) => pkg.category === "spa"))
  .chain((layout) =>
    fc
      .constantFrom(...layout.libraries.filter((pkg) => pkg.category === "spa"))
      .map((spa) => {
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
          spa,
        };
      }),
  );

// ---------------------------------------------------------------------------
// Property 1: Project_List membership and topological order
// ---------------------------------------------------------------------------

describe("Property 1: Project_List membership and topological order", () => {
  it("membership equals contracts plus the required Common_Packages plus the selected microservices plus the Overseer", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const selector = selected.join(",");
        const list = listOf(layout, selector);

        // The set actually selected is resolveSelected's output for this
        // selector (an empty subarray joins to "", which is the all-selector),
        // so the membership oracle is computed over that resolved set.
        const resolved = resolveSelected(
          selector,
          discoveredIdentifiers(layout),
        );
        expect(new Set(list)).toEqual(expectedMembers(layout, resolved));
      }),
      { numRuns: 200 },
    );
  });

  it("emits every member exactly once (no duplicates)", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const list = listOf(layout, selected.join(","));
        expect(new Set(list).size).toBe(list.length);
      }),
      { numRuns: 200 },
    );
  });

  it("never includes a discovered Spa_Package, even when one is a required dependency", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const list = listOf(layout, selected.join(","));
        for (const spa of layout.libraries.filter(
          (pkg) => pkg.category === "spa",
        )) {
          expect(list).not.toContain(spa.packageDir);
        }
      }),
      { numRuns: 200 },
    );

    fc.assert(
      fc.property(arbRequiredSpaCase, ({ layout, selector, spa }) => {
        // The Spa_Package is genuinely required — it is a required dependency of this
        // Selector — and still absent from the Project_List.
        expect([...requiredNames(layout, [selector])]).toContain(spa.name);
        expect(listOf(layout, selector)).not.toContain(spa.packageDir);
      }),
      { numRuns: 100 },
    );
  });

  it("never includes packages/build-tools or packages/integration-tests", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const list = listOf(layout, selected.join(","));
        expect(list).not.toContain(BUILD_TOOLS.packageDir);
        expect(list).not.toContain(INTEGRATION_TESTS.packageDir);
        expect(list).not.toContain("packages/build-tools");
        expect(list).not.toContain("packages/integration-tests");
      }),
      { numRuns: 200 },
    );
  });

  it("places every dependency before its dependent for every edge in the layout", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const selector = selected.join(",");
        const list = listOf(layout, selector);
        const resolved = resolveSelected(
          selector,
          discoveredIdentifiers(layout),
        );

        const position = new Map<string, number>();
        list.forEach((dir, i) => position.set(dir, i));

        // Only edges whose endpoints are both members constrain the order.
        for (const { dependency, dependent } of edgesFor(layout, resolved)) {
          if (position.has(dependency) && position.has(dependent)) {
            expect(position.get(dependency)!).toBeLessThan(
              position.get(dependent)!,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("places packages/contracts first, every selected microservice next, and packages/overseer last", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const selector = selected.join(",");
        const list = listOf(layout, selector);
        const resolved = resolveSelected(
          selector,
          discoveredIdentifiers(layout),
        );

        expect(list[0]).toBe(CONTRACTS.packageDir);

        const overseerIndex = list.indexOf(OVERSEER.packageDir);
        expect(overseerIndex).toBe(list.length - 1);

        for (const identifier of resolved) {
          const index = list.indexOf(microserviceDir(identifier));
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(overseerIndex);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Selector resolution is the existing behavior
// ---------------------------------------------------------------------------

describe("Property 2: selector resolution is the existing behavior", () => {
  /**
   * Extract the Project_List's microservice members (the
   * `packages/microservices/<id>` entries), in list order, as bare ids.
   */
  function microserviceMembers(list: readonly string[]): string[] {
    return list
      .filter((dir) => dir.startsWith(MICROSERVICE_PREFIX))
      .map((dir) => dir.slice(MICROSERVICE_PREFIX.length));
  }

  it("microservice members equal resolveSelected for an explicit id-list selector", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const identifiers = discoveredIdentifiers(layout);
        const selector = selected.join(",");
        expect(microserviceMembers(listOf(layout, selector))).toEqual(
          resolveSelected(selector, identifiers),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("selects every discovered candidate for unset, blank, and * selectors", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.constantFrom<string | undefined>(undefined, "", "   ", "*", " * "),
        (layout, selector) => {
          const identifiers = discoveredIdentifiers(layout);
          const members = microserviceMembers(listOf(layout, selector));
          // The all-selector semantics: every discovered candidate, in
          // discovery order — exactly what resolveSelected produces.
          expect(members).toEqual(resolveSelected(selector, identifiers));
          expect(members).toEqual([...identifiers]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("matches resolveSelected for whitespace-padded and duplicated identifiers", () => {
    fc.assert(
      fc.property(
        arbLayout.chain((layout) => {
          const identifiers = discoveredIdentifiers(layout);
          return fc
            .subarray([...identifiers], { minLength: 1 })
            .chain((picked) =>
              // Build a messy selector: pad each id with random surrounding
              // whitespace and duplicate a prefix of the list, so the raw
              // string exercises trimming and duplicate handling.
              fc
                .tuple(
                  fc.constant(picked),
                  fc.array(fc.constantFrom("", " ", "  ", "\t"), {
                    minLength: picked.length,
                    maxLength: picked.length,
                  }),
                  fc.subarray(picked),
                )
                .map(([base, pads, dups]) => {
                  const padded = base.map(
                    (id, i) => `${pads[i]}${id}${pads[i]}`,
                  );
                  const selector = [...padded, ...dups].join(",");
                  return { layout, selector };
                }),
            );
        }),
        ({ layout, selector }) => {
          expect(microserviceMembers(listOf(layout, selector))).toEqual(
            resolveSelected(selector, discoveredIdentifiers(layout)),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("throws [selector:unmatched] naming every unknown identifier", () => {
    fc.assert(
      fc.property(
        arbLayout.chain((layout) => {
          const identifiers = discoveredIdentifiers(layout);
          const discovered = new Set(identifiers);
          return fc
            .uniqueArray(arbIdentifier, { minLength: 1, maxLength: 4 })
            .filter((names) => names.every((n) => !discovered.has(n)))
            .chain((unknown) =>
              // Mix the unknown identifiers among an arbitrary subset of the
              // known ones, so the offender set is exactly `unknown`.
              fc.subarray([...identifiers]).map((known) => ({
                layout,
                unknown,
                selector: [...known, ...unknown].join(","),
              })),
            );
        }),
        ({ layout, unknown, selector }) => {
          let thrown: unknown;
          try {
            listOf(layout, selector);
            throw new Error("expected projectListFrom to throw");
          } catch (err) {
            thrown = err;
          }

          expect(thrown).toBeInstanceOf(Error);
          const message = (thrown as Error).message;
          expect(message).toContain("[selector:unmatched]");
          for (const name of unknown) {
            expect(message).toContain(`"${name}"`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

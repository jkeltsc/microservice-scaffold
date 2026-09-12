// Feature: package-categories, Property 19: A package is staged if and only if the Selector justifies it
// Feature: package-categories, Property 21: A planned package with no build output fails before anything is staged
// Feature: package-categories, Property 22: The Integrity_Assertion is sound and complete over the enumerated entries
//
// These three properties are exercised through the two pure assertions the
// Image_Assembler runs before and after it copies — `assertBuildOutputsPresent`
// and `assertImageTreeIntegrity` — plus the `plan.stage` those assertions read.
// Neither assertion touches the real filesystem: both take their view of the
// world as an injected argument (`exists` / `isNonEmptyDir` for the first,
// `listScopedEntries` for the second), so a generated (plan, actual-entries)
// pair is the entire world each assertion sees.
//
// The plan itself is built by the ONE derivation, `buildPlanFrom`, over an
// in-memory `Discovery` — the same layout model `build-plan.property.test.ts`
// and `required-dependencies.property.test.ts` use — so Property 19 checks the justified set
// against a plan the production derivation actually produces, not a hand-built
// one. Properties 21 and 22 then vary the *actual* filesystem view (the dist
// predicates, the enumerated scope entries) around that plan, injecting strays
// (including entries belonging to no discovered category) and omissions.
//
// The oracles are written from the requirements, not from `image-tree.ts`:
//
//   - `justifiedScopeEntries` restates R5.10/R7.3–R7.5 as the union of the
//     always-staged Framework_Singletons, the **Staged_Dependencies**, and the
//     Selected_Microservices — independently of `plan.stage`, so Property 19
//     confirms `plan.stage`'s scope entries equal that union rather than
//     assuming they do. The Staged_Dependencies are computed by an independent
//     SPA-cut reachability walk (`referenceStagedNames`): the traversal arrives
//     at a Spa_Package but does not expand it, so a Common_Package reachable
//     ONLY through a Spa_Package is built (it is in the Required_Dependencies)
//     yet ships nowhere (it is not in the Staged_Dependencies). This oracle does
//     not call the production `.staged` — it is written from R7.14 directly;
//   - the Property 22 assertions restate soundness (every enumerated entry is
//     justified) and completeness (every justified entry is present) as two set
//     comparisons, and expect the assertion to succeed exactly on set equality.
//     A built-but-unstaged package — a member of the Required_Dependencies that
//     is NOT a member of the Staged_Dependencies, present in the tree because it
//     was built — must register as an unjustified entry, exactly like a stray of
//     no discovered category. The `arbStrictSubsetCase` generator produces the
//     `microservice → spa → common` shape that makes `stagedDependencies` a
//     strict subset of `requiredDependencies`, so this case is actually reached;
//   - the Property 21 assertions restate R5.9/R6.11 as "some staged member has
//     no non-empty dist/", with the framework variant taking precedence.
//
// Validates: Requirements 5.6, 5.9, 5.10, 6.11, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9, 7.11, 8.11, 8.12, 9.7

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ReadDependencies } from "../src/required-dependencies.js";
import {
  buildPlanFrom,
  SCOPE_DIR,
  type BuildPlan,
  type StagedPackage,
} from "../src/build-plan.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import {
  ALWAYS_STAGED_SCOPED_ENTRIES,
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";
import {
  assertBuildOutputsPresent,
  assertImageTreeIntegrity,
} from "../src/image-tree.js";

/** Framework directory names as data, so no generator collides with one. */
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

/** The library Consumer_Categories eligible to be required dependencies: everything but `microservice`. */
const LIBRARY_CATEGORIES: readonly ConsumerCategory[] = ["common", "spa"];

// ---------------------------------------------------------------------------
// In-memory layout model (shared with the build-plan / required-dependencies suites)
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
 * The `Discovery` a layout presents, each category sorted by directory name —
 * the order Package_Discovery guarantees (R2.5) and therefore what an
 * all-Selector resolves to.
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
function planOf(layout: Layout, selector: string | undefined): BuildPlan {
  return buildPlanFrom(selector, discoveryOf(layout), readerFor(layout));
}

/** The Microservice_Identifiers a layout discovers, in discovery order. */
function discoveredIdentifiers(layout: Layout): readonly string[] {
  return [...layout.microservices].sort(byDirName).map((pkg) => pkg.dirName);
}

// ---------------------------------------------------------------------------
// Oracles: the justified scope-entry union, independent of plan.stage
// ---------------------------------------------------------------------------

/**
 * The all/list Selector rule restated (every generator names only discovered
 * identifiers, so the unmatched branch is out of scope here).
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
 * R7.14 restated as the SPA-cut reachability walk — the STAGE-set oracle,
 * written independently of the production `.staged` derivation. A worklist
 * reachability walk over declared names: from the Selected_Microservices' and
 * the Overseer's specifiers, ignore anything not `@microservices`-scoped,
 * resolve-but-do-not-follow a Framework_Singleton name, and follow every
 * discovered library edge — with ONE restriction that separates it from the
 * build-set reachability: a Spa_Package is ARRIVED AT (and so staged) but is
 * NOT expanded, so nothing reachable only through a Spa_Package enters the
 * result. A Common_Package reachable both through a Spa_Package and through some
 * non-SPA path is present, because reachability under the restricted edge
 * relation is a disjunction over paths, not a per-node flag.
 *
 * The generators produce no peer edge and no dangling name, so nothing is
 * dropped silently. The result is always a subset of the Required_Dependencies,
 * and a strict subset exactly when some library is reachable only by way of a
 * Spa_Package — the `microservice → spa → common` shape `arbStrictSubsetCase`
 * forces.
 */
function referenceStagedNames(
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
    // Arrive at a Spa_Package but do not expand its outgoing specifiers: a
    // Spa_Package is a sink in the stage-set traversal (R7.14, R9.7).
    if (pkg.category === "spa") continue;
    queue.push(...pkg.dependencySpecifiers);
  }
  return reached;
}

/**
 * The justified `node_modules/@microservices/` entry names for a layout and
 * Selector, restated from R5.10/R7.3–R7.5 as a union of three sources — the
 * always-staged Framework_Singletons, the **Staged_Dependencies**'s members
 * (Common *and* Spa), and the Selected_Microservices — WITHOUT reading
 * `plan.stage`. A discovered Common_Package or Spa_Package is justified iff it
 * is a member of the Staged_Dependencies (the SPA-cut reachable set), NOT merely
 * of the Required_Dependencies: a Common_Package reachable only through a
 * Spa_Package is built but ships nowhere, so it is not justified. The Overseer
 * ships at its own package directory and so contributes nothing here.
 */
function justifiedScopeEntries(
  layout: Layout,
  selector: string | undefined,
): Set<string> {
  const selected = referenceSelected(selector, discoveredIdentifiers(layout));
  const stagedNames = referenceStagedNames(layout, selected);
  const stagedDirNames = allPackages(layout)
    .filter((pkg) => stagedNames.has(pkg.name))
    .map((pkg) => pkg.dirName);

  return new Set<string>([
    ...ALWAYS_STAGED_SCOPED_ENTRIES,
    ...stagedDirNames,
    ...selected,
  ]);
}

/** The `scopedEntry` names of a plan's staging list. */
function planScopeEntries(plan: BuildPlan): Set<string> {
  return new Set(
    plan.stage
      .map((staged) => staged.scopedEntry)
      .filter((entry): entry is string => entry !== undefined),
  );
}

// ---------------------------------------------------------------------------
// Generators: layouts and Selectors (the build-plan suite's model)
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
 * "A subset of the earlier NON-SPA names" per position — a resolvable DAG that
 * stays clean of both forbidden inbound-SPA edges. A library may depend only on
 * earlier libraries whose category is not `spa`, so no `common → spa` and no
 * `spa → spa` edge is ever generated (both are hard failures in the resolver,
 * R8.13/R9.11). A `microservice → spa` edge is fine and is produced separately
 * by {@link arbMicroservices}; only library-to-library edges are constrained
 * here. `contracts` and every framework name are excluded upstream, so a library
 * only ever names another discovered library.
 */
function arbEarlierSubsets(
  entries: readonly { dirName: string; category: ConsumerCategory }[],
): fc.Arbitrary<string[][]> {
  if (entries.length === 0) return fc.constant<string[][]>([]);
  return fc.tuple(
    ...entries.map((_, i) =>
      fc.subarray([
        ...entries
          .slice(0, i)
          .filter((earlier) => earlier.category !== "spa")
          .map((earlier) => `${WORKSPACE_SCOPE}/${earlier.dirName}`),
      ]),
    ),
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
 * `@microservices/contracts` — the R5.3/R5.4 case (declared, resolved, never a
 * required dependency).
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

    return arbEarlierSubsets(entries).chain((depsPerLibrary) => {
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
 * A raw `MICROSERVICES` value for a layout: the all-Selector spellings and
 * comma lists exercising trimming and empty-entry dropping. Entries are drawn
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
 * A layout and Selector whose `stagedDependencies` is a STRICT subset of its
 * `requiredDependencies` — the `microservice → spa → common` shape, following
 * the `arbRequiredSpaCase` pattern from `build-plan.property.test.ts`.
 *
 * The construction, on top of {@link arbLayout}:
 *
 *   1. add a fresh Common_Package `via-spa-common` that nothing else names;
 *   2. add a fresh Spa_Package `via-spa` that depends ONLY on `via-spa-common`;
 *   3. point the first Microservice_Package at `via-spa` and make it the Selector.
 *
 * The microservice legally reaches `via-spa` (a `microservice → spa` edge is
 * allowed), `via-spa` legally depends on `via-spa-common` (`spa → common` is
 * downward), and `via-spa-common` is reachable ONLY through `via-spa`. So
 * `via-spa-common` is BUILT (it is in the Required_Dependencies — the bundler
 * needs its `dist/`) but is NOT STAGED (the SPA-cut walk stops at `via-spa`),
 * which is the strict-subset case. The names are prefixed so they cannot collide
 * with a generated library's directory name (`arbDirName` never yields a `-`
 * that lands exactly here, and uniqueness is enforced below regardless).
 */
const arbStrictSubsetCase: fc.Arbitrary<{
  layout: Layout;
  selector: string;
}> = arbLayout
  // Keep the injected names clear of any generated library or framework name.
  .filter(
    (layout) =>
      !layout.libraries.some(
        (pkg) => pkg.dirName === "via-spa" || pkg.dirName === "via-spa-common",
      ) &&
      !FRAMEWORK_DIR_NAMES.includes("via-spa") &&
      !FRAMEWORK_DIR_NAMES.includes("via-spa-common"),
  )
  .map((layout) => {
    const commonName = `${WORKSPACE_SCOPE}/via-spa-common`;
    const spaName = `${WORKSPACE_SCOPE}/via-spa`;
    // The Common_Package nothing else reaches, and the Spa_Package that alone
    // reaches it. Order in `libraries` respects the DAG invariant (common before
    // the spa that depends on it), though the resolver does not rely on it.
    const viaSpaCommon = consumerPackage("common", "via-spa-common", []);
    const viaSpa = consumerPackage("spa", "via-spa", [commonName]);
    const entryPoint = layout.microservices[0];

    return {
      layout: {
        ...layout,
        libraries: [...layout.libraries, viaSpaCommon, viaSpa],
        microservices: layout.microservices.map((pkg) =>
          pkg.packageDir === entryPoint.packageDir
            ? {
                ...pkg,
                dependencySpecifiers: [
                  ...new Set([...pkg.dependencySpecifiers, spaName]),
                ].sort(),
              }
            : pkg,
        ),
      },
      selector: entryPoint.dirName,
    };
  });

/**
 * The Property 22 layout/Selector source: the ordinary cases plus the
 * strict-subset (`microservice → spa → common`) case, so the integrity
 * assertion is exercised on plans whose `stagedDependencies` is sometimes a
 * strict subset of `requiredDependencies` — a built-but-unstaged Common_Package
 * present in the tree must register as unjustified, and the justified union is
 * the Staged_Dependencies-based one.
 */
const arbLayoutAndSelectorMaybeStrict: fc.Arbitrary<{
  layout: Layout;
  selector: string | undefined;
}> = fc.oneof(arbLayoutAndSelector, arbStrictSubsetCase);

// ---------------------------------------------------------------------------
// Actual-entry-set generators: the justified set perturbed by strays / omissions
// ---------------------------------------------------------------------------
//
// The scope directory the Image_Assembler enumerates is a set of entry names.
// The Integrity_Assertion never sees the plan's target paths; it sees only what
// `listScopedEntries` reports. So Property 22 varies that report around a fixed
// plan: the exact justified set, the set with strays added, the set with
// members omitted, and both at once — where a stray may be a name of no
// discovered category at all (`stray-*`, `LEAKED.txt`), which is the case the
// two old discovered-set guards could not express (R7.9).

/** A name that belongs to no discovered category and no framework singleton. */
const arbStrayEntry: fc.Arbitrary<string> = fc
  .oneof(
    fc.stringMatching(/^[a-z][a-z0-9-]*$/).map((s) => `stray-${s}`),
    fc.constantFrom("LEAKED.txt", "stray-a", "stray-z", ".partial"),
  )
  .filter((s) => s.length > 0);

/**
 * An actual scope-entry set derived from the justified set by dropping an
 * arbitrary subset (omissions) and adding an arbitrary set of strays. Returns
 * the resulting entry list plus the two perturbations, so the property can
 * decide the expected verdict from the perturbation rather than re-deriving it.
 */
function arbActualEntries(justified: readonly string[]): fc.Arbitrary<{
  entries: readonly string[];
  omitted: readonly string[];
  strays: readonly string[];
}> {
  return fc
    .record({
      kept: fc.subarray([...justified]),
      strays: fc.uniqueArray(arbStrayEntry, { maxLength: 4 }),
    })
    .map(({ kept, strays }) => {
      // Strays that happen to collide with a justified name are not strays.
      const trueStrays = strays.filter((s) => !justified.includes(s));
      const omitted = justified.filter((j) => !kept.includes(j));
      return {
        entries: [...new Set([...kept, ...trueStrays])],
        omitted,
        strays: trueStrays,
      };
    });
}

/** An injected `listScopedEntries` returning a fixed set for the plan's scope dir. */
function listerReturning(
  outDir: string,
  entries: readonly string[],
): (scopeDir: string) => readonly string[] {
  const expectedScope = `${outDir}/${SCOPE_DIR}`;
  return (scopeDir) => (scopeDir === expectedScope ? [...entries].sort() : []);
}

// ---------------------------------------------------------------------------
// Property 19 — a package is staged iff the Selector justifies it
// ---------------------------------------------------------------------------
//
// Validates: Requirements 5.6, 7.3, 7.4, 7.5, 8.11, 8.12, 9.7

describe("Property 19: a package is staged iff the Selector justifies it", () => {
  it("stages exactly the justified scope-entry union, in both directions", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        // The plan's scope entries equal the independently derived justified
        // union — no unjustified entry is staged, and no justified one omitted.
        expect(planScopeEntries(plan)).toEqual(
          justifiedScopeEntries(layout, selector),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("stages a discovered library iff it is a staged dependency", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const staged = planScopeEntries(plan);
        const selected = referenceSelected(
          selector,
          discoveredIdentifiers(layout),
        );
        const stagedNames = referenceStagedNames(layout, selected);

        for (const library of layout.libraries) {
          const isStaged = stagedNames.has(library.name);
          expect(staged.has(library.dirName)).toBe(isStaged);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("stages a discovered microservice iff it is selected", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const staged = planScopeEntries(plan);
        const selected = new Set(
          referenceSelected(selector, discoveredIdentifiers(layout)),
        );

        for (const microservice of layout.microservices) {
          expect(staged.has(microservice.dirName)).toBe(
            selected.has(microservice.dirName),
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("stages the Overseer at its package directory, not under the scope", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const plan = planOf(layout, selector);
        const overseer = plan.stage.find(
          (staged) => staged.sourceDir === OVERSEER.packageDir,
        );
        expect(overseer).toBeDefined();
        expect(overseer!.targetDir).toBe(OVERSEER.packageDir);
        expect(overseer!.scopedEntry).toBeUndefined();
        // ...and it never leaks in as a scope entry.
        expect(planScopeEntries(plan).has(OVERSEER.dirName)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("always stages the Framework_Singleton scope entries regardless of Selector", () => {
    fc.assert(
      fc.property(arbLayoutAndSelector, ({ layout, selector }) => {
        const staged = planScopeEntries(planOf(layout, selector));
        for (const entry of ALWAYS_STAGED_SCOPED_ENTRIES) {
          expect(staged.has(entry)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21 — a planned package with no build output fails before staging
// ---------------------------------------------------------------------------
//
// Validates: Requirements 5.9, 6.11

describe("Property 21: a planned package with no build output fails before staging", () => {
  /** A dist path is the staged member's source dir plus `/dist`. */
  function distOf(sourceDir: string): string {
    return `${sourceDir}/dist`;
  }

  /**
   * A plan whose staged members are exactly the given entries, at their own
   * source dirs. Enough for `assertBuildOutputsPresent`, which reads only
   * `plan.stage`'s `sourceDir` and `justification`.
   */
  function planStaging(stage: readonly StagedPackage[]): BuildPlan {
    return {
      selected: [],
      requiredDependencies: [],
      spaBuilds: [],
      tscRoots: [],
      stage,
    };
  }

  /** An arbitrary staged member with a chosen justification. */
  const arbStaged: fc.Arbitrary<StagedPackage> = fc
    .record({
      dir: fc.stringMatching(/^[a-z][a-z0-9-]*$/).filter((s) => s.length > 0),
      justification: fc.constantFrom<StagedPackage["justification"]>(
        "framework-singleton",
        "required-dependency",
        "selected-microservice",
      ),
    })
    .map(({ dir, justification }) => ({
      sourceDir: `packages/${dir}`,
      targetDir: `${SCOPE_DIR}/${dir}`,
      scopedEntry: dir,
      justification,
    }));

  it("succeeds exactly when every staged member has a non-empty dist/", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbStaged, {
            minLength: 1,
            maxLength: 6,
            selector: (staged) => staged.sourceDir,
          })
          .chain((stage) =>
            // For each member, decide whether its dist/ is present-and-nonempty.
            fc
              .tuple(...stage.map(() => fc.boolean()))
              .map((present) => ({ stage, present })),
          ),
        ({ stage, present }) => {
          const plan = planStaging(stage);
          const okDirs = new Set(
            stage
              .filter((_, i) => present[i])
              .map((staged) => distOf(staged.sourceDir)),
          );
          const exists = (path: string): boolean => okDirs.has(path);
          const isNonEmptyDir = (path: string): boolean => okDirs.has(path);

          const allPresent = present.every(Boolean);
          if (allPresent) {
            expect(() =>
              assertBuildOutputsPresent(plan, exists, isNonEmptyDir),
            ).not.toThrow();
          } else {
            expect(() =>
              assertBuildOutputsPresent(plan, exists, isNonEmptyDir),
            ).toThrow();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("names every offender, and uses the framework variant when a framework member is short", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbStaged, {
            minLength: 1,
            maxLength: 6,
            selector: (staged) => staged.sourceDir,
          })
          .chain((stage) =>
            fc
              .tuple(...stage.map(() => fc.boolean()))
              .map((present) => ({ stage, present })),
          )
          // Only the runs with at least one offender are interesting here.
          .filter(({ present }) => present.some((ok) => !ok)),
        ({ stage, present }) => {
          const plan = planStaging(stage);
          const okDirs = new Set(
            stage
              .filter((_, i) => present[i])
              .map((staged) => distOf(staged.sourceDir)),
          );
          const view = (path: string): boolean => okDirs.has(path);

          const offenders = stage.filter((_, i) => !present[i]);
          const frameworkOffenders = offenders.filter(
            (s) => s.justification === "framework-singleton",
          );

          let thrown: Error | undefined;
          try {
            assertBuildOutputsPresent(plan, view, view);
          } catch (error) {
            thrown = error as Error;
          }
          expect(thrown).toBeDefined();
          const message = thrown!.message;

          if (frameworkOffenders.length > 0) {
            // Framework variant wins when any framework member is short.
            expect(message).toMatch(/^\[image-tree:framework-output\]/);
            for (const offender of frameworkOffenders) {
              expect(message).toContain(`"${offender.sourceDir}"`);
            }
          } else {
            expect(message).toMatch(/^\[image-tree:no-dist\]/);
            for (const offender of offenders) {
              expect(message).toContain(`"${offender.sourceDir}"`);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("treats an empty dist/ the same as an absent one", () => {
    fc.assert(
      fc.property(arbStaged, (staged) => {
        const plan = planStaging([staged]);
        const dist = distOf(staged.sourceDir);
        // dist/ exists as a path but is empty: exists true, isNonEmptyDir false.
        const exists = (path: string): boolean => path === dist;
        const isNonEmptyDir = (): boolean => false;
        expect(() =>
          assertBuildOutputsPresent(plan, exists, isNonEmptyDir),
        ).toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22 — the Integrity_Assertion is sound and complete
// ---------------------------------------------------------------------------
//
// Validates: Requirements 5.10, 7.7, 7.8, 7.9, 7.11

describe("Property 22: the Integrity_Assertion is sound and complete over the enumerated entries", () => {
  const OUT_DIR = "/out";

  it("succeeds exactly when the enumerated entries equal the justified union", () => {
    fc.assert(
      fc.property(
        arbLayoutAndSelectorMaybeStrict.chain(({ layout, selector }) => {
          const justified = [...justifiedScopeEntries(layout, selector)];
          return arbActualEntries(justified).map((actual) => ({
            layout,
            selector,
            actual,
          }));
        }),
        ({ layout, selector, actual }) => {
          const plan = planOf(layout, selector);
          const lister = listerReturning(OUT_DIR, actual.entries);

          const isExactMatch =
            actual.omitted.length === 0 && actual.strays.length === 0;

          if (isExactMatch) {
            expect(() =>
              assertImageTreeIntegrity(OUT_DIR, plan, lister),
            ).not.toThrow();
          } else {
            expect(() =>
              assertImageTreeIntegrity(OUT_DIR, plan, lister),
            ).toThrow();
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("names every unjustified entry — including entries of no discovered category — when unsound", () => {
    fc.assert(
      fc.property(
        arbLayoutAndSelectorMaybeStrict.chain(({ layout, selector }) => {
          const justified = [...justifiedScopeEntries(layout, selector)];
          return fc
            .uniqueArray(arbStrayEntry, { minLength: 1, maxLength: 4 })
            .filter((strays) => strays.every((s) => !justified.includes(s)))
            .map((strays) => ({ layout, selector, justified, strays }));
        }),
        ({ layout, selector, justified, strays }) => {
          const plan = planOf(layout, selector);
          // All justified entries present PLUS the strays: sound-fail only.
          const entries = [...justified, ...strays];
          const lister = listerReturning(OUT_DIR, entries);

          let thrown: Error | undefined;
          try {
            assertImageTreeIntegrity(OUT_DIR, plan, lister);
          } catch (error) {
            thrown = error as Error;
          }
          expect(thrown).toBeDefined();
          expect(thrown!.message).toMatch(/^\[image-tree:unjustified\]/);
          for (const stray of strays) {
            expect(thrown!.message).toContain(`"${stray}"`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("names every absent justified entry when incomplete", () => {
    fc.assert(
      fc.property(
        arbLayoutAndSelectorMaybeStrict.chain(({ layout, selector }) => {
          const justified = [...justifiedScopeEntries(layout, selector)];
          return fc
            .subarray(justified, {
              minLength: 0,
              maxLength: Math.max(0, justified.length - 1),
            })
            .map((kept) => ({ layout, selector, justified, kept }));
        }),
        ({ layout, selector, justified, kept }) => {
          const plan = planOf(layout, selector);
          const omitted = justified.filter((j) => !kept.includes(j));
          // No strays, so this is a pure completeness failure (missing only).
          const lister = listerReturning(OUT_DIR, kept);

          let thrown: Error | undefined;
          try {
            assertImageTreeIntegrity(OUT_DIR, plan, lister);
          } catch (error) {
            thrown = error as Error;
          }

          if (omitted.length === 0) {
            // kept === justified: exact match, no failure.
            expect(thrown).toBeUndefined();
            return;
          }
          expect(thrown).toBeDefined();
          expect(thrown!.message).toMatch(/^\[image-tree:missing\]/);
          for (const absent of omitted) {
            expect(thrown!.message).toContain(`"${absent}"`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reports unjustified before missing when the tree is both unsound and incomplete", () => {
    fc.assert(
      fc.property(
        arbLayoutAndSelectorMaybeStrict.chain(({ layout, selector }) => {
          const justified = [...justifiedScopeEntries(layout, selector)];
          return fc
            .record({
              kept: fc.subarray(justified, {
                maxLength: Math.max(0, justified.length - 1),
              }),
              strays: fc.uniqueArray(arbStrayEntry, {
                minLength: 1,
                maxLength: 3,
              }),
            })
            .filter(
              ({ kept, strays }) =>
                kept.length < justified.length &&
                strays.every((s) => !justified.includes(s)),
            )
            .map(({ kept, strays }) => ({ layout, selector, kept, strays }));
        }),
        ({ layout, selector, kept, strays }) => {
          const plan = planOf(layout, selector);
          const lister = listerReturning(OUT_DIR, [...kept, ...strays]);
          // Both offender kinds exist; the unjustified failure must win.
          expect(() =>
            assertImageTreeIntegrity(OUT_DIR, plan, lister),
          ).toThrowError(/^\[image-tree:unjustified\]/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("registers a built-but-unstaged package (reached only via a Spa_Package) as unjustified", () => {
    fc.assert(
      fc.property(arbStrictSubsetCase, ({ layout, selector }) => {
        const plan = planOf(layout, selector);

        // Precondition the generator guarantees: stagedDependencies is a STRICT
        // subset of requiredDependencies, so at least one built package ships
        // nowhere. This is the case the requirements-based oracle must model.
        const requiredNames = new Set(
          plan.requiredDependencies.map((pkg) => pkg.name),
        );
        const stagedNames = new Set(
          plan.stagedDependencies.map((pkg) => pkg.name),
        );
        const builtButUnstaged = plan.requiredDependencies.filter(
          (pkg) => !stagedNames.has(pkg.name),
        );
        expect(stagedNames.size).toBeLessThan(requiredNames.size);
        expect(builtButUnstaged.length).toBeGreaterThan(0);
        // `via-spa-common` is the package reached only through `via-spa`.
        expect(
          builtButUnstaged.some((pkg) => pkg.dirName === "via-spa-common"),
        ).toBe(true);

        const justified = [...justifiedScopeEntries(layout, selector)];
        // The built-but-unstaged package must NOT be part of the justified
        // union — the oracle counts staged, not required, dependencies.
        for (const pkg of builtButUnstaged) {
          expect(justified).not.toContain(pkg.dirName);
        }

        // A tree that ships every justified entry PLUS the built-but-unstaged
        // directory (its `dist/` exists, so it is a real candidate to leak) is
        // unsound: the assertion must name every built-but-unstaged directory
        // among the unjustified entries, exactly as it names a stray of no
        // discovered category.
        const leaked = builtButUnstaged.map((pkg) => pkg.dirName);
        const lister = listerReturning(OUT_DIR, [...justified, ...leaked]);

        let thrown: Error | undefined;
        try {
          assertImageTreeIntegrity(OUT_DIR, plan, lister);
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown).toBeDefined();
        expect(thrown!.message).toMatch(/^\[image-tree:unjustified\]/);
        for (const dirName of leaked) {
          expect(thrown!.message).toContain(`"${dirName}"`);
        }
      }),
      { numRuns: 200 },
    );
  });
});

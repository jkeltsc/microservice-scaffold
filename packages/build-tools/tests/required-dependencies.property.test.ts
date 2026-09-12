// Feature: package-categories, Property 10: A Framework_Singleton specifier resolves and never becomes a required dependency
// Feature: package-categories, Property 11: An unresolvable specifier fails with the preserved message; unscoped keys are ignored
// Feature: package-categories, Property 12: The Required_Dependencies equal the reachability oracle
// Feature: package-categories, Property 13: The Required_Dependencies are in the lexicographically-least topological order
// Feature: package-categories, Property 14: A dependency cycle fails, naming every participant
// Feature: package-categories, Property 28: A forbidden inbound edge into a Spa_Package fails, naming the declarer and the remedy
// Feature: package-categories, Property 29: A Microservice_Package is never a dependency target, whatever the declarer
// Feature: package-categories, Property 31: The Staged_Dependencies equal the SPA-cut reachability oracle
//
// Every property is exercised through `requiredDependencies(selected, discovery,
// readDependencies)` — the pure Dependency_Resolver — over generated in-memory
// layouts. No filesystem is touched: the `Discovery` handed to the resolver is
// assembled by `discoveryOf` below and the root specifiers come from
// `readerFor`, so the injected graph is the entire world the resolver sees.
//
// The layout model and the reference reachability oracle are carried over from
// the retired `shared-packages` dependency-walk suite, re-modelled from
// `Map<name, SharedPackage>` onto a `Discovery`. Two things change with the model:
//
//   - `contracts` is no longer a member of the generated graph pinned at index
//     0. It is a Framework_Singleton, so a specifier naming it resolves without
//     being followed and without becoming a required dependency (Property 10) —
//     the Overseer still declares it in every generated layout, which is what makes
//     that framework edge present in every run.
//   - Consumer_Packages come in two categories eligible to be required
//     dependencies, `common` and `spa`, both of which sit under their own
//     Namespace_Container. The generator mixes them so resolution is exercised
//     over both.
//
// The oracles are written from the requirements rather than from
// `required-dependencies.ts`:
//
//   - `referenceRequired` restates R7.1 as a worklist reachability walk over the
//     generated layout — start from the Selected_Microservices' and the
//     Overseer's specifiers, ignore anything not `@microservices`-scoped (R3.10),
//     resolve-but-do-not-follow a Framework_Singleton name (R3.7), and follow
//     every discovered Consumer_Package edge.
//   - `referenceOrder` restates R7.2 as "repeatedly emit the lexicographically
//     least member all of whose member dependencies have been emitted" — a
//     Kahn-style walk with a sorted ready queue, which is what makes the
//     ordering assertion stronger than the inherited "every dependency precedes
//     its dependents" check it replaces.
//
// The `[shared:unresolved]` block is preserved from the old suite: R13.11 pins
// that message byte for byte, so the assertion is a literal string comparison
// rather than a substring check.
//
// Validates: Requirements 3.7, 3.8, 3.10, 5.3, 5.4, 5.7, 7.1, 7.2, 7.10, 8.12, 13.11, 14.5

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  requiredDependencies,
  resolveDependencySets,
  type ReadDependencies,
} from "../src/required-dependencies.js";
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

/** Framework names as data, so the oracles never call the production lookup. */
const FRAMEWORK_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.name,
);
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

/** The Consumer_Categories eligible to be required dependencies: everything but `microservice`. */
const LIBRARY_CATEGORIES: readonly ConsumerCategory[] = ["common", "spa"];

// ---------------------------------------------------------------------------
// In-memory layout model
// ---------------------------------------------------------------------------
//
// A layout is a set of discovered Consumer_Packages — library packages (Common
// and Spa) plus Microservice_Packages — together with the Overseer's declared
// specifiers. Library packages are laid out in a list and may depend only on
// packages *earlier* in the list, so the base graph is always acyclic and every
// edge resolves; the dangling case is Property 11's and the cyclic case is
// Property 14's, each built by injecting into a base layout.

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
  name: string,
  dependencySpecifiers: readonly string[],
): ConsumerPackage {
  return {
    category,
    dirName,
    packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
    name,
    dependencySpecifiers: [...dependencySpecifiers].sort(),
    buildKind: buildKindOf(category),
  };
}

/** The `Discovery` a layout presents to the resolver. */
function discoveryOf(layout: Layout): Discovery {
  const all = [...layout.libraries, ...layout.microservices];
  return {
    byCategory: {
      microservice: all.filter((pkg) => pkg.category === "microservice"),
      common: all.filter((pkg) => pkg.category === "common"),
      spa: all.filter((pkg) => pkg.category === "spa"),
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

/** Every discovered package of a layout, in a single list. */
function allPackages(layout: Layout): readonly ConsumerPackage[] {
  return [...layout.libraries, ...layout.microservices];
}

/** The Required_Dependencies `requiredDependencies` computes for a layout and a Selector. */
function requiredOf(
  layout: Layout,
  selected: readonly string[],
): readonly ConsumerPackage[] {
  return requiredDependencies(selected, discoveryOf(layout), readerFor(layout));
}

// ---------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------

/**
 * Reference reachability — R7.1 restated as a worklist walk, kept
 * independent of the production two-phase walk. Returns the *set* of declared
 * names reachable from the Selected_Microservices' and the Overseer's
 * specifiers:
 *
 *   - a specifier that is not `@microservices`-scoped is ignored (R3.10);
 *   - a specifier equal to a Framework_Singleton name resolves and is neither
 *     followed nor recorded (R3.7, R5.3, R5.7);
 *   - a specifier naming a discovered Consumer_Package is recorded and followed.
 *
 * A specifier naming nothing at all, and a specifier naming a
 * Microservice_Package, are dropped: both are failures the resolver raises, and
 * the blocks that generate them assert on the failure rather than on a set.
 */
function referenceRequired(
  layout: Layout,
  selected: readonly string[],
): Set<string> {
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
    if (FRAMEWORK_NAMES.includes(specifier)) continue;
    if (reached.has(specifier)) continue;
    const pkg = byName.get(specifier);
    if (pkg === undefined || pkg.category === "microservice") continue;
    reached.add(specifier);
    queue.push(...pkg.dependencySpecifiers);
  }
  return reached;
}

/** Ascending code-point comparison of the R7.2 ordering key. */
function compareOrderKey(a: ConsumerPackage, b: ConsumerPackage): number {
  const key = (pkg: ConsumerPackage): string =>
    `${pkg.dirName}\u0000${pkg.packageDir}`;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/**
 * Reference order — R7.2 restated as Kahn's algorithm with a sorted ready
 * queue: repeatedly emit the lexicographically least member (by directory name,
 * with the repo-relative directory as a tiebreak) all of whose member
 * dependencies have already been emitted. That greedy choice yields the unique
 * lexicographically-least topological order, which is strictly stronger than
 * "every dependency precedes its dependents".
 *
 * @throws when the reachable subgraph has a cycle — the callers of this oracle
 *   generate acyclic layouts, so reaching it means the generator is wrong.
 */
function referenceOrder(
  layout: Layout,
  selected: readonly string[],
): ConsumerPackage[] {
  const memberNames = referenceRequired(layout, selected);
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
      .sort(compareOrderKey);

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
 * One "subset of the legal names before me" arbitrary per library position,
 * which is what makes the generated library graph a DAG with every edge both
 * resolvable AND permitted by the inbound-SPA rules.
 *
 * A library may depend only on entries *earlier* in the list (the DAG
 * guarantee), and — because a `common → spa` edge is `[deps:common-to-spa]` and
 * a `spa → spa` edge is `[deps:spa-to-spa]` — a `common` or `spa` declarer may
 * depend only on earlier NON-SPA (i.e. `common`) libraries. A microservice, by
 * contrast, may depend on any earlier library including a Spa_Package (a legal
 * `microservice → spa` edge), which is why microservice edges are generated
 * separately in {@link arbMicroservices}, not here. Keeping the base library
 * graph free of forbidden edges is what lets Properties 10–14 resolve cleanly;
 * Property 28 injects the forbidden edges deliberately against this base.
 */
function arbLibraryEarlierSubsets(
  entries: readonly { dirName: string; category: ConsumerCategory }[],
  names: readonly string[],
): fc.Arbitrary<string[][]> {
  if (entries.length === 0) return fc.constant<string[][]>([]);
  return fc.tuple(
    ...entries.map((entry, i) => {
      // The declarer's own category decides which earlier libraries it may
      // name: a common/spa declarer sees only earlier common libraries, so no
      // inbound-SPA edge is ever generated in the base graph.
      const candidates = entries
        .slice(0, i)
        .filter((earlier) =>
          entry.category === "microservice"
            ? true
            : earlier.category !== "spa",
        )
        .map((earlier) => names[entries.indexOf(earlier)]);
      return fc.subarray([...candidates]);
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
          ids.map((id, i) =>
            consumerPackage(
              "microservice",
              id,
              `${WORKSPACE_SCOPE}/${id}`,
              depsPerId[i],
            ),
          ),
        ),
    );
}

/**
 * A random layout. Library packages are laid out in a list and may depend only
 * on earlier entries (a DAG, every edge resolvable); microservices and the
 * Overseer depend on arbitrary subsets of them. The Overseer always declares
 * `@microservices/contracts`, mirroring the real repository — which puts a
 * Framework_Singleton edge in every generated run.
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

    return arbLibraryEarlierSubsets(entries, libraryNames).chain((depsPerLibrary) => {
      const libraries = entries.map((entry, i) =>
        consumerPackage(
          entry.category,
          entry.dirName,
          libraryNames[i],
          depsPerLibrary[i],
        ),
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

/** A layout paired with a Selector: a subset of its microservice identifiers. */
const arbLayoutAndSelection: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
}> = arbLayout.chain((layout) =>
  fc
    .subarray(layout.microservices.map((pkg) => pkg.dirName))
    .map((selected) => ({ layout, selected })),
);

// ---------------------------------------------------------------------------
// Injection helpers, shared by the failure blocks
// ---------------------------------------------------------------------------

/** The same package with a different specifier list. */
function withSpecifiers(
  pkg: ConsumerPackage,
  specifiers: readonly string[],
): ConsumerPackage {
  return { ...pkg, dependencySpecifiers: [...specifiers].sort() };
}

/** A layout in which the package at `packageDir` declares `specifiers`. */
function withPackageSpecifiers(
  layout: Layout,
  packageDir: string,
  specifiers: readonly string[],
): Layout {
  const apply = (pkgs: readonly ConsumerPackage[]): ConsumerPackage[] =>
    pkgs.map((pkg) =>
      pkg.packageDir === packageDir ? withSpecifiers(pkg, specifiers) : pkg,
    );
  return {
    libraries: apply(layout.libraries),
    microservices: apply(layout.microservices),
    overseerDeps: layout.overseerDeps,
  };
}

/** A layout in which *every* consumer additionally declares `extra`. */
function withExtraSpecifiersEverywhere(
  layout: Layout,
  extra: readonly string[],
): Layout {
  const add = (pkgs: readonly ConsumerPackage[]): ConsumerPackage[] =>
    pkgs.map((pkg) =>
      withSpecifiers(pkg, [
        ...new Set([...pkg.dependencySpecifiers, ...extra]),
      ]),
    );
  return {
    libraries: add(layout.libraries),
    microservices: add(layout.microservices),
    overseerDeps: [...new Set([...layout.overseerDeps, ...extra])].sort(),
  };
}

/** Which consumer a failure block attaches its offending specifiers to. */
type Declarer =
  | { readonly kind: "overseer" }
  | { readonly kind: "microservice"; readonly dirName: string }
  | { readonly kind: "library"; readonly dirName: string };

function arbDeclarer(layout: Layout): fc.Arbitrary<Declarer> {
  const options: fc.Arbitrary<Declarer>[] = [
    fc.constant<Declarer>({ kind: "overseer" }),
    fc
      .constantFrom(...layout.microservices.map((pkg) => pkg.dirName))
      .map((dirName) => ({ kind: "microservice" as const, dirName })),
  ];
  if (layout.libraries.length > 0) {
    options.push(
      fc
        .constantFrom(...layout.libraries.map((pkg) => pkg.dirName))
        .map((dirName) => ({ kind: "library" as const, dirName })),
    );
  }
  return fc.oneof(...options);
}

/**
 * Attach `extra` specifiers to one consumer and return the Selector that makes
 * the resolver reach that consumer:
 *
 *   - the Overseer is a root under every Selector, so every microservice is
 *     selected and the failure surfaces once the roots' clean subgraphs are done;
 *   - a Microservice_Package is made the sole Selected_Microservice, so the
 *     failure surfaces while its own specifiers are resolved;
 *   - a library package is reached by pointing the first microservice at it and
 *     selecting only that microservice, so it is the only reachable declarer.
 *
 * Either way exactly one consumer declares `extra`, which is what lets the
 * failure blocks assert on an exact message.
 */
function injectAt(
  layout: Layout,
  declarer: Declarer,
  extra: readonly string[],
): { layout: Layout; selected: string[]; declarerDir: string } {
  if (declarer.kind === "overseer") {
    return {
      layout: {
        ...layout,
        overseerDeps: [...new Set([...layout.overseerDeps, ...extra])].sort(),
      },
      selected: layout.microservices.map((pkg) => pkg.dirName),
      declarerDir: OVERSEER.packageDir,
    };
  }

  if (declarer.kind === "microservice") {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === declarer.dirName,
    )!;
    return {
      layout: withPackageSpecifiers(layout, microservice.packageDir, [
        ...new Set([...microservice.dependencySpecifiers, ...extra]),
      ]),
      selected: [microservice.dirName],
      declarerDir: microservice.packageDir,
    };
  }

  const library = layout.libraries.find(
    (pkg) => pkg.dirName === declarer.dirName,
  )!;
  const entryPoint = layout.microservices[0];
  return {
    layout: withPackageSpecifiers(
      withPackageSpecifiers(layout, library.packageDir, [
        ...new Set([...library.dependencySpecifiers, ...extra]),
      ]),
      entryPoint.packageDir,
      [library.name],
    ),
    selected: [entryPoint.dirName],
    declarerDir: library.packageDir,
  };
}

/** The message of the error `run` throws; fails the test when it throws nothing. */
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("expected requiredDependencies to throw");
}

// ---------------------------------------------------------------------------
// Property 10 — a Framework_Singleton specifier resolves and never becomes a required dependency
// ---------------------------------------------------------------------------
//
// Validates: Requirements 3.7, 5.3, 5.4, 5.7, 7.1

/** A non-empty set of Framework_Singleton names to inject as specifiers. */
const arbFrameworkSpecifiers: fc.Arbitrary<string[]> = fc
  .subarray([...FRAMEWORK_NAMES], { minLength: 1 })
  .map((names) => [...new Set([CONTRACTS.name, ...names])].sort());

describe("Property 10: a Framework_Singleton specifier resolves and never becomes a required dependency", () => {
  it("resolves framework specifiers declared by any consumer without failing and without adding a member", () => {
    fc.assert(
      fc.property(
        arbLayoutAndSelection,
        arbFrameworkSpecifiers,
        ({ layout, selected }, frameworkSpecifiers) => {
          const injected = withExtraSpecifiersEverywhere(
            layout,
            frameworkSpecifiers,
          );

          // No unresolved-specifier failure: every framework name resolves.
          const required = requiredOf(injected, selected);

          // No Framework_Singleton is a member, by name or by directory name.
          for (const name of required.map((pkg) => pkg.name)) {
            expect(FRAMEWORK_NAMES).not.toContain(name);
          }
          for (const dirName of required.map((pkg) => pkg.dirName)) {
            expect(FRAMEWORK_DIR_NAMES).not.toContain(dirName);
          }

          // Framework edges are inert: the result is what it would have been
          // had the framework specifiers not been declared at all.
          expect(required.map((pkg) => pkg.packageDir)).toEqual(
            requiredOf(layout, selected).map((pkg) => pkg.packageDir),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("excludes contracts from the Required_Dependencies for every Selector while keeping it a first build root and always staged", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const required = requiredOf(layout, selected);

        // The Overseer declares @microservices/contracts in every generated
        // layout, so this is the R5.3 case: declared, resolved, not a member.
        expect(layout.overseerDeps).toContain(CONTRACTS.name);
        expect(required.map((pkg) => pkg.name)).not.toContain(CONTRACTS.name);

        // It is nevertheless always built first and always staged, on
        // Framework_Singleton grounds alone rather than required dependencyship
        // (R5.4, R5.5, R5.10) — neither fact depends on the Selector.
        expect(CONTRACTS.buildPosition).toBe("first");
        expect(CONTRACTS.staging).toBe("scoped-node-modules");
        expect(ALWAYS_STAGED_SCOPED_ENTRIES).toContain(CONTRACTS.dirName);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11 — an unresolvable specifier fails with the preserved message; unscoped keys are ignored
// ---------------------------------------------------------------------------
//
// The `[shared:unresolved]` block is carried over from the shared-packages suite
// unchanged in substance: R13.11 pins the message, so it is compared literally.
// The second half of the property is new — arbitrary non-`@microservices`
// `dependencies` keys must change neither the Required_Dependencies nor a
// failure (R3.10).
//
// Validates: Requirements 3.8, 3.10, 13.11

/** An `@microservices` name; the generators below keep it out of discovery. */
const arbDanglingName: fc.Arbitrary<string> = arbDirName.map(
  (dirName) => `${WORKSPACE_SCOPE}/${dirName}`,
);

/**
 * A layout, a Selector, and a non-empty set of `@microservices` specifiers that
 * name neither a discovered Consumer_Package nor a Framework_Singleton,
 * attached to exactly one reachable consumer.
 */
const arbDanglingCase: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
  declarerDir: string;
  dangling: string[];
}> = arbLayout.chain((layout) => {
  const declared = new Set([
    ...allPackages(layout).map((pkg) => pkg.name),
    ...FRAMEWORK_NAMES,
  ]);

  return fc
    .uniqueArray(arbDanglingName, { minLength: 1, maxLength: 4 })
    .filter((names) => names.every((name) => !declared.has(name)))
    .chain((dangling) =>
      arbDeclarer(layout).map((declarer) => ({
        ...injectAt(layout, declarer, dangling),
        dangling: [...dangling].sort(),
      })),
    );
});

/** A `dependencies` key that is not an `@microservices` Dependency_Specifier. */
const arbUnscopedKey: fc.Arbitrary<string> = fc
  .oneof(
    arbDirName,
    arbDirName.map((name) => `@other/${name}`),
    // Near misses: the scope without its separator, without its `@`, and with
    // different case. None of them is an @microservices specifier.
    arbDirName.map((name) => `${WORKSPACE_SCOPE}x/${name}`),
    arbDirName.map((name) => `microservices/${name}`),
    arbDirName.map((name) => `@Microservices/${name}`),
    fc.constantFrom("express", "@types/node", "typescript", "vitest"),
  )
  .filter((key) => !key.startsWith(`${WORKSPACE_SCOPE}/`));

describe("Property 11: an unresolvable specifier fails with the preserved message", () => {
  it("throws [shared:unresolved] naming the declaring package and every unresolved specifier", () => {
    fc.assert(
      fc.property(
        arbDanglingCase,
        ({ layout, selected, declarerDir, dangling }) => {
          const message = messageOf(() => requiredOf(layout, selected));

          expect(message).toContain("[shared:unresolved]");
          expect(message).toContain(`"${declarerDir}"`);
          for (const name of dangling) {
            expect(message).toContain(`"${name}"`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("preserves the message byte for byte, with the specifiers deduplicated and sorted", () => {
    fc.assert(
      fc.property(
        arbDanglingCase,
        ({ layout, selected, declarerDir, dangling }) => {
          const message = messageOf(() => requiredOf(layout, selected));
          const named = dangling.map((name) => `"${name}"`).join(", ");

          // R13.11: this string is the pinned operator-facing contract, kept
          // identical to the one shared-packages.ts produced — same `[shared:`
          // prefix, same wording, same quoting.
          expect(message).toBe(
            `[shared:unresolved] "${declarerDir}" depends on unknown ${WORKSPACE_SCOPE} package(s): ${named}`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("Property 11: non-@microservices dependencies keys are ignored", () => {
  it("leaves the Required_Dependencies unchanged when every consumer declares arbitrary unscoped keys", () => {
    fc.assert(
      fc.property(
        arbLayoutAndSelection,
        fc.uniqueArray(arbUnscopedKey, { minLength: 1, maxLength: 5 }),
        ({ layout, selected }, unscoped) => {
          const injected = withExtraSpecifiersEverywhere(layout, unscoped);

          // Ignored without any attempt to resolve them and without failing.
          expect(
            requiredOf(injected, selected).map((pkg) => pkg.packageDir),
          ).toEqual(requiredOf(layout, selected).map((pkg) => pkg.packageDir));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("leaves the unresolved-specifier failure unchanged when unscoped keys are added", () => {
    fc.assert(
      fc.property(
        arbDanglingCase,
        fc.uniqueArray(arbUnscopedKey, { minLength: 1, maxLength: 5 }),
        ({ layout, selected, declarerDir, dangling }, unscoped) => {
          const injected = withExtraSpecifiersEverywhere(layout, unscoped);
          const named = dangling.map((name) => `"${name}"`).join(", ");

          expect(messageOf(() => requiredOf(injected, selected))).toBe(
            `[shared:unresolved] "${declarerDir}" depends on unknown ${WORKSPACE_SCOPE} package(s): ${named}`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12 — the Required_Dependencies equals the reachability oracle
// ---------------------------------------------------------------------------
//
// Validates: Requirements 7.1, 8.12

describe("Property 12: the Required_Dependencies equals the reachability oracle", () => {
  it("equals the oracle for any Selector and dependency graph (completeness + minimality)", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const required = requiredOf(layout, selected);
        const members = new Set(required.map((pkg) => pkg.name));

        // Completeness: nothing reachable is missing.
        // Minimality: nothing unreachable is present.
        expect(members).toEqual(referenceRequired(layout, selected));

        // Each member appears exactly once, and is a discovered package rather
        // than a value the resolver invented.
        expect(required.length).toBe(members.size);
        const byName = discoveryOf(layout).byName;
        for (const pkg of required) {
          expect(byName.get(pkg.name)).toBe(pkg);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("excludes the Selected_Microservices, every Microservice_Package, and the Overseer", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const required = requiredOf(layout, selected);

        for (const pkg of required) {
          expect(pkg.category).not.toBe("microservice");
        }
        const members = new Set(required.map((pkg) => pkg.dirName));
        for (const dirName of selected) {
          expect(members.has(dirName)).toBe(false);
        }
        expect(members.has(OVERSEER.dirName)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("stages nothing beyond the Overseer's own required dependencies when no microservice is selected", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const members = new Set(requiredOf(layout, []).map((pkg) => pkg.name));
        expect(members).toEqual(referenceRequired(layout, []));
      }),
      { numRuns: 200 },
    );
  });

  it("unions every single-microservice result when every microservice is selected", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const allIds = layout.microservices.map((pkg) => pkg.dirName);
        const all = new Set(requiredOf(layout, allIds).map((pkg) => pkg.name));

        // The empty-Selector result (the Overseer's own required dependencies)
        // is part of every Selector's result, so it seeds the union.
        const union = new Set(requiredOf(layout, []).map((pkg) => pkg.name));
        for (const id of allIds) {
          for (const pkg of requiredOf(layout, [id])) union.add(pkg.name);
        }

        expect(all).toEqual(union);
        expect(all).toEqual(referenceRequired(layout, allIds));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13 — the Required_Dependencies is the lexicographically-least topological order
// ---------------------------------------------------------------------------
//
// Validates: Requirements 7.2

describe("Property 13: the Required_Dependencies is the lexicographically-least topological order", () => {
  it("equals the Kahn-with-sorted-ready-queue oracle element for element", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        expect(
          requiredOf(layout, selected).map((pkg) => pkg.packageDir),
        ).toEqual(
          referenceOrder(layout, selected).map((pkg) => pkg.packageDir),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("places every package before each package whose specifier resolves to it", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const required = requiredOf(layout, selected);
        const position = new Map(required.map((pkg, i) => [pkg.name, i]));

        for (const pkg of required) {
          for (const specifier of pkg.dependencySpecifiers) {
            if (!position.has(specifier)) continue;
            expect(position.get(specifier)!).toBeLessThan(
              position.get(pkg.name)!,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // R7.2's second clause — "packages having no dependency relation to each other
  // appear in lexicographic order of directory name" — cannot be read as a claim
  // about every unrelated pair: no topological order satisfies that reading. Take
  // members `a` (depending on `z`), `z`, and `m`, all pairs but (a, z) unrelated:
  // the pairwise reading demands a < m, m < z and z < a at once. The realizable
  // reading, and the one the implementation and the oracle above share, is the
  // ready-queue one asserted here — among the packages that *could* be emitted at
  // a given step, the least by directory name is the one emitted. Applied at
  // every step that is exactly the lexicographically-least topological order.
  it("emits, at every step, the lexicographically least package whose dependencies are already emitted", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const required = requiredOf(layout, selected);
        const memberNames = new Set(required.map((pkg) => pkg.name));

        const emitted = new Set<string>();
        for (const [i, next] of required.entries()) {
          const ready = required
            .slice(i)
            .filter((pkg) =>
              pkg.dependencySpecifiers.every(
                (specifier) =>
                  !memberNames.has(specifier) || emitted.has(specifier),
              ),
            )
            .sort(compareOrderKey);

          expect(ready.length).toBeGreaterThan(0);
          expect(next.packageDir).toBe(ready[0].packageDir);
          emitted.add(next.name);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns an identical list for repeated runs over unchanged input", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        expect(requiredOf(layout, selected)).toEqual(
          requiredOf(layout, selected),
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14 — a dependency cycle fails, naming every participant
// ---------------------------------------------------------------------------
//
// Cycles of length 1 through k are injected into an otherwise acyclic layout:
// the chosen participants have their specifiers *replaced* by the single next
// participant, so the chain is the only cycle in the graph and the reported
// participant list can be compared exactly. The first microservice is pointed at
// the chain's head and is the only Selected_Microservice, so the walk enters the
// cycle at a known package.
//
// Validates: Requirements 7.10

// A cycle can only form AMONG Common_Packages: with the inbound-SPA edges now
// rejected, a Spa_Package is a traversal leaf (its outbound edges are cut before
// any cycle could close), so a chain touching a Spa_Package fails as
// `[deps:common-to-spa]` / `[deps:spa-to-spa]` rather than `[deps:cycle]`. The
// chain is therefore drawn from the `common` libraries only, over a layout
// guaranteed to hold at least one of them.
const arbLayoutWithCommon: fc.Arbitrary<Layout> = arbLayout.filter((layout) =>
  layout.libraries.some((pkg) => pkg.category === "common"),
);

const arbCycleCase: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
  chain: ConsumerPackage[];
}> = arbLayoutWithCommon.chain((layout) => {
  const commonLibraries = layout.libraries.filter(
    (pkg) => pkg.category === "common",
  );
  return fc
    .shuffledSubarray([...commonLibraries], {
      minLength: 1,
      maxLength: Math.min(4, commonLibraries.length),
    })
    .map((chain) => {
      // Each participant depends on exactly the next one, wrapping around: a
      // one-element chain becomes a self-dependency.
      let cyclic = layout;
      chain.forEach((pkg, i) => {
        cyclic = withPackageSpecifiers(cyclic, pkg.packageDir, [
          chain[(i + 1) % chain.length].name,
        ]);
      });

      const entryPoint = layout.microservices[0];
      cyclic = withPackageSpecifiers(cyclic, entryPoint.packageDir, [
        chain[0].name,
      ]);

      return { layout: cyclic, selected: [entryPoint.dirName], chain };
    });
});

describe("Property 14: a dependency cycle fails, naming every participant", () => {
  it("throws [deps:cycle] naming exactly the participants, in cycle order", () => {
    fc.assert(
      fc.property(arbCycleCase, ({ layout, selected, chain }) => {
        const message = messageOf(() => requiredOf(layout, selected));

        const path = chain
          .map((pkg) => `"${pkg.name}"`)
          .concat(`"${chain[0].name}"`)
          .join(" -> ");
        expect(message).toBe(
          `[deps:cycle] the ${WORKSPACE_SCOPE} dependency graph contains a cycle: ${path}`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("names every participant and no non-participant", () => {
    fc.assert(
      fc.property(arbCycleCase, ({ layout, selected, chain }) => {
        const message = messageOf(() => requiredOf(layout, selected));
        const named = new Set(
          [...message.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
        );

        expect(named).toEqual(new Set(chain.map((pkg) => pkg.name)));

        // Length k + 1: every participant once, plus the entry point repeated to
        // close the cycle. A self-dependency reads `"a" -> "a"`.
        const path = message.slice(message.indexOf(": ") + 2).split(" -> ");
        expect(path.length).toBe(chain.length + 1);
        expect(path[0]).toBe(path[path.length - 1]);
      }),
      { numRuns: 200 },
    );
  });

  it("returns no Required_Dependencies at all, for cycles of any length", () => {
    fc.assert(
      fc.property(arbCycleCase, ({ layout, selected }) => {
        expect(() => requiredOf(layout, selected)).toThrow(/^\[deps:cycle\]/);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Peer dependencies
// ---------------------------------------------------------------------------
//
// A specifier resolving to a Microservice_Package is excluded from the
// Required_Dependencies
// per R7.1 and reported per R14.5: microservices are independent modules that
// may not depend on each other, so an edge into one is forbidden rather than
// merely ignored.
//
// Validates: Requirements 7.1, 14.5

const arbPeerCase: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
  declarerDir: string;
  peers: string[];
}> = arbLayout.chain((layout) =>
  fc
    .shuffledSubarray(
      layout.microservices.map((pkg) => pkg.name),
      { minLength: 1, maxLength: Math.min(3, layout.microservices.length) },
    )
    .chain((peers) =>
      arbDeclarer(layout).map((declarer) => ({
        ...injectAt(layout, declarer, peers),
        peers: [...peers].sort(),
      })),
    ),
);

describe("[deps:peer]: a specifier naming a Microservice_Package is forbidden", () => {
  it("throws naming the declaring package and the peer it depends on", () => {
    fc.assert(
      fc.property(arbPeerCase, ({ layout, selected, declarerDir, peers }) => {
        const message = messageOf(() => requiredOf(layout, selected));

        expect(message).toBe(
          `[deps:peer] "${declarerDir}" depends on Microservice_Package "${peers[0]}"; a Microservice_Package is never a dependency target`,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("reports the pinned unresolved-specifier failure first when a declarer has both", () => {
    fc.assert(
      fc.property(
        arbLayout.chain((layout) => {
          const declared = new Set([
            ...allPackages(layout).map((pkg) => pkg.name),
            ...FRAMEWORK_NAMES,
          ]);
          return fc
            .tuple(
              arbDanglingName.filter((name) => !declared.has(name)),
              fc.constantFrom(...layout.microservices.map((pkg) => pkg.name)),
              arbDeclarer(layout),
            )
            .map(([dangling, peer, declarer]) => ({
              ...injectAt(layout, declarer, [dangling, peer]),
              dangling,
            }));
        }),
        ({ layout, selected, declarerDir, dangling }) => {
          // R13.11 keeps the unresolved message the one a broken repository
          // reports, so it wins over the peer-dependency failure.
          expect(messageOf(() => requiredOf(layout, selected))).toBe(
            `[shared:unresolved] "${declarerDir}" depends on unknown ${WORKSPACE_SCOPE} package(s): "${dangling}"`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 28 — a forbidden inbound edge into a Spa_Package fails, naming the declarer and the remedy
// ---------------------------------------------------------------------------
//
// Two edges are forbidden regardless of the target's reachability: a
// Common_Package resolving a specifier to a Spa_Package (`[deps:common-to-spa]`,
// R8.13) and a Spa_Package resolving a specifier to another Spa_Package
// (`[deps:spa-to-spa]`, R9.11). A `microservice -> spa` or `overseer -> spa`
// edge is legal — only the two inbound-SPA edges above are rejected, and both
// are decided by the DECLARER's category.
//
// The base `arbLayout` is free of forbidden edges by construction (see
// `arbLibraryEarlierSubsets`), so it is the clean control: it must resolve
// without either failure. The failing cases are built on a bespoke layout with
// explicit categories — a Spa_Package target, a declarer of a chosen category,
// and a microservice reaching the declarer — so the reported message can be
// compared exactly.
//
// Feature: package-categories, Property 28: A forbidden inbound edge into a Spa_Package fails, naming the declarer and the remedy
//
// Validates: Requirements 8.13, 9.11

/**
 * A layout holding one Spa_Package target and one declarer of a chosen kind
 * (`common` or `spa`) that depends on that Spa_Package, plus one microservice
 * that depends on the declarer and is the sole Selected_Microservice, so the
 * walk reaches the declarer and resolves its forbidden specifier. The declarer
 * is placed *after* the target in the library list so the base DAG rule (a
 * library depends only on earlier entries) is respected once the edge exists.
 */
const arbInboundSpaCase: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
  declarerDir: string;
  targetDir: string;
  targetSpecifier: string;
  declarerKind: "common" | "spa";
}> = fc
  .record({
    targetDir: arbDirName,
    declarerDir: arbDirName,
    microserviceId: arbIdentifier,
    declarerKind: fc.constantFrom<"common" | "spa">("common", "spa"),
    overseerExtra: fc.boolean(),
  })
  .filter(
    ({ targetDir, declarerDir, microserviceId }) =>
      // Distinct directory names, and none colliding with a Framework_Singleton
      // directory (which would make the specifier resolve to the framework).
      targetDir !== declarerDir &&
      microserviceId !== targetDir &&
      microserviceId !== declarerDir &&
      !FRAMEWORK_DIR_NAMES.includes(targetDir) &&
      !FRAMEWORK_DIR_NAMES.includes(declarerDir) &&
      !FRAMEWORK_DIR_NAMES.includes(microserviceId),
  )
  .map(({ targetDir, declarerDir, microserviceId, declarerKind, overseerExtra }) => {
    const targetName = `${WORKSPACE_SCOPE}/${targetDir}`;
    const declarerName = `${WORKSPACE_SCOPE}/${declarerDir}`;
    const target = consumerPackage("spa", targetDir, targetName, []);
    // The declarer resolves a specifier to the Spa_Package target: a common
    // declarer trips [deps:common-to-spa], a spa declarer trips [deps:spa-to-spa].
    const declarer = consumerPackage(declarerKind, declarerDir, declarerName, [
      targetName,
    ]);
    const microservice = consumerPackage(
      "microservice",
      microserviceId,
      `${WORKSPACE_SCOPE}/${microserviceId}`,
      [declarerName],
    );
    const layout: Layout = {
      libraries: [target, declarer],
      microservices: [microservice],
      // Optionally also reach the declarer from the Overseer; either way the
      // walk resolves the declarer's forbidden specifier.
      overseerDeps: [
        ...new Set([
          CONTRACTS.name,
          ...(overseerExtra ? [declarerName] : []),
        ]),
      ].sort(),
    };
    return {
      layout,
      selected: [microserviceId],
      declarerDir: declarer.packageDir,
      targetDir: target.packageDir,
      targetSpecifier: targetName,
      declarerKind,
    };
  });

describe("Property 28: a forbidden inbound edge into a Spa_Package fails, naming the declarer and the remedy", () => {
  it("fails with [deps:common-to-spa] naming the Common_Package and the offending specifier", () => {
    fc.assert(
      fc.property(
        arbInboundSpaCase.filter((c) => c.declarerKind === "common"),
        ({ layout, selected, declarerDir, targetSpecifier }) => {
          const message = messageOf(() => requiredOf(layout, selected));
          expect(message).toBe(
            `[deps:common-to-spa] Common_Package "${declarerDir}" depends on Spa_Package "${targetSpecifier}"; a Common_Package must point downward only and a Spa_Package exposes no importable API`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("fails with [deps:spa-to-spa] naming both Spa_Package directories and the Common_Package remedy", () => {
    fc.assert(
      fc.property(
        arbInboundSpaCase.filter((c) => c.declarerKind === "spa"),
        ({ layout, selected, declarerDir, targetDir }) => {
          const message = messageOf(() => requiredOf(layout, selected));
          expect(message).toBe(
            `[deps:spa-to-spa] Spa_Package "${declarerDir}" depends on Spa_Package "${targetDir}"; code shared between two Spa_Packages belongs in a Common_Package that each of them declares a dependency on`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns no Required_Dependencies when a forbidden inbound-SPA edge exists", () => {
    fc.assert(
      fc.property(arbInboundSpaCase, ({ layout, selected }) => {
        expect(() => requiredOf(layout, selected)).toThrow(
          /^\[deps:(common-to-spa|spa-to-spa)\]/,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("fails exactly when at least one forbidden inbound-SPA edge is present", () => {
    fc.assert(
      fc.property(arbInboundSpaCase, ({ layout, selected, declarerKind }) => {
        // The injected layout always carries exactly one forbidden edge, so
        // resolution must fail with the matching message.
        const prefix =
          declarerKind === "common"
            ? "[deps:common-to-spa]"
            : "[deps:spa-to-spa]";
        expect(messageOf(() => requiredOf(layout, selected))).toContain(prefix);

        // Removing the forbidden edge (the declarer now names nothing) makes the
        // very same layout resolve cleanly: the edge, not the layout shape, is
        // the fault.
        const cleaned = withPackageSpecifiers(layout, declarerKind === "common"
          ? layout.libraries.find((p) => p.category === "common")!.packageDir
          : layout.libraries.filter((p) => p.category === "spa")[1].packageDir,
          [],
        );
        expect(() => requiredOf(cleaned, selected)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it("resolves a clean layout (Common and Spa naming only third-party, Framework_Singletons, and Common_Packages) without either failure", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        // The base generator never produces a common->spa or spa->spa edge, so
        // neither forbidden-edge failure can fire.
        expect(() => requiredOf(layout, selected)).not.toThrow(
          /^\[deps:(common-to-spa|spa-to-spa)\]/,
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 29 — a Microservice_Package is never a dependency target, whatever the declarer
// ---------------------------------------------------------------------------
//
// The declarer's category is varied across all four kinds that can declare a
// specifier resolving to a Microservice_Package — a peer Microservice_Package, a
// Common_Package, a Spa_Package, and the Overseer — and every one must fail with
// the SAME `[deps:peer]` wording: the message names the declarer's repo-relative
// directory and the offending specifier and attributes NO Package_Category to
// the declarer, so one sentence is correct for all four (R7.12). The old clause
// "microservices may not depend on each other" was false for the three
// non-microservice declarers; this property pins that it is gone.
//
// The declarer of each kind is placed so the walk reaches it and resolves the
// peer specifier: a common/spa declarer is reached by a microservice pointed at
// it; a peer-microservice declarer is the sole Selected_Microservice; the
// Overseer is a root under every Selector.
//
// Feature: package-categories, Property 29: A Microservice_Package is never a dependency target, whatever the declarer
//
// Validates: Requirements 7.12, 14.5

type DeclarerKind = "microservice" | "common" | "spa" | "overseer";

/**
 * A layout with a Microservice_Package `victim` that some declarer of a chosen
 * kind names as a dependency, plus the Selector that makes the walk reach that
 * declarer. Every case declares exactly one peer specifier, so the reported
 * message is exact.
 */
const arbPeerDeclarerCase: fc.Arbitrary<{
  layout: Layout;
  selected: string[];
  declarerDir: string;
  peerSpecifier: string;
}> = fc
  .record({
    victimId: arbIdentifier,
    declarerDir: arbDirName,
    otherId: arbIdentifier,
    kind: fc.constantFrom<DeclarerKind>(
      "microservice",
      "common",
      "spa",
      "overseer",
    ),
  })
  .filter(
    ({ victimId, declarerDir, otherId }) =>
      victimId !== otherId &&
      victimId !== declarerDir &&
      otherId !== declarerDir &&
      ![victimId, otherId, declarerDir].some((n) =>
        FRAMEWORK_DIR_NAMES.includes(n),
      ),
  )
  .map(({ victimId, declarerDir, otherId, kind }) => {
    const peerSpecifier = `${WORKSPACE_SCOPE}/${victimId}`;
    const victim = consumerPackage("microservice", victimId, peerSpecifier, []);

    if (kind === "microservice") {
      // A peer microservice declares the victim; it is the sole selection so
      // the walk resolves its specifiers.
      const declarer = consumerPackage(
        "microservice",
        declarerDir,
        `${WORKSPACE_SCOPE}/${declarerDir}`,
        [peerSpecifier],
      );
      return {
        layout: {
          libraries: [],
          microservices: [victim, declarer],
          overseerDeps: [CONTRACTS.name],
        },
        selected: [declarer.dirName],
        declarerDir: declarer.packageDir,
        peerSpecifier,
      };
    }

    if (kind === "overseer") {
      return {
        layout: {
          libraries: [],
          microservices: [victim],
          overseerDeps: [...new Set([CONTRACTS.name, peerSpecifier])].sort(),
        },
        // The Overseer is a root under every Selector; select the victim too.
        selected: [victim.dirName],
        declarerDir: OVERSEER.packageDir,
        peerSpecifier,
      };
    }

    // A common or spa declarer names the victim; a microservice points at the
    // declarer and is the sole selection so the declarer is reached.
    const declarer = consumerPackage(
      kind,
      declarerDir,
      `${WORKSPACE_SCOPE}/${declarerDir}`,
      [peerSpecifier],
    );
    const entry = consumerPackage(
      "microservice",
      otherId,
      `${WORKSPACE_SCOPE}/${otherId}`,
      [declarer.name],
    );
    return {
      layout: {
        libraries: [declarer],
        microservices: [victim, entry],
        overseerDeps: [CONTRACTS.name],
      },
      selected: [entry.dirName],
      declarerDir: declarer.packageDir,
      peerSpecifier,
    };
  });

describe("Property 29: a Microservice_Package is never a dependency target, whatever the declarer", () => {
  it("fails with the identical [deps:peer] wording for every declarer kind", () => {
    fc.assert(
      fc.property(
        arbPeerDeclarerCase,
        ({ layout, selected, declarerDir, peerSpecifier }) => {
          const message = messageOf(() => requiredOf(layout, selected));

          // One sentence, naming the declarer's directory and the specifier,
          // with NO Package_Category for the declarer — correct for all four
          // declarer kinds (R7.12).
          expect(message).toBe(
            `[deps:peer] "${declarerDir}" depends on Microservice_Package "${peerSpecifier}"; a Microservice_Package is never a dependency target`,
          );

          // The declarer's own category never appears in the message, so the
          // one wording cannot have been specialised per declarer kind.
          expect(message).not.toContain("Common_Package");
          expect(message).not.toContain("Spa_Package");
          expect(message).not.toContain("microservices may not depend");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns no Required_Dependencies whatever the declarer kind", () => {
    fc.assert(
      fc.property(arbPeerDeclarerCase, ({ layout, selected }) => {
        expect(() => requiredOf(layout, selected)).toThrow(/^\[deps:peer\]/);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 31 — the Staged_Dependencies equal the SPA-cut reachability oracle
// ---------------------------------------------------------------------------
//
// The Staged_Dependencies (`resolveDependencySets(...).staged`) are the
// discovered Consumer_Packages reachable from the Selected_Microservices and the
// Overseer under the RESTRICTED edge relation that follows every specifier of a
// root and of every reached non-Spa_Package, but follows no specifier a
// Spa_Package declares (R7.14, R9.12). So a reached Spa_Package is arrived at
// and staged, a Common_Package reachable only via a Spa_Package is NOT staged,
// and a Common_Package reachable both via a Spa_Package and by a path expanding
// no Spa_Package IS staged.
//
// The oracle below is an independently written restricted-reachability walk over
// the generated layout — a disjunction over reaching paths, not a flag threaded
// through a single traversal — and the assertion compares `staged` against it as
// a set and confirms `staged` is a subsequence of `required` (so the order is
// inherited, R7.13).
//
// Feature: package-categories, Property 31: The Staged_Dependencies equal the SPA-cut reachability oracle
//
// Validates: Requirements 7.14, 9.12

/** `resolveDependencySets(...).staged` for a layout and a Selector. */
function stagedOf(
  layout: Layout,
  selected: readonly string[],
): readonly ConsumerPackage[] {
  return resolveDependencySets(selected, discoveryOf(layout), readerFor(layout))
    .staged;
}

/**
 * The SPA-cut reachability oracle — the set of discovered Consumer_Package names
 * reachable from the roots' specifiers where a Spa_Package is arrived at but
 * never expanded. Independent of `stagedSubset`: a plain worklist that simply
 * skips enqueuing the edges of any reached Spa_Package.
 */
function referenceStaged(
  layout: Layout,
  selected: readonly string[],
): Set<string> {
  const byName = new Map(allPackages(layout).map((pkg) => [pkg.name, pkg]));

  const seed: string[] = [...layout.overseerDeps];
  for (const dirName of selected) {
    const microservice = layout.microservices.find(
      (pkg) => pkg.dirName === dirName,
    );
    seed.push(...(microservice?.dependencySpecifiers ?? []));
  }

  const reached = new Set<string>();
  const queue = [...seed];
  while (queue.length > 0) {
    const specifier = queue.shift()!;
    if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) continue;
    if (FRAMEWORK_NAMES.includes(specifier)) continue;
    const pkg = byName.get(specifier);
    // A microservice specifier is a peer failure and never reached here; the
    // generator below keeps roots pointing only at libraries.
    if (pkg === undefined || pkg.category === "microservice") continue;
    if (reached.has(specifier)) continue;
    reached.add(specifier);
    // Arrive at a Spa_Package but do not expand it — its edges are cut.
    if (pkg.category !== "spa") {
      queue.push(...pkg.dependencySpecifiers);
    }
  }
  return reached;
}

describe("Property 31: the Staged_Dependencies equal the SPA-cut reachability oracle", () => {
  it("equals the restricted-reachability oracle as a set, over any layout and Selector", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const staged = stagedOf(layout, selected);
        expect(new Set(staged.map((pkg) => pkg.name))).toEqual(
          referenceStaged(layout, selected),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("is a subsequence of the Required_Dependencies, inheriting their order", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const required = requiredOf(layout, selected).map((pkg) => pkg.name);
        const staged = stagedOf(layout, selected).map((pkg) => pkg.name);

        // Every staged member is required, and staged reads left-to-right in
        // the same relative order as required (a subsequence).
        let cursor = 0;
        for (const name of staged) {
          const at = required.indexOf(name, cursor);
          expect(at).toBeGreaterThanOrEqual(0);
          cursor = at + 1;
        }
      }),
      { numRuns: 200 },
    );
  });

  it("excludes a Common_Package reachable only via a Spa_Package, includes one also reachable by a non-SPA path, and includes a required Spa_Package", () => {
    // A hand-built layout exercising all three oracle clauses at once:
    //   deep   (common) — reached ONLY through the Spa_Package -> excluded
    //   both   (common) — reached via the Spa_Package AND directly -> included
    //   ui     (spa)    — depends on deep and both; itself reached -> included
    // A microservice depends on ui and on both directly.
    const deep = consumerPackage(
      "common",
      "deep",
      `${WORKSPACE_SCOPE}/deep`,
      [],
    );
    const both = consumerPackage(
      "common",
      "both",
      `${WORKSPACE_SCOPE}/both`,
      [],
    );
    const ui = consumerPackage("spa", "ui", `${WORKSPACE_SCOPE}/ui`, [
      deep.name,
      both.name,
    ]);
    const service = consumerPackage(
      "microservice",
      "svc",
      `${WORKSPACE_SCOPE}/svc`,
      [ui.name, both.name],
    );
    const layout: Layout = {
      libraries: [deep, both, ui],
      microservices: [service],
      overseerDeps: [CONTRACTS.name],
    };

    const staged = new Set(
      stagedOf(layout, ["svc"]).map((pkg) => pkg.name),
    );
    const required = new Set(
      requiredOf(layout, ["svc"]).map((pkg) => pkg.name),
    );

    // Required follows every edge, so all three libraries are required.
    expect(required).toEqual(new Set([deep.name, both.name, ui.name]));

    // Staged cuts the SPA's edges: `deep` is reachable only through `ui` and is
    // dropped; `both` is reachable directly and stays; `ui` is arrived at and
    // stays.
    expect(staged).toEqual(new Set([both.name, ui.name]));
    expect(staged.has(deep.name)).toBe(false);
    expect(staged.has(ui.name)).toBe(true);
    expect(staged.has(both.name)).toBe(true);
  });

  it("is identical across repeated runs and independent of root/specifier visit order", () => {
    fc.assert(
      fc.property(arbLayoutAndSelection, ({ layout, selected }) => {
        const once = stagedOf(layout, selected).map((pkg) => pkg.packageDir);

        // Repeated run over unchanged input: identical element for element.
        expect(stagedOf(layout, selected).map((pkg) => pkg.packageDir)).toEqual(
          once,
        );

        // Permuting the Selector order and every consumer's specifier order
        // changes neither the staged set nor its order — reachability under the
        // restricted relation is a disjunction over paths, not a visit-order
        // accident.
        const permuted: Layout = {
          libraries: layout.libraries.map((pkg) => ({
            ...pkg,
            dependencySpecifiers: [...pkg.dependencySpecifiers].reverse(),
          })),
          microservices: layout.microservices.map((pkg) => ({
            ...pkg,
            dependencySpecifiers: [...pkg.dependencySpecifiers].reverse(),
          })),
          overseerDeps: [...layout.overseerDeps].reverse(),
        };
        expect(
          stagedOf(permuted, [...selected].reverse()).map(
            (pkg) => pkg.packageDir,
          ),
        ).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});

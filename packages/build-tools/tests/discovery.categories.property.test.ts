// Feature: package-categories, Property 1: Location determines Package_Category, exactly once
// Feature: package-categories, Property 2: Manifest fields cannot change a category or a staged set
//
// Both properties are exercised through `discoverPackagesFrom(listContainer,
// readManifest)` — the pure core of Package_Discovery — over generated
// in-memory repository layouts: any set of Namespace_Container entries with any
// manifests, alongside the four Framework_Singleton directories.
//
// The oracles below are written from the requirements, not from `discovery.ts`:
//
// - `referenceMembers` restates R2.4/R2.5 ("a direct entry qualifies when it
//   resolves to a directory and its name does not begin with `.`", ordered by
//   ascending code point of directory name") over the generated layout.
// - `categoriesFromLocation` restates R1.3 independently of the layout, by
//   asking which Namespace_Containers a reported `packageDir` is a *direct*
//   subdirectory of. R1.1's "exactly one" is then the assertion that the answer
//   is a single category and that it is the one discovery reported.
// - `referenceStaged` restates R7.1/R7.3 (the Selector-justified staged set)
//   straight from the generated manifests, reading `dependencies` keys itself.
//   It never touches `Discovery`, so Property 2's staged-set claim is checked
//   along a second path rather than restated from the first. `stagedFromDiscovery`
//   is the same set derived from the discovery result, cross-checked against it.
//
// The Dependency_Resolver and the Image_Assembler are not in scope here: this file
// derives the staged set with its own reachability walk so that Property 2 stays
// inside Package_Discovery's boundary. Required-dependency ordering, cycles, and the real
// staging are Properties 12–14 and 19–22.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6, 2.8, 2.9, 2.10, 5.1, 5.2

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  ALWAYS_STAGED_SCOPED_ENTRIES,
  CONSUMER_CATEGORIES,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  PACKAGES_DIR,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";
import {
  discoverPackagesFrom,
  type ContainerEntry,
  type Discovery,
  type ListContainer,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";

// ---------------------------------------------------------------------------
// In-memory layout model
// ---------------------------------------------------------------------------

/** A manifest under construction: arbitrary parsed JSON, as on disk. */
type Manifest = Record<string, unknown>;

/** One generated Consumer_Package: where it sits, what it declares. */
interface PackageSpec {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  readonly packageDir: string;
  /** The `name` its manifest declares. */
  readonly name: string;
  /** `@microservices`-scoped specifiers it declares, each resolvable. */
  readonly deps: readonly string[];
  readonly manifest: Manifest;
}

/**
 * A generated repository layout. `absent` names the consumer containers whose
 * directory does not exist (only `common` and `spa` — an absent
 * `packages/microservices/` is Property 4's subject).
 */
interface Layout {
  readonly packages: readonly PackageSpec[];
  readonly noise: Readonly<Record<ConsumerCategory, readonly ContainerEntry[]>>;
  readonly absent: readonly ConsumerCategory[];
  /** The Overseer's `@microservices`-scoped specifiers. */
  readonly overseerDeps: readonly string[];
}

/** Non-package entries a container may hold: files, and dot-prefixed names. */
const NOISE_ENTRIES: readonly ContainerEntry[] = [
  { name: "README.md", isDirectory: false },
  { name: "tsconfig.json", isDirectory: false },
  { name: ".DS_Store", isDirectory: false },
  { name: ".cache", isDirectory: true },
  { name: ".scratch-pkg", isDirectory: true },
];

const FRAMEWORK_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.name,
);
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);
const FRAMEWORK_PACKAGE_DIRS: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.packageDir,
);

/** Ascending code-point comparison, the order R2.5 requires. */
function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Injected readers over a layout
// ---------------------------------------------------------------------------

/** Reverse lookup of {@link NAMESPACE_CONTAINER}. */
function categoryOfContainer(
  containerDir: string,
): ConsumerCategory | undefined {
  return CONSUMER_CATEGORIES.find(
    (category) => NAMESPACE_CONTAINER[category] === containerDir,
  );
}

/**
 * A container lister over a layout, recording every path it is asked about.
 * Entries are handed back in *descending* name order so that any ordering in
 * the result is discovery's own doing and not the lister's.
 */
function listerFor(layout: Layout, asked: string[]): ListContainer {
  return (containerDir) => {
    asked.push(containerDir);
    const category = categoryOfContainer(containerDir);
    if (category === undefined || layout.absent.includes(category)) {
      return undefined;
    }
    return [
      ...layout.packages
        .filter((pkg) => pkg.category === category)
        .map((pkg) => ({ name: pkg.dirName, isDirectory: true })),
      ...layout.noise[category],
    ].sort((a, b) => ascending(b.name, a.name));
  };
}

/**
 * A manifest reader over a layout, recording every directory it is asked about.
 * The four Framework_Singleton directories are *present* in the map and each
 * declares a full barrel, so R2.10 has something to bite on: if location-based
 * discovery ever reached for a framework manifest, that manifest would qualify
 * under the old manifest-shape rule.
 */
function readerFor(layout: Layout, read: string[]): ReadManifest {
  const byDir = new Map<string, Manifest>(
    layout.packages.map((pkg) => [pkg.packageDir, pkg.manifest]),
  );
  for (const singleton of FRAMEWORK_SINGLETONS) {
    byDir.set(singleton.packageDir, {
      name: singleton.name,
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
  }
  return (packageDir) => {
    read.push(packageDir);
    const manifest = byDir.get(packageDir);
    return manifest === undefined
      ? { kind: "absent" }
      : { kind: "ok", manifest: manifest as PackageManifest };
  };
}

// ---------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------

/**
 * The qualifying direct entries of each container, in the order R2.5 requires.
 * Derived from the layout: an entry qualifies when it resolves to a directory
 * and its name does not begin with `.` (R2.4); an absent container yields none.
 */
function referenceMembers(
  layout: Layout,
): Record<ConsumerCategory, readonly string[]> {
  const members: Partial<Record<ConsumerCategory, readonly string[]>> = {};
  for (const category of CONSUMER_CATEGORIES) {
    if (layout.absent.includes(category)) {
      members[category] = [];
      continue;
    }
    const entries: ContainerEntry[] = [
      ...layout.packages
        .filter((pkg) => pkg.category === category)
        .map((pkg) => ({ name: pkg.dirName, isDirectory: true })),
      ...layout.noise[category],
    ];
    members[category] = entries
      .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort(ascending);
  }
  return members as Record<ConsumerCategory, readonly string[]>;
}

/**
 * The Consumer_Categories a repo-relative package directory belongs to purely
 * by location (R1.3): those whose Namespace_Container it is a *direct*
 * subdirectory of. R1.1 requires this to be exactly one for every discovered
 * package; a path nested deeper belongs to none.
 */
function categoriesFromLocation(packageDir: string): ConsumerCategory[] {
  return CONSUMER_CATEGORIES.filter((category) => {
    const prefix = `${NAMESPACE_CONTAINER[category]}/`;
    return (
      packageDir.startsWith(prefix) &&
      packageDir.slice(prefix.length).length > 0 &&
      !packageDir.slice(prefix.length).includes("/")
    );
  });
}

/** The `@microservices`-scoped keys of a raw manifest, as the requirements define them. */
function scopedKeysOf(manifest: Manifest): string[] {
  const dependencies = manifest.dependencies;
  if (dependencies === null || typeof dependencies !== "object") return [];
  return Object.keys(dependencies).filter((key) =>
    key.startsWith(`${WORKSPACE_SCOPE}/`),
  );
}

/**
 * The Selector-justified staged package directories, computed from the layout's
 * raw manifests without consulting `Discovery` at all (R7.1, R7.3, R5.6): the
 * selected Microservice_Packages, every Common_Package and Spa_Package
 * transitively reachable from them and from the Overseer, the always-staged
 * Framework_Singletons, and the Overseer at its own package directory.
 */
function referenceStaged(
  layout: Layout,
  selectedDirs: readonly string[],
): string[] {
  const discovered = referenceMembers(layout);
  const live = layout.packages.filter((pkg) =>
    discovered[pkg.category].includes(pkg.dirName),
  );
  const byName = new Map<string, PackageSpec>(
    live.map((pkg) => [String(pkg.manifest.name), pkg]),
  );

  const selected = live.filter(
    (pkg) =>
      pkg.category === "microservice" && selectedDirs.includes(pkg.dirName),
  );

  const staged = new Set<string>([
    ...ALWAYS_STAGED_SCOPED_ENTRIES.map(
      (dirName) => `${PACKAGES_DIR}/${dirName}`,
    ),
    OVERSEER.packageDir,
    ...selected.map((pkg) => pkg.packageDir),
  ]);

  const pending = [
    ...layout.overseerDeps,
    ...selected.flatMap((pkg) => scopedKeysOf(pkg.manifest)),
  ];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const specifier = pending.pop();
    if (specifier === undefined || seen.has(specifier)) continue;
    seen.add(specifier);
    const target = byName.get(specifier);
    if (target === undefined) continue; // a framework name, or nothing
    if (target.category !== "microservice") staged.add(target.packageDir);
    pending.push(...scopedKeysOf(target.manifest));
  }

  return [...staged].sort(ascending);
}

/** The same staged set, derived from a discovery result instead. */
function stagedFromDiscovery(
  discovery: Discovery,
  selectedDirs: readonly string[],
  overseerDeps: readonly string[],
): string[] {
  const selected = discovery.byCategory.microservice.filter((pkg) =>
    selectedDirs.includes(pkg.dirName),
  );
  const staged = new Set<string>([
    ...ALWAYS_STAGED_SCOPED_ENTRIES.map(
      (dirName) => `${PACKAGES_DIR}/${dirName}`,
    ),
    OVERSEER.packageDir,
    ...selected.map((pkg) => pkg.packageDir),
  ]);

  const pending = [
    ...overseerDeps,
    ...selected.flatMap((pkg) => [...pkg.dependencySpecifiers]),
  ];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const specifier = pending.pop();
    if (specifier === undefined || seen.has(specifier)) continue;
    seen.add(specifier);
    const target = discovery.byName.get(specifier);
    if (target === undefined) continue;
    if (target.category !== "microservice") staged.add(target.packageDir);
    pending.push(...target.dependencySpecifiers);
  }

  return [...staged].sort(ascending);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Directory names to draw from; none of them is a Framework_Singleton directory. */
const DIR_POOL: readonly string[] = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "config",
  "admin",
  "portal",
  "auth",
  "billing",
  "Zed",
];

const UNSCOPED_DEP_POOL: readonly string[] = [
  "express",
  "vitest",
  "@types/node",
  "fast-check",
];

/** The raw draws a layout is built from; sizes are fixed so indices line up. */
const PLAN_SIZE = 8;

interface Plan {
  readonly dirs: readonly string[];
  readonly categories: readonly ConsumerCategory[];
  readonly depSeeds: readonly (readonly number[])[];
  readonly frameworkDep: readonly boolean[];
  readonly noiseSeeds: readonly (readonly ContainerEntry[])[];
  readonly absent: readonly ConsumerCategory[];
  readonly overseerDepSeeds: readonly number[];
  readonly selectorAll: boolean;
  readonly selectorSeeds: readonly number[];
}

const arbPlan: fc.Arbitrary<Plan> = fc.record({
  dirs: fc.uniqueArray(fc.constantFrom(...DIR_POOL), {
    minLength: 1,
    maxLength: PLAN_SIZE,
  }),
  categories: fc.array(
    fc.constantFrom<ConsumerCategory>("microservice", "common", "spa"),
    { minLength: PLAN_SIZE, maxLength: PLAN_SIZE },
  ),
  depSeeds: fc.array(fc.array(fc.nat({ max: 32 }), { maxLength: 3 }), {
    minLength: PLAN_SIZE,
    maxLength: PLAN_SIZE,
  }),
  frameworkDep: fc.array(fc.boolean(), {
    minLength: PLAN_SIZE,
    maxLength: PLAN_SIZE,
  }),
  noiseSeeds: fc.array(fc.subarray([...NOISE_ENTRIES]), {
    minLength: CONSUMER_CATEGORIES.length,
    maxLength: CONSUMER_CATEGORIES.length,
  }),
  absent: fc.subarray<ConsumerCategory>(["common", "spa"]),
  overseerDepSeeds: fc.array(fc.nat({ max: 32 }), { maxLength: 4 }),
  selectorAll: fc.boolean(),
  selectorSeeds: fc.array(fc.nat({ max: 32 }), { maxLength: 4 }),
});

/**
 * The base manifest of a package of `category`: valid for its category's
 * contract, so that the layout exercises classification rather than validation
 * (a Common_Package declares its barrel per R4.1, a Spa_Package its build
 * script per R4.3, a Microservice_Package neither by obligation).
 */
function baseManifest(
  category: ConsumerCategory,
  name: string,
  deps: readonly string[],
): Manifest {
  const dependencies: Record<string, string> = {};
  for (const dep of deps) dependencies[dep] = "*";

  const manifest: Manifest = { name, version: "0.0.0", dependencies };
  if (category === "common") {
    manifest.main = "./dist/index.js";
    manifest.types = "./dist/index.d.ts";
  }
  if (category === "spa") {
    manifest.scripts = { build: "vite build" };
  }
  return manifest;
}

/**
 * Realize a {@link Plan} as a layout. Dependency edges point only at *earlier*
 * Common_Packages and Spa_Packages, so every generated graph is acyclic, holds
 * no peer-Microservice_Package edge, and has no Common_Package pointing upward —
 * the graphs the repository invariants permit.
 */
function layoutOf(plan: Plan): { layout: Layout; selectedDirs: string[] } {
  const packages: PackageSpec[] = [];

  for (const [index, dirName] of plan.dirs.entries()) {
    const drawn = plan.categories[index];
    // A package cannot live in a container that does not exist.
    const category: ConsumerCategory = plan.absent.includes(drawn)
      ? "microservice"
      : drawn;

    // Every discovered Consumer_Package — Microservice_Packages included —
    // must declare a name that mirrors its directory exactly (R3.6, and R4.5
    // which now routes a Microservice_Package through the same mirroring check
    // rather than exempting it). A non-mirroring name throws `[discovery:mirror]`
    // before any property assertion runs, so the layout always mirrors.
    const name = `${WORKSPACE_SCOPE}/${dirName}`;

    // A library-to-library edge may only ever target a Common_Package: a
    // Common_Package is the sole downward target a library may name. The two
    // forbidden inbound-SPA edges — `common → spa` and `spa → spa` — throw at
    // the Dependency_Resolver (task 13.1), so a generator that emitted either
    // would poison the reachability oracles below. A Microservice_Package may
    // additionally name a Spa_Package (`microservice → spa` is legal), so its
    // targets include earlier Spa_Packages too.
    const targets = packages.filter((pkg) =>
      category === "microservice"
        ? pkg.category === "common" || pkg.category === "spa"
        : pkg.category === "common",
    );
    const deps = new Set<string>();
    for (const seed of plan.depSeeds[index]) {
      if (targets.length > 0) deps.add(targets[seed % targets.length].name);
    }
    if (plan.frameworkDep[index]) deps.add(`${WORKSPACE_SCOPE}/contracts`);

    packages.push({
      category,
      dirName,
      packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
      name,
      deps: [...deps],
      manifest: baseManifest(category, name, [...deps]),
    });
  }

  const noise: Partial<Record<ConsumerCategory, readonly ContainerEntry[]>> =
    {};
  for (const [index, category] of CONSUMER_CATEGORIES.entries()) {
    noise[category] = plan.noiseSeeds[index];
  }

  const overseerTargets = packages.filter(
    (pkg) => pkg.category === "common" || pkg.category === "spa",
  );
  const overseerDeps = new Set<string>([`${WORKSPACE_SCOPE}/contracts`]);
  for (const seed of plan.overseerDepSeeds) {
    if (overseerTargets.length > 0) {
      overseerDeps.add(overseerTargets[seed % overseerTargets.length].name);
    }
  }

  const microserviceDirs = packages
    .filter((pkg) => pkg.category === "microservice")
    .map((pkg) => pkg.dirName);
  const selectedDirs = plan.selectorAll
    ? microserviceDirs
    : [
        ...new Set(
          plan.selectorSeeds.flatMap((seed) =>
            microserviceDirs.length > 0
              ? [microserviceDirs[seed % microserviceDirs.length]]
              : [],
          ),
        ),
      ];

  return {
    layout: {
      packages,
      noise: noise as Record<ConsumerCategory, readonly ContainerEntry[]>,
      absent: plan.absent,
      overseerDeps: [...overseerDeps],
    },
    selectedDirs,
  };
}

const arbLayout: fc.Arbitrary<{ layout: Layout; selectedDirs: string[] }> =
  arbPlan.map(layoutOf);

// ---------------------------------------------------------------------------
// Manifest mutation (Property 2)
// ---------------------------------------------------------------------------

/**
 * A validity-preserving manifest mutation: it may add or drop `bin`, add
 * unscoped `dependencies` keys, reverse the order the scoped keys are written
 * in, add unrelated fields, and — where the category's contract permits it —
 * add, drop, or change `main`, `types`, and `scripts.build`.
 */
interface Mutation {
  readonly bin: "none" | "string" | "object";
  readonly unscopedDeps: readonly string[];
  readonly reverseDepOrder: boolean;
  readonly barrel: "add" | "drop" | "rewrite";
  readonly extraFields: boolean;
  readonly buildScript: "keep" | "rewrite";
}

const arbMutation: fc.Arbitrary<Mutation> = fc.record({
  bin: fc.constantFrom<Mutation["bin"]>("none", "string", "object"),
  unscopedDeps: fc.subarray([...UNSCOPED_DEP_POOL]),
  reverseDepOrder: fc.boolean(),
  barrel: fc.constantFrom<Mutation["barrel"]>("add", "drop", "rewrite"),
  extraFields: fc.boolean(),
  buildScript: fc.constantFrom<Mutation["buildScript"]>("keep", "rewrite"),
});

/**
 * Apply a mutation to one package's manifest, keeping the result valid for its
 * category: a Common_Package keeps a non-empty `main`/`types` pair (its values
 * may change), a Spa_Package keeps a non-empty `scripts.build`, and a
 * Microservice_Package may gain or lose `main`/`types` freely (R2.9).
 */
function mutateManifest(spec: PackageSpec, mutation: Mutation): Manifest {
  const scopedFirst = [...spec.deps];
  const keys = mutation.reverseDepOrder
    ? [...mutation.unscopedDeps, ...scopedFirst.reverse()]
    : [...scopedFirst, ...mutation.unscopedDeps];
  const dependencies: Record<string, string> = {};
  for (const key of keys) dependencies[key] = "*";

  const manifest: Manifest = {
    name: spec.name,
    version: "0.0.0",
    dependencies,
  };

  if (spec.category === "common") {
    // The barrel must stay declared; only its values may move (R4.1).
    manifest.main =
      mutation.barrel === "rewrite" ? "./lib/main.js" : "./dist/index.js";
    manifest.types =
      mutation.barrel === "rewrite" ? "./lib/main.d.ts" : "./dist/index.d.ts";
  } else if (mutation.barrel !== "drop") {
    manifest.main =
      mutation.barrel === "rewrite" ? "./lib/main.js" : "./dist/index.js";
    manifest.types =
      mutation.barrel === "rewrite" ? "./lib/main.d.ts" : "./dist/index.d.ts";
  }

  if (spec.category === "spa") {
    manifest.scripts = {
      build: mutation.buildScript === "rewrite" ? "rollup -c" : "vite build",
    };
  } else if (mutation.extraFields) {
    manifest.scripts = { build: "tsc", test: "vitest --run" };
  }

  if (mutation.bin === "string") manifest.bin = "./dist/cli.js";
  if (mutation.bin === "object") manifest.bin = { tool: "./dist/cli.js" };

  if (mutation.extraFields) {
    manifest.description = "generated";
    manifest.files = ["dist"];
    manifest.exports = { ".": "./dist/index.js" };
  }

  return manifest;
}

/** The same layout with every Consumer_Package manifest mutated. */
function mutateLayout(layout: Layout, mutations: readonly Mutation[]): Layout {
  return {
    ...layout,
    packages: layout.packages.map((spec, index) => ({
      ...spec,
      manifest: mutateManifest(spec, mutations[index % mutations.length]),
    })),
  };
}

/** Discovery over a layout, with the paths the readers were asked about. */
function discover(layout: Layout): {
  discovery: Discovery;
  asked: string[];
  read: string[];
} {
  const asked: string[] = [];
  const read: string[] = [];
  const discovery = discoverPackagesFrom(
    listerFor(layout, asked),
    readerFor(layout, read),
  );
  return { discovery, asked, read };
}

/** Every discovered package of every category. */
function allDiscovered(discovery: Discovery) {
  return CONSUMER_CATEGORIES.flatMap((category) => [
    ...discovery.byCategory[category],
  ]);
}

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

// Feature: package-categories, Property 1: Location determines Package_Category, exactly once
describe("Property 1: location determines Package_Category, exactly once", () => {
  it("assigns each package the category of the container holding it, and only that one", () => {
    fc.assert(
      fc.property(arbLayout, ({ layout }) => {
        const { discovery, asked, read } = discover(layout);
        const expected = referenceMembers(layout);

        // Each category holds exactly the qualifying entries of its own
        // container, in ascending code-point order (R1.3, R2.5).
        for (const category of CONSUMER_CATEGORIES) {
          expect(
            discovery.byCategory[category].map((pkg) => pkg.dirName),
          ).toEqual([...expected[category]]);
        }

        const discovered = allDiscovered(discovery);

        // Exactly one category per package, and it is the one location implies
        // (R1.1, R1.3). Checked against the path, independently of the layout.
        for (const pkg of discovered) {
          expect(categoriesFromLocation(pkg.packageDir)).toEqual([
            pkg.category,
          ]);
          expect(pkg.packageDir).toBe(
            `${NAMESPACE_CONTAINER[pkg.category]}/${pkg.dirName}`,
          );
        }

        // No package is assigned two categories: every packageDir occurs once
        // across the whole discovered set (R1.1).
        const dirs = discovered.map((pkg) => pkg.packageDir);
        expect(new Set(dirs).size).toBe(dirs.length);

        // No discovered Consumer_Package is a Framework_Singleton, by name or
        // by directory (R1.6, R5.2).
        for (const pkg of discovered) {
          expect(FRAMEWORK_NAMES).not.toContain(pkg.name);
          expect(FRAMEWORK_PACKAGE_DIRS).not.toContain(pkg.packageDir);
        }

        // Framework membership is decided by name in the
        // Framework_Constants_Module, never by discovery: the only directories
        // discovery enumerates are the three Namespace_Containers, so no
        // framework directory is ever a candidate and no framework manifest is
        // ever read — even though each declares a full barrel (R1.2, R2.10,
        // R5.1).
        expect(new Set(asked)).toEqual(
          new Set(CONSUMER_CATEGORIES.map((c) => NAMESPACE_CONTAINER[c])),
        );
        for (const packageDir of FRAMEWORK_PACKAGE_DIRS) {
          expect(read).not.toContain(packageDir);
        }

        // The Package_Name_Lookup covers exactly the discovered packages, and
        // `byName` is the injective index over their declared names (R3.1).
        expect([...discovery.nameByDir.keys()].sort(ascending)).toEqual(
          dirs.slice().sort(ascending),
        );
        expect(discovery.byName.size).toBe(discovered.length);
      }),
      { numRuns: 200 },
    );
  });

  it("never admits a container entry as a Framework_Singleton, however it is named", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.constantFrom(...CONSUMER_CATEGORIES),
        fc.constantFrom(...FRAMEWORK_DIR_NAMES),
        fc.boolean(),
        ({ layout }, category, frameworkDir, useFrameworkDir) => {
          if (layout.absent.includes(category)) return;

          // An intruder in one of the containers, in every category including
          // microservice. It always declares a mirroring name (R3.6 now binds
          // every Consumer_Category), so it clears the `[discovery:mirror]`
          // gate and the question this property asks — "can a container entry
          // ever become a Framework_Singleton?" — is decided further along.
          // When its directory is a Framework_Singleton's directory name, that
          // mirroring name IS the Framework_Singleton's declared name, so the
          // collision surfaces as `[discovery:duplicate]`; the framework-name
          // intrusion this block used to force through a non-mirroring
          // microservice name is exactly this `useFrameworkDir` branch, which
          // is the only way a mirroring consumer name can equal a framework
          // name.
          const dirName = useFrameworkDir ? frameworkDir : "intruder";
          if (layout.packages.some((pkg) => pkg.dirName === dirName)) return;
          const name = `${WORKSPACE_SCOPE}/${dirName}`;
          const intruder: PackageSpec = {
            category,
            dirName,
            packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
            name,
            deps: [],
            manifest: baseManifest(category, name, []),
          };
          const withIntruder: Layout = {
            ...layout,
            packages: [...layout.packages, intruder],
          };

          let discovery: Discovery | undefined;
          try {
            discovery = discover(withIntruder).discovery;
          } catch (error) {
            // Rejected as a duplicate of the framework directory's claim on
            // that name (R1.6, R5.2).
            expect((error as Error).message).toMatch(/\[discovery:duplicate\]/);
            return;
          }

          // Otherwise it was admitted as an ordinary Consumer_Package of the
          // container it sits in — and is still not a Framework_Singleton.
          const admitted = allDiscovered(discovery).find(
            (pkg) => pkg.packageDir === intruder.packageDir,
          );
          expect(admitted?.category).toBe(category);
          for (const pkg of allDiscovered(discovery)) {
            expect(FRAMEWORK_NAMES).not.toContain(pkg.name);
            expect(FRAMEWORK_PACKAGE_DIRS).not.toContain(pkg.packageDir);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects a Common_Package or Spa_Package directory named after a Framework_Singleton", () => {
    for (const category of ["common", "spa"] as const) {
      for (const singleton of FRAMEWORK_SINGLETONS) {
        const name = `${WORKSPACE_SCOPE}/${singleton.dirName}`;
        const layout: Layout = {
          packages: [
            {
              category,
              dirName: singleton.dirName,
              packageDir: `${NAMESPACE_CONTAINER[category]}/${singleton.dirName}`,
              name,
              deps: [],
              manifest: baseManifest(category, name, []),
            },
          ],
          noise: { microservice: [], common: [], spa: [] },
          absent: [],
          overseerDeps: [],
        };
        expect(() => discover(layout)).toThrow(/\[discovery:duplicate\]/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

// Feature: package-categories, Property 2: Manifest fields cannot change a category or a staged set
describe("Property 2: manifest fields cannot change a category or a staged set", () => {
  it("keeps every category's members and the staged set fixed under manifest mutation", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.array(arbMutation, { minLength: 1, maxLength: PLAN_SIZE }),
        ({ layout, selectedDirs }, mutations) => {
          const mutated = mutateLayout(layout, mutations);

          const base = discover(layout).discovery;
          const after = discover(mutated).discovery;

          // Same members, same order, same recorded names, same derived
          // Build_Kind — mutating `main`, `types`, `bin`, and the shape of
          // `dependencies` moves none of it (R1.5, R2.8, R2.9).
          for (const category of CONSUMER_CATEGORIES) {
            expect(after.byCategory[category]).toEqual(
              base.byCategory[category],
            );
          }
          expect([...after.nameByDir.entries()].sort()).toEqual(
            [...base.nameByDir.entries()].sort(),
          );
          expect([...after.byName.keys()].sort(ascending)).toEqual(
            [...base.byName.keys()].sort(ascending),
          );

          // The staged set for the Selector is unchanged, along both the
          // manifest-only path and the discovery-derived one (R2.9).
          const stagedBase = referenceStaged(layout, selectedDirs);
          const stagedAfter = referenceStaged(mutated, selectedDirs);
          expect(stagedAfter).toEqual(stagedBase);
          expect(
            stagedFromDiscovery(base, selectedDirs, layout.overseerDeps),
          ).toEqual(stagedBase);
          expect(
            stagedFromDiscovery(after, selectedDirs, mutated.overseerDeps),
          ).toEqual(stagedBase);

          // A staged set never contains a Namespace_Container itself, and
          // always contains the always-staged Framework_Singletons (R5.6).
          for (const category of CONSUMER_CATEGORIES) {
            expect(stagedBase).not.toContain(NAMESPACE_CONTAINER[category]);
          }
          for (const dirName of ALWAYS_STAGED_SCOPED_ENTRIES) {
            expect(stagedBase).toContain(`${PACKAGES_DIR}/${dirName}`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("discovers no Consumer_Package for a Framework_Singleton that declares main and types", () => {
    // Every framework manifest in `readerFor` declares a full barrel — the
    // exact shape the removed manifest-shape classifier promoted into every
    // image. Location-based discovery yields nothing for any of them (R2.10).
    const layout: Layout = {
      packages: [],
      noise: { microservice: [], common: [], spa: [] },
      absent: [],
      overseerDeps: [],
    };
    const { discovery, read } = discover(layout);
    expect(allDiscovered(discovery)).toEqual([]);
    for (const packageDir of FRAMEWORK_PACKAGE_DIRS) {
      expect(read).not.toContain(packageDir);
    }
  });

  it("keeps a Common_Package's category when its barrel values change", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIR_POOL),
        fc.tuple(
          fc.constantFrom("./dist/index.js", "./lib/main.js", "index.js"),
          fc.constantFrom("./dist/index.d.ts", "./lib/main.d.ts", "index.d.ts"),
        ),
        (dirName, [main, types]) => {
          const name = `${WORKSPACE_SCOPE}/${dirName}`;
          const layout: Layout = {
            packages: [
              {
                category: "common",
                dirName,
                packageDir: `${NAMESPACE_CONTAINER.common}/${dirName}`,
                name,
                deps: [],
                manifest: { name, main, types },
              },
            ],
            noise: { microservice: [], common: [], spa: [] },
            absent: [],
            overseerDeps: [],
          };
          const { discovery } = discover(layout);
          expect(discovery.byCategory.common.map((pkg) => pkg.dirName)).toEqual(
            [dirName],
          );
          expect(discovery.byCategory.common[0].buildKind).toBe("tsc-project");
        },
      ),
      { numRuns: 200 },
    );
  });
});

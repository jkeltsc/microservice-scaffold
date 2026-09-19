// Feature: config-driven-discovery, Property (containers): An absent Discovery_Root
// is tolerated uniformly for every Consumer_Category.
//
// For any layout, when ANY of the three Discovery_Roots — microservice, common,
// or spa — is absent or holds zero qualifying entries, discovery yields zero
// members for that category, raises nothing, and returns the same members for
// every other category as it would with that root populated. The
// required-versus-tolerant distinction the Pre_Change_Baseline drew (an absent
// microservice root throwing `[discovery:container-missing]`) is gone: task 7.1
// deleted that throw, and the Config_Loader's `[config:root-missing]` now fails
// the run before discovery is ever called when a microservice root is absent
// (asserted in `config-loader.root-missing.test.ts`). So discovery itself treats
// all three roots alike (R5.2, R6.14).
//
// The property is expressed over `discoverPackagesFrom(context, listRoot,
// readManifest)`, the pure core: the injected lister is exactly where the three
// root states live — `undefined` for an absent root directory, an empty (or
// noise-only) entry list for a present-but-empty one, and an entry per member
// for a populated one. Each of the three roots varies independently across those
// states, so the generated space covers the requirement's cases together rather
// than one at a time. The roots come from the generated context
// (`context.roots`), not from any Namespace_Container literal.
//
// Two things beyond "no throw" are pinned, because neither follows from the
// verdict alone. First, tolerance is *silent*: `console.warn`/`console.error`
// are never called, so an absent root produces no diagnostic at all. Second,
// tolerance is *inert*: for every layout with an absent or empty root, discovery
// is re-run with that root populated by a witness member, and the members of the
// other two categories must come back byte-identical — the clause a
// zero-members assertion cannot express.
//
// Expected members are computed by a local oracle (`expectedMembers`) written
// straight from the requirement — populated root yields its qualifying entries
// in ascending code-point order, absent or empty yields none — and kept
// independent of the production enumeration.
//
// Validates: Requirements 5.2, 6.14, 13.1

import { describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

import {
  discoverPackagesFrom,
  type RootEntry,
  type Discovery,
  type ListRoot,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  CONSUMER_CATEGORIES,
  type ConsumerCategory,
} from "../src/framework.js";

/** Default-config context; the Discovery_Roots come from `context.roots`, and
 *  every scoped member name from `context.scopedName`. */
const discoveryContext = projectContext(defaultEffectiveConfig());

/** The four Framework_Singletons (each with its scope-composed name) come from
 *  the run's context, not from framework.ts's scope-free surface (R3.7). */
const FRAMEWORK_SINGLETONS = discoveryContext.framework.all;

/**
 * The member used to populate an otherwise absent/empty root in the invariance
 * re-run. One per category, so the re-run stays a valid layout; the names are
 * excluded from generation so they can never collide with a generated member.
 */
const WITNESS: Readonly<Record<ConsumerCategory, string>> = {
  microservice: "witnessmicro",
  common: "witnesscommon",
  spa: "witnessspa",
};

/**
 * Directory names generation must avoid: a Framework_Singleton's directory name
 * would make a mirrored Common/Spa name collide with that singleton (a
 * `[discovery:duplicate]` failure, Property 6's subject, not this one), and a
 * witness name would collide with the invariance re-run's own member.
 */
const RESERVED_DIR_NAMES: ReadonlySet<string> = new Set([
  ...FRAMEWORK_SINGLETONS.map((entry) => entry.dirName),
  ...Object.values(WITNESS),
]);

/** Non-qualifying container entries: a regular file and a dot-prefixed dir. */
const NOISE_ENTRIES: readonly RootEntry[] = [
  { name: "README.md", isDirectory: false },
  { name: ".cache", isDirectory: true },
];

/** One qualifying member of a root, with the manifest its category needs. */
interface Member {
  readonly dirName: string;
  readonly manifest: PackageManifest;
}

/**
 * A root's state. `present` with zero members models "present and contains zero
 * qualifying entries"; `noise` decides whether it holds non-qualifying entries
 * as well, so an "empty" root is covered both as a genuinely empty directory and
 * as one holding only files and dot-directories.
 */
type ContainerState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly members: readonly Member[];
      readonly noise: boolean;
    };

type Layout = Readonly<Record<ConsumerCategory, ContainerState>>;

/**
 * A manifest that satisfies its category's contract, so the only outcome a
 * generated layout can produce is the tolerated absent/empty one this property
 * is about. Common declares the barrel (R4.1), Spa a build script (R4.3), a
 * Microservice_Package only its name.
 */
function manifestFor(
  category: ConsumerCategory,
  dirName: string,
): PackageManifest {
  const name = discoveryContext.scopedName(dirName);
  if (category === "common") {
    return { name, main: "./dist/index.js", types: "./dist/index.d.ts" };
  }
  if (category === "spa") {
    return { name, scripts: { build: "vite build" } };
  }
  return { name };
}

function memberOf(category: ConsumerCategory, dirName: string): Member {
  return { dirName, manifest: manifestFor(category, dirName) };
}

/** Ascending code-point comparison, the order R2.5 requires. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The oracle: the directory names discovery must report for one category,
 * derived from the requirement rather than from the production enumeration. A
 * populated root yields its qualifying entries in ascending code-point order; an
 * absent or empty one yields none.
 */
function expectedMembers(state: ContainerState): string[] {
  if (state.kind === "absent") {
    return [];
  }
  return state.members.map((member) => member.dirName).sort(byCodePoint);
}

/** The entries the lister reports for one root state. */
function entriesOf(
  state: ContainerState,
): readonly RootEntry[] | undefined {
  if (state.kind === "absent") {
    return undefined;
  }
  const qualifying = state.members.map((member) => ({
    name: member.dirName,
    isDirectory: true,
  }));
  return state.noise ? [...qualifying, ...NOISE_ENTRIES] : qualifying;
}

/** Readers over an in-memory layout, plus the root paths they were asked about. */
function readersFor(layout: Layout): {
  readonly listRoot: ListRoot;
  readonly readManifest: ReadManifest;
  readonly queried: string[];
} {
  const entriesByDir = new Map<string, readonly RootEntry[] | undefined>();
  const manifestByDir = new Map<string, PackageManifest>();
  for (const category of CONSUMER_CATEGORIES) {
    const state = layout[category];
    const rootDir = discoveryContext.roots[category];
    entriesByDir.set(rootDir, entriesOf(state));
    if (state.kind === "present") {
      for (const member of state.members) {
        manifestByDir.set(`${rootDir}/${member.dirName}`, member.manifest);
      }
    }
  }

  const queried: string[] = [];
  return {
    listRoot: (rootDir) => {
      queried.push(rootDir);
      return entriesByDir.get(rootDir);
    },
    readManifest: (packageDir) => {
      const manifest = manifestByDir.get(packageDir);
      return manifest === undefined
        ? { kind: "absent" }
        : { kind: "ok", manifest };
    },
    queried,
  };
}

function discover(layout: Layout): Discovery {
  const { listRoot, readManifest } = readersFor(layout);
  return discoverPackagesFrom(discoveryContext, listRoot, readManifest);
}

/** An identity for each member of one category, for cross-run comparison. */
function membersOf(
  discovery: Discovery,
  category: ConsumerCategory,
): { dirName: string; packageDir: string; name: string }[] {
  return discovery.byCategory[category].map((pkg) => ({
    dirName: pkg.dirName,
    packageDir: pkg.packageDir,
    name: pkg.name,
  }));
}

/** The same layout with one root populated by that category's witness. */
function withPopulated(layout: Layout, category: ConsumerCategory): Layout {
  return {
    ...layout,
    [category]: {
      kind: "present",
      members: [memberOf(category, WITNESS[category])],
      noise: false,
    },
  };
}

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter(
    (name) =>
      name.length > 0 && name.length <= 12 && !RESERVED_DIR_NAMES.has(name),
  );

/**
 * One root's state, weighted so absent, empty, and populated all occur often:
 * absent 1/4, present-but-empty 1/4, populated 1/2.
 */
const arbState: fc.Arbitrary<{
  readonly kind: "absent" | "present";
  readonly names: readonly string[];
  readonly noise: boolean;
}> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("absent" as const),
      names: fc.constant<readonly string[]>([]),
      noise: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("present" as const),
      names: fc.constant<readonly string[]>([]),
      noise: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("present" as const),
      names: fc.array(arbDirName, { minLength: 1, maxLength: 3 }),
      noise: fc.boolean(),
    }),
  },
);

/**
 * A layout: each of the three roots independently absent, present-empty, or
 * populated. Member directory names are deduplicated across the whole layout so
 * no two members declare the same mirrored name — a duplicate name is Property
 * 6's subject and would mask this property's outcome.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .record({
    microservice: arbState,
    common: arbState,
    spa: arbState,
  })
  .map((states) => {
    const seen = new Set<string>();
    const layout: Partial<Record<ConsumerCategory, ContainerState>> = {};
    for (const category of CONSUMER_CATEGORIES) {
      const state = states[category];
      if (state.kind === "absent") {
        layout[category] = { kind: "absent" };
        continue;
      }
      const members: Member[] = [];
      for (const dirName of state.names) {
        if (seen.has(dirName)) continue;
        seen.add(dirName);
        members.push(memberOf(category, dirName));
      }
      layout[category] = { kind: "present", members, noise: state.noise };
    }
    return layout as Layout;
  });

describe("Discovery: an absent Discovery_Root is tolerated uniformly", () => {
  it("yields zero members for an absent or empty root of any category, silently and inertly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      fc.assert(
        fc.property(arbLayout, (layout) => {
          const { listRoot, readManifest, queried } = readersFor(layout);

          // No category's absence throws now: every root is tolerated (R5.2,
          // R6.14). Discovery always returns a Discovery value.
          const discovery = discoverPackagesFrom(
            discoveryContext,
            listRoot,
            readManifest,
          );

          // Every category matches the oracle, including the empty ones: an
          // absent or empty root yields an empty array, not a missing key.
          for (const category of CONSUMER_CATEGORIES) {
            const state = layout[category];
            expect(
              membersOf(discovery, category).map((m) => m.dirName),
            ).toEqual(expectedMembers(state));
            for (const pkg of discovery.byCategory[category]) {
              expect(pkg.category).toBe(category);
              expect(pkg.packageDir).toBe(
                `${discoveryContext.roots[category]}/${pkg.dirName}`,
              );
            }
          }

          // Every root was consulted — a tolerated root is tolerated after being
          // looked at, not by being skipped.
          expect(new Set(queried)).toEqual(
            new Set(
              CONSUMER_CATEGORIES.map(
                (category) => discoveryContext.roots[category],
              ),
            ),
          );

          // For every category whose root is absent or empty: zero members,
          // nothing recorded under that root, and populating it leaves every
          // other category byte-identical.
          for (const category of CONSUMER_CATEGORIES) {
            if (expectedMembers(layout[category]).length > 0) continue;

            expect(discovery.byCategory[category]).toEqual([]);
            for (const dir of discovery.nameByDir.keys()) {
              expect(
                dir.startsWith(`${discoveryContext.roots[category]}/`),
              ).toBe(false);
            }

            // Inert as well as silent: populating this root leaves every other
            // category's members byte-identical.
            const populated = discover(withPopulated(layout, category));
            for (const other of CONSUMER_CATEGORIES) {
              if (other === category) continue;
              expect(membersOf(populated, other)).toEqual(
                membersOf(discovery, other),
              );
            }
            expect(
              membersOf(populated, category).map((m) => m.dirName),
            ).toEqual([WITNESS[category]]);
          }
        }),
        { numRuns: 200 },
      );

      // Tolerance is silent: no diagnostic was written anywhere in 200 runs.
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// Feature: package-categories, Property 4: An absent or empty consumer container is tolerated; an absent microservices container is not
//
// For any layout, when the `common` or `spa` container is absent or holds zero
// qualifying entries, discovery yields zero members for that category, raises
// nothing, and returns the same members for every other category as it would
// with that container populated; when the `microservices` container is absent,
// discovery fails naming that directory and returns no result for any category.
//
// The property is expressed over `discoverPackagesFrom(listContainer,
// readManifest)`, the pure core: the injected lister is exactly where the three
// container states live — `undefined` for an absent container directory, an
// empty (or noise-only) entry list for a present-but-empty one, and an entry per
// member for a populated one. Each of the three containers varies independently
// across those states, so the generated space covers the requirement's cases
// (absent `common`/`spa`, empty `common`/`spa`, absent `microservices`) together
// rather than one at a time.
//
// Two things beyond "no throw" are pinned, because neither follows from the
// verdict alone. First, tolerance is *silent*: `console.warn`/`console.error`
// are never called, so an absent consumer container produces no diagnostic at
// all (R2.6 "raise no error"). Second, tolerance is *inert*: for every layout
// whose `common` or `spa` container is absent or empty, discovery is re-run with
// that container populated by a witness member, and the members of the other
// two categories must come back byte-identical — which is the clause a
// zero-members assertion cannot express.
//
// Expected members are computed by a local oracle (`expectedMembers`) written
// straight from the requirement — populated container yields its qualifying
// entries in ascending code-point order, absent or empty yields none — and kept
// independent of the production enumeration.
//
// Validates: Requirements 1.9, 2.6, 2.7, 9.3

import { describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

import {
  discoverPackagesFrom,
  type ContainerEntry,
  type Discovery,
  type ListContainer,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";
import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";

/** The category whose container may not be absent (R2.7). */
const REQUIRED: ConsumerCategory = "microservice";

/** The categories an absent or empty container is tolerated for (R2.6). */
const TOLERANT: readonly ConsumerCategory[] = ["common", "spa"];

/**
 * The member used to populate an otherwise absent/empty container in the
 * invariance re-run. One per tolerant category, so the re-run stays a valid
 * layout; the names are excluded from generation so they can never collide with
 * a generated member.
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
const NOISE_ENTRIES: readonly ContainerEntry[] = [
  { name: "README.md", isDirectory: false },
  { name: ".cache", isDirectory: true },
];

/** One qualifying member of a container, with the manifest its category needs. */
interface Member {
  readonly dirName: string;
  readonly manifest: PackageManifest;
}

/**
 * A container's state. `present` with zero members models "present and contains
 * zero qualifying entries"; `noise` decides whether it holds non-qualifying
 * entries as well, so an "empty" container is covered both as a genuinely empty
 * directory and as one holding only files and dot-directories.
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
 * A manifest that satisfies its category's contract, so the only failure a
 * generated layout can produce is the absent-`microservices` one this property
 * is about. Common declares the barrel (R4.1), Spa a build script (R4.3), a
 * Microservice_Package only its name.
 */
function manifestFor(
  category: ConsumerCategory,
  dirName: string,
): PackageManifest {
  const name = `${WORKSPACE_SCOPE}/${dirName}`;
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
 * populated container yields its qualifying entries in ascending code-point
 * order; an absent or empty one yields none.
 */
function expectedMembers(state: ContainerState): string[] {
  if (state.kind === "absent") {
    return [];
  }
  return state.members.map((member) => member.dirName).sort(byCodePoint);
}

/** The entries the lister reports for one container state. */
function entriesOf(
  state: ContainerState,
): readonly ContainerEntry[] | undefined {
  if (state.kind === "absent") {
    return undefined;
  }
  const qualifying = state.members.map((member) => ({
    name: member.dirName,
    isDirectory: true,
  }));
  return state.noise ? [...qualifying, ...NOISE_ENTRIES] : qualifying;
}

/** Readers over an in-memory layout, plus the container paths they were asked about. */
function readersFor(layout: Layout): {
  readonly listContainer: ListContainer;
  readonly readManifest: ReadManifest;
  readonly queried: string[];
} {
  const entriesByDir = new Map<string, readonly ContainerEntry[] | undefined>();
  const manifestByDir = new Map<string, PackageManifest>();
  for (const category of CONSUMER_CATEGORIES) {
    const state = layout[category];
    const containerDir = NAMESPACE_CONTAINER[category];
    entriesByDir.set(containerDir, entriesOf(state));
    if (state.kind === "present") {
      for (const member of state.members) {
        manifestByDir.set(`${containerDir}/${member.dirName}`, member.manifest);
      }
    }
  }

  const queried: string[] = [];
  return {
    listContainer: (containerDir) => {
      queried.push(containerDir);
      return entriesByDir.get(containerDir);
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
  const { listContainer, readManifest } = readersFor(layout);
  return discoverPackagesFrom(listContainer, readManifest);
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

/** The same layout with one container populated by that category's witness. */
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
 * One container's state, weighted so absent, empty, and populated all occur
 * often: absent 1/4, present-but-empty 1/4, populated 1/2.
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
 * A layout: each of the three containers independently absent, present-empty,
 * or populated. Member directory names are deduplicated across the whole layout
 * so no two members declare the same mirrored name — a duplicate name is
 * Property 6's subject and would mask this property's outcome.
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

describe("Property 4: container presence across the three categories", () => {
  it("tolerates an absent or empty consumer container and fails on an absent microservices container", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      fc.assert(
        fc.property(arbLayout, (layout) => {
          const { listContainer, readManifest, queried } = readersFor(layout);

          if (layout[REQUIRED].kind === "absent") {
            // The microservices container is absent: the run fails naming that
            // directory, and no Discovery value comes back for any category.
            let thrown: unknown;
            try {
              discoverPackagesFrom(listContainer, readManifest);
            } catch (caught) {
              thrown = caught;
            }
            expect(thrown).toBeInstanceOf(Error);
            const message = (thrown as Error).message;
            expect(message.startsWith("[discovery:container-missing] ")).toBe(
              true,
            );
            // The failure names the missing directory, and only it: a message
            // naming a tolerated container would send a reader after the wrong
            // directory.
            expect(message).toContain(`"${NAMESPACE_CONTAINER[REQUIRED]}"`);
            for (const category of TOLERANT) {
              expect(message).not.toContain(NAMESPACE_CONTAINER[category]);
            }
            return;
          }

          const discovery = discoverPackagesFrom(listContainer, readManifest);

          // Every category matches the oracle, including the empty ones: an
          // absent or empty container yields an empty array, not a missing key.
          for (const category of CONSUMER_CATEGORIES) {
            const state = layout[category];
            expect(
              membersOf(discovery, category).map((m) => m.dirName),
            ).toEqual(expectedMembers(state));
            for (const pkg of discovery.byCategory[category]) {
              expect(pkg.category).toBe(category);
              expect(pkg.packageDir).toBe(
                `${NAMESPACE_CONTAINER[category]}/${pkg.dirName}`,
              );
            }
          }

          // Every container was consulted — a tolerated container is tolerated
          // after being looked at, not by being skipped.
          expect(new Set(queried)).toEqual(
            new Set(
              CONSUMER_CATEGORIES.map(
                (category) => NAMESPACE_CONTAINER[category],
              ),
            ),
          );

          for (const category of TOLERANT) {
            if (expectedMembers(layout[category]).length > 0) continue;

            // Zero members, and nothing recorded under that container.
            expect(discovery.byCategory[category]).toEqual([]);
            for (const dir of discovery.nameByDir.keys()) {
              expect(dir.startsWith(`${NAMESPACE_CONTAINER[category]}/`)).toBe(
                false,
              );
            }

            // Inert as well as silent: populating this container leaves every
            // other category's members byte-identical.
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

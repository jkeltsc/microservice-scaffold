// Feature: package-categories, Property 3: Discovery enumerates exactly the qualifying direct entries, in code-point order
//
// For any Namespace_Container contents — directories, regular files,
// dot-prefixed names, and directories nested two or more levels deep — the
// discovered members of that category are exactly the direct entries that
// resolve to a directory whose name does not begin with `.`, one member per such
// entry, ordered by ascending code-point comparison of directory name, with
// every deeper directory excluded and treated as private content of its nearest
// depth-1 ancestor; two invocations over unchanged input return identical
// sequences.
//
// The property is exercised through `discoverPackagesFrom(listContainer,
// readManifest)`, the pure core of `discovery.ts`. The injected `ListContainer`
// models a real `readdir`: it only ever reports the DIRECT entries of the
// directory it is asked about. "Nesting depth two or more" is therefore modelled
// by an in-memory filesystem that HOLDS deeper directories — each with a
// perfectly usable manifest of its own — which the container-level listing never
// reports. That the deeper directories are excluded because of their location
// and not because they look unusable is what makes the exclusion meaningful, and
// the recorded manifest reads show their manifests are never even consulted.
//
// The expected member list per category is computed by `qualifyingNames` below,
// a local oracle derived straight from the requirement text (resolves to a
// directory AND name does not begin with `.`, sorted by ascending code point via
// an explicit code-point comparator) and kept independent of the production
// filter and of the production sort's use of `<`.
//
// Validates: Requirements 1.4, 1.10, 2.1, 2.2, 2.3, 2.4, 2.5, 9.1, 9.6, 9.8

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  CONSUMER_CATEGORIES,
  NAMESPACE_CONTAINER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";
import {
  discoverPackagesFrom,
  type ContainerEntry,
  type Discovery,
  type ListContainer,
  type ManifestRead,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";

// ---------------------------------------------------------------------------
// The oracle: the qualifying-entry rule and the code-point order
// ---------------------------------------------------------------------------

/**
 * Ascending code-point comparison, written out rather than delegated to `<`.
 * `<` on strings compares UTF-16 code units, which agrees with code-point order
 * across the Basic Multilingual Plane (which every generated name below stays
 * inside) but not for astral characters. Spelling the comparator out keeps the
 * oracle honest about what R2.5 asks for.
 */
function compareByCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const x = left[i].codePointAt(0) ?? 0;
    const y = right[i].codePointAt(0) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * The oracle: the names of the direct entries of one container that qualify —
 * resolve to a directory and do not begin with `.` (R2.4) — in ascending
 * code-point order (R2.5). Everything else, regular files included, is dropped
 * without being an error (R1.10, R9.8).
 */
function qualifyingNames(entries: readonly EntrySpec[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(compareByCodePoint);
}

// ---------------------------------------------------------------------------
// In-memory filesystem model
// ---------------------------------------------------------------------------

/** What a generated direct entry of a Namespace_Container is. */
type EntryKind =
  /** A plain directory: qualifies. */
  | "dir"
  /** A directory whose name begins with `.`: excluded by name (R2.4). */
  | "dot-dir"
  /** A regular file: excluded by kind (R1.10, R9.8). */
  | "file"
  /** A dot-prefixed regular file: excluded on both counts. */
  | "dot-file";

/** One direct entry of a Namespace_Container in the generated layout. */
interface EntrySpec {
  /** The listed name, dot prefix included. */
  readonly name: string;
  readonly isDirectory: boolean;
  /**
   * Directory paths BELOW this entry, as segment lists of length >= 1, so every
   * one of them sits two or more levels below the container. Only meaningful
   * when this entry is a directory.
   */
  readonly nested: readonly (readonly string[])[];
}

type Layout = Readonly<Record<ConsumerCategory, readonly EntrySpec[]>>;

/** A directory of the in-memory filesystem sitting two or more levels deep. */
interface DeepDir {
  readonly category: ConsumerCategory;
  /** The depth-1 entry it lives under; its nearest depth-1 ancestor. */
  readonly ancestorName: string;
  /** Repo-relative path of the depth-1 ancestor. */
  readonly ancestorDir: string;
  /** Repo-relative path of the deep directory itself. */
  readonly path: string;
}

/**
 * A manifest that satisfies every category's contract at once: a mirrored name,
 * a barrel, and a build script. Deep directories get one, so a deep directory is
 * excluded purely because of where it sits and not because discovery would have
 * rejected it anyway.
 */
function usableManifest(dirName: string): PackageManifest {
  return {
    name: `${WORKSPACE_SCOPE}/${dirName}`,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    scripts: { build: "tsc" },
  };
}

/** The manifest a depth-1 member of `category` declares, valid for its category. */
function manifestFor(
  category: ConsumerCategory,
  dirName: string,
): PackageManifest {
  const name = `${WORKSPACE_SCOPE}/${dirName}`;
  switch (category) {
    case "common":
      return { name, main: "./dist/index.js", types: "./dist/index.d.ts" };
    case "spa":
      return { name, scripts: { build: "vite build" } };
    case "microservice":
      return { name };
  }
}

interface Fake {
  readonly listContainer: ListContainer;
  readonly readManifest: ReadManifest;
  /** Every directory the lister was asked about, in call order. */
  readonly listed: string[];
  /** Every package directory whose manifest was read, in call order. */
  readonly read: string[];
  /** Every directory of the layout two or more levels below its container. */
  readonly deepDirs: readonly DeepDir[];
  /** Repo-relative paths of the depth-1 entries that qualify. */
  readonly qualifyingDirs: readonly string[];
}

/**
 * Build the injected readers over a layout. The lister reports DIRECT entries
 * only — the deeper directories are in the filesystem map but reachable solely
 * by listing the depth-1 entry itself, which discovery never does — while the
 * manifest reader resolves a manifest for every directory at every depth.
 *
 * @param order permutes each container's listing, modelling `readdir` returning
 *   entries in an arbitrary order.
 */
function fakeFor(
  layout: Layout,
  order: (entries: readonly ContainerEntry[]) => readonly ContainerEntry[] = (
    entries,
  ) => entries,
): Fake {
  const entriesByDir = new Map<string, ContainerEntry[]>();
  const manifestByDir = new Map<string, PackageManifest>();
  const deepDirs: DeepDir[] = [];
  const qualifyingDirs: string[] = [];

  const addEntry = (parentDir: string, entry: ContainerEntry): void => {
    const siblings = entriesByDir.get(parentDir);
    if (siblings === undefined) {
      entriesByDir.set(parentDir, [entry]);
    } else {
      siblings.push(entry);
    }
  };

  for (const category of CONSUMER_CATEGORIES) {
    const containerDir = NAMESPACE_CONTAINER[category];
    // Present but possibly empty: an absent container is Property 4's subject.
    entriesByDir.set(containerDir, []);

    for (const entry of layout[category]) {
      addEntry(containerDir, {
        name: entry.name,
        isDirectory: entry.isDirectory,
      });
      if (!entry.isDirectory) continue;

      const ancestorDir = `${containerDir}/${entry.name}`;
      manifestByDir.set(ancestorDir, manifestFor(category, entry.name));
      if (!entry.name.startsWith(".")) {
        qualifyingDirs.push(ancestorDir);
      }

      // Every prefix of every nested path is itself a directory of the
      // filesystem, so depth 2 and depth 3 are both represented.
      for (const segments of entry.nested) {
        let parentDir = ancestorDir;
        for (const segment of segments) {
          const path = `${parentDir}/${segment}`;
          if (!manifestByDir.has(path)) {
            addEntry(parentDir, { name: segment, isDirectory: true });
            manifestByDir.set(path, usableManifest(segment));
            deepDirs.push({
              category,
              ancestorName: entry.name,
              ancestorDir,
              path,
            });
          }
          parentDir = path;
        }
      }
    }
  }

  const listed: string[] = [];
  const read: string[] = [];

  const listContainer: ListContainer = (containerDir) => {
    listed.push(containerDir);
    const entries = entriesByDir.get(containerDir);
    return entries === undefined ? undefined : order(entries);
  };

  const readManifest: ReadManifest = (packageDir) => {
    read.push(packageDir);
    const manifest = manifestByDir.get(packageDir);
    const result: ManifestRead =
      manifest === undefined ? { kind: "absent" } : { kind: "ok", manifest };
    return result;
  };

  return {
    listContainer,
    readManifest,
    listed,
    read,
    deepDirs,
    qualifyingDirs,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Name characters chosen to make the ordering assertion bite: two cases, digits,
 * `-` and `_` (which straddle the ASCII letters), and BMP non-ASCII characters
 * that sort after every ASCII one. Deliberately excludes the letters needed to
 * spell any Framework_Singleton directory name, so no generated member can claim
 * a framework name and trip the uniqueness stage.
 */
const NAME_CHARS = [
  "a",
  "b",
  "z",
  "A",
  "B",
  "Z",
  "0",
  "9",
  "-",
  "_",
  "é",
  "ß",
  "Ω",
];

const arbSegment: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 4 })
  .map((chars) => chars.join(""));

/** One generated entry, before its name is committed and its category fixed. */
interface RawEntry {
  readonly base: string;
  readonly kind: EntryKind;
  readonly category: ConsumerCategory;
  readonly nested: readonly (readonly string[])[];
}

const arbRawEntry: fc.Arbitrary<RawEntry> = fc.record({
  base: arbSegment,
  // Weighted towards plain directories so most runs have members to order,
  // while every excluded kind still shows up regularly.
  kind: fc.constantFrom<EntryKind>(
    "dir",
    "dir",
    "dir",
    "dot-dir",
    "file",
    "dot-file",
  ),
  category: fc.constantFrom(...CONSUMER_CATEGORIES),
  nested: fc.array(fc.array(arbSegment, { minLength: 1, maxLength: 3 }), {
    maxLength: 3,
  }),
});

function isDirectoryKind(kind: EntryKind): boolean {
  return kind === "dir" || kind === "dot-dir";
}

/**
 * A layout across all three containers. Entry base names are unique across the
 * whole layout, which keeps sibling names unique (a real filesystem cannot hold
 * two same-named siblings) and keeps every mirrored declared name unique, so no
 * run fails on the duplicate-name stage instead of exercising enumeration.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .uniqueArray(arbRawEntry, {
    selector: (entry) => entry.base,
    maxLength: 14,
  })
  .map((raw) => {
    const layout: Record<ConsumerCategory, EntrySpec[]> = {
      microservice: [],
      common: [],
      spa: [],
    };
    for (const entry of raw) {
      layout[entry.category].push({
        name: entry.kind.startsWith("dot") ? `.${entry.base}` : entry.base,
        isDirectory: isDirectoryKind(entry.kind),
        nested: entry.nested,
      });
    }
    return layout;
  });

/** A reproducible permutation, so "shuffled listing order" is a real variable. */
function permutation<T>(items: readonly T[], seed: number): readonly T[] {
  const out = [...items];
  let state = (seed + 1) % 2147483647;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The dirNames of one category's discovered members, in returned order. */
function memberNames(
  discovery: Discovery,
  category: ConsumerCategory,
): string[] {
  return discovery.byCategory[category].map((pkg) => pkg.dirName);
}

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

describe("Property 3: discovery enumerates exactly the qualifying direct entries, in code-point order", () => {
  it("returns one member per qualifying direct entry, ordered by ascending code point, and nothing else", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const fake = fakeFor(layout);
        const discovery = discoverPackagesFrom(
          fake.listContainer,
          fake.readManifest,
        );

        for (const category of CONSUMER_CATEGORIES) {
          const expected = qualifyingNames(layout[category]);
          const members = discovery.byCategory[category];

          // Exactly one member per qualifying entry, in the oracle's order
          // (R2.1, R2.2, R2.3, R2.5, R9.1).
          expect(memberNames(discovery, category)).toEqual(expected);

          for (const pkg of members) {
            expect(pkg.category).toBe(category);
            expect(pkg.packageDir).toBe(
              `${NAMESPACE_CONTAINER[category]}/${pkg.dirName}`,
            );
          }

          // Strictly ascending: no duplicate and no out-of-order pair.
          for (let i = 1; i < members.length; i++) {
            expect(
              compareByCodePoint(members[i - 1].dirName, members[i].dirName),
            ).toBeLessThan(0);
          }

          // Nothing the oracle excluded slipped in: not a regular file, not a
          // dot-prefixed name (R1.10, R2.4, R9.8).
          const excluded = layout[category]
            .filter((entry) => !entry.isDirectory || entry.name.startsWith("."))
            .map((entry) => entry.name);
          for (const name of excluded) {
            expect(memberNames(discovery, category)).not.toContain(name);
          }
        }

        // The lookup covers exactly the members of the three categories.
        const allMembers = CONSUMER_CATEGORIES.flatMap(
          (category) => discovery.byCategory[category],
        );
        expect(discovery.nameByDir.size).toBe(allMembers.length);
        expect(discovery.byName.size).toBe(allMembers.length);
      }),
      { numRuns: 200 },
    );
  });

  it("excludes every directory two or more levels deep, treating it as private content of its nearest depth-1 ancestor", () => {
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const fake = fakeFor(layout);
        const discovery = discoverPackagesFrom(
          fake.listContainer,
          fake.readManifest,
        );

        const stagedDirs = new Set(
          CONSUMER_CATEGORIES.flatMap((category) =>
            discovery.byCategory[category].map((pkg) => pkg.packageDir),
          ),
        );

        for (const deep of fake.deepDirs) {
          // Never a member of any category, in any form (R1.4, R2.1, R2.2,
          // R2.3, R9.6) — even though its own manifest is perfectly usable.
          expect(stagedDirs.has(deep.path)).toBe(false);
          expect(discovery.nameByDir.has(deep.path)).toBe(false);

          // Private content of its nearest depth-1 ancestor: it lives strictly
          // under that ancestor's directory, and the ancestor is the member
          // exactly when the ancestor itself qualifies.
          expect(deep.path.startsWith(`${deep.ancestorDir}/`)).toBe(true);
          expect(stagedDirs.has(deep.ancestorDir)).toBe(
            !deep.ancestorName.startsWith("."),
          );
        }

        // Every recorded package directory is depth 1 under its container:
        // `packages/<container>/<dirName>`, three segments, no more.
        for (const dir of discovery.nameByDir.keys()) {
          expect(dir.split("/")).toHaveLength(3);
        }

        // Only the three Namespace_Containers are ever listed, so a deeper
        // directory is never even enumerated.
        expect([...new Set(fake.listed)].sort()).toEqual(
          CONSUMER_CATEGORIES.map(
            (category) => NAMESPACE_CONTAINER[category],
          ).sort(),
        );

        // And exactly the qualifying depth-1 directories have their manifests
        // read, once each: no deeper directory's manifest participates.
        expect([...fake.read].sort()).toEqual([...fake.qualifyingDirs].sort());
      }),
      { numRuns: 200 },
    );
  });

  it("returns identical sequences for two invocations over unchanged input, and for any listing order", () => {
    fc.assert(
      fc.property(arbLayout, fc.nat(), (layout, seed) => {
        const asListed = fakeFor(layout);
        const shuffledFake = fakeFor(layout, (entries) =>
          permutation(entries, seed),
        );

        const first = discoverPackagesFrom(
          asListed.listContainer,
          asListed.readManifest,
        );
        const second = discoverPackagesFrom(
          asListed.listContainer,
          asListed.readManifest,
        );
        const shuffled = discoverPackagesFrom(
          shuffledFake.listContainer,
          shuffledFake.readManifest,
        );

        for (const category of CONSUMER_CATEGORIES) {
          expect(second.byCategory[category]).toEqual(
            first.byCategory[category],
          );
          // Order the entries arrive in cannot change the order they leave in
          // (R2.5): the returned sequence is a function of the entry set alone.
          expect(shuffled.byCategory[category]).toEqual(
            first.byCategory[category],
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Concrete cases
// ---------------------------------------------------------------------------

describe("Property 3 (concrete): the qualifying-entry rule", () => {
  const emptyLayout: Layout = { microservice: [], common: [], spa: [] };

  function discover(layout: Layout): Discovery {
    const fake = fakeFor(layout);
    return discoverPackagesFrom(fake.listContainer, fake.readManifest);
  }

  it("treats a microservice's own src/ and dist/ subtrees as private content", () => {
    const discovery = discover({
      ...emptyLayout,
      microservice: [
        {
          name: "microservice1",
          isDirectory: true,
          nested: [["src"], ["src", "routes"], ["dist", "src"]],
        },
      ],
    });

    expect(memberNames(discovery, "microservice")).toEqual(["microservice1"]);
    expect([...discovery.nameByDir.keys()]).toEqual([
      "packages/microservices/microservice1",
    ]);
  });

  it("ignores regular files and dot-prefixed entries without failing", () => {
    const discovery = discover({
      microservice: [
        { name: "microservice1", isDirectory: true, nested: [] },
        { name: "README.md", isDirectory: false, nested: [] },
        { name: ".DS_Store", isDirectory: false, nested: [] },
        { name: ".cache", isDirectory: true, nested: [["chunks"]] },
      ],
      common: [
        { name: "config", isDirectory: true, nested: [] },
        { name: "tsconfig.json", isDirectory: false, nested: [] },
      ],
      spa: [{ name: ".vite", isDirectory: true, nested: [] }],
    });

    expect(memberNames(discovery, "microservice")).toEqual(["microservice1"]);
    expect(memberNames(discovery, "common")).toEqual(["config"]);
    expect(memberNames(discovery, "spa")).toEqual([]);
  });

  it("orders members by ascending code point regardless of listing order", () => {
    const names = ["Zulu", "alpha", "_under", "9nine", "Ωmega"];
    const discovery = discover({
      ...emptyLayout,
      microservice: [...names]
        .reverse()
        .map((name) => ({ name, isDirectory: true, nested: [] })),
    });

    expect(memberNames(discovery, "microservice")).toEqual([
      "9nine",
      "Zulu",
      "_under",
      "alpha",
      "Ωmega",
    ]);
  });
});

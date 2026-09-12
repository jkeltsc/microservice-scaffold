// Feature: package-categories, Property 23: The Workspace_Coverage check verdict equals the coverage oracle
//
// For any `workspaces` array and any set of workspace package directories,
// `checkWorkspaceCoverage` reports exactly those packages matched by a number of
// entries OTHER THAN ONE — naming each such package's repo-relative directory
// together with every entry matching it — and reports nothing otherwise,
// leaving the Root_Manifest (its inputs) unmodified in every case.
//
// The coverage oracle below is written from the acceptance criteria of
// Requirement 12.15–12.20, not from `repo-invariants.ts`: it counts, per
// workspace package, how many entries match its directory, and calls a package
// a violation exactly when that count is not one (R12.15, R12.18). It reads no
// entry order (R12.16), no dependency edge (R12.19), and treats a glob matching
// nothing as contributing zero matches (R12.20). Every ordering assertion the
// retired suite carried — fixed positions, tier precedence, per-edge entry
// precedence, and the shared-entry rule — is gone, because each stated a rule
// R12.16 removes.
//
// Message content is asserted structurally: for each oracle violation there must
// be exactly one returned message quoting the package directory and every entry
// (with its index) matching it, and no returned message may go unclaimed.
// Quoting the fragments is what keeps `"packages/common/common1"` from matching
// a message about `"packages/common/common10"`. The concrete cases at the end
// pin the full message shapes, including the entry indices.
//
// Validates: Requirements R12.15, R12.16, R12.17, R12.18, R12.19, R12.20

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  checkWorkspaceCoverage,
  type WorkspaceEntry,
  type WorkspacePackage,
} from "../src/repo-invariants.js";

// ---------------------------------------------------------------------------
// The literals Requirement 12 names
// ---------------------------------------------------------------------------

const CONTRACTS_DIR = "packages/contracts";
const BUILD_TOOLS_DIR = "packages/build-tools";
const OVERSEER_DIR = "packages/overseer";
const INTEGRATION_TESTS_DIR = "packages/integration-tests";
const COMMON_GLOB = "packages/common/*";
const SPA_GLOB = "packages/spa/*";
const MICROSERVICES_GLOB = "packages/microservices/*";

/**
 * The `workspaces` entries the Root_Manifest declares. Coverage constrains the
 * *set* only (R12.16), so the array order here is arbitrary and the property
 * varies it freely — the canonical listing is just a convenient default the
 * generator permutes. Every generated model declares exactly these entries
 * (plus, sometimes, one extra duplicate entry), because the Root_Manifest always
 * declares all of them: an entirely absent glob is not part of this input space.
 */
const CANONICAL_PATTERNS: readonly string[] = [
  CONTRACTS_DIR,
  BUILD_TOOLS_DIR,
  COMMON_GLOB,
  SPA_GLOB,
  MICROSERVICES_GLOB,
  OVERSEER_DIR,
  INTEGRATION_TESTS_DIR,
];

const GLOB_SUFFIX = "/*";
const COVERAGE_PREFIX = "[workspaces:coverage]";

// ---------------------------------------------------------------------------
// The entry-matching helper (carried over from the retired suite)
// ---------------------------------------------------------------------------

/** The entries whose resolved matches include `dir`, in array-index order. */
function entriesMatching(
  entries: readonly WorkspaceEntry[],
  dir: string,
): readonly WorkspaceEntry[] {
  return entries
    .filter((entry) => entry.matches.includes(dir))
    .sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// The coverage oracle (Requirement 12.15–12.20, restated from the criteria)
// ---------------------------------------------------------------------------

/**
 * A coverage violation: a package matched by a number of entries other than one,
 * together with every entry matching it (empty for a zero-match package).
 * R12.18 says the message must name the package directory and every matching
 * entry with its index, so the oracle records exactly that.
 */
interface CoverageViolation {
  readonly name: string;
  readonly dir: string;
  readonly matching: readonly WorkspaceEntry[];
}

/**
 * Every Workspace_Coverage violation the inputs commit, by the one rule in both
 * directions (R12.15, R12.18): a package matched by ZERO entries is a violation,
 * and a package matched by TWO OR MORE is a violation. The oracle reads no entry
 * order (R12.16) — it counts matches, and a count is permutation-invariant — no
 * dependency edge (R12.19), and treats a zero-match glob as contributing zero
 * matches (R12.20). Order is irrelevant: the property matches the check's
 * messages against this list as a set.
 */
function coverageOracle(
  entries: readonly WorkspaceEntry[],
  packages: readonly WorkspacePackage[],
): CoverageViolation[] {
  const violations: CoverageViolation[] = [];
  for (const pkg of packages) {
    const matching = entriesMatching(entries, pkg.packageDir);
    if (matching.length !== 1) {
      violations.push({ name: pkg.name, dir: pkg.packageDir, matching });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Message matching
// ---------------------------------------------------------------------------

const quoted = (value: string): string => `"${value}"`;

/** How an entry is named in a message: its pattern plus its array index. */
const describeEntry = (entry: WorkspaceEntry): string =>
  `"${entry.pattern}" (index ${String(entry.index)})`;

/**
 * The quoted fragments Requirement 12.18 says a coverage message must carry: the
 * package directory, and every entry matching it (pattern and index). A
 * zero-match violation names no entry; a duplicate names both. Nothing about
 * phrasing is asserted — only that the message names what R12.18 requires.
 */
function requiredFragments(violation: CoverageViolation): string[] {
  return [
    quoted(violation.dir),
    ...violation.matching.map((entry) => describeEntry(entry)),
  ];
}

/**
 * Claim one distinct message per violation. Violations carrying the most
 * fragments are matched first, so a duplicate naming two entries is claimed by
 * the two-match violation rather than by a coarser one whose single fragment it
 * happens to contain.
 *
 * Returns the unclaimed violations and the unclaimed messages: both empty means
 * the check reported exactly the oracle's violations, one message each.
 */
function pairUp(
  messages: readonly string[],
  violations: readonly CoverageViolation[],
): { unmatchedViolations: CoverageViolation[]; unclaimedMessages: string[] } {
  const remaining = [...messages];
  const unmatchedViolations: CoverageViolation[] = [];

  const ordered = [...violations].sort(
    (a, b) => requiredFragments(b).length - requiredFragments(a).length,
  );

  for (const violation of ordered) {
    const fragments = requiredFragments(violation);
    const at = remaining.findIndex((message) =>
      fragments.every((fragment) => message.includes(fragment)),
    );
    if (at === -1) {
      unmatchedViolations.push(violation);
    } else {
      remaining.splice(at, 1);
    }
  }

  return { unmatchedViolations, unclaimedMessages: remaining };
}

// ---------------------------------------------------------------------------
// The generated model
// ---------------------------------------------------------------------------

interface ModelPackage {
  readonly packageDir: string;
  readonly name: string;
}

interface Model {
  readonly entries: readonly WorkspaceEntry[];
  readonly packages: readonly WorkspacePackage[];
}

function member(dir: string, name: string): ModelPackage {
  return { packageDir: dir, name };
}

/** The four Framework_Singletons, always present, each declaring an entry. */
const FRAMEWORK_MEMBERS: readonly ModelPackage[] = [
  member(CONTRACTS_DIR, "@microservices/contracts"),
  member(BUILD_TOOLS_DIR, "@microservices/build-tools"),
  member(OVERSEER_DIR, "@microservices/overseer"),
  member(INTEGRATION_TESTS_DIR, "@microservices/integration-tests"),
];

/**
 * Specifiers that resolve to no workspace package, plus by-name specifiers that
 * do. Coverage inspects no dependency edge (R12.19), so these are carried on the
 * records only to prove the check ignores them.
 */
const FOREIGN_SPECIFIERS: readonly string[] = [
  "express",
  "@microservices/not-a-workspace-package",
];

interface Layout {
  readonly common: number;
  readonly spa: number;
  readonly microservices: number;
  /** A package under no entry at all, exercising R12.15's zero-match case. */
  readonly orphan: boolean;
}

function membersOf(layout: Layout): ModelPackage[] {
  const consumers: ModelPackage[] = [];
  for (let i = 0; i < layout.common; i += 1) {
    consumers.push(
      member(
        `packages/common/common${String(i)}`,
        `@microservices/common${String(i)}`,
      ),
    );
  }
  for (let i = 0; i < layout.spa; i += 1) {
    consumers.push(
      member(`packages/spa/spa${String(i)}`, `@microservices/spa${String(i)}`),
    );
  }
  for (let i = 0; i < layout.microservices; i += 1) {
    consumers.push(
      member(
        `packages/microservices/microservice${String(i)}`,
        `@microservices/microservice${String(i)}`,
      ),
    );
  }
  if (layout.orphan) {
    consumers.push(member("packages/orphan", "@microservices/orphan"));
  }
  return [...FRAMEWORK_MEMBERS, ...consumers];
}

/** Resolve one entry pattern against the model's package directories (npm rules). */
function resolveEntry(
  pattern: string,
  index: number,
  members: readonly ModelPackage[],
): WorkspaceEntry {
  const matches = members
    .map((m) => m.packageDir)
    .filter((dir) =>
      pattern.endsWith(GLOB_SUFFIX)
        ? dir.startsWith(pattern.slice(0, -1)) &&
          !dir.slice(pattern.length - 1).includes("/")
        : dir === pattern,
    );
  return { pattern, index, matches };
}

const arbLayout: fc.Arbitrary<Layout> = fc.record({
  common: fc.integer({ min: 0, max: 3 }),
  spa: fc.integer({ min: 0, max: 2 }),
  microservices: fc.integer({ min: 0, max: 3 }),
  // Rare on purpose: an uncovered package is one specific violation, and every
  // model containing one is a violating model, which would crowd out the
  // zero-violation verdicts the property also has to exercise.
  orphan: fc.oneof(
    { weight: 4, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
});

/**
 * A `workspaces` array: an arbitrary permutation of the declared entries.
 * Coverage carries no order meaning (R12.16), so the order is free; the
 * permutation is what lets the permutation-invariance block below observe that
 * reordering changes nothing.
 */
const arbPatternOrder: fc.Arbitrary<readonly string[]> = fc.shuffledSubarray(
  CANONICAL_PATTERNS,
  {
    minLength: CANONICAL_PATTERNS.length,
    maxLength: CANONICAL_PATTERNS.length,
  },
);

/**
 * A full model: a `workspaces` array, a package set, and a dependency graph.
 * Dependency specifiers are drawn freely across every package name plus foreign
 * specifiers — coverage never inspects them, and the invariance block for R12.19
 * relies on their presence to prove exactly that. A rare extra exact entry
 * duplicates one already-matched directory, so some packages are matched by two
 * entries (R12.18's other half).
 */
const arbModel: fc.Arbitrary<Model> = arbLayout.chain((layout) => {
  const members = membersOf(layout);
  const names = members.map((m) => m.name);

  const depsFor = (self: ModelPackage): fc.Arbitrary<string[]> =>
    fc
      .tuple(
        fc.subarray(names.filter((n) => n !== self.name)),
        fc.subarray(FOREIGN_SPECIFIERS),
      )
      .map(([resolved, foreign]) => [...resolved, ...foreign]);

  return fc
    .tuple(
      arbPatternOrder,
      fc.tuple(...members.map(depsFor)),
      // An extra exact entry duplicating one already-matched directory, so some
      // packages are matched by two entries. Rare, for the same reason the
      // orphan is.
      fc.oneof(
        { weight: 4, arbitrary: fc.constant<number | undefined>(undefined) },
        {
          weight: 1,
          arbitrary: fc.nat({ max: Math.max(members.length - 1, 0) }),
        },
      ),
    )
    .map(([patternOrder, deps, duplicateAt]) => {
      const patterns = [...patternOrder];
      if (duplicateAt !== undefined) {
        // Spliced in at position 1 rather than appended, so the array order
        // stays arbitrary and no single position is privileged.
        patterns.splice(1, 0, members[duplicateAt].packageDir);
      }
      const entries = patterns.map((pattern, index) =>
        resolveEntry(pattern, index, members),
      );
      const packages: WorkspacePackage[] = members.map((m, i) => ({
        packageDir: m.packageDir,
        name: m.name,
        dependencySpecifiers: deps[i],
      }));
      return { entries, packages };
    });
});

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

describe("Property 23: the Workspace_Coverage check verdict equals the coverage oracle", () => {
  it("returns no message exactly when every package is matched by one entry", () => {
    fc.assert(
      fc.property(arbModel, ({ entries, packages }) => {
        const messages = checkWorkspaceCoverage(entries, packages);
        const violations = coverageOracle(entries, packages);

        expect(messages.length === 0).toBe(violations.length === 0);
      }),
      { numRuns: 200 },
    );
  });

  it("reports exactly the oracle's violations, each naming the directory and every matching entry", () => {
    fc.assert(
      fc.property(arbModel, ({ entries, packages }) => {
        const messages = checkWorkspaceCoverage(entries, packages);
        const violations = coverageOracle(entries, packages);

        expect(messages.length).toBe(violations.length);

        const { unmatchedViolations, unclaimedMessages } = pairUp(
          messages,
          violations,
        );
        expect(unmatchedViolations).toEqual([]);
        expect(unclaimedMessages).toEqual([]);

        for (const message of messages) {
          expect(message.startsWith(`${COVERAGE_PREFIX} `)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("leaves the Root_Manifest (its inputs) unmodified in every case (R12.18)", () => {
    fc.assert(
      fc.property(arbModel, ({ entries, packages }) => {
        const before = JSON.stringify({ entries, packages });
        checkWorkspaceCoverage(entries, packages);
        expect(JSON.stringify({ entries, packages })).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariance (a): permuting entries with the matched directory set fixed
// changes neither the verdict nor the message set (R12.16)
// ---------------------------------------------------------------------------

describe("Property 23 (invariance): entry-order permutation (R12.16)", () => {
  it("changes neither the verdict nor the message set when the matched set is held fixed", () => {
    fc.assert(
      fc.property(
        arbModel,
        fc.integer(),
        ({ entries, packages }, seed) => {
          // A permutation of the entries. Re-indexing does not change which
          // directories an entry matches — `matches` is fixed on the record —
          // so the set of directories the array matches is held fixed while its
          // order is scrambled.
          const permuted = shuffle(entries, seed).map((entry, index) => ({
            ...entry,
            index,
          }));

          const base = checkWorkspaceCoverage(entries, packages);
          const after = checkWorkspaceCoverage(permuted, packages);

          // The verdict (violation or not) is unchanged.
          expect(after.length === 0).toBe(base.length === 0);

          // The message count is unchanged: one message per reported package,
          // and which packages are reported cannot change under a permutation
          // that holds each package's match COUNT fixed.
          expect(after.length).toBe(base.length);

          // The set of reported packages is unchanged. A duplicate message
          // lists its two matching entries sorted by array index, so permuting
          // the array legitimately reorders those entries and their index
          // annotations within one message — R12.16 asks only that reordering
          // not change WHICH packages are reported, not the byte order of a
          // multi-entry listing. Comparing the reported package directories
          // (and the multiset of patterns each message names) captures exactly
          // that set property.
          expect(reportedSet(after)).toEqual(reportedSet(base));
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** A deterministic Fisher–Yates shuffle seeded by an integer. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = (seed | 0) ^ 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) | 0;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The set property each coverage message carries, order-free: the package
 * directory it reports, plus the multiset of entry patterns it names (indices
 * and listing order dropped, since a permutation legitimately reorders them).
 * Two message sets with the same value here report the same packages against
 * the same matching entries — which is exactly what R12.16 preserves.
 */
function reportedSet(messages: readonly string[]): string[] {
  const dirOf = (m: string): string => /at "([^"]+)"/.exec(m)?.[1] ?? m;
  const patternsOf = (m: string): string =>
    // Every quoted `packages/...` fragment except the one following `at`,
    // i.e. the entry patterns the message names, sorted so listing order and
    // index annotations do not matter.
    [...m.matchAll(/"(packages\/[^"]+)"/g)]
      .map((x) => x[1])
      .sort()
      .join("|");
  return [...messages].map((m) => `${dirOf(m)} :: ${patternsOf(m)}`).sort();
}

// ---------------------------------------------------------------------------
// Invariance (b): a dependency edge inside one entry is no violation (R12.19)
// ---------------------------------------------------------------------------

describe("Property 23 (invariance): dependency edge inside one entry (R12.19)", () => {
  it("reports no violation for an edge between two packages the same single entry matches", () => {
    fc.assert(
      fc.property(
        // Two-plus common packages, so `packages/common/*` matches both ends of
        // an edge with the same single entry. No orphan, no duplicate entry, so
        // coverage holds and any reported message would have to come from the
        // edge — which R12.19 says must be none.
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        (commonCount, edgeSeed) => {
          const members = membersOf({
            common: commonCount,
            spa: 0,
            microservices: 0,
            orphan: false,
          });
          const entries = CANONICAL_PATTERNS.map((pattern, index) =>
            resolveEntry(pattern, index, members),
          );

          // Add a dependency edge between two common packages the single
          // `packages/common/*` entry matches.
          const from = 0;
          const to = 1 + (edgeSeed % (commonCount - 1));
          const commonName = (i: number): string =>
            `@microservices/common${String(i)}`;

          const packages: WorkspacePackage[] = members.map((m) => ({
            packageDir: m.packageDir,
            name: m.name,
            dependencySpecifiers:
              m.name === commonName(from) ? [commonName(to)] : [],
          }));

          // With the edge present.
          const withEdge = checkWorkspaceCoverage(entries, packages);
          // Without the edge — the baseline.
          const withoutEdge = checkWorkspaceCoverage(
            entries,
            members.map((m) => ({
              packageDir: m.packageDir,
              name: m.name,
              dependencySpecifiers: [],
            })),
          );

          // The edge changes the verdict not at all, and reports no violation.
          expect(withEdge).toEqual([]);
          expect(withEdge).toEqual(withoutEdge);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariance (c): a glob matching zero directories is no violation (R12.20)
// ---------------------------------------------------------------------------

describe("Property 23 (invariance): zero-match glob (R12.20)", () => {
  it("contributes zero matches and is itself no violation", () => {
    fc.assert(
      fc.property(
        // No spa members, so `packages/spa/*` matches nothing. Everything else
        // is covered exactly once, so the only thing that could produce a
        // message is the empty glob — which R12.20 says is no violation.
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        (commonCount, microserviceCount) => {
          const members = membersOf({
            common: commonCount,
            spa: 0,
            microservices: microserviceCount,
            orphan: false,
          });
          const entries = CANONICAL_PATTERNS.map((pattern, index) =>
            resolveEntry(pattern, index, members),
          );

          const spaEntry = entries.find((e) => e.pattern === SPA_GLOB);
          expect(spaEntry?.matches).toEqual([]); // the glob matches nothing

          const packages: WorkspacePackage[] = members.map((m) => ({
            packageDir: m.packageDir,
            name: m.name,
            dependencySpecifiers: [],
          }));

          // The empty glob contributes zero matches to every package and is
          // itself reported nowhere.
          expect(checkWorkspaceCoverage(entries, packages)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Concrete cases: the message shapes R12.18 describes
// ---------------------------------------------------------------------------

describe("Property 23 (concrete): message shapes", () => {
  it("accepts a well-covered repository regardless of entry order", () => {
    const members = membersOf({
      common: 1,
      spa: 0,
      microservices: 1,
      orphan: false,
    });
    // A deliberately scrambled order: coverage carries no order meaning.
    const scrambled = [
      OVERSEER_DIR,
      MICROSERVICES_GLOB,
      CONTRACTS_DIR,
      INTEGRATION_TESTS_DIR,
      SPA_GLOB,
      BUILD_TOOLS_DIR,
      COMMON_GLOB,
    ];
    const entries = scrambled.map((pattern, index) =>
      resolveEntry(pattern, index, members),
    );
    const packages: WorkspacePackage[] = members.map((m) => ({
      packageDir: m.packageDir,
      name: m.name,
      dependencySpecifiers: [],
    }));

    expect(checkWorkspaceCoverage(entries, packages)).toEqual([]);
  });

  it("reports a package matched by no entry and one matched by two (R12.18)", () => {
    const withOrphan = membersOf({
      common: 1,
      spa: 0,
      microservices: 0,
      orphan: true,
    });
    // A duplicate exact entry for the common package, which the glob matches
    // too, inserted ahead of the last entry so the array stays well-formed.
    const patterns = [
      ...CANONICAL_PATTERNS.slice(0, -1),
      "packages/common/common0",
      INTEGRATION_TESTS_DIR,
    ];
    const entries = patterns.map((pattern, index) =>
      resolveEntry(pattern, index, withOrphan),
    );
    const packages: WorkspacePackage[] = withOrphan.map((m) => ({
      packageDir: m.packageDir,
      name: m.name,
      dependencySpecifiers: [],
    }));

    const messages = checkWorkspaceCoverage(entries, packages);

    expect(messages).toEqual([
      `${COVERAGE_PREFIX} package "@microservices/common0" at "packages/common/common0" is matched by 2 workspaces entries: "${COMMON_GLOB}" (index 2), "packages/common/common0" (index 6); exactly one entry must match it`,
      `${COVERAGE_PREFIX} package "@microservices/orphan" at "packages/orphan" is matched by no workspaces entry; exactly one entry must match it`,
    ]);
  });
});

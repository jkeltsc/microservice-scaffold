// Feature: package-categories, Property 5: The Package_Name_Lookup records exactly and resolves only on exact equality
// Feature: package-categories, Property 6: Duplicate declared names fail, naming every declaring directory
// Feature: package-categories, Property 7: An unusable or nameless manifest fails, naming the directory and the condition
// Feature: package-categories, Property 8: Every discovered Consumer_Package's declared name must mirror its directory
//
// All four properties concern the Package_Name_Lookup: what discovery records
// (R3.1), what a Dependency_Specifier resolves against (R3.2, R3.3), and the
// three ways a declared name can fail the run — an unusable manifest or an
// unusable name (R3.4, R3.5), a declared name of any Consumer_Category that
// does not mirror its directory (R3.6), and a name two packages both claim
// (R3.9).
//
// Everything runs through `discoverPackagesFrom(listContainer, readManifest)` —
// the pure core of Package_Discovery — over generated in-memory layouts, plus
// `requiredDependencies` where a property is about *resolution* rather than about
// recording. The container lister deliberately hands entries back in descending
// name order, so nothing here depends on the lister's ordering.
//
// The oracles are written from the requirements and from the design's documented
// message examples ("Error Taxonomy"), not from `discovery.ts`:
//
// - `declaredNameOf` restates R3.5's "declares a `name` that is a non-empty,
//   non-whitespace-only string" over the generated manifest, and R3.1's "that
//   exact declared string, with no trimming or case folding" by handing the
//   generated string back untouched. `Object.is` is the comparison, so a
//   trimmed or re-cased recording fails the assertion.
// - `resolvesTo` restates R3.2/R3.3/R3.7/R3.10 as a four-way decision over a
//   specifier: out of scope -> ignored, framework name -> resolved but not a
//   member, exactly equal to a recorded name -> that package, otherwise
//   unresolved. Nothing about a directory name enters it.
// - `duplicateClaims` restates R3.9 by counting claimants per name, seeded with
//   the Framework_Singletons' own declarations, since a framework directory
//   declares its name as surely as a container member does.
// - `manifestOffenders` / `nameOffenders` / `mirrorOffenders` restate R3.4,
//   R3.5, and R3.6 respectively, each as a predicate over one generated entry.
//   `mirrorOffenders` considers every Consumer_Category — Microservice_Package
//   included — because R3.6 no longer exempts any category.
// - `offenderMessage` restates the design's failure shape (a bracketed tag, a
//   count-bearing headline, one two-space-indented line per offender) so the
//   assertions can check the whole message rather than only its tag.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.9

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { requiredDependencies } from "../src/required-dependencies.js";
import {
  discoverPackagesFrom,
  type Discovery,
  type ListContainer,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";
import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";

// ---------------------------------------------------------------------------
// In-memory layout model
// ---------------------------------------------------------------------------

/** A manifest as it comes off disk: arbitrary parsed JSON. */
type Manifest = Record<string, unknown>;

/** How one generated package's `package.json` reads (the R3.4 outcomes). */
type ReadOutcome =
  | { readonly kind: "ok"; readonly manifest: Manifest }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unparsable" };

/** One generated container member. */
interface Entry {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  /** Repo-relative, e.g. "packages/common/config". */
  readonly packageDir: string;
  readonly outcome: ReadOutcome;
}

/** Sentinel for "the manifest declares no `name` key at all". */
const NO_NAME = Symbol("no name declared");

/** Ascending code-point comparison — the ordering every sort here uses. */
function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const FRAMEWORK_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.name,
);

/** Where a Framework_Singleton declares its name, keyed by that name. */
const FRAMEWORK_DIR_BY_NAME: ReadonlyMap<string, string> = new Map(
  FRAMEWORK_SINGLETONS.map((entry) => [entry.name, entry.packageDir]),
);

/**
 * A manifest that satisfies its category's contract (R4.1, R4.3) and declares
 * `name` as given, so that a layout built from these exercises the name stages
 * rather than the category-contract stage. `NO_NAME` omits the key entirely;
 * every other value — including a number, `null`, or `"  "` — is written
 * through verbatim, since R3.5 is about what an arbitrary manifest may hold.
 */
function manifestWith(
  category: ConsumerCategory,
  name: unknown,
  deps: readonly string[] = [],
): Manifest {
  const manifest: Manifest = { version: "0.0.0" };
  if (name !== NO_NAME) {
    manifest.name = name;
  }
  if (deps.length > 0) {
    manifest.dependencies = Object.fromEntries(deps.map((dep) => [dep, "*"]));
  }
  if (category === "common") {
    manifest.main = "./dist/index.js";
    manifest.types = "./dist/index.d.ts";
  }
  if (category === "spa") {
    manifest.scripts = { build: "vite build" };
  }
  return manifest;
}

/** A container member with a readable manifest declaring `name`. */
function okEntry(
  category: ConsumerCategory,
  dirName: string,
  name: unknown,
  deps: readonly string[] = [],
): Entry {
  return {
    category,
    dirName,
    packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
    outcome: { kind: "ok", manifest: manifestWith(category, name, deps) },
  };
}

/** A container member whose manifest read fails in one of the R3.4 ways. */
function failedEntry(
  category: ConsumerCategory,
  dirName: string,
  kind: "absent" | "unreadable" | "unparsable",
): Entry {
  return {
    category,
    dirName,
    packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
    outcome: { kind },
  };
}

// ---------------------------------------------------------------------------
// Injected readers over a layout
// ---------------------------------------------------------------------------

/**
 * A container lister over a layout. Every container is present (an absent
 * container is Property 4's subject), and entries come back in *descending*
 * name order so that any ordering downstream is discovery's own doing.
 */
function listerFor(entries: readonly Entry[]): ListContainer {
  return (containerDir) => {
    const category = CONSUMER_CATEGORIES.find(
      (candidate) => NAMESPACE_CONTAINER[candidate] === containerDir,
    );
    if (category === undefined) {
      return undefined;
    }
    return entries
      .filter((entry) => entry.category === category)
      .map((entry) => ({ name: entry.dirName, isDirectory: true }))
      .sort((a, b) => ascending(b.name, a.name));
  };
}

/** A manifest reader over a layout, recording every directory it is asked about. */
function readerFor(entries: readonly Entry[], asked: string[]): ReadManifest {
  const byDir = new Map<string, ReadOutcome>(
    entries.map((entry) => [entry.packageDir, entry.outcome]),
  );
  return (packageDir) => {
    asked.push(packageDir);
    const outcome = byDir.get(packageDir);
    if (outcome === undefined) {
      return { kind: "absent" };
    }
    switch (outcome.kind) {
      case "ok":
        return { kind: "ok", manifest: outcome.manifest as PackageManifest };
      case "absent":
        return { kind: "absent" };
      case "unreadable":
        return { kind: "unreadable" };
      case "unparsable":
        return { kind: "unparsable" };
    }
  };
}

/** Discovery over a layout, with the directories the manifest reader saw. */
function discover(entries: readonly Entry[]): {
  discovery: Discovery;
  asked: string[];
} {
  const asked: string[] = [];
  const discovery = discoverPackagesFrom(
    listerFor(entries),
    readerFor(entries, asked),
  );
  return { discovery, asked };
}

/** The message of a thrown error, or `undefined` when the call succeeded. */
function failureOf(entries: readonly Entry[]): string | undefined {
  try {
    discover(entries);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------

/**
 * The name an entry declares usably, or `undefined` (R3.5): a declared `name`
 * counts only when it is a string with at least one non-whitespace character.
 * The string is handed back untouched, which is what makes the R3.1 assertion
 * an equality against the *generated* value rather than a normalized one.
 */
function declaredNameOf(entry: Entry): string | undefined {
  if (entry.outcome.kind !== "ok") {
    return undefined;
  }
  const declared: unknown = entry.outcome.manifest.name;
  return typeof declared === "string" && declared.trim().length > 0
    ? declared
    : undefined;
}

/** The design's multi-offender failure shape: tag, headline, indented lines. */
function offenderMessage(
  tag: string,
  headline: string,
  lines: readonly string[],
): string {
  return `[${tag}] ${headline}\n${lines.map((line) => `  ${line}`).join("\n")}`;
}

/** Entries whose manifest cannot be used, with the condition R3.4 names. */
function manifestOffenders(
  entries: readonly Entry[],
): { entry: Entry; condition: string }[] {
  return entries
    .filter((entry) => entry.outcome.kind !== "ok")
    .map((entry) => ({
      entry,
      condition:
        entry.outcome.kind === "absent"
          ? "package.json is absent"
          : entry.outcome.kind === "unreadable"
            ? "package.json is unreadable"
            : "package.json is not parseable as JSON",
    }))
    .sort((a, b) => ascending(a.entry.packageDir, b.entry.packageDir));
}

/** Entries with a readable manifest but no usable declared name (R3.5). */
function nameOffenders(entries: readonly Entry[]): Entry[] {
  return entries
    .filter(
      (entry) =>
        entry.outcome.kind === "ok" && declaredNameOf(entry) === undefined,
    )
    .sort((a, b) => ascending(a.packageDir, b.packageDir));
}

/**
 * Entries of *any* Consumer_Category whose declared name is not exactly
 * `@microservices/` followed by the directory name (R3.6). The rule is now
 * category-blind, so a Microservice_Package is considered exactly like a
 * Common_Package or a Spa_Package.
 */
function mirrorOffenders(entries: readonly Entry[]): Entry[] {
  return entries
    .filter((entry) => declaredNameOf(entry) !== mirrorNameOf(entry.dirName))
    .sort((a, b) => ascending(a.packageDir, b.packageDir));
}

/** The name R3.6 requires of any discovered Consumer_Package in `dirName`. */
function mirrorNameOf(dirName: string): string {
  return `${WORKSPACE_SCOPE}/${dirName}`;
}

/**
 * Names claimed by more than one directory (R3.9), with every claimant sorted.
 * Seeded with the Framework_Singletons: each declares its name in its own
 * `package.json`, so a container member declaring a framework name is the
 * second claimant of it and the failure must name the framework directory too.
 */
function duplicateClaims(entries: readonly Entry[]): [string, string[]][] {
  const claimants = new Map<string, string[]>();
  const claim = (name: string, packageDir: string): void => {
    const held = claimants.get(name);
    if (held === undefined) {
      claimants.set(name, [packageDir]);
    } else {
      held.push(packageDir);
    }
  };

  for (const singleton of FRAMEWORK_SINGLETONS) {
    claim(singleton.name, singleton.packageDir);
  }
  for (const entry of entries) {
    const name = declaredNameOf(entry);
    if (name !== undefined) {
      claim(name, entry.packageDir);
    }
  }

  return [...claimants.entries()]
    .filter(([, dirs]) => dirs.length > 1)
    .map(([name, dirs]): [string, string[]] => [name, [...dirs].sort()])
    .sort(([a], [b]) => ascending(a, b));
}

/** What resolving one specifier against a set of recorded names must yield. */
type Resolution =
  /** Not an `@microservices` specifier: ignored, unresolved, no failure (R3.10). */
  | { readonly kind: "ignored" }
  /** A Framework_Singleton name: resolved, not followed, not a member (R3.7). */
  | { readonly kind: "framework" }
  /** Exactly equal to a recorded declared name (R3.2, R3.3). */
  | { readonly kind: "package"; readonly name: string }
  /** Matches nothing (R3.8). */
  | { readonly kind: "unresolved" };

/**
 * Resolution of one Dependency_Specifier, restated from R3.2/R3.3/R3.7/R3.10.
 * The only test applied to a recorded name is `===`: no prefix, alias,
 * version-range, or path matching, and no name derived from a directory.
 */
function resolvesTo(
  specifier: string,
  recordedNames: ReadonlySet<string>,
): Resolution {
  if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) {
    return { kind: "ignored" };
  }
  if (FRAMEWORK_NAMES.includes(specifier)) {
    return { kind: "framework" };
  }
  return recordedNames.has(specifier)
    ? { kind: "package", name: specifier }
    : { kind: "unresolved" };
}

// ---------------------------------------------------------------------------
// Near-miss specifiers
// ---------------------------------------------------------------------------

/**
 * The near-miss kinds Property 5 requires to resolve to nothing: a case-flipped
 * name, a prefixed or suffixed one, a whitespace-padded one, a version-ranged
 * one, a path-shaped one, and the name a directory *would* produce.
 */
type NearMiss =
  | "exact"
  | "upper"
  | "lower"
  | "flip-first"
  | "scope-cased"
  | "prefixed"
  | "suffixed"
  | "pad-left"
  | "pad-right"
  | "version-range"
  | "path"
  | "dir-derived";

const NEAR_MISSES: readonly NearMiss[] = [
  "exact",
  "upper",
  "lower",
  "flip-first",
  "scope-cased",
  "prefixed",
  "suffixed",
  "pad-left",
  "pad-right",
  "version-range",
  "path",
  "dir-derived",
];

/** Flip the case of the first character after the scope separator. */
function flipFirstCharAfterSlash(name: string): string {
  const at = name.indexOf("/");
  if (at < 0 || at + 1 >= name.length) {
    return name;
  }
  const char = name[at + 1];
  const flipped =
    char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
  return `${name.slice(0, at + 1)}${flipped}${name.slice(at + 2)}`;
}

/**
 * One near-miss of a package's declared name. `"exact"` and `"dir-derived"` are
 * in the set deliberately: the first must resolve, and the second must resolve
 * only when the package happens to declare its mirror name, which is the point
 * of "no resolvable name is derived from a directory name" (R3.3).
 */
function nearMissOf(kind: NearMiss, name: string, dirName: string): string {
  switch (kind) {
    case "exact":
      return name;
    case "upper":
      return name.toUpperCase();
    case "lower":
      return name.toLowerCase();
    case "flip-first":
      return flipFirstCharAfterSlash(name);
    case "scope-cased":
      return name.replace(WORKSPACE_SCOPE, "@Microservices");
    case "prefixed":
      return `x${name}`;
    case "suffixed":
      return `${name}x`;
    case "pad-left":
      return ` ${name}`;
    case "pad-right":
      return `${name} `;
    case "version-range":
      return `${name}@^1.0.0`;
    case "path":
      return `../../${dirName}`;
    case "dir-derived":
      return mirrorNameOf(dirName);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Directory names to draw from. None is a Framework_Singleton directory, and no
 * two differ only by case, so a case-changing name style cannot accidentally
 * collide with another entry's mirror name.
 */
const DIR_POOL: readonly string[] = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "config",
  "portal",
  "admin",
  "Zed",
  "x9",
  "ümlaut",
];

/**
 * Every Consumer_Category — Microservice_Package included — now declares its
 * mirror name in Properties 5 and 6's layouts. Before 13.10 a microservice
 * could name itself freely, and these properties (resolution and uniqueness)
 * drew from a variety of non-mirroring microservice styles; 13.10 made
 * mirroring (R3.6) category-blind and stage-ordered before resolution and
 * uniqueness, so a non-mirroring name never reaches the stage either property
 * tests. Property 5's near-miss variety therefore lives on the *specifier* side
 * (`NEAR_MISSES` / `nearMissOf`), and Property 6 collides only through mirror
 * names (see `arbCollidingLayout`).
 */

/** A set of distinct directory names, one per generated entry. */
function arbDirs(maxLength: number): fc.Arbitrary<string[]> {
  return fc.uniqueArray(fc.constantFrom(...DIR_POOL), {
    minLength: 1,
    maxLength,
  });
}

const arbCategory: fc.Arbitrary<ConsumerCategory> = fc.constantFrom(
  ...CONSUMER_CATEGORIES,
);

/**
 * A layout that passes every validation stage: distinct directories, every
 * member of every category — Microservice_Package included — mirroring its
 * directory. Since 13.10's stage-3 rule (R3.6) is category-blind, a
 * non-mirroring declared name of any category throws `[discovery:mirror]`
 * before resolution or recording runs, so a layout that is to reach the
 * recording (R3.1) and resolution (R3.2, R3.3) stages Property 5 tests must
 * declare mirror names throughout. Property 5's near-miss variety therefore
 * lives on the *specifier* side (`NEAR_MISSES` / `nearMissOf`), not on the
 * declared-name side: the case-flipped, padded, prefixed, version-ranged, and
 * path-shaped strings are what a consumer *asks for* against these mirroring
 * packages.
 */
const arbValidLayout: fc.Arbitrary<Entry[]> = fc
  .record({
    dirs: arbDirs(8),
    categories: fc.array(arbCategory, { minLength: 8, maxLength: 8 }),
  })
  .map(({ dirs, categories }) =>
    dirs.map((dirName, index) =>
      okEntry(categories[index], dirName, mirrorNameOf(dirName)),
    ),
  );

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

// Feature: package-categories, Property 5: The Package_Name_Lookup records exactly and resolves only on exact equality
describe("Property 5: the Package_Name_Lookup records exactly and resolves only on exact equality", () => {
  it("records each declared name byte for byte, keyed by the package directory", () => {
    fc.assert(
      fc.property(arbValidLayout, (entries) => {
        // A generated layout with two claimants of one name is Property 6's
        // subject; skip it here rather than assert a recording that never
        // happens.
        fc.pre(duplicateClaims(entries).length === 0);

        const { discovery } = discover(entries);

        // One entry per discovered package, keyed by repo-relative directory,
        // holding the declared string with no trimming or case folding (R3.1).
        expect(discovery.nameByDir.size).toBe(entries.length);
        for (const entry of entries) {
          const declared = declaredNameOf(entry);
          expect(
            Object.is(discovery.nameByDir.get(entry.packageDir), declared),
          ).toBe(true);
        }
        expect([...discovery.nameByDir.keys()].sort(ascending)).toEqual(
          entries.map((entry) => entry.packageDir).sort(ascending),
        );

        // The resolution index is keyed by those same exact strings and is
        // injective, so it is usable as the thing a specifier is matched
        // against (R3.2).
        expect(discovery.byName.size).toBe(entries.length);
        for (const entry of entries) {
          const declared = declaredNameOf(entry);
          expect(declared).toBeDefined();
          const resolved = discovery.byName.get(declared as string);
          expect(resolved?.packageDir).toBe(entry.packageDir);
          expect(Object.is(resolved?.name, declared)).toBe(true);
          expect(resolved?.category).toBe(entry.category);
        }

        // The per-category members carry the same recorded names.
        for (const category of CONSUMER_CATEGORIES) {
          for (const pkg of discovery.byCategory[category]) {
            expect(discovery.nameByDir.get(pkg.packageDir)).toBe(pkg.name);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("resolves a specifier only when it equals a recorded name character for character", () => {
    fc.assert(
      fc.property(arbValidLayout, (entries) => {
        fc.pre(duplicateClaims(entries).length === 0);

        const { discovery } = discover(entries);
        const recorded = new Set(
          entries.map((entry) => declaredNameOf(entry) as string),
        );

        for (const entry of entries) {
          const declared = declaredNameOf(entry) as string;
          for (const kind of NEAR_MISSES) {
            const specifier = nearMissOf(kind, declared, entry.dirName);
            const expected = resolvesTo(specifier, recorded);

            // The index resolves on exact equality and on nothing else: a
            // case-flipped, prefixed, suffixed, whitespace-padded,
            // version-ranged, or path-shaped near-miss is simply absent — as is
            // a name derived from a directory the package does not mirror
            // (R3.2, R3.3).
            const hit = discovery.byName.get(specifier);
            if (recorded.has(specifier)) {
              expect(hit?.name).toBe(specifier);
            } else {
              expect(hit).toBeUndefined();
              expect(expected.kind).not.toBe("package");
            }
          }
        }

        // No resolvable name is derived from a directory name: unless a package
        // declares its mirror name, the mirror name resolves to nothing (R3.3).
        for (const entry of entries) {
          const mirrored = mirrorNameOf(entry.dirName);
          expect(discovery.byName.has(mirrored)).toBe(recorded.has(mirrored));
        }

        // A Framework_Singleton is never in the consumer resolution index; it
        // resolves through the Framework_Constants_Module instead (R3.7).
        for (const name of FRAMEWORK_NAMES) {
          expect(discovery.byName.has(name)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("resolves a Dependency_Resolver specifier only on exact equality with a recorded name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIR_POOL),
        fc.constantFrom(...DIR_POOL),
        fc.constantFrom(...NEAR_MISSES),
        (targetDir, serviceDir, kind) => {
          fc.pre(targetDir !== serviceDir);

          // Both the target and the depending microservice mirror their
          // directories, so the layout clears stage 3 (R3.6) and the resolution
          // stage this property tests is what decides the run. The near-miss
          // variety is on the *specifier* the service declares, below.
          const target = okEntry("common", targetDir, mirrorNameOf(targetDir));
          const service = okEntry(
            "microservice",
            serviceDir,
            mirrorNameOf(serviceDir),
          );
          const entries = [target, service];
          fc.pre(duplicateClaims(entries).length === 0);

          const { discovery } = discover(entries);
          const recorded = new Set(
            entries.map((entry) => declaredNameOf(entry) as string),
          );

          const specifier = nearMissOf(
            kind,
            mirrorNameOf(targetDir),
            targetDir,
          );
          const expected = resolvesTo(specifier, recorded);
          const readDependencies = (packageDir: string): readonly string[] =>
            packageDir === service.packageDir ? [specifier] : [];

          const resolve = (): readonly { packageDir: string }[] =>
            requiredDependencies([serviceDir], discovery, readDependencies);

          if (expected.kind === "package") {
            // Only the exact declared name (and, when the target mirrors its
            // directory, the identical directory-derived string) resolves.
            expect(resolve().map((pkg) => pkg.packageDir)).toEqual([
              target.packageDir,
            ]);
          } else if (expected.kind === "unresolved") {
            // Every other in-scope near-miss matches nothing and is reported
            // against the declaring directory (R3.2, R3.8).
            expect(resolve).toThrow(
              `[shared:unresolved] "${service.packageDir}" depends on unknown ${WORKSPACE_SCOPE} package(s): "${specifier}"`,
            );
          } else {
            // Out of scope (a padded or re-cased scope, a relative path): not a
            // Dependency_Specifier at all, so it is ignored without failing
            // (R3.10) — and a framework name resolves without becoming a
            // member (R3.7).
            expect(resolve()).toEqual([]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("derives no resolvable name from a directory that declares no matching name", () => {
    // R3.3: the only resolvable names are the recorded declared strings; the
    // resolver invents none from a directory name. Since 13.10 forces every
    // Consumer_Package to mirror its directory (R3.6), the single legal member
    // here declares `@microservices/alpha`, which resolves *because it is the
    // recorded declared name* — not because it is directory-derived. A
    // specifier naming a directory that holds no package (`@microservices/beta`)
    // is a directory-derived string with no recorded name behind it, so it
    // resolves to nothing rather than to "whatever sits in `packages/.../beta`".
    const service = okEntry("microservice", "alpha", mirrorNameOf("alpha"));
    const { discovery } = discover([service]);

    expect(discovery.nameByDir.get(service.packageDir)).toBe(
      mirrorNameOf("alpha"),
    );
    // The declared name resolves; the directory-derived name of an empty
    // directory does not — nothing is synthesized from `beta`'s directory.
    expect(discovery.byName.has(mirrorNameOf("alpha"))).toBe(true);
    expect(discovery.byName.has(mirrorNameOf("beta"))).toBe(false);
    expect(() =>
      requiredDependencies([], discovery, (packageDir) =>
        packageDir === OVERSEER.packageDir ? [mirrorNameOf("beta")] : [],
      ),
    ).toThrow(
      `[shared:unresolved] "${OVERSEER.packageDir}" depends on unknown ${WORKSPACE_SCOPE} package(s): "${mirrorNameOf("beta")}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

/**
 * How a generated layout is made to claim one name twice.
 *
 * Reconciliation with the stage order (option (a) of the task guidance): since
 * 13.10 made mirroring (stage 3) category-blind and it runs *before* the
 * duplicate stage (stage 4), an entry that collides by declaring some *other*
 * package's or Framework_Singleton's name is — by construction — also NOT its
 * own mirror name, so it would fail with `[discovery:mirror]` and the run would
 * never reach the duplicate stage. Those "steal a name" collisions therefore no
 * longer exercise R3.9 at all; they exercise R3.6.
 *
 * The one collision that survives mirroring is `other-container`: two directories
 * of the *same name* in two different mirroring containers (e.g. `common/config`
 * and `spa/config`) each legitimately mirror their directory — each clears stage
 * 3 — yet both declare the identical `@microservices/config`, so the duplicate
 * stage is what fails. This is the collision that keeps Property 6 a faithful,
 * non-vacuous test of R3.9's duplicate rule under the new stage order. (A
 * microservice-vs-framework or microservice-steal collision is covered by
 * Property 8 / stage 3 instead, and its dedicated example test below asserts the
 * new `[discovery:mirror]` verdict for it.)
 */
type Collision =
  | "none"
  /** The same directory name in the other mirroring container (R3.6-legal, R3.9-duplicate). */
  | "other-container";

const COLLISIONS: readonly Collision[] = ["none", "other-container"];

/**
 * A layout whose every member of every category mirrors its directory — so
 * stages 1–3 pass and the duplicate stage is what decides the run — with the
 * only mirroring-compatible collision injected on purpose: two containers
 * holding the same directory name, each declaring the identical mirror name.
 */
const arbCollidingLayout: fc.Arbitrary<Entry[]> = fc
  .record({
    dirs: arbDirs(5),
    categories: fc.array(arbCategory, { minLength: 5, maxLength: 5 }),
    collisions: fc.array(fc.constantFrom(...COLLISIONS), {
      minLength: 5,
      maxLength: 5,
    }),
  })
  .map(({ dirs, categories, collisions }) => {
    const base = dirs.map((dirName, index) =>
      okEntry(categories[index], dirName, mirrorNameOf(dirName)),
    );

    const extra: Entry[] = [];
    base.forEach((entry, index) => {
      switch (collisions[index]) {
        case "none":
          break;
        case "other-container":
          // Two directories of the same name in two different containers both
          // mirror that name, so both declare the identical
          // `@microservices/<dir>` from different containers and neither is a
          // mirror offender — the collision reaches and fails the duplicate
          // stage (R3.9). A microservice cannot participate: a second
          // microservice of the same directory name would be the same
          // directory, and stealing a peer's name is a stage-3 mirror
          // violation, not a duplicate.
          if (entry.category === "common") {
            extra.push(
              okEntry("spa", entry.dirName, mirrorNameOf(entry.dirName)),
            );
          } else if (entry.category === "spa") {
            extra.push(
              okEntry("common", entry.dirName, mirrorNameOf(entry.dirName)),
            );
          }
          // A microservice draws `other-container` too, but has no sibling
          // container to duplicate into, so it contributes no collision — a
          // deliberate "none" outcome that keeps the generator total.
          break;
      }
    });

    return [...base, ...extra];
  });

// Feature: package-categories, Property 6: Duplicate declared names fail, naming every declaring directory
describe("Property 6: duplicate declared names fail, naming every declaring directory", () => {
  it("fails exactly when a name has two claimants, naming the name and every directory", () => {
    fc.assert(
      fc.property(arbCollidingLayout, (entries) => {
        const duplicated = duplicateClaims(entries);
        const message = failureOf(entries);

        if (duplicated.length === 0) {
          expect(message).toBeUndefined();
          return;
        }

        // One failure carrying every duplicated name, each with every directory
        // declaring it — including a Framework_Singleton's own directory, since
        // it declares its name as surely as a container member does (R3.9).
        expect(message).toBe(
          offenderMessage(
            "discovery:duplicate",
            `${String(duplicated.length)} package name(s) are declared by more than one package:`,
            duplicated.map(
              ([name, dirs]) =>
                `"${name}" — ${dirs.map((dir) => `"${dir}"`).join(", ")}`,
            ),
          ),
        );

        // Every claimant directory is named, and no other directory is.
        for (const [, dirs] of duplicated) {
          for (const dir of dirs) {
            expect(message).toContain(`"${dir}"`);
          }
        }

        // Repeated runs over an unchanged layout produce identical output.
        expect(failureOf(entries)).toBe(message);
      }),
      { numRuns: 200 },
    );
  });

  it("fails on a cross-container collision, naming both containers", () => {
    // The same directory name in `common` and `spa`: both mirror it, so both
    // declare `@microservices/config` and neither is at fault on its own.
    const entries = [
      okEntry("common", "config", mirrorNameOf("config")),
      okEntry("spa", "config", mirrorNameOf("config")),
    ];
    expect(failureOf(entries)).toBe(
      offenderMessage(
        "discovery:duplicate",
        "1 package name(s) are declared by more than one package:",
        [
          `"${mirrorNameOf("config")}" — "${NAMESPACE_CONTAINER.common}/config", "${NAMESPACE_CONTAINER.spa}/config"`,
        ],
      ),
    );
  });

  it("catches a member claiming a Framework_Singleton's name at the mirror stage, not the duplicate stage", () => {
    // Before 13.10 a microservice could name itself freely, so a microservice
    // declaring a Framework_Singleton's name was a pure duplicate (stage 4). Now
    // that name is by construction not `@microservices/svc`, so it is first a
    // mirror offender (stage 3), which runs before the duplicate stage — so the
    // run fails with `[discovery:mirror]` and never reaches the duplicate check.
    // The framework-name *duplicate* is thus unreachable through a
    // Consumer_Package; this example pins the stage-order verdict so the shift
    // is a documented, tested consequence of the universal mirroring rule
    // rather than a silent behavior change. `FRAMEWORK_DIR_BY_NAME` still
    // records where each framework name is declared, per R3.9's seeding.
    for (const singleton of FRAMEWORK_SINGLETONS) {
      const entries = [okEntry("microservice", "svc", singleton.name)];
      expect(failureOf(entries)).toBe(
        offenderMessage(
          "discovery:mirror",
          "1 discovered package(s) declare a name that does not mirror the directory:",
          [
            `"${NAMESPACE_CONTAINER.microservice}/svc" — declared "${singleton.name}", expected "${mirrorNameOf("svc")}"`,
          ],
        ),
      );
      expect(FRAMEWORK_DIR_BY_NAME.get(singleton.name)).toBe(
        singleton.packageDir,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

/** How one generated entry's manifest and `name` are broken, or not. */
type ManifestState =
  | "ok"
  | "absent"
  | "unreadable"
  | "unparsable"
  | "name-missing"
  | "name-number"
  | "name-null"
  | "name-boolean"
  | "name-object"
  | "name-array"
  | "name-empty"
  | "name-spaces"
  | "name-tabs";

const MANIFEST_STATES: readonly ManifestState[] = [
  "ok",
  "absent",
  "unreadable",
  "unparsable",
  "name-missing",
  "name-number",
  "name-null",
  "name-boolean",
  "name-object",
  "name-array",
  "name-empty",
  "name-spaces",
  "name-tabs",
];

/** The `name` value a broken-name state declares. */
function brokenName(state: ManifestState): unknown {
  switch (state) {
    case "name-missing":
      return NO_NAME;
    case "name-number":
      return 42;
    case "name-null":
      return null;
    case "name-boolean":
      return true;
    case "name-object":
      return { scope: "@microservices" };
    case "name-array":
      return ["@microservices/alpha"];
    case "name-empty":
      return "";
    case "name-spaces":
      return "   ";
    default:
      return "\t\n ";
  }
}

/**
 * A layout mixing the three manifest-read outcomes with every unusable-`name`
 * shape. Directory names are distinct and every usable name mirrors its
 * directory, so stages 3 and 4 have nothing to report and stages 1 and 2 decide
 * the run.
 */
const arbBrokenLayout: fc.Arbitrary<Entry[]> = fc
  .record({
    dirs: arbDirs(6),
    categories: fc.array(arbCategory, { minLength: 6, maxLength: 6 }),
    states: fc.array(fc.constantFrom(...MANIFEST_STATES), {
      minLength: 6,
      maxLength: 6,
    }),
  })
  .map(({ dirs, categories, states }) =>
    dirs.map((dirName, index) => {
      const category = categories[index];
      const state = states[index];
      if (
        state === "absent" ||
        state === "unreadable" ||
        state === "unparsable"
      ) {
        return failedEntry(category, dirName, state);
      }
      return okEntry(
        category,
        dirName,
        state === "ok" ? mirrorNameOf(dirName) : brokenName(state),
      );
    }),
  );

// Feature: package-categories, Property 7: An unusable or nameless manifest fails, naming the directory and the condition
describe("Property 7: an unusable or nameless manifest fails, naming the directory and the condition", () => {
  it("reports every unusable manifest with its condition, then every unusable name", () => {
    fc.assert(
      fc.property(arbBrokenLayout, (entries) => {
        const unusable = manifestOffenders(entries);
        const nameless = nameOffenders(entries);

        // Nothing is produced when a stage fails: no Package_Name_Lookup, and
        // therefore no Microservice_Registry, Project_List, or Image_Tree, since
        // every one of those is derived from the discovery result that never
        // came back (R3.4, R4.8).
        let discovery: Discovery | undefined;
        let message: string | undefined;
        const asked: string[] = [];
        try {
          discovery = discoverPackagesFrom(
            listerFor(entries),
            readerFor(entries, asked),
          );
        } catch (error) {
          message = (error as Error).message;
        }

        if (unusable.length > 0) {
          expect(discovery).toBeUndefined();
          expect(message).toBe(
            offenderMessage(
              "discovery:manifest",
              `cannot read the package.json of ${String(unusable.length)} discovered package(s):`,
              unusable.map(
                ({ entry, condition }) =>
                  `"${entry.packageDir}" — ${condition}`,
              ),
            ),
          );
          // Every candidate was read before failing, so one run names every
          // offender rather than only the first.
          expect(new Set(asked)).toEqual(
            new Set(entries.map((entry) => entry.packageDir)),
          );
          return;
        }

        if (nameless.length > 0) {
          expect(discovery).toBeUndefined();
          expect(message).toBe(
            offenderMessage(
              "discovery:name",
              `${String(nameless.length)} discovered package(s) declare no usable "name":`,
              nameless.map(
                (entry) =>
                  `"${entry.packageDir}" — the declared name is missing or empty`,
              ),
            ),
          );
          return;
        }

        // Every manifest usable and every name usable: the run succeeds and the
        // Package_Name_Lookup covers exactly the discovered packages.
        expect(message).toBeUndefined();
        expect(discovery?.nameByDir.size).toBe(entries.length);
      }),
      { numRuns: 200 },
    );
  });

  it("names the condition that occurred for each of the three read outcomes", () => {
    const conditions = {
      absent: "package.json is absent",
      unreadable: "package.json is unreadable",
      unparsable: "package.json is not parseable as JSON",
    } as const;

    for (const kind of ["absent", "unreadable", "unparsable"] as const) {
      const entry = failedEntry("common", "config", kind);
      expect(failureOf([entry])).toBe(
        offenderMessage(
          "discovery:manifest",
          "cannot read the package.json of 1 discovered package(s):",
          [`"${entry.packageDir}" — ${conditions[kind]}`],
        ),
      );
    }
  });

  it("reports an unusable manifest before an unusable name", () => {
    // Stage order is fixed, so a repository broken in both ways reports the
    // same first failure every time (R4.7).
    const entries = [
      failedEntry("microservice", "alpha", "unparsable"),
      okEntry("common", "config", ""),
    ];
    expect(failureOf(entries)).toContain("[discovery:manifest]");
  });
});

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

/**
 * How a discovered Consumer_Package of *any* category names itself relative to
 * its directory. `"mirror"` is the only style R3.6 admits; every other style is
 * a case-flipped, prefixed, suffixed, whitespace-padded, unscoped, re-cased, or
 * wrong-directory near-miss that must now fail for a Microservice_Package
 * exactly as it does for a Common_Package or a Spa_Package.
 */
type MirrorStyle =
  | "mirror"
  | "upper"
  | "flip-first"
  | "prefixed"
  | "suffixed"
  | "pad-left"
  | "pad-right"
  | "unscoped"
  | "scope-cased"
  | "other-dir";

const MIRROR_STYLES: readonly MirrorStyle[] = [
  "mirror",
  "upper",
  "flip-first",
  "prefixed",
  "suffixed",
  "pad-left",
  "pad-right",
  "unscoped",
  "scope-cased",
  "other-dir",
];

/** The name a member of any category declares under one style; always non-blank. */
function mirrorStyleName(style: MirrorStyle, dirName: string): string {
  const mirrored = mirrorNameOf(dirName);
  switch (style) {
    case "mirror":
      return mirrored;
    case "upper":
      return mirrored.toUpperCase();
    case "flip-first":
      return flipFirstCharAfterSlash(mirrored);
    case "prefixed":
      return `${WORKSPACE_SCOPE}/pkg-${dirName}`;
    case "suffixed":
      return `${mirrored}-lib`;
    case "pad-left":
      return ` ${mirrored}`;
    case "pad-right":
      return `${mirrored} `;
    case "unscoped":
      return dirName;
    case "scope-cased":
      return mirrored.replace(WORKSPACE_SCOPE, "@Microservices");
    case "other-dir":
      return mirrorNameOf(`${dirName}-other`);
  }
}

/**
 * A layout of Common, Spa, and Microservice members whose declared names vary
 * across mirroring and every kind of near-miss — the *same* mirror styles for
 * every category, because R3.6 now applies to every category alike. Manifests
 * are readable and names are non-blank, so stages 1 and 2 pass and mirroring
 * decides the run.
 */
const arbMirrorLayout: fc.Arbitrary<Entry[]> = fc
  .record({
    dirs: arbDirs(6),
    categories: fc.array(arbCategory, { minLength: 6, maxLength: 6 }),
    mirrorStyles: fc.array(fc.constantFrom(...MIRROR_STYLES), {
      minLength: 6,
      maxLength: 6,
    }),
  })
  .map(({ dirs, categories, mirrorStyles }) =>
    dirs.map((dirName, index) =>
      okEntry(
        categories[index],
        dirName,
        mirrorStyleName(mirrorStyles[index], dirName),
      ),
    ),
  );

// Feature: package-categories, Property 8: Every discovered Consumer_Package's declared name must mirror its directory
describe("Property 8: every discovered Consumer_Package's declared name must mirror its directory", () => {
  it("fails exactly for the members of any category whose name does not mirror the directory", () => {
    fc.assert(
      fc.property(arbMirrorLayout, (entries) => {
        const offenders = mirrorOffenders(entries);
        const message = failureOf(entries);

        if (offenders.length > 0) {
          // Mirroring is checked before uniqueness, so this is the failure a
          // layout with both problems reports. Every offender — Microservice,
          // Common, and Spa alike — appears in the one sorted, run-stable
          // failure (R3.6).
          expect(message).toBe(
            offenderMessage(
              "discovery:mirror",
              `${String(offenders.length)} discovered package(s) declare a name that does not mirror the directory:`,
              offenders.map(
                (entry) =>
                  `"${entry.packageDir}" — declared "${declaredNameOf(entry) ?? ""}", expected "${mirrorNameOf(entry.dirName)}"`,
              ),
            ),
          );

          // The check is category-blind: a Microservice_Package whose declared
          // name diverges from its directory is named exactly as a Common or
          // Spa offender is, and never exempted (R3.6, R4.5).
          for (const entry of offenders) {
            if (entry.category === "microservice") {
              expect(message).toContain(`"${entry.packageDir}" — declared`);
            }
          }

          // Repeated runs over an unchanged layout produce identical output.
          expect(failureOf(entries)).toBe(message);
          return;
        }

        // Every member of every category mirrors: mirroring raises nothing. A
        // remaining duplicate is Property 6's subject.
        if (duplicateClaims(entries).length > 0) {
          expect(message).toContain("[discovery:duplicate]");
          return;
        }
        expect(message).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it("applies the mirroring check to a Microservice_Package exactly as to a Common_Package", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIR_POOL),
        fc.constantFrom(...MIRROR_STYLES),
        (dirName, style) => {
          const declared = mirrorStyleName(style, dirName);

          // The identical declared name in a microservice directory and in a
          // common directory produces the identical mirror verdict: both pass
          // when it mirrors, both fail with the same message shape otherwise.
          const service = okEntry("microservice", dirName, declared);
          const common = okEntry("common", dirName, declared);

          const expected =
            style === "mirror"
              ? undefined
              : offenderMessage(
                  "discovery:mirror",
                  "1 discovered package(s) declare a name that does not mirror the directory:",
                  [
                    `"__DIR__" — declared "${declared}", expected "${mirrorNameOf(dirName)}"`,
                  ],
                );

          const serviceMessage = failureOf([service]);
          const commonMessage = failureOf([common]);

          if (expected === undefined) {
            expect(serviceMessage).toBeUndefined();
            expect(commonMessage).toBeUndefined();
          } else {
            expect(serviceMessage).toBe(
              expected.replace("__DIR__", service.packageDir),
            );
            expect(commonMessage).toBe(
              expected.replace("__DIR__", common.packageDir),
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("names the directory, the declared name, and the expected name, for every category", () => {
    for (const category of CONSUMER_CATEGORIES) {
      const entry = okEntry(category, "config", `${WORKSPACE_SCOPE}/Config`);
      expect(failureOf([entry])).toBe(
        offenderMessage(
          "discovery:mirror",
          "1 discovered package(s) declare a name that does not mirror the directory:",
          [
            `"${entry.packageDir}" — declared "${WORKSPACE_SCOPE}/Config", expected "${mirrorNameOf("config")}"`,
          ],
        ),
      );
    }
  });
});

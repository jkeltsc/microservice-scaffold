// Shared fast-check arbitraries for the layout-metamorphic property suite of
// Step 11 (Properties 11, 12, 13, 16, 17).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it. It
// lives under `tests/arbitraries/` alongside `config.ts` and `tsconfig.ts`; the
// point of putting the generators in one place is that two properties drawing
// from `synthesizedTree()` genuinely draw from the *same* inputs.
//
// IN-MEMORY ONLY. Nothing here is ever materialised on disk. A Synthesized_Tree
// is a plain description object plus the two injected functions the pure core of
// Package_Discovery takes — `ListRoot` and `ReadManifest` — so every property
// runs `discoverPackagesFrom(context, listRoot, readManifest)` against values
// held in memory, with no filesystem at all. This is exactly what Requirements
// 13.5 and 13.6 mean by "a Synthesized_Tree is either in-memory inputs to a pure
// function or a directory inside an OS temporary directory": these are the pure
// half.
//
// The design's Testing Strategy fixes the surface:
//
//   - `synthesizedTree()` — 0 to 5 packages per category, each carrying a
//     manifest whose fields satisfy or violate its category's contract, with
//     `@`-scoped dependency specifiers drawn from the tree's own declared names
//     so a specifier always resolves.
//   - `acyclicTree()` — a `synthesizedTree()` whose dependency edges are
//     restricted to a generated topological numbering, for Property 16.
//   - `relocatedAs(tree, roots)` and `rescopedAs(tree, scope)` — the two
//     metamorphic transformations of Properties 11 and 12, written as functions
//     rather than arbitraries, so a property reads as "run the same tree twice".
//   - `importLayout()` — per-package import specifier sets for Property 17,
//     including peer-microservice, Overseer, Spa_Package and escaping-relative
//     specifiers as labelled positives, so the expected violation set is known
//     by construction rather than recomputed by a second checker.

import * as fc from "fast-check";

import {
  CONSUMER_CATEGORIES,
  type ConsumerCategory,
} from "../../src/framework.js";
import {
  type ListRoot,
  type PackageManifest,
  type ReadManifest,
  type RootEntry,
} from "../../src/discovery.js";
import { SCOPE_DEFAULT } from "../../src/project-config.js";

// ---------------------------------------------------------------------------
// The description model
// ---------------------------------------------------------------------------

/** A per-category root assignment, in the same shape `context.roots` carries. */
export type RootAssignment = Readonly<Record<ConsumerCategory, string>>;

/**
 * One synthesized Consumer_Package, described independently of any root or scope.
 *
 * `defect` records the ONE way (if any) this package's manifest departs from what
 * discovery accepts, so Property 13 can name the expected failure without a
 * second copy of the validation rules. A `defect` of `undefined` means the
 * manifest is fully conforming for its category.
 */
export interface PackageSpec {
  readonly category: ConsumerCategory;
  /** Directory name inside its category's Discovery_Root, e.g. "config". */
  readonly dirName: string;
  /**
   * The bare (unscoped) directory-mirroring specifiers this package declares as
   * `@scope/<name>` dependencies. Every entry is another package's directory
   * name drawn from the SAME tree, so under any scope the specifier resolves.
   */
  readonly dependencyDirNames: readonly string[];
  /** The single manifest defect this package carries, if any (Property 13). */
  readonly defect: PackageDefect | undefined;
}

/** The one way a synthesized package's manifest may be non-conforming (R6.12). */
export type PackageDefect =
  /** Declares no `name` at all (R3.5 → `[discovery:name]`). */
  | { readonly kind: "no-name" }
  /** Declares a `name` that does not mirror `@scope/<dirName>` (R3.6 → mirror). */
  | { readonly kind: "non-mirroring-name" }
  /** `package.json` cannot be read (→ `[discovery:manifest]`). */
  | { readonly kind: "unreadable" }
  /** `package.json` is not parseable as JSON (→ `[discovery:manifest]`). */
  | { readonly kind: "unparsable" }
  /** Fails the category manifest contract (R4.1/R4.3 → `[barrel:invalid]`). */
  | { readonly kind: "contract" };

/**
 * A whole synthesized repository layout, described independently of the roots it
 * is rooted at and the scope its names are composed under. `relocatedAs` and
 * `rescopedAs` are total over this shape.
 */
export interface TreeDescription {
  readonly packages: readonly PackageSpec[];
  /** The per-category Discovery_Roots this description is currently rooted at. */
  readonly roots: RootAssignment;
  /** The Configured_Scope this description's names are composed under. */
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// Deriving the discovery inputs from a description
// ---------------------------------------------------------------------------

/** The scoped package name a spec declares: `<scope>/<dirName>` unless a defect
 *  overrides it. A `non-mirroring-name` defect declares a name that cannot mirror
 *  any directory; a `no-name` defect declares no `name` field at all. */
function declaredNameOf(spec: PackageSpec, scope: string): string | undefined {
  if (spec.defect?.kind === "no-name") return undefined;
  if (spec.defect?.kind === "non-mirroring-name") {
    return `${scope}/not-${spec.dirName}`;
  }
  return `${scope}/${spec.dirName}`;
}

/** The scoped dependency specifiers a spec declares under a scope: every
 *  `dependencyDirNames` entry composed as `<scope>/<name>`. */
function dependencySpecifiersOf(
  spec: PackageSpec,
  scope: string,
): readonly string[] {
  return spec.dependencyDirNames.map((dirName) => `${scope}/${dirName}`);
}

/** The `package.json` object a conforming spec of `category` declares. Common
 *  packages owe a barrel (`main`/`types`); spa packages owe `scripts.build`;
 *  microservices owe neither. A `contract` defect strips the owed field. */
function conformingManifest(
  spec: PackageSpec,
  scope: string,
): Record<string, unknown> {
  const name = declaredNameOf(spec, scope);
  const manifest: Record<string, unknown> = {};
  if (name !== undefined) manifest.name = name;

  const deps: Record<string, string> = {};
  for (const specifier of dependencySpecifiersOf(spec, scope)) {
    deps[specifier] = "*";
  }
  // A non-@microservices dependency is always present, to prove discovery
  // ignores unscoped keys; it never resolves to a package in the tree.
  deps.express = "^5.1.0";
  manifest.dependencies = deps;

  const contractBroken = spec.defect?.kind === "contract";

  if (spec.category === "common") {
    if (!contractBroken) {
      manifest.main = "./dist/index.js";
      manifest.types = "./dist/index.d.ts";
    }
  } else if (spec.category === "spa") {
    manifest.scripts = contractBroken
      ? { test: "vitest --run" }
      : { build: "vite build", test: "vitest --run" };
  }
  return manifest;
}

/** The direct entries a root lister reports for one category under `roots`,
 *  ascending — plus a stable non-package noise file so discovery's own filter,
 *  not the lister, is what drops non-directories. */
function entriesOf(
  description: TreeDescription,
  category: ConsumerCategory,
): readonly RootEntry[] {
  const members: RootEntry[] = description.packages
    .filter((spec) => spec.category === category)
    .map((spec) => ({ name: spec.dirName, isDirectory: true }));
  return [...members, { name: "README.md", isDirectory: false }].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** The materialised discovery inputs for a description: the two pure functions
 *  `discoverPackagesFrom` takes, closed over the description in memory. */
export interface TreeInputs {
  readonly description: TreeDescription;
  readonly listRoot: ListRoot;
  readonly readManifest: ReadManifest;
}

/**
 * Builds the `ListRoot` and `ReadManifest` a description presents to the pure
 * discovery core. The lister answers by the root path it is handed (never a
 * category name it derives), returning `undefined` for any path that is not one
 * of the three configured roots — which is how an absent root is modelled.
 */
export function treeInputs(description: TreeDescription): TreeInputs {
  const rootToCategory = new Map<string, ConsumerCategory>(
    CONSUMER_CATEGORIES.map((category) => [description.roots[category], category]),
  );

  const packageDirOf = (spec: PackageSpec): string =>
    `${description.roots[spec.category]}/${spec.dirName}`;

  const manifestByDir = new Map<string, Record<string, unknown>>(
    description.packages.map((spec) => [
      packageDirOf(spec),
      conformingManifest(spec, description.scope),
    ]),
  );
  const defectByDir = new Map<string, PackageDefect | undefined>(
    description.packages.map((spec) => [packageDirOf(spec), spec.defect]),
  );

  const listRoot: ListRoot = (rootDir) => {
    const category = rootToCategory.get(rootDir);
    if (category === undefined) return undefined;
    return entriesOf(description, category);
  };

  const readManifest: ReadManifest = (packageDir) => {
    const defect = defectByDir.get(packageDir);
    if (defect?.kind === "unreadable") return { kind: "unreadable" };
    if (defect?.kind === "unparsable") return { kind: "unparsable" };
    const manifest = manifestByDir.get(packageDir);
    if (manifest === undefined) return { kind: "absent" };
    return { kind: "ok", manifest: manifest as PackageManifest };
  };

  return { description, listRoot, readManifest };
}

/** The repo-relative package directory a spec occupies under a description. */
export function packageDirOf(
  description: TreeDescription,
  spec: PackageSpec,
): string {
  return `${description.roots[spec.category]}/${spec.dirName}`;
}

// ---------------------------------------------------------------------------
// The metamorphic transformations (Properties 11 and 12)
// ---------------------------------------------------------------------------

/**
 * Re-roots a description at a new per-category root assignment, changing nothing
 * else — the packages, their names, their dependency edges, their defects and the
 * scope are all preserved. This is the transformation of Property 11: discovery
 * over `tree` and over `relocatedAs(tree, roots)` must agree in order, directory
 * name, declared name, build kind and dependency-specifier list, differing only
 * in each recorded package directory's root prefix.
 */
export function relocatedAs(
  description: TreeDescription,
  roots: RootAssignment,
): TreeDescription {
  return { ...description, roots };
}

/**
 * Rewrites a description under a new Configured_Scope, changing every composed
 * name and every dependency specifier from the old scope to the new one and
 * nothing else. This is the transformation of Property 12: discovery over `tree`
 * and over `rescopedAs(tree, scope)` must agree in order, directory name,
 * recorded directory, build kind and dependency-specifier list once the scope
 * prefix is disregarded, and neither run may error.
 *
 * The rewrite is expressed on the description (its `scope` field), and
 * {@link treeInputs} recomposes every name and specifier from that field, so a
 * `non-mirroring-name` defect stays non-mirroring under the new scope and a
 * conforming name keeps mirroring — which is exactly the consistent rename
 * Property 12 requires.
 */
export function rescopedAs(
  description: TreeDescription,
  scope: string,
): TreeDescription {
  return { ...description, scope };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A directory-name pool, none colliding with a Framework_Singleton directory.
 * It holds at least 15 distinct names so `synthesizedTree()` can draw up to 5
 * unique directory names per category (15 total) without `uniqueArray` ever
 * failing to satisfy its length bound.
 */
const DIR_POOL: readonly string[] = [
  "admin",
  "alpha",
  "beta",
  "config",
  "delta",
  "epsilon",
  "gamma",
  "kappa",
  "lambda",
  "lib",
  "omega",
  "portal",
  "sigma",
  "theta",
  "widgets",
  "zeta",
];

/** The default per-category roots, the base assignment every tree starts at. */
export const DEFAULT_ROOTS: RootAssignment = {
  microservice: "packages/microservices",
  common: "packages/common",
  spa: "packages/spa",
};

/**
 * A relocated root assignment with three distinct first segments, none of them
 * `packages` (so no root can equal, nest in, or contain a Framework_Singleton
 * directory), satisfying Requirements 4.5-4.7. Deliberately different in shape
 * from the defaults — nested, multi-segment — so relocation genuinely moves every
 * recorded package directory.
 */
export function relocatedRoots(): fc.Arbitrary<RootAssignment> {
  return fc
    .uniqueArray(
      fc
        .array(
          fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
          { minLength: 1, maxLength: 6 },
        )
        .map((chars) => chars.join(""))
        .filter((segment) => segment.length > 0 && segment !== "packages"),
      { minLength: 3, maxLength: 3 },
    )
    .chain(([m, c, s]) =>
      fc
        .tuple(
          fc.constantFrom("", "sub", "a/b"),
          fc.constantFrom("", "shared/libs", "x"),
          fc.constantFrom("", "frontends", "y/z"),
        )
        .map(([mTail, cTail, sTail]): RootAssignment => {
          const join = (lead: string, tail: string): string =>
            tail === "" ? lead : `${lead}/${tail}`;
          return {
            microservice: join(m!, mTail),
            common: join(c!, cTail),
            spa: join(s!, sTail),
          };
        }),
    );
}

/** A Valid_Scope: `@` followed by 1 to 12 characters from `[a-z0-9-]`. */
export function validScope(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), {
      minLength: 1,
      maxLength: 12,
    })
    .map((chars) => `@${chars.join("")}`);
}

/**
 * A generated set of package specs: 0 to 5 per category, unique directory names
 * across the whole tree (so no two mirror to one name and collide as duplicates),
 * with dependency edges drawn from the OTHER packages' directory names so every
 * scoped specifier resolves, and at most a light sprinkling of one manifest
 * defect. Defect-carrying specs are opt-in via `withDefects`.
 */
function arbPackageSpecs(options: {
  readonly acyclic: boolean;
  readonly withDefects: boolean;
}): fc.Arbitrary<readonly PackageSpec[]> {
  const arbCategoryCounts = fc.record({
    microservice: fc.integer({ min: 0, max: 5 }),
    common: fc.integer({ min: 0, max: 5 }),
    spa: fc.integer({ min: 0, max: 5 }),
  });

  return arbCategoryCounts.chain((counts) => {
    // Assign distinct directory names across the whole tree.
    const total = counts.microservice + counts.common + counts.spa;
    return fc
      .uniqueArray(fc.constantFrom(...DIR_POOL), {
        minLength: total,
        maxLength: total,
      })
      .chain((dirNames) => {
        const skeleton: { category: ConsumerCategory; dirName: string }[] = [];
        let cursor = 0;
        for (const category of CONSUMER_CATEGORIES) {
          for (let i = 0; i < counts[category]; i += 1) {
            skeleton.push({ category, dirName: dirNames[cursor] as string });
            cursor += 1;
          }
        }

        // Per package, choose its dependency edges. In acyclic mode an edge must
        // also be sound under the Build_Sequence's fixed statement order, which
        // the Verification_Pass enforces: a package may depend only on a package
        // in a STRICTLY EARLIER statement (common 3, microservice 4, spa 7), or
        // — within the same statement — on one at a lower index. A cross-tier
        // dependency that pointed at a later statement (a common → microservice
        // edge, say) is acyclic yet an Ordering_Violation, so the derived order
        // would be rejected; gating on statement rank keeps every drawn tree
        // buildable. Outside acyclic mode any other package is a candidate.
        // Statement 3 (common) is the only statement with a CALCULATED
        // intra-statement order, so an edge between two Common_Packages is
        // honoured. Statements 4 (microservice) and 7 (spa) order their members
        // by directory alone, so an edge between two members of one of those
        // statements is an Ordering_Violation the Verification_Pass rejects even
        // when it is acyclic. Acyclic-mode edges are therefore restricted to a
        // strictly-earlier statement, plus a lower-index same-statement common.
        const statementRank: Readonly<Record<ConsumerCategory, number>> = {
          common: 3,
          microservice: 4,
          spa: 7,
        };
        const depChoices = skeleton.map((self, index) => {
          const candidates = skeleton
            .map((entry, other) => ({ entry, other }))
            .filter(({ entry, other }) => {
              if (!options.acyclic) return other !== index;
              const mine = statementRank[self.category];
              const theirs = statementRank[entry.category];
              if (theirs < mine) return true;
              // Same-statement edge only within statement 3 (common), ordered.
              return (
                theirs === mine &&
                self.category === "common" &&
                entry.category === "common" &&
                other < index
              );
            })
            .map(({ entry }) => entry.dirName);
          return fc.subarray(candidates);
        });

        const defectChoices = skeleton.map(() =>
          options.withDefects
            ? fc.option(
                fc.constantFrom<PackageDefect>(
                  { kind: "no-name" },
                  { kind: "non-mirroring-name" },
                  { kind: "unreadable" },
                  { kind: "unparsable" },
                  { kind: "contract" },
                ),
                { nil: undefined, freq: 4 },
              )
            : fc.constant<PackageDefect | undefined>(undefined),
        );

        return fc
          .tuple(fc.tuple(...depChoices), fc.tuple(...defectChoices))
          .map(([deps, defects]): readonly PackageSpec[] =>
            skeleton.map((entry, index) => ({
              category: entry.category,
              dirName: entry.dirName,
              dependencyDirNames: deps[index] as readonly string[],
              defect: defects[index] as PackageDefect | undefined,
            })),
          );
      });
  });
}

/**
 * A conforming Synthesized_Tree: 0 to 5 Consumer_Packages per category, every
 * manifest satisfying its category's contract, every dependency specifier
 * resolving within the tree, rooted at {@link DEFAULT_ROOTS} under the
 * Scope_Default. The base tree of Properties 11 and 12, which relocate or
 * rescope it and compare.
 */
export function synthesizedTree(): fc.Arbitrary<TreeDescription> {
  return arbPackageSpecs({ acyclic: false, withDefects: false }).map(
    (packages) => ({
      packages,
      roots: DEFAULT_ROOTS,
      scope: SCOPE_DEFAULT,
    }),
  );
}

/**
 * An acyclic Synthesized_Tree: like {@link synthesizedTree} but with dependency
 * edges restricted to a topological numbering, so the derived build order has no
 * cycle. Property 16 permutes such a tree's `workspaces` entries and asserts the
 * derived order and Project_List are unchanged.
 */
export function acyclicTree(): fc.Arbitrary<TreeDescription> {
  return arbPackageSpecs({ acyclic: true, withDefects: false }).map(
    (packages) => ({
      packages,
      roots: DEFAULT_ROOTS,
      scope: SCOPE_DEFAULT,
    }),
  );
}

/**
 * A Synthesized_Tree seeded so that a healthy share of runs carries exactly one
 * kind of manifest defect on at least one package. Property 13 asserts the run
 * fails naming that package's directory and the reason, recording no package,
 * specifier or build kind for it.
 */
export function defectiveTree(): fc.Arbitrary<TreeDescription> {
  return arbPackageSpecs({ acyclic: false, withDefects: true }).map(
    (packages) => ({
      packages,
      roots: DEFAULT_ROOTS,
      scope: SCOPE_DEFAULT,
    }),
  );
}

// ---------------------------------------------------------------------------
// Import layout (Property 17)
// ---------------------------------------------------------------------------

/** One synthesized source file and the specifiers it imports. */
export interface ImportFileSpec {
  /** Repo-relative POSIX path of the file, relative to the tree's roots/scope. */
  readonly relPathInPackage: string;
  readonly specifiers: readonly ImportSpecifierSpec[];
}

/**
 * One import specifier, LABELLED with the verdict it must draw. The label is what
 * lets Property 17 know the expected violation set by construction: it never
 * re-runs a second copy of the checker. `legal` specifiers draw nothing; the rest
 * name the rule they must trip.
 */
export type ImportSpecifierSpec =
  /** A relative path that escapes the importing package's own directory (R7.4). */
  | { readonly label: "escape"; readonly relative: string }
  /** A by-name import of a peer Microservice_Package (R7.5). */
  | { readonly label: "peer"; readonly targetDirName: string }
  /** A by-name import of the Overseer (R7.5). */
  | { readonly label: "overseer" }
  /** A by-name import of a Spa_Package from a Tsc_Project (R7.6). */
  | { readonly label: "spa"; readonly targetDirName: string }
  /** A specifier no rule faults for the importing package. */
  | { readonly label: "legal"; readonly specifier: string };

/** One package's owned files, in a layout for Property 17. */
export interface ImportPackageSpec {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  readonly files: readonly ImportFileSpec[];
}

/** A whole import layout: packages, files, and the roots/scope they hang off. */
export interface ImportLayoutDescription {
  readonly packages: readonly ImportPackageSpec[];
  readonly roots: RootAssignment;
  readonly scope: string;
}

/**
 * A generated import layout with labelled positives: at least one microservice
 * (so peer and Overseer imports are possible) and some libraries, each package's
 * source files carrying a mix of escaping-relative, peer, Overseer, Spa_Package,
 * and legal specifiers. The label on each specifier fixes the expected verdict,
 * so Property 17 can assert the reported violation set stays identical under
 * relocation and rename by construction.
 */
export function importLayout(): fc.Arbitrary<ImportLayoutDescription> {
  const arbDir = fc.constantFrom(...DIR_POOL);
  return fc
    .record({
      microserviceDirs: fc.uniqueArray(arbDir, { minLength: 1, maxLength: 3 }),
      commonDirs: fc.uniqueArray(arbDir, { minLength: 0, maxLength: 2 }),
      spaDirs: fc.uniqueArray(arbDir, { minLength: 0, maxLength: 2 }),
    })
    .filter(({ microserviceDirs, commonDirs, spaDirs }) => {
      const all = [...microserviceDirs, ...commonDirs, ...spaDirs];
      return new Set(all).size === all.length;
    })
    .chain(({ microserviceDirs, commonDirs, spaDirs }) => {
      const peers = microserviceDirs;
      const spas = spaDirs;

      const fileSpecsFor = (
        category: ConsumerCategory,
        dirName: string,
      ): fc.Arbitrary<readonly ImportFileSpec[]> => {
        // The pool of labelled specifiers this package may draw from.
        const pool: ImportSpecifierSpec[] = [
          { label: "escape", relative: "../../elsewhere/thing.js" },
          { label: "legal", specifier: "./sibling.js" },
          { label: "legal", specifier: "express" },
        ];
        // A microservice may import a peer (another microservice) or the Overseer.
        if (category === "microservice") {
          for (const peer of peers) {
            if (peer !== dirName) {
              pool.push({ label: "peer", targetDirName: peer });
            }
          }
          pool.push({ label: "overseer" });
        }
        // Any Tsc_Project (microservice or common) may illegally import a Spa.
        if (category !== "spa") {
          for (const spa of spas) {
            pool.push({ label: "spa", targetDirName: spa });
          }
        }

        return fc
          .array(fc.subarray(pool), { minLength: 1, maxLength: 2 })
          .map((perFile) =>
            perFile.map((specifiers, index) => ({
              relPathInPackage:
                index === 0 ? "src/index.ts" : `src/deep/mod${String(index)}.ts`,
              specifiers,
            })),
          );
      };

      const specFor = (
        category: ConsumerCategory,
        dirName: string,
      ): fc.Arbitrary<ImportPackageSpec> =>
        fileSpecsFor(category, dirName).map((files) => ({
          category,
          dirName,
          files,
        }));

      const microservicePkgs = microserviceDirs.map((dir) =>
        specFor("microservice", dir),
      );
      const commonPkgs = commonDirs.map((dir) => specFor("common", dir));
      const spaPkgs = spaDirs.map((dir) => specFor("spa", dir));

      return fc
        .tuple(
          fc.tuple(...microservicePkgs),
          fc.tuple(...commonPkgs),
          fc.tuple(...spaPkgs),
        )
        .map(
          ([microservices, commons, spaList]): ImportLayoutDescription => ({
            packages: [...microservices, ...commons, ...spaList],
            roots: DEFAULT_ROOTS,
            scope: SCOPE_DEFAULT,
          }),
        );
    });
}

/** Re-roots an import layout, for Property 17's relocation half. */
export function importLayoutRelocatedAs(
  layout: ImportLayoutDescription,
  roots: RootAssignment,
): ImportLayoutDescription {
  return { ...layout, roots };
}

/** Rescopes an import layout, for Property 17's rename half. */
export function importLayoutRescopedAs(
  layout: ImportLayoutDescription,
  scope: string,
): ImportLayoutDescription {
  return { ...layout, scope };
}

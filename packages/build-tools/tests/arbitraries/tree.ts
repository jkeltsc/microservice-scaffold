// Shared fast-check arbitraries for the layout-metamorphic property suite of
// Step 11 (Properties 11, 12, 13, 16, 17).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it. It
// lives under `tests/arbitraries/` alongside `config.ts` and `tsconfig.ts`; the
// point of putting the generators in one place is that two properties drawing
// from `synthesizedTree()` genuinely draw from the *same* inputs.
//
// EVERY GENERATOR IS PURE; only one exported FUNCTION touches disk. A
// Synthesized_Tree is a plain description object, and for the category-discovery
// properties it becomes the two injected functions the pure core of
// Package_Discovery takes — `ListRoot` and `ReadManifest` — so those properties
// run `discoverPackagesFrom(context, listRoot, readManifest)` against values held
// in memory, with no filesystem at all. This is exactly what Requirements 13.5
// and 13.6 mean by "a Synthesized_Tree is either in-memory inputs to a pure
// function or a directory inside an OS temporary directory": these are the pure
// half.
//
// The registry-inversion half below (`arbSynthesizedTreeWithEntry`,
// `arbWorkspacesPermutation`) adds the OTHER half for the two properties that
// genuinely need files on disk — Property 5's whole-file replacement and
// Property 9's staged file at the Entry_Point_Path. The split is deliberate:
// `arbSynthesizedTreeWithEntry` is still a pure arbitrary over a DESCRIPTION, and
// `materializeEntryTree(description, parentDir)` is the one function that writes,
// refusing any destination outside the operating system's temporary directory
// (registry-inversion R12.4, R12.5). A fast-check generator must stay
// side-effect-free — it is re-run during shrinking — so materialisation cannot
// live inside one, and the suite keeps ownership of creation and removal.
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

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import * as fc from "fast-check";

import {
  CONSUMER_CATEGORIES,
  type ConsumerCategory,
} from "../../src/framework.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type ListRoot,
  type PackageManifest,
  type ReadManifest,
  type RootEntry,
} from "../../src/discovery.js";
import {
  PROJECT_CONFIG_FILE,
  SCOPE_DEFAULT,
  serializeProjectConfig,
  type EffectiveConfig,
} from "../../src/project-config.js";
import {
  arbAcceptedEntryRoot,
  DEFAULT_RESERVED_ENTRY_PATHS,
} from "./config.js";

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
    CONSUMER_CATEGORIES.map((category) => [
      description.roots[category],
      category,
    ]),
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
    .array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
      {
        minLength: 1,
        maxLength: 12,
      },
    )
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
                index === 0
                  ? "src/index.ts"
                  : `src/deep/mod${String(index)}.ts`,
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
        .map(([microservices, commons, spaList]): ImportLayoutDescription => ({
          packages: [...microservices, ...commons, ...spaList],
          roots: DEFAULT_ROOTS,
          scope: SCOPE_DEFAULT,
        }));
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
// ---------------------------------------------------------------------------
// The Entry_Package layout (registry-inversion Properties 1, 2, 5, 6, 7, 9)
// ---------------------------------------------------------------------------
//
// One description model, two consumers. `arbSynthesizedTreeWithEntry` generates a
// layout description — 1 to 5 Microservice_Packages, 0 to 3 Common_Packages, and
// an Entry_Package at a generated Entry_Root, under a generated Valid_Scope — and
// the pure derivations below turn that one description into whichever shape a
// property needs: an `EffectiveConfig` (and through it a `ProjectContext`), the
// `ConsumerPackage` records a `SequenceMembership` is built from, the Root_Manifest
// `workspaces` entries, or a real directory tree. No property composes any of
// those inline, which is the point of the two generators existing (R13.12).
//
// Why 1 to 5 microservices and 0 to 3 commons rather than the wider bounds
// `synthesizedTree()` uses: Properties 1, 2 and 7 quantify over a Selector drawn
// from the tree's own identifiers, and both bounds are what Requirement 13.1
// states. The lower bound of 1 matters — a tree with no microservice admits no
// non-empty Selector list, so an empty draw would silently narrow those
// properties to the wildcard case.

/**
 * A Synthesized_Tree that also has an Entry_Package, at `entryRoot`.
 *
 * Extends {@link TreeDescription} rather than restating it, so `treeInputs`,
 * `packageDirOf`, `relocatedAs` and `rescopedAs` are all total over it — the
 * Entry_Package changes none of their behaviour, being discovered by nothing
 * (registry-inversion R1.9) and therefore absent from every category's entry
 * list.
 */
export interface EntryTreeDescription extends TreeDescription {
  /** The Entry_Root: the Entry_Package's Project_Directory-relative POSIX path. */
  readonly entryRoot: string;
}

/**
 * The four Framework_Singleton directory names, in `FRAMEWORK_DIRECTORIES` order.
 *
 * Spelled here rather than imported on purpose, the same way `config.ts` spells
 * them: a property over a synthesized layout must state the layout rule itself
 * rather than read it from the module it is testing.
 */
const FRAMEWORK_DIR_NAMES: readonly string[] = [
  "contracts",
  "overseer",
  "build-tools",
  "integration-tests",
];

/** The last `/`-separated segment of a path — the Entry_Root's own directory
 *  name, which is what registry-inversion R1.10 composes the Entry_Package's
 *  declared name from. A root with no `/` (the default `app`) is its own last
 *  segment. */
function lastSegmentOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The Entry_Package's declared name: the Configured_Scope, `/`, and the
 *  Entry_Root's last segment (registry-inversion R1.10). */
export function entryPackageNameOf(description: EntryTreeDescription): string {
  return `${description.scope}/${lastSegmentOf(description.entryRoot)}`;
}

/** The Entry_Point_Path: the Entry_Root joined to `dist/index.js` by a single
 *  `/` (registry-inversion R7.1). Stated here as the test's own mirror of the
 *  rule, so a property comparing against `context.entryPointPath` compares two
 *  independent derivations rather than one value with itself. */
export function entryPointPathOf(description: EntryTreeDescription): string {
  return `${description.entryRoot}/dist/index.js`;
}

/** The repo-relative path of the Generated_Registry under this description's
 *  Entry_Root (registry-inversion R4.1). */
export function generatedRegistryPathOf(
  description: EntryTreeDescription,
): string {
  return `${description.entryRoot}/src/generated/microservice-registry.ts`;
}

/** The Effective_Config a description denotes — the input `projectContext` takes,
 *  so a property needs no config literal of its own. */
export function effectiveConfigOf(
  description: EntryTreeDescription,
): EffectiveConfig {
  return {
    scope: description.scope,
    roots: {
      microservice: description.roots.microservice,
      common: description.roots.common,
      spa: description.roots.spa,
    },
    entry: description.entryRoot,
  };
}

/**
 * The `ConsumerPackage` records a description's packages denote, in ascending
 * code-point order of `packageDir` within each category — the shape
 * `SequenceMembership` and `Discovery` are both built from.
 *
 * Every package of one of these trees is conforming (`defect: undefined`), so
 * each declared name mirrors its directory under the description's scope and each
 * `dependencySpecifiers` list is that package's scoped dependency keys, sorted as
 * `ConsumerPackage` requires.
 */
export function consumerPackagesOf(
  description: EntryTreeDescription,
  category: ConsumerCategory,
): readonly ConsumerPackage[] {
  return description.packages
    .filter((spec) => spec.category === category)
    .map((spec): ConsumerPackage => ({
      category: spec.category,
      dirName: spec.dirName,
      packageDir: packageDirOf(description, spec),
      name: `${description.scope}/${spec.dirName}`,
      dependencySpecifiers: [
        ...dependencySpecifiersOf(spec, description.scope),
      ].sort(),
      buildKind: buildKindOf(spec.category),
    }))
    .sort((a, b) =>
      a.packageDir < b.packageDir ? -1 : a.packageDir > b.packageDir ? 1 : 0,
    );
}

/** The Microservice_Identifiers of a description, ascending — the identifier
 *  pool a generated Selector is drawn from. */
export function microserviceIdentifiersOf(
  description: EntryTreeDescription,
): readonly string[] {
  return consumerPackagesOf(description, "microservice").map(
    (pkg) => pkg.dirName,
  );
}

/**
 * The Root_Manifest `workspaces` entries a description denotes, in the shape this
 * repository's own Root_Manifest declares them: the Entry_Root first, the
 * non-globbed Framework_Singletons by path, and one glob per configured
 * Discovery_Root.
 *
 * The ORDER returned here is the unpermuted baseline Property 7 compares against.
 * It carries no meaning to the Build_System — the order is load-bearing for
 * nothing — which is exactly what that property exists to establish.
 */
export function workspacesEntriesOf(
  description: EntryTreeDescription,
): readonly string[] {
  return [
    description.entryRoot,
    "packages/contracts",
    "packages/build-tools",
    `${description.roots.common}/*`,
    `${description.roots.spa}/*`,
    `${description.roots.microservice}/*`,
    "packages/overseer",
    "packages/integration-tests",
  ];
}

/**
 * Moves a description's Entry_Package to another Entry_Root, changing nothing
 * else — the third metamorphic transformation of this module, alongside
 * {@link relocatedAs} and {@link rescopedAs}, and the one Property 6 applies:
 * every derived path must differ only in the Entry_Root prefix, while the emitted
 * Generated_Registry text is byte-identical across the pair.
 */
export function entryRootRelocatedAs(
  description: EntryTreeDescription,
  entryRoot: string,
): EntryTreeDescription {
  return { ...description, entryRoot };
}

/**
 * A Synthesized_Tree with an Entry_Package: 1 to 5 Microservice_Packages with
 * distinct identifiers, 0 to 3 Common_Packages, no Spa_Package, under a generated
 * Valid_Scope, at the default Discovery_Roots, with an Entry_Root the Config_Parser
 * accepts (registry-inversion R1.4, R1.6 — drawn from `config.ts`'s
 * `arbAcceptedEntryRoot`, never a second Entry_Root generator written here).
 *
 * The dependency edges are drawn so the graph has no cycle AND no
 * Ordering_Violation under the Build_Sequence's fixed statement order, which is
 * what Property 7 quantifies over: a microservice (statement 4) may depend on any
 * Common_Package (statement 3), and a Common_Package on a lower-indexed
 * Common_Package only. An edge pointing at a later statement is acyclic yet an
 * Ordering_Violation the Verification_Pass rejects, so drawing one would make the
 * property fail on its own generator rather than on the code.
 *
 * The Entry_Root's last segment is held distinct from every package directory
 * name, because that segment composes the Entry_Package's declared name: sharing
 * it with a Common_Package would make two packages declare one name, a duplicate
 * that fails discovery for a reason the property is not about.
 *
 * No Spa_Package: every property consuming this generator is about the registry,
 * the derived order, or the staged tree, and the Build_Sequence's trailing
 * bundler phase is already covered by `build-sequence-spa-phase.property.test.ts`
 * over `synthesizedTree()`. A Spa_Package here would add a `npm run build` to
 * every materialised tree and nothing else.
 */
export function arbSynthesizedTreeWithEntry(): fc.Arbitrary<EntryTreeDescription> {
  const arbCounts = fc.record({
    microservice: fc.integer({ min: 1, max: 5 }),
    common: fc.integer({ min: 0, max: 3 }),
  });

  return arbCounts
    .chain((counts) => {
      const total = counts.microservice + counts.common;
      return fc
        .uniqueArray(fc.constantFrom(...DIR_POOL), {
          minLength: total,
          maxLength: total,
        })
        .chain((dirNames) => {
          const commonDirs = dirNames.slice(0, counts.common);
          const microserviceDirs = dirNames.slice(counts.common);

          // Statement 3's members may depend on a LOWER-INDEXED member of their
          // own statement; statement 4's members may depend on any of them.
          const commonEdges = commonDirs.map((_dirName, index) =>
            fc.subarray(commonDirs.slice(0, index)),
          );
          const microserviceEdges = microserviceDirs.map(() =>
            fc.subarray(commonDirs),
          );

          return fc
            .tuple(fc.tuple(...commonEdges), fc.tuple(...microserviceEdges))
            .map((edges): readonly PackageSpec[] => {
              const [commonDeps, microserviceDeps] = edges;
              return [
                ...commonDirs.map((dirName, index): PackageSpec => ({
                  category: "common",
                  dirName,
                  dependencyDirNames: commonDeps[index] as readonly string[],
                  defect: undefined,
                })),
                ...microserviceDirs.map((dirName, index): PackageSpec => ({
                  category: "microservice",
                  dirName,
                  dependencyDirNames: microserviceDeps[
                    index
                  ] as readonly string[],
                  defect: undefined,
                })),
              ];
            });
        });
    })
    .chain((packages) => {
      const dirNames = new Set(packages.map((spec) => spec.dirName));
      return fc
        .tuple(
          validScope(),
          // The reserved set of a project at the default roots, which is what
          // DEFAULT_ROOTS below makes this description. A relocated variant must
          // pass `reservedEntryPaths([...])` of its own triple instead.
          arbAcceptedEntryRoot(DEFAULT_RESERVED_ENTRY_PATHS).filter(
            (entryRoot) =>
              !dirNames.has(lastSegmentOf(entryRoot)) &&
              !FRAMEWORK_DIR_NAMES.includes(lastSegmentOf(entryRoot)),
          ),
        )
        .map(([scope, entryRoot]): EntryTreeDescription => ({
          packages,
          roots: DEFAULT_ROOTS,
          scope,
          entryRoot,
        }));
    });
}

/**
 * A permutation of a Root_Manifest's `workspaces` entries — every entry present
 * exactly once, in a generated order, the identity permutation included.
 *
 * `fc.shuffledSubarray` with both length bounds pinned to the input length is a
 * permutation generator: no entry is dropped and none is duplicated. Pinning both
 * bounds is what makes that true, so Property 7 compares two derivations over the
 * SAME membership in different orders, which is the whole claim — a dropped entry
 * would change membership and the property would be asserting something else.
 *
 * @param entries the unpermuted baseline, conventionally {@link workspacesEntriesOf}.
 */
export function arbWorkspacesPermutation(
  entries: readonly string[],
): fc.Arbitrary<readonly string[]> {
  return fc.shuffledSubarray([...entries], {
    minLength: entries.length,
    maxLength: entries.length,
  });
}

// ---------------------------------------------------------------------------
// Materialisation — the one function here that writes (R12.4, R12.5)
// ---------------------------------------------------------------------------

/** What {@link materializeEntryTree} wrote, and where. */
export interface MaterializedEntryTree {
  /** Absolute path of the materialised tree's root — the Project_Directory a
   *  spawned process would take as its working directory. */
  readonly dir: string;
  /** The description it was written from. */
  readonly description: EntryTreeDescription;
  /** Absolute path of the written `scaffold.config.json`. */
  readonly configPath: string;
  /** Absolute path of the written root `package.json`. */
  readonly rootManifestPath: string;
  /** Absolute path of the Entry_Package's directory. */
  readonly entryDir: string;
  /** Absolute path of the seeded file at the Entry_Point_Path. */
  readonly entryPointPath: string;
}

/**
 * Refuses any destination outside the operating system's temporary directory.
 *
 * This is the hard worktree rule made mechanical rather than remembered
 * (registry-inversion R12.4, R12.5): the one writing function in this module
 * cannot be pointed at the checked-out tree by a mistaken argument, so no test
 * using it can create a package, a directory, or a `node_modules` symlink inside
 * the repository. Both the raw and the real path of each side are compared,
 * because `os.tmpdir()` is itself a symlink on macOS.
 */
function assertInsideTempDirectory(parentDir: string): void {
  const roots = new Set<string>([resolve(tmpdir())]);
  try {
    roots.add(resolve(realpathSync(tmpdir())));
  } catch {
    // An unreadable tmpdir is the caller's problem; the raw path still guards.
  }

  const candidates = new Set<string>([resolve(parentDir)]);
  try {
    candidates.add(resolve(realpathSync(parentDir)));
  } catch {
    // Not yet created is fine — the resolved path is what is being judged.
  }

  for (const candidate of candidates) {
    for (const root of roots) {
      if (candidate === root || candidate.startsWith(`${root}${sep}`)) return;
    }
  }

  throw new Error(
    `refusing to materialize a Synthesized_Tree outside the OS temporary directory: "${resolve(parentDir)}"`,
  );
}

/** Writes one file, creating every absent parent directory. */
function writeFileAt(absolutePath: string, contents: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

/** A minimal package manifest, rendered the way npm writes one. */
function renderManifest(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The seeded one-line `dist/index.js` of a materialised package. Deterministic in
 * the package's own name, so two materialisations of one description write
 * byte-identical files — which is what lets Property 5 compare bytes at all.
 */
function seededDistLine(dirName: string): string {
  return `export const id = ${JSON.stringify(dirName)};\n`;
}

/**
 * Materialises a description as a real directory tree inside `parentDir`, which
 * MUST be inside the operating system's temporary directory.
 *
 * Each call creates its own uniquely-named subdirectory of `parentDir` through
 * `mkdtempSync`, so a suite creates ONE temporary root in `beforeAll`, calls this
 * once per generated input, and removes that one root in `afterAll` — the cost is
 * one `mkdtempSync` per input and no `npm ci` at all. Removal stays the suite's,
 * because a fast-check generator is re-run while shrinking and must not own a
 * lifecycle; {@link removeMaterializedTree} is the removal side of the
 * convention.
 *
 * What is written, and why each piece is needed:
 *   - the root `package.json`, declaring {@link workspacesEntriesOf} in baseline
 *     order (a property wanting a permuted array rewrites just this file);
 *   - `scaffold.config.json`, through `serializeProjectConfig`, so a spawned
 *     Build_System process reads the same scope, roots and Entry_Root the
 *     in-memory derivations used;
 *   - the four Framework_Singleton directories, each with a manifest and a
 *     one-line `dist/`, because the Image_Assembler stages `contracts` and the
 *     Overseer under every Selector and asserts every staged package has compiled
 *     output;
 *   - each Microservice_Package and Common_Package under its configured
 *     Discovery_Root, manifest plus one-line `dist/`;
 *   - the Entry_Package at the Entry_Root: a manifest declaring the scoped
 *     Overseer and `contracts` and NO Microservice_Package, with neither `main`
 *     nor `types` (registry-inversion R1.10 to R1.14), plus a one-line `dist/`
 *     whose file IS the Entry_Point_Path — which is the file Property 9 looks for
 *     in the staged tree.
 *
 * No `src/` is written and no `node_modules` is created: nothing here compiles,
 * and every property consuming these trees reads manifests, derives paths, or
 * copies `package.json` plus `dist/`.
 */
export function materializeEntryTree(
  description: EntryTreeDescription,
  parentDir: string,
): MaterializedEntryTree {
  assertInsideTempDirectory(parentDir);
  mkdirSync(parentDir, { recursive: true });
  const dir = mkdtempSync(join(parentDir, "entry-tree-"));

  const at = (relative: string): string => join(dir, ...relative.split("/"));

  const rootManifestPath = at("package.json");
  writeFileAt(
    rootManifestPath,
    renderManifest({
      name: "synthesized-tree",
      version: "0.0.0",
      private: true,
      type: "module",
      workspaces: [...workspacesEntriesOf(description)],
    }),
  );

  const configPath = at(PROJECT_CONFIG_FILE);
  writeFileAt(
    configPath,
    serializeProjectConfig(effectiveConfigOf(description)),
  );

  for (const dirName of FRAMEWORK_DIR_NAMES) {
    const packageDir = `packages/${dirName}`;
    writeFileAt(
      at(`${packageDir}/package.json`),
      renderManifest({
        name: `${description.scope}/${dirName}`,
        version: "0.0.0",
        type: "module",
      }),
    );
    writeFileAt(at(`${packageDir}/dist/index.js`), seededDistLine(dirName));
  }

  for (const spec of description.packages) {
    const packageDir = packageDirOf(description, spec);
    writeFileAt(
      at(`${packageDir}/package.json`),
      renderManifest({
        ...conformingManifest(spec, description.scope),
        version: "0.0.0",
        type: "module",
      }),
    );
    writeFileAt(
      at(`${packageDir}/dist/index.js`),
      seededDistLine(spec.dirName),
    );
  }

  // The Entry_Package. Its dependencies name the scoped Overseer and `contracts`
  // and no Microservice_Package (R1.12), and it declares neither `main` nor
  // `types` (R1.13) — the Entry_Point_Path is its interface, not a barrel.
  writeFileAt(
    at(`${description.entryRoot}/package.json`),
    renderManifest({
      name: entryPackageNameOf(description),
      version: "0.0.0",
      type: "module",
      scripts: {
        build: "tsc --build",
        test: "vitest --run",
        lint: "eslint .",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        [`${description.scope}/overseer`]: "*",
        [`${description.scope}/contracts`]: "*",
      },
    }),
  );
  const entryPointPath = at(entryPointPathOf(description));
  writeFileAt(
    entryPointPath,
    seededDistLine(lastSegmentOf(description.entryRoot)),
  );

  return {
    dir,
    description,
    configPath,
    rootManifestPath,
    entryDir: at(description.entryRoot),
    entryPointPath,
  };
}

/**
 * Removes a materialised tree, or a suite's whole temporary root.
 *
 * The removal half of the convention {@link materializeEntryTree} describes, and
 * it refuses a destination outside the temporary directory for the same reason
 * the writing half does — a recursive remove aimed at the checked-out tree is the
 * one mistake with no undo. Safe to call on a path that no longer exists, so an
 * `afterAll` runs it whether the suite's assertions passed or failed (R12.4).
 */
export function removeMaterializedTree(dir: string): void {
  assertInsideTempDirectory(dir);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The generic filesystem-tree (Properties 3 and 4)
// ---------------------------------------------------------------------------
//
// Properties 3 (Fixture_Clone fidelity) and 4 (Output_Clearing exactness) both
// need an arbitrary FILESYSTEM tree — regular files carrying generated bytes,
// nested directories, and symlinks whose target is a generated relative path
// text — rather than the package-layout tree the generators above describe. The
// two consumers differ only in the SEED they draw from: Property 3 wants any
// tree of 0 to 20 files across 0 to 4 nesting levels including symlinks;
// Property 4 wants a tree that also carries `dist/` directories at arbitrary
// depths, `*.tsbuildinfo` files, other files, and a `node_modules/`. Both are
// expressed here over one description model, `FsTreeDescription`.
//
// Same discipline as the rest of this module: the GENERATOR is pure over a
// DESCRIPTION, and the one function that writes — `materializeFsTree` — refuses
// any destination outside the operating system's temporary directory, reusing
// `assertInsideTempDirectory` above. A fast-check generator is re-run while
// shrinking, so no write may live inside one.

/** One node of a generic filesystem tree, described independently of any root. */
export type FsNode =
  /** A regular file carrying `bytes`, written verbatim. */
  | { readonly kind: "file"; readonly name: string; readonly bytes: string }
  /**
   * A symlink whose link text IS `target`, a generated RELATIVE path text —
   * reproduced as a symlink with that same target text, never dereferenced.
   * The target need not resolve to anything; the fidelity claim is about the
   * link text, not what it points at.
   */
  | { readonly kind: "symlink"; readonly name: string; readonly target: string }
  /** A directory holding further nodes. */
  | {
      readonly kind: "dir";
      readonly name: string;
      readonly children: readonly FsNode[];
    };

/** A whole generic filesystem tree: the nodes directly under its (later-chosen)
 *  root. The description carries no root of its own — the root is the temp
 *  directory {@link materializeFsTree} creates. */
export interface FsTreeDescription {
  readonly nodes: readonly FsNode[];
}

/** A non-empty, filesystem-safe node name: 1 to 8 characters from a small pool
 *  that never yields `.`, `..`, `/`, `dist`, `node_modules`, or a
 *  `.tsbuildinfo` name, so a plain node cannot masquerade as a
 *  Generated_Fixture_Output path unless the seed deliberately adds one. */
function arbNodeName(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
      minLength: 1,
      maxLength: 8,
    })
    .map((chars) => `f${chars.join("")}`);
}

/** Generated file bytes: any string, including empty, rendered verbatim. Kept
 *  free of embedded NULs so a byte comparison in a property reads cleanly. */
function arbFileBytes(): fc.Arbitrary<string> {
  return fc.string({ maxLength: 64 });
}

/** A generated RELATIVE symlink target text — one to three `../` or plain
 *  segments joined by `/`. Never absolute and never dereferenced; the point is
 *  that the link text round-trips, not that it resolves. */
function arbRelativeTarget(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom("..", "a", "b", "sibling", "nested"), {
      minLength: 1,
      maxLength: 3,
    })
    .map((segments) => segments.join("/"));
}

/**
 * A generic filesystem-tree description with configurable depth bounds and an
 * optional sprinkling of Generated_Fixture_Output (a `dist/` directory, a
 * `*.tsbuildinfo` file) and a `node_modules/` directory.
 *
 * Depth is bounded to `maxDepth` nesting levels (0 to 4), so a value of 0
 * produces only leaves directly under the root and a value of 4 produces up to
 * four levels of directories. The total file count is bounded by keeping each
 * directory's child count small; the two consuming properties assert their own
 * count bounds (Property 3 wants 0 to 20 files) rather than the generator
 * pinning them.
 *
 * @param options.maxDepth       maximum directory nesting, 0 to 4.
 * @param options.withSymlinks   when true, a node may be a symlink whose target
 *                               is a generated relative path text (Property 3).
 * @param options.withOutput     when true, a directory may carry a `dist/`
 *                               subtree, a `*.tsbuildinfo` file, and a
 *                               `node_modules/` directory (Property 4).
 */
export function fsTree(options: {
  readonly maxDepth: number;
  readonly withSymlinks: boolean;
  readonly withOutput: boolean;
}): fc.Arbitrary<FsTreeDescription> {
  const depth = Math.max(0, Math.min(4, options.maxDepth));

  const arbFile = (): fc.Arbitrary<FsNode> =>
    fc.record({ name: arbNodeName(), bytes: arbFileBytes() }).map(
      ({ name, bytes }): FsNode => ({ kind: "file", name, bytes }),
    );

  const arbSymlink = (): fc.Arbitrary<FsNode> =>
    fc.record({ name: arbNodeName(), target: arbRelativeTarget() }).map(
      ({ name, target }): FsNode => ({ kind: "symlink", name, target }),
    );

  // A `*.tsbuildinfo` file — Generated_Fixture_Output Output_Clearing removes.
  const arbTsbuildinfo = (): fc.Arbitrary<FsNode> =>
    fc.record({ name: arbNodeName(), bytes: arbFileBytes() }).map(
      ({ name, bytes }): FsNode => ({
        kind: "file",
        name: `${name}.tsbuildinfo`,
        bytes,
      }),
    );

  // A `dist/` directory carrying a few files — Generated_Fixture_Output too.
  const arbDist = (): fc.Arbitrary<FsNode> =>
    fc
      .array(arbFile(), { minLength: 0, maxLength: 3 })
      .map((children): FsNode => ({ kind: "dir", name: "dist", children }));

  // A `node_modules/` directory carrying a few files — must SURVIVE clearing.
  const arbNodeModules = (): fc.Arbitrary<FsNode> =>
    fc
      .array(arbFile(), { minLength: 0, maxLength: 3 })
      .map(
        (children): FsNode => ({
          kind: "dir",
          name: "node_modules",
          children,
        }),
      );

  // The leaf-node pool at a given remaining depth: files always, symlinks and
  // output entries when the caller opted in.
  const arbLeaf = (): fc.Arbitrary<FsNode> => {
    const pool: fc.Arbitrary<FsNode>[] = [arbFile()];
    if (options.withSymlinks) pool.push(arbSymlink());
    if (options.withOutput) {
      pool.push(arbTsbuildinfo(), arbDist(), arbNodeModules());
    }
    return fc.oneof(...pool);
  };

  // Nodes at `remaining` further nesting levels. At 0, only leaves. Above 0, a
  // node may also be a directory whose children are drawn one level shallower.
  const arbNodesAt = (remaining: number): fc.Arbitrary<readonly FsNode[]> => {
    if (remaining <= 0) {
      return fc.array(arbLeaf(), { minLength: 0, maxLength: 6 });
    }
    const arbChildDir = (): fc.Arbitrary<FsNode> =>
      fc
        .record({ name: arbNodeName(), children: arbNodesAt(remaining - 1) })
        .map(({ name, children }): FsNode => ({ kind: "dir", name, children }));
    return fc.array(fc.oneof(arbLeaf(), arbChildDir()), {
      minLength: 0,
      maxLength: 6,
    });
  };

  return arbNodesAt(depth).map((nodes): FsTreeDescription => ({ nodes }));
}

/**
 * The relative POSIX paths of every regular file a description denotes, each
 * paired with its bytes — the set a fidelity or exactness property compares
 * against after materialising. Symlinks and directories are not listed here;
 * a symlink's fidelity is asserted separately (it is still a symlink with equal
 * target text), and an empty directory carries no bytes.
 */
export function fsTreeFileEntries(
  description: FsTreeDescription,
): ReadonlyArray<readonly [string, string]> {
  const entries: (readonly [string, string])[] = [];
  const walk = (nodes: readonly FsNode[], prefix: string): void => {
    for (const node of nodes) {
      const rel = prefix === "" ? node.name : `${prefix}/${node.name}`;
      if (node.kind === "file") {
        entries.push([rel, node.bytes]);
      } else if (node.kind === "dir") {
        walk(node.children, rel);
      }
    }
  };
  walk(description.nodes, "");
  return entries;
}

/** The relative POSIX path and target text of every symlink a description
 *  denotes — what a fidelity property checks stays a symlink with equal target. */
export function fsTreeSymlinkEntries(
  description: FsTreeDescription,
): ReadonlyArray<readonly [string, string]> {
  const entries: (readonly [string, string])[] = [];
  const walk = (nodes: readonly FsNode[], prefix: string): void => {
    for (const node of nodes) {
      const rel = prefix === "" ? node.name : `${prefix}/${node.name}`;
      if (node.kind === "symlink") {
        entries.push([rel, node.target]);
      } else if (node.kind === "dir") {
        walk(node.children, rel);
      }
    }
  };
  walk(description.nodes, "");
  return entries;
}

/** What {@link materializeFsTree} wrote, and where. */
export interface MaterializedFsTree {
  /** Absolute path of the materialised tree's root, inside an OS temp directory. */
  readonly dir: string;
  /** The description it was written from. */
  readonly description: FsTreeDescription;
}

/**
 * Materialises a generic filesystem tree inside `parentDir`, which MUST be
 * inside the operating system's temporary directory — the same guard
 * {@link materializeEntryTree} uses, for the same reason (registry-inversion
 * R12.4, R12.5, and this feature's R9.7): the one writing function here cannot
 * be pointed at the checked-out tree.
 *
 * Each call creates its own uniquely-named subdirectory of `parentDir` through
 * `mkdtempSync`, so a suite creates ONE temporary root in `beforeAll`, calls
 * this once per generated input, and removes that one root with
 * {@link removeMaterializedTree} in an unconditional `afterAll`. A symlink is
 * written with its generated target text VERBATIM and is never dereferenced, so
 * a dangling target is fine — the fidelity claim is about the link text.
 */
export function materializeFsTree(
  description: FsTreeDescription,
  parentDir: string,
): MaterializedFsTree {
  assertInsideTempDirectory(parentDir);
  mkdirSync(parentDir, { recursive: true });
  const dir = mkdtempSync(join(parentDir, "fs-tree-"));

  const writeNodes = (nodes: readonly FsNode[], absoluteBase: string): void => {
    mkdirSync(absoluteBase, { recursive: true });
    for (const node of nodes) {
      const absolute = join(absoluteBase, node.name);
      if (node.kind === "file") {
        writeFileSync(absolute, node.bytes, "utf8");
      } else if (node.kind === "symlink") {
        symlinkSync(node.target, absolute);
      } else {
        writeNodes(node.children, absolute);
      }
    }
  };

  writeNodes(description.nodes, dir);
  return { dir, description };
}

// Feature: package-categories, Property 20: A staged package contributes exactly its manifest plus its `dist/` contents
//
// `copyPackage(sourceDir, targetDir)` is the single staging primitive every
// Package_Category flows through (Framework_Singleton, Microservice_Package,
// Common_Package, Spa_Package), so "manifest plus `dist/`" is one rule rather
// than four (R6.8). This property pins that rule directly: for an arbitrary
// package source tree — `package.json` and `dist/` surrounded by any number of
// extra files and directories at any depth — the set of tree-relative paths
// `copyPackage` produces in the target equals `package.json` plus every file
// under `dist/`, with nothing else from the source tree carried over and no
// `dist/` file dropped.
//
// Like `image-tree-minimality.test.ts`, this uses a real temp directory rather
// than a stubbed filesystem: `copyPackage` is pure effect (`cpSync`) with no
// injected reader, so the only faithful oracle is to build a real tree, stage
// it, and walk both sides. The Testing Strategy note keeps this property in
// `build-tools` (not `integration-tests`) precisely because it exercises one
// exported function against a temp dir.
//
// The `category` axis is modelled as a label attached to each generated tree
// rather than as a behavioural switch, because `copyPackage` reads no category:
// staging is uniform. Varying the label across every Package_Category and
// asserting the same invariant is what demonstrates the uniformity R6.8 claims.
//
// Validates: Requirements 6.8

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { copyPackage } from "../src/image-tree.js";

/** Every Package_Category, so the invariant is asserted uniformly across all. */
const CATEGORIES = [
  "framework-singleton",
  "microservice",
  "common",
  "spa",
] as const;

/**
 * A file to plant in a generated tree: a slash-separated path relative to the
 * package root plus its byte contents. Directories are implied by the path.
 */
interface PlantedFile {
  readonly path: string;
  readonly contents: string;
}

/** A single path segment: safe, non-dotted, no separators, non-empty. */
const segment = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => s.replace(/[^a-zA-Z0-9]/g, "x"))
  .filter((s) => s.length > 0 && s !== "." && s !== "..");

/** A relative path of one or more segments, e.g. `a`, `a/b`, `a/b/c`. */
const relPath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));

/** File contents; arbitrary bytes are fine, kept small for run speed. */
const contents = fc.string({ maxLength: 32 });

/** Zero or more files placed *under* `dist/` — these MUST be staged. */
const distFiles = fc.array(
  fc.record({ path: relPath, contents }).map(
    ({ path, contents: c }): PlantedFile => ({
      path: `dist/${path}`,
      contents: c,
    }),
  ),
  { maxLength: 6 },
);

/**
 * Zero or more "noise" files elsewhere in the source tree (src/, tests/,
 * READMEs, nested config, even a stray top-level file) — none of these may be
 * staged. Paths are constrained to never begin with `dist/` or equal
 * `package.json`, since those are the two things that ARE staged.
 */
const noiseFiles = fc.array(
  fc.record({ path: relPath, contents }).map(
    ({ path, contents: c }): PlantedFile => ({ path, contents: c }),
  ),
  { maxLength: 8 },
).map((files) =>
  files.filter(
    (f) => f.path !== "package.json" && !f.path.startsWith("dist/"),
  ),
);

/**
 * True when the planted paths form a valid filesystem: no path repeats, and no
 * path is a strict directory-prefix of another (which would require the same
 * name to be both a file and a directory). `package.json` and the implicit
 * `dist/` directory are reserved, so no planted path may collide with them.
 *
 * Every comparison is CASE-INSENSITIVE because the target filesystem may be
 * (macOS APFS is by default), and one on-disk entry cannot hold two spellings
 * that differ only in case. fast-check found two collision classes a
 * case-sensitive check lets through:
 *   - `x/x` plus `X`: `plant()` makes directory `x` (parent of `x/x`), then
 *     `writeFileSync("X")` hits that same entry and throws `EISDIR` before
 *     `copyPackage` runs.
 *   - `dist/xX/x` plus `dist/xx/xx`: directories `xX` and `xx` are one entry on
 *     disk, so the second file lands under whichever spelling was planted
 *     first, and the walked tree no longer matches the case-preserving
 *     `expected` set.
 * Both reduce to the same rule: a directory/file name must have a single
 * canonical spelling. So we require the case-folding to be injective at every
 * path prefix — if one lowercased prefix ever appears with two different
 * original spellings, the tree would collide on disk and is rejected. This
 * mirrors how sibling discovery tests key off a lowercased name for the same
 * macOS reason. (Reserving `package.json` in the fold also rejects noise like
 * `Package.json`; `dist/` is already reserved by the `noiseFiles` filter.)
 */
function isConsistentTree(paths: readonly string[]): boolean {
  const all = ["package.json", ...paths];

  // Every lowercased prefix must map to exactly one original spelling. A prefix
  // that ends a full path is a leaf (file); a shorter prefix is a directory.
  // Recording both spelling collisions and leaf/directory clashes here catches
  // duplicates, case-variant duplicates, strict directory-prefix overlaps, and
  // case-variant sibling directories in one pass.
  const spellingOf = new Map<string, string>();
  const leafKeys = new Set<string>();
  const dirKeys = new Set<string>();

  for (const path of all) {
    const segments = path.split("/");
    let lowerPrefix = "";
    for (let i = 0; i < segments.length; i++) {
      const original = segments[i];
      lowerPrefix = lowerPrefix === ""
        ? original.toLowerCase()
        : `${lowerPrefix}/${original.toLowerCase()}`;

      const existing = spellingOf.get(lowerPrefix);
      if (existing === undefined) {
        spellingOf.set(lowerPrefix, original);
      } else if (existing !== original) {
        return false; // same on-disk entry, two spellings
      }

      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        if (leafKeys.has(lowerPrefix) || dirKeys.has(lowerPrefix)) return false;
        leafKeys.add(lowerPrefix);
      } else {
        if (leafKeys.has(lowerPrefix)) return false; // file vs directory
        dirKeys.add(lowerPrefix);
      }
    }
  }
  return true;
}

/** A generated package source tree, tagged with the category it stands in for. */
const packageTree = fc
  .record({
    category: fc.constantFrom(...CATEGORIES),
    manifest: contents.map((c) => c || "{}"),
    dist: distFiles,
    noise: noiseFiles,
  })
  .filter((tree) =>
    isConsistentTree([
      ...tree.dist.map((f) => f.path),
      ...tree.noise.map((f) => f.path),
    ]),
  );

/** Write `file` (creating parent directories) under `root`. */
function plant(root: string, file: PlantedFile): void {
  const abs = join(root, ...file.path.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, file.contents);
}

/** Every file (not directory) under `root`, as tree-relative posix paths. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const recurse = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(abs);
      } else {
        out.push(relative(root, abs).split(sep).join(posix.sep));
      }
    }
  };
  recurse(root);
  return out.sort();
}

describe("copyPackage stages exactly package.json plus dist/ (Property 20)", () => {
  it("stages the manifest and every dist/ file, and nothing else, for every category", () => {
    fc.assert(
      fc.property(packageTree, (tree) => {
        const work = mkdtempSync(join(tmpdir(), "staging-prop-"));
        try {
          const sourceDir = join(work, "source");
          const targetDir = join(work, "target");
          mkdirSync(sourceDir, { recursive: true });

          // Always present: the manifest and the dist/ directory itself.
          writeFileSync(join(sourceDir, "package.json"), tree.manifest);
          mkdirSync(join(sourceDir, "dist"), { recursive: true });

          for (const file of tree.dist) {
            plant(sourceDir, file);
          }
          for (const file of tree.noise) {
            plant(sourceDir, file);
          }

          copyPackage(sourceDir, targetDir);

          const staged = walkFiles(targetDir);
          const expected = ["package.json", ...tree.dist.map((f) => f.path)]
            .sort();

          expect(staged).toStrictEqual(expected);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ===========================================================================
// Feature: spa-common-consumption, Property 10: The STAGE set omits exactly what only a Spa_Package reaches
//
// Confirmation for task 5.3. Property 20 above pins the staging PRIMITIVE
// (`copyPackage` moves exactly `package.json` + `dist/`, uniformly per
// category). Property 10 is the complementary claim over the staging DECISION:
// which packages the plan places in the STAGE set at all. The two are one
// suite's two halves — "how a package is staged" and "which packages are
// staged" — so the strict-subset shape the `spa-common-consumption` feature
// makes reachable is confirmed here, driving a real staged-set assertion rather
// than only the `copyPackage` walk.
//
// The shape: a `microservice → spa → common → common` chain in which the two
// Common_Packages are reachable ONLY through the Spa_Package. The Dependency
// _Resolver arrives at the Spa_Package and includes it, but does not expand it
// (the SPA cut), so a Common_Package reached only that way is a member of the
// Required_Dependencies (BUILD — the bundler needs its compiled `dist/`) yet
// NOT of the Staged_Dependencies (STAGE — no runtime process reaches it after
// inlining). The assertion runs ACROSS SELECTORS: the microservice alone, the
// all-Selector, and a comma list, so the omission holds however the Selector is
// spelled, not just for one value.
//
// The STAGE/BUILD sets are read off the ONE derivation, `buildPlanFrom`, over an
// in-memory `Discovery` — no assembly, no filesystem — exactly as the sibling
// integrity suite (`image-tree.integrity.property.test.ts`, Property 19) does.
// This suite already imports nothing but `copyPackage`; the confirmation adds
// the plan derivation and the framework/discovery helpers it needs, and changes
// no file under `packages/build-tools/src/`.
//
// Validates: Requirements 5.3, 5.8, 5.9, 5.11

import {
  buildPlanFrom,
  type BuildPlan,
} from "../src/build-plan.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import { type ConsumerCategory } from "../src/framework.js";
import type { ReadDependencies } from "../src/required-dependencies.js";

/** Default-config context; scope and roots equal the pre-context baseline. */
const CONTEXT = projectContext(defaultEffectiveConfig());

// Scope, per-category roots, and the two Framework_Singletons this file names
// (each with its scope-composed name) come from the run's context, not from
// framework.ts's scope-free surface (R3.7).
const WORKSPACE_SCOPE = CONTEXT.config.scope;
const NAMESPACE_CONTAINER = CONTEXT.roots;
const { contracts: CONTRACTS, overseer: OVERSEER } = CONTEXT.framework;

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

/**
 * The strict-subset chain, as data. Names mirror the committed repository's own
 * `microservice1 → demo → extended-config → config` chain so the confirmation
 * reads against the feature it confirms, without depending on the real tree.
 */
const CONFIG = consumerPackage("common", "config", []);
const EXTENDED_CONFIG = consumerPackage("common", "extended-config", [
  CONFIG.name,
]);
const DEMO = consumerPackage("spa", "demo", [EXTENDED_CONFIG.name]);
const MICROSERVICE1 = consumerPackage("microservice", "microservice1", [
  DEMO.name,
]);
// A second microservice reaching a Common_Package through NO Spa_Package, so a
// comma-list Selector proves the "present when also reachable off-SPA" half.
const MICROSERVICE2 = consumerPackage("microservice", "microservice2", [
  CONFIG.name,
]);

const CHAIN_PACKAGES: readonly ConsumerPackage[] = [
  CONFIG,
  EXTENDED_CONFIG,
  DEMO,
  MICROSERVICE1,
  MICROSERVICE2,
];

/** The `Discovery` the chain presents, each category sorted by directory name. */
function chainDiscovery(): Discovery {
  const of = (category: ConsumerCategory): readonly ConsumerPackage[] =>
    CHAIN_PACKAGES.filter((pkg) => pkg.category === category).sort((a, b) =>
      a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0,
    );
  return {
    byCategory: {
      microservice: of("microservice"),
      common: of("common"),
      spa: of("spa"),
    },
    nameByDir: new Map(CHAIN_PACKAGES.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(CHAIN_PACKAGES.map((pkg) => [pkg.name, pkg])),
  };
}

/** A reader over the chain's root consumers (the Overseer names only `contracts`). */
const chainReader: ReadDependencies = (packageDir) => {
  if (packageDir === OVERSEER.packageDir) return [CONTRACTS.name];
  const microservice = CHAIN_PACKAGES.find(
    (pkg) => pkg.packageDir === packageDir,
  );
  return microservice?.dependencySpecifiers ?? [];
};

function planFor(selector: string): BuildPlan {
  return buildPlanFrom(CONTEXT, selector, chainDiscovery(), chainReader);
}

/** Directory names of a plan's BUILD set. */
function requiredDirs(plan: BuildPlan): string[] {
  return plan.requiredDependencies.map((pkg) => pkg.dirName);
}

/** Directory names of a plan's STAGE set. */
function stagedDirs(plan: BuildPlan): string[] {
  return plan.stagedDependencies.map((pkg) => pkg.dirName);
}

describe("Property 10: the STAGE set omits exactly what only a Spa_Package reaches", () => {
  it("stages the Spa_Package but neither Common_Package reached only through it (Selector microservice1)", () => {
    const plan = planFor("microservice1");

    // BUILD reaches the whole chain: both Common_Packages compile so the
    // bundler can inline them.
    expect([...requiredDirs(plan)].sort()).toEqual(
      ["config", "demo", "extended-config"].sort(),
    );
    // STAGE holds the Spa_Package alone: `config` and `extended-config` are
    // reachable ONLY through `demo`, so the SPA cut drops both.
    expect(stagedDirs(plan)).toEqual(["demo"]);

    // Stated as the property: STAGE is a strict subset of BUILD, and the missing
    // members are exactly those with no non-SPA path from the roots.
    const required = new Set(requiredDirs(plan));
    const staged = new Set(stagedDirs(plan));
    expect(staged.size).toBeLessThan(required.size);
    for (const onlyViaSpa of ["config", "extended-config"]) {
      expect(required.has(onlyViaSpa)).toBe(true);
      expect(staged.has(onlyViaSpa)).toBe(false);
    }
  });

  it("keeps STAGE a subsequence of BUILD across every Selector spelling", () => {
    for (const selector of ["microservice1", "*", "microservice1,microservice2"]) {
      const plan = planFor(selector);
      const required = requiredDirs(plan);

      // Subsequence: every staged member appears in BUILD, in the same relative
      // order (R5.3's "subsequence of the Required_Dependencies").
      let cursor = 0;
      for (const dir of stagedDirs(plan)) {
        const at = required.indexOf(dir, cursor);
        expect(at, `staged "${dir}" not found in BUILD order for "${selector}"`)
          .toBeGreaterThanOrEqual(0);
        cursor = at + 1;
      }
    }
  });

  it("stages a Common_Package once a non-SPA path also reaches it (Selector microservice1,microservice2)", () => {
    // microservice2 reaches `config` directly — no Spa_Package on that path — so
    // `config` is now staged, while `extended-config` (still reachable only via
    // `demo`) stays out. Reachability is a disjunction over paths, not a flag.
    const plan = planFor("microservice1,microservice2");
    const staged = new Set(stagedDirs(plan));

    expect(new Set(requiredDirs(plan))).toEqual(
      new Set(["config", "demo", "extended-config"]),
    );
    expect(staged.has("config")).toBe(true); // reached off-SPA via microservice2
    expect(staged.has("demo")).toBe(true); // the Spa_Package itself ships
    expect(staged.has("extended-config")).toBe(false); // only via the Spa_Package
  });

  it("stages both Common_Packages under the all-Selector, where microservice3 reaches them directly", () => {
    // Add microservice3 → extended-config to the chain for this case only, so
    // BOTH Common_Packages have a non-SPA path and the all-Selector stages all
    // three consumer libraries (the committed `*` row of the design's table).
    const microservice3 = consumerPackage("microservice", "microservice3", [
      EXTENDED_CONFIG.name,
    ]);
    const packages = [...CHAIN_PACKAGES, microservice3];
    const of = (category: ConsumerCategory): readonly ConsumerPackage[] =>
      packages.filter((pkg) => pkg.category === category).sort((a, b) =>
        a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0,
      );
    const discovery: Discovery = {
      byCategory: {
        microservice: of("microservice"),
        common: of("common"),
        spa: of("spa"),
      },
      nameByDir: new Map(packages.map((pkg) => [pkg.packageDir, pkg.name])),
      byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
    };
    const reader: ReadDependencies = (packageDir) => {
      if (packageDir === OVERSEER.packageDir) return [CONTRACTS.name];
      return (
        packages.find((pkg) => pkg.packageDir === packageDir)
          ?.dependencySpecifiers ?? []
      );
    };

    const plan = buildPlanFrom(CONTEXT, "*", discovery, reader);
    expect([...plan.stagedDependencies.map((pkg) => pkg.dirName)].sort()).toEqual(
      ["config", "demo", "extended-config"].sort(),
    );
  });
});

// Feature: platform-fixtures — the Fixture_Equivalent of the payload-coupled
// staged Image_Tree entry-set claim (design "the ordering argument", Testing
// Strategy table: "Staged Image_Tree entry set — Tree_Fixture — the assembler's
// entry set is derived from categories and Required_Dependencies, not from bytes
// on disk").
//
// The payload-coupled Image_Tree claim is embodied by the recorded
// `image-tree.<slug>.json` Baseline_Recordings and the suites that assert the
// assembler stages, over the committed `packages/` tree, exactly the
// `node_modules/@microservices/<entry>` set a Selector justifies (the
// always-staged Framework_Singletons, the Required_Dependencies, and the
// Selected_Microservices). Every one of those assertions would change if a
// package of the Payload_Tree were renamed, relocated, or removed. This suite is
// the Fixture_Equivalent (R13.1): it makes the SAME claim — assemble the
// Image_Tree, then assert the set of scoped entries actually staged under the
// scope directory equals the set the plan justifies — but over a MATERIALISED
// Tree_Fixture rather than the committed tree, and it asserts NO fact about the
// Payload_Tree (R13.7). The two passing together is the evidence the fixture
// subject is a faithful stand-in for the payload the recorded Image_Trees still
// pin.
//
// Why a materialised Synthesized_Tree, and why the assembler is driven through
// `stageImageTree`: every committed `fixtures/trees/` fixture is HOSTILE and
// yields no discoverable records, so a staged-entry-set claim has no subject
// there. The subject is therefore a well-formed `Synthesized_Tree` with an
// Entry_Package that `materializeEntryTree` writes into an OS temporary directory,
// seeding a one-line `dist/` for every package it writes (the Entry_Package's
// being the Entry_Point_Path). The full assembler entry point `buildImageTree`
// would first run a real `tsc --build` over roots that have no `src/` and no
// per-package `tsconfig.json`, and would demand a Generated_Registry the seeded
// tree does not carry — neither is a claim about the STAGED ENTRY SET. So the
// suite drives the assembler through `stageImageTree(plan, outDir)`, the staging
// half of `executeBuildPlan`: it runs `assertBuildOutputsPresent` over the seeded
// `dist/`s, physically copies each staged package into `outDir`, and runs the
// Integrity_Assertion — assembling a real Image_Tree into a real `outDir` from
// the seeded compiled output, which is exactly the staged-entry-set subject. The
// entry set is then read back off the assembled tree with the exported
// `listScopedEntries`, so the assertion is over the tree that was really written,
// not over the plan alone.
//
// Derived-configuration discipline (R13.2): the scope, the Discovery_Roots, and
// the Entry_Root all come from the SUBJECT tree's own description, threaded
// through `projectContext(effectiveConfigOf(description))`. The scope directory
// the entries are read from is `context.scopeDir`, and every expected entry name
// is a directory name of the subject's own packages — no `packages/...` path
// literal and no `@microservices` scope literal is spelled. The subject uses a
// Configured_Scope OTHER than the Scope_Default and Discovery_Roots ALL differing
// from their defaults (R13.6), so the staged tree is read under `@acme` rather
// than the default scope.
//
// Worktree discipline (R11.2, R11.3): the materialised tree AND the assembled
// Image_Tree both live inside ONE temporary root created in `beforeAll` and
// removed in `afterAll`, whether the assertions pass or fail. `materializeEntryTree`
// refuses any destination outside the OS temporary directory; `stageImageTree`
// resolves each staged source directory against `cwd`, pinned to the materialised
// tree and restored in a `finally`, and assembles into an `outDir` that is a
// subdirectory of that same materialised tree. Nothing is written into the
// checked-out tree, and no committed fixture is touched.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.6, 13.7

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPlanFrom, type BuildPlan } from "../src/build-plan.js";
import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import { listScopedEntries, stageImageTree } from "../src/image-tree.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import type { ReadDependencies } from "../src/required-dependencies.js";
import {
  consumerPackagesOf,
  effectiveConfigOf,
  materializeEntryTree,
  removeMaterializedTree,
  type EntryTreeDescription,
  type PackageSpec,
} from "./arbitraries/tree.js";

// ---------------------------------------------------------------------------
// The subject fixture — a well-formed Synthesized_Tree with an Entry_Package, at
// a non-default Configured_Scope and non-default Discovery_Roots (R13.6). A
// microservice → common → common chain plus a standalone microservice, so a
// single-microservice Selector stages a strict subset and the all-Selector stages
// the whole justified set — the staged-entry-set claim across Selectors.
// ---------------------------------------------------------------------------

const SUBJECT_SCOPE = "@acme";
const SUBJECT_ROOTS = {
  microservice: "services",
  common: "libs",
  spa: "frontends",
} as const;
const SUBJECT_ENTRY_ROOT = "entrypoint";

/** `alpha` → `extended` → `base`, and `charlie` reaching nothing. So selecting
 *  `alpha` justifies both Common_Packages (transitively), while selecting
 *  `charlie` justifies neither. No Spa_Package: a Spa_Package would add a
 *  bundler build and a STAGE-vs-BUILD asymmetry that the staged-entry-set claim
 *  is not about, and `spa-build-sequencing`/`image-tree.staging` already cover
 *  that. Each microservice declares only directory-mirroring scoped dependencies
 *  drawn from this tree, so under `SUBJECT_SCOPE` every specifier resolves. */
const SUBJECT_PACKAGES: readonly PackageSpec[] = [
  {
    category: "common",
    dirName: "base",
    dependencyDirNames: [],
    defect: undefined,
  },
  {
    category: "common",
    dirName: "extended",
    dependencyDirNames: ["base"],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "alpha",
    dependencyDirNames: ["extended"],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "charlie",
    dependencyDirNames: [],
    defect: undefined,
  },
];

const SUBJECT: EntryTreeDescription = {
  packages: SUBJECT_PACKAGES,
  roots: SUBJECT_ROOTS,
  scope: SUBJECT_SCOPE,
  entryRoot: SUBJECT_ENTRY_ROOT,
};

const context = projectContext(effectiveConfigOf(SUBJECT));

// ---------------------------------------------------------------------------
// The discovery and dependency reader a description denotes — the shared pure
// derivations, so nothing is composed inline that discovery would otherwise read
// from disk. Discovery is derived from the description directly (the tree is
// materialised for staging, but the plan is derived over the description's own
// records, exactly as `image-tree.entry-staging.property.test.ts` does).
// ---------------------------------------------------------------------------

/** Every Consumer_Package of the subject, in one list. */
function allPackages(
  description: EntryTreeDescription,
): readonly ConsumerPackage[] {
  return [
    ...consumerPackagesOf(description, "microservice"),
    ...consumerPackagesOf(description, "common"),
    ...consumerPackagesOf(description, "spa"),
  ];
}

/** The `Discovery` the subject denotes, from the shared pure derivation. */
function discoveryOf(description: EntryTreeDescription): Discovery {
  const all = allPackages(description);
  return {
    byCategory: {
      microservice: consumerPackagesOf(description, "microservice"),
      common: consumerPackagesOf(description, "common"),
      spa: consumerPackagesOf(description, "spa"),
    },
    nameByDir: new Map(all.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(all.map((pkg) => [pkg.name, pkg])),
  };
}

/** The dependency reader for the packages discovery never records: the
 *  Entry_Package names the scoped Overseer and `contracts` and no
 *  Microservice_Package, and `contracts` names nothing — exactly as the manifest
 *  `materializeEntryTree` writes declares them. */
function readerFor(
  ctx: ProjectContext,
  description: EntryTreeDescription,
): ReadDependencies {
  const declaredByDir = new Map<string, readonly string[]>(
    allPackages(description).map(
      (pkg) => [pkg.packageDir, pkg.dependencySpecifiers] as const,
    ),
  );
  const { contracts, overseer } = ctx.framework;
  return (packageDir) => {
    if (packageDir === ctx.entryRoot) return [overseer.name, contracts.name];
    if (packageDir === contracts.packageDir) return [];
    return declaredByDir.get(packageDir) ?? [contracts.name];
  };
}

/** The plan for a Selector over the subject. */
function planFor(selector: string): BuildPlan {
  return buildPlanFrom(context, selector, discoveryOf(SUBJECT), readerFor(context, SUBJECT));
}

/** The scoped-entry set a plan justifies: the `scopedEntry` values of `plan.stage`
 *  — the always-staged Framework_Singletons, the Required_Dependencies, and the
 *  Selected_Microservices. The Entry_Package carries `scopedEntry: undefined`, so
 *  it is (correctly) not in this set: it ships at its package directory, outside
 *  the scope directory. */
function justifiedScopedEntries(plan: BuildPlan): readonly string[] {
  return [
    ...new Set(
      plan.stage
        .map((staged) => staged.scopedEntry)
        .filter((entry): entry is string => entry !== undefined),
    ),
  ].sort();
}

/**
 * Assembles the Image_Tree for a Selector into a fresh `outDir` under the
 * materialised subject, then reads back the set of entries actually staged under
 * the scope directory. `stageImageTree` copies each staged package's seeded
 * `dist/` and `package.json`, and `listScopedEntries` enumerates the real direct
 * entries of `<outDir>/<context.scopeDir>` — so the returned set is what was
 * really written to disk, not the plan restated.
 */
function stagedScopedEntries(
  materializedDir: string,
  plan: BuildPlan,
  outDirName: string,
): readonly string[] {
  const previousCwd = process.cwd();
  try {
    // `stageImageTree` resolves each staged source directory against `cwd`;
    // pinning it to the subject's own materialised tree keeps every read inside
    // the temporary directory.
    process.chdir(materializedDir);
    const outDir = join(materializedDir, outDirName);
    stageImageTree(plan, outDir);
    return [...listScopedEntries(join(outDir, context.scopeDir))].sort();
  } finally {
    process.chdir(previousCwd);
  }
}

describe("Feature: platform-fixtures: the staged Image_Tree entry set over a Tree_Fixture (Fixture_Equivalent of the recorded Image_Trees)", () => {
  let tempRoot: string;
  let materializedDir: string;

  beforeAll(() => {
    // ONE temporary root for the whole suite; the subject tree and every assembled
    // Image_Tree live inside subdirectories of it. One materialisation is reused
    // across the Selectors — each assembles into its own `outDir` subdirectory, so
    // the copies do not conflict.
    tempRoot = mkdtempSync(join(tmpdir(), "image-tree-fixture-"));
    materializedDir = materializeEntryTree(SUBJECT, tempRoot).dir;
  });

  afterAll(() => {
    // Runs whether the assertions passed or failed. `removeMaterializedTree`
    // refuses a destination outside the OS temporary directory.
    if (tempRoot !== undefined) removeMaterializedTree(tempRoot);
  });

  it("uses a non-default Configured_Scope and non-default Discovery_Roots (R13.6)", () => {
    const defaults = projectContext(
      effectiveConfigOf({
        ...SUBJECT,
        scope: "@microservices",
        roots: {
          microservice: "packages/microservices",
          common: "packages/common",
          spa: "packages/spa",
        },
      }),
    );
    expect(context.scopeDir).not.toBe(defaults.scopeDir);
    expect(SUBJECT.roots.microservice).not.toBe(defaults.roots.microservice);
    expect(SUBJECT.roots.common).not.toBe(defaults.roots.common);
    expect(SUBJECT.roots.spa).not.toBe(defaults.roots.spa);
  });

  it("stages, for the all-Selector, exactly the scoped entries the plan justifies", () => {
    const plan = planFor("*");
    // The justified set: the always-staged Framework_Singletons (`contracts` and
    // the Overseer_Library, both shipping under the scope directory as
    // `node_modules/<scope>/<name>` real directories — registry-inversion R3.7),
    // both Common_Packages (`alpha` reaches `extended` → `base`), and both
    // microservices. Stated as the suite's own composition from the subject's
    // directory names, then compared with what the plan justifies AND with what
    // was really staged under the scope directory.
    const expected = [
      "base",
      "charlie",
      "contracts",
      "extended",
      "alpha",
      "overseer",
    ].sort();
    expect(justifiedScopedEntries(plan)).toEqual(expected);
    expect(stagedScopedEntries(materializedDir, plan, "image-out-all")).toEqual(
      expected,
    );
  });

  it("stages, for a single-microservice Selector, a strict subset — no unrequired Common_Package", () => {
    // `charlie` alone: it reaches no Common_Package, so neither `base` nor
    // `extended` is a Required_Dependency and neither is staged. The staged scoped
    // set is the always-staged Framework_Singletons (`contracts`, `overseer`)
    // plus the one Selected_Microservice.
    const plan = planFor("charlie");
    const expected = ["charlie", "contracts", "overseer"].sort();
    expect(justifiedScopedEntries(plan)).toEqual(expected);
    expect(
      stagedScopedEntries(materializedDir, plan, "image-out-charlie"),
    ).toEqual(expected);

    // The strict-subset shape, stated: the single-Selector set omits `alpha`,
    // `base`, and `extended`, all of which the all-Selector staged.
    const staged = new Set(expected);
    for (const omitted of ["alpha", "base", "extended"]) {
      expect(staged.has(omitted)).toBe(false);
    }
  });

  it("stages, for a Selector reaching the common chain, both Common_Packages transitively", () => {
    // `alpha` alone reaches `extended` directly and `base` through it, so both
    // Common_Packages are Required_Dependencies and both are staged; `charlie` is
    // not selected, so it is absent.
    const plan = planFor("alpha");
    const expected = ["base", "contracts", "extended", "alpha", "overseer"].sort();
    expect(justifiedScopedEntries(plan)).toEqual(expected);
    expect(
      stagedScopedEntries(materializedDir, plan, "image-out-alpha"),
    ).toEqual(expected);
    // `charlie` was not selected and is reached by nothing, so it does not ship.
    expect(new Set(expected).has("charlie")).toBe(false);
  });
});

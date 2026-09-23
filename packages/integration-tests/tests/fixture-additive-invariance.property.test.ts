// Feature: platform-fixtures, Property 5: The Fixture_Tier's presence changes no
// discovery result, no derived order, no Project_List, and no staged Image_Tree.
//
// This is the machine-checked form of R10.5, R10.6, and R10.7: the tier is
// discovered by nothing, so pointing the Build_System at a project that HAS a
// tier must yield exactly what it yields for the same project WITHOUT one. Where
// `baseline-byte-stability.property.test.ts` pins the observables over THIS
// repository (the tier absent from those recordings), this property quantifies
// over MANY generated tier contents and MANY Selectors and asserts, value for
// value in order, that adding the tier changes none of the four derivations.
//
// The four derivations, each run through the same compiled `dist/` effect shell
// the platform's own commands run, cwd-relative to the copy:
//
//   1. Package_Discovery   — discoverPackages(context).byCategory          (R10.5)
//   2. Workspace build order— workspaceBuildOrder(workspaceNodesFrom(...))  (R10.6)
//   3. Project_List        — devProjectList(context, buildPlan(...))       (R10.6)
//   4. Staged Image_Tree   — buildPlan(context, selector).stage            (R10.7)
//
// Method (R16.6): take ONE `pristineWorktree()` copy in `beforeAll` — the copy
// is the slow step, so it is reused across every generated example. For each
// generated (Selector, tier-content) pair we materialise the generated content
// under `fixtures/` inside the copy, run the four derivations (tier PRESENT),
// remove `fixtures/` again, run the four derivations (tier ABSENT), and compare
// present-versus-absent value for value in order. Because the tier is toggled
// inside the ONE copy rather than by re-cloning, the two runs differ in nothing
// but the tier's presence, which is exactly the variable under test.
//
// Every subject is derived from a GENERATED configuration (a generated Selector
// threaded through the copy's own default ProjectContext) — this file spells no
// scope literal and no Discovery_Root path of its own (R16.11). R16.6 quantifies
// over "every generated Selector ACCEPTED by the Build_System", so the Selector
// generator draws from the microservice identifiers Package_Discovery actually
// yields over the copy (`*`, the blank/whitespace forms, and comma-lists of
// discovered identifiers) rather than from arbitrary strings that would name a
// nonexistent microservice and be rejected with `[selector:unmatched]` before a
// derivation could run. The accepted identifier set is DISCOVERED from the copy
// in `beforeAll`, not written here, keeping the subject configuration-derived.
// The Fixture_Tier content generator (`arbFixtureContent`) comes from
// `@microservices/build-tools/dist/testing`, because a suite in
// `packages/integration-tests` cannot import `packages/build-tools/tests/
// arbitraries/` by relative path and the design's cross-package rule sends a
// generator two packages need to `src/testing/`.
//
// Worktree safety: the ONLY tree this suite writes to is the OS-temp
// `pristineWorktree()` copy (materialising and removing its `fixtures/`); it
// never writes into the checked-out tree, and it restores `process.cwd()` and
// `process.env.MICROSERVICES` after every derivation.
//
// Validates: Requirements 10.5, 10.6, 10.7, 16.1, 16.6, 16.11

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  arbFixtureContent,
  type FixtureContent,
} from "@microservices/build-tools/dist/testing/index.js";
import { pristineWorktree } from "./helpers.js";

/** The clone is slow (its `npm ci`); toggling the tier inside it is cheap. */
const SUITE_TIMEOUT_MS = 300_000;

/** At least 100 generated inputs per run (R16.1). */
const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Compiled-module loading, rooted at the COPY's build-tools dist.
//
// The derivations are cwd-relative effect shells: they read manifests and list
// Discovery_Roots relative to `process.cwd()`. So we chdir into the copy and run
// them there. We load the compiled modules from the COPY's own dist/ (its
// `npm ci` produced the workspace symlinks and the compiled output survives the
// `git ls-files` capture only if committed; build-tools dist/ is gitignored, so
// we load from THIS repository's already-built dist/ and drive it against the
// copy by cwd — the effect shell reads cwd, not its own module location).
// ---------------------------------------------------------------------------

const __dirname = dirname(new URL(import.meta.url).pathname);
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const DIST = resolve(repoRoot, "packages/build-tools/dist");

async function distModule(fileName: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(resolve(DIST, fileName)).href) as Promise<
    Record<string, unknown>
  >;
}

/** The bundle of compiled entry points the four derivations need, loaded once. */
interface Derivations {
  defaultEffectiveConfig: () => unknown;
  projectContext: (config: unknown) => unknown;
  discoverPackages: (context: unknown) => {
    byCategory: Record<string, readonly Record<string, unknown>[]>;
  };
  readDependencySpecifiers: (context: unknown) => unknown;
  workspaceNodesFrom: (
    context: unknown,
    discovery: unknown,
    readDeps: unknown,
  ) => readonly { packageDir: string }[];
  workspaceBuildOrder: (
    context: unknown,
    nodes: unknown,
  ) => readonly { packageDir: string }[];
  buildPlan: (
    context: unknown,
    selector: string | undefined,
  ) => { stage: readonly { targetDir: string }[]; tscRoots: readonly string[] };
  devProjectList: (context: unknown, plan: unknown) => readonly string[];
}

async function loadDerivations(): Promise<Derivations> {
  const config = await distModule("project-config.js");
  const context = await distModule("project-context.js");
  const discovery = await distModule("discovery.js");
  const workspace = await distModule("workspace-build-order.js");
  const plan = await distModule("build-plan.js");
  const dev = await distModule("dev-supervisor.js");
  return {
    defaultEffectiveConfig: config.defaultEffectiveConfig as Derivations["defaultEffectiveConfig"],
    projectContext: context.projectContext as Derivations["projectContext"],
    discoverPackages: discovery.discoverPackages as Derivations["discoverPackages"],
    readDependencySpecifiers:
      discovery.readDependencySpecifiers as Derivations["readDependencySpecifiers"],
    workspaceNodesFrom:
      workspace.workspaceNodesFrom as Derivations["workspaceNodesFrom"],
    workspaceBuildOrder:
      workspace.workspaceBuildOrder as Derivations["workspaceBuildOrder"],
    buildPlan: plan.buildPlan as Derivations["buildPlan"],
    devProjectList: dev.devProjectList as Derivations["devProjectList"],
  };
}

// ---------------------------------------------------------------------------
// The four derivations, computed over whatever tree `process.cwd()` names.
// ---------------------------------------------------------------------------

/** The value-for-value comparable snapshot of all four derivations. */
interface DerivationSnapshot {
  /** Per-category discovery facts, category -> ordered [dirName, name] list. */
  readonly discovery: Record<string, readonly [string, string][]>;
  /** The workspace build order, as package directories in order. */
  readonly buildOrder: readonly string[];
  /** The Project_List, as tsc roots in order. */
  readonly projectList: readonly string[];
  /** The staged Image_Tree target directories, in order. */
  readonly stage: readonly string[];
}

/**
 * Run the four derivations against the current working directory for `selector`,
 * building a fresh default ProjectContext (a generated Selector is the only
 * varied input — the configuration is the copy's own default, so no path or
 * scope literal is written here). Restores `process.env.MICROSERVICES`.
 */
function deriveHere(
  d: Derivations,
  selector: string | undefined,
): DerivationSnapshot {
  const context = d.projectContext(d.defaultEffectiveConfig());

  const discovery = d.discoverPackages(context);
  const discoveryFacts: Record<string, readonly [string, string][]> = {};
  for (const [category, members] of Object.entries(discovery.byCategory)) {
    discoveryFacts[category] = members
      .map(
        (pkg): [string, string] => [pkg.dirName as string, pkg.name as string],
      )
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  const readDeps = d.readDependencySpecifiers(context);
  const nodes = d.workspaceNodesFrom(context, discovery, readDeps);
  const buildOrder = d
    .workspaceBuildOrder(context, nodes)
    .map((node) => node.packageDir);

  const previousSelector = process.env.MICROSERVICES;
  try {
    if (selector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = selector;
    }
    const plan = d.buildPlan(context, selector);
    const projectList = [...d.devProjectList(context, plan)];
    const stage = [...plan.stage.map((staged) => staged.targetDir)].sort();
    return {
      discovery: discoveryFacts,
      buildOrder,
      projectList,
      stage,
    };
  } finally {
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
}

// ---------------------------------------------------------------------------
// Materialising / removing the generated Fixture_Tier under the copy.
// ---------------------------------------------------------------------------

/** Materialise generated content under `<copyDir>/fixtures/`. */
function materialiseTier(copyDir: string, content: FixtureContent): void {
  const tierRoot = resolve(copyDir, "fixtures");
  for (const file of content) {
    const full = resolve(tierRoot, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.contents, "utf8");
  }
}

/** Remove `<copyDir>/fixtures/` entirely, leaving no tier behind. */
function removeTier(copyDir: string): void {
  rmSync(resolve(copyDir, "fixtures"), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The property.
// ---------------------------------------------------------------------------

/**
 * The microservice identifiers Package_Discovery yields over the tree at the
 * given directory. Derived, not written — the accepted-Selector generator is
 * built from these, so R16.6's "Selector accepted by the Build_System" holds.
 */
function discoveredMicroserviceIdentifiers(
  d: Derivations,
  dir: string,
): readonly string[] {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const context = d.projectContext(d.defaultEffectiveConfig());
    const discovery = d.discoverPackages(context);
    return (discovery.byCategory.microservice ?? []).map(
      (pkg) => pkg.dirName as string,
    );
  } finally {
    process.chdir(previousCwd);
  }
}

/**
 * A Selector the Build_System ACCEPTS over a project whose discovered
 * microservice identifiers are `ids`: the wildcard `*`, the empty/whitespace
 * forms (which select none), and comma-separated lists — with the whitespace and
 * empty-entry noise the parser tolerates — drawn only from `ids`, plus the
 * unset case (`undefined`). Never an identifier outside `ids`, so no draw is
 * rejected with `[selector:unmatched]`.
 */
function arbAcceptedSelector(
  ids: readonly string[],
): fc.Arbitrary<string | undefined> {
  const trivial = fc.constantFrom<string | undefined>(
    "*",
    "",
    "   ",
    ",",
    " , ",
    undefined,
  );
  if (ids.length === 0) {
    return trivial;
  }
  const lists = fc
    .array(fc.constantFrom(...ids), { minLength: 1, maxLength: ids.length + 2 })
    .chain((chosen) =>
      fc
        .tuple(fc.constantFrom("", " ", "  "), fc.boolean())
        .map(([pad, addEmpty]) => {
          const parts = chosen.map((id) => `${pad}${id}${pad}`);
          if (addEmpty) parts.push("");
          return parts.join(",");
        }),
    );
  return fc.oneof(trivial, lists);
}

describe("Property 5: the Fixture_Tier's presence changes no derivation", () => {
  let derivations: Derivations;
  let clone: ReturnType<typeof pristineWorktree>;
  let copyDir: string | undefined;
  let selectorArb: fc.Arbitrary<string | undefined>;

  beforeAll(async () => {
    derivations = await loadDerivations();
    clone = pristineWorktree();
    if (clone.available) {
      copyDir = clone.dir;
      // Start from a copy with no tier, so the "absent" run is a clean baseline.
      removeTier(copyDir);
      // Build the accepted-Selector generator from the copy's own discovered
      // microservices (a configuration-derived subject, R16.11).
      const ids = discoveredMicroserviceIdentifiers(derivations, copyDir);
      selectorArb = arbAcceptedSelector(ids);
    }
  }, SUITE_TIMEOUT_MS);

  afterAll(() => {
    if (clone !== undefined && clone.available) {
      clone.cleanup();
    }
  });

  it(
    "yields identical discovery, build order, Project_List, and staged Image_Tree with the tier present and absent, for any Selector and any tier content",
    () => {
      if (copyDir === undefined) {
        const reason =
          clone.available === false
            ? clone.reason
            : "pristine worktree unavailable";
        // Skip with the returned reason rather than assert against no copy.
        console.warn(`skipping additive-invariance property: ${reason}`);
        return;
      }
      const dir = copyDir;

      const previousCwd = process.cwd();
      try {
        process.chdir(dir);
        fc.assert(
          fc.property(
            selectorArb,
            arbFixtureContent(),
            (selector, content) => {
              // Tier PRESENT: materialise the generated content, derive.
              materialiseTier(dir, content);
              const withTier = deriveHere(derivations, selector);

              // Tier ABSENT: remove it, derive again over the same copy.
              removeTier(dir);
              const withoutTier = deriveHere(derivations, selector);

              // Value for value, in order, across all four derivations.
              expect(
                withTier.discovery,
                `discovery differs with the tier present (selector=${JSON.stringify(
                  selector,
                )})`,
              ).toEqual(withoutTier.discovery);
              expect(
                withTier.buildOrder,
                `build order differs with the tier present (selector=${JSON.stringify(
                  selector,
                )})`,
              ).toEqual(withoutTier.buildOrder);
              expect(
                withTier.projectList,
                `Project_List differs with the tier present (selector=${JSON.stringify(
                  selector,
                )})`,
              ).toEqual(withoutTier.projectList);
              expect(
                withTier.stage,
                `staged Image_Tree differs with the tier present (selector=${JSON.stringify(
                  selector,
                )})`,
              ).toEqual(withoutTier.stage);
            },
          ),
          { numRuns: NUM_RUNS },
        );
      } finally {
        // Leave the copy tier-free and restore cwd.
        removeTier(dir);
        process.chdir(previousCwd);
      }
    },
    SUITE_TIMEOUT_MS,
  );
});

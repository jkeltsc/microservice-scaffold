// Feature: platform-fixtures, Property 2: Every Fixture_Scenario reports
// exactly the Diagnostic_Tag its name declares, under every behaviour-preserving
// perturbation.
//
// Where the deterministic sibling `fixture-scenario-diagnostics.test.ts` (task
// 4.3) asserts, once per Tree_Fixture, that the committed scenario reports
// exactly its one Expected_Diagnostic, THIS property strengthens that to a
// claim over MANY behaviour-preserving perturbations of each scenario: reorder
// its Root_Manifest `workspaces`, add a well-formed member in a category its
// fault does not concern, or relocate its Discovery_Roots to any assignment the
// Config_Parser accepts — none of which changes the fault the scenario carries,
// so each perturbed copy must still report exactly the one Expected_Diagnostic,
// no extra tag and not the empty set (R4.5, R4.6).
//
// WHY A CLONE, AND WHY AN IMPORTED FUNCTION (R7.2, R7.5, R7.7, R7.8; R4.6):
//
//   * A perturbation MUTATES the tree, and a Tree_Fixture is committed and must
//     never be written (R2.2, worktree safety). So every perturbation is applied
//     to a Fixture_Clone in an OS temp directory OUTSIDE the Project_Directory
//     (R7.2), never to the committed scenario. The clone is taken ONCE per
//     scenario in `beforeAll` (its copy is the cost, R7.8) and reused across
//     examples; each example applies its perturbation, computes the tag set,
//     then restores the copy from the bytes captured right after cloning (R7.8)
//     rather than re-cloning. `cleanup` runs in an UNCONDITIONAL `afterAll`, so
//     the temp copy is removed even when an assertion fails or a test throws
//     (R7.7).
//
//   * The entry point is invoked as an IMPORTED FUNCTION taking the copy's
//     directory as its Project_Directory (not a spawned process), so the run
//     floor stays affordable at >= 100 runs per scenario. We reproduce the
//     Repo_Invariant_Checker's OWN pipeline without its `process.exit`: load the
//     config (short-circuiting on a config diagnostic exactly as the CLI does,
//     via `requireProjectContext`), and only on a clean config proceed to
//     discovery and the four invariant checks. The compiled functions come from
//     the PLATFORM's own tree (`@microservices/build-tools/dist/...`), reached by
//     package name, never from a fixture's `node_modules` (R2.7, R3.7).
//
// HOW THE TAG SET IS BUILT, and the config short-circuit (mirrors
// `runRepoInvariantsCli` in `packages/build-tools/src/repo-invariants.ts`):
//
//   1. Load the Project_Config_File with `loadProjectConfig`, the same pure core
//      the CLI's `requireProjectContext` drives. On `rejected`, the reported set
//      is exactly the config diagnostics' tags (rendered with `renderDiagnostic`
//      to the bracketed `[category:detail]` form), and NO discovery runs — the
//      four-statement `loadProjectConfig` and the CLI both stop here (config
//      first, short-circuit before discovery). A config scenario therefore
//      yields only its config tag.
//   2. On a clean config, build the ProjectContext and run `collectViolations`
//      over `discoverPackages(context)`. `discoverPackages` THROWS a bracketed
//      `[discovery:*]` diagnostic; `collectViolations` RETURNS bracketed
//      messages. Either way the reported tag set is the bracketed tags recovered
//      from the combined text. A discovery scenario (clean config) therefore
//      proceeds to discovery and yields its discovery tag.
//
// Config loading and discovery are BOTH cwd-relative (the CLI reads
// `join(process.cwd(), PROJECT_CONFIG_FILE)` and discovery resolves roots
// against cwd). So we `chdir` into the copy for the run and restore
// `process.cwd()` in a `finally`, which exercises the same code path a real
// project at that directory exercises (R2.7).
//
// THE ROOTS GENERATOR (R16.11 — no path/scope literal of the property's own).
// `arbBehaviourPreservingPerturbation` takes a `PerturbationRoots` generator for
// its `relocate-roots` kind. `dist/testing/` exports no such generator, so this
// suite defines one inline: three Valid_Root_Paths with three DISTINCT lead
// segments, none equal to `packages`. Distinct lead segments make the three
// roots pairwise non-nesting (no `[config:root-overlap]`) and a lead segment
// other than `packages` keeps every root clear of the Framework_Singleton
// directories under `packages/` (no `[config:root-framework]`) — so a relocation
// is behaviour-preserving: it introduces no config diagnostic of its own, and
// the scenario's own fault travels with its moved files.
//
// THE UNCONCERNED CATEGORY (add-package kind) AND PER-SCENARIO NARROWING.
// R16.3 defines the three perturbation kinds AS behaviour-preserving, and the
// design delegates to THIS property the job of feeding a scenario only the kinds
// that genuinely preserve ITS fault ("only the property knows which category a
// given scenario's fault lives in"). Two facts about the fixed applier
// (`applyPerturbation`, which this task must not modify) shape the narrowing:
//
//   * `add-package` is forced to `spa` — no enumerated Tree_Fixture has a fault
//     under the spa Discovery_Root, so `spa` is unconcerned for every scenario.
//     The applier composes the added member's name under the scenario's
//     Configured_Scope, falling back to a fixture scope (`@fx`) when the
//     scenario declares no `scope`. A CONFIG scenario short-circuits before
//     discovery, so its added spa member is never discovered and introduces no
//     tag — behaviour-preserving. A DISCOVERY scenario declares no config, so its
//     true scope is the default `@microservices`; the applier's `@fx`-named
//     member does not mirror it and discovery reports `[discovery:mirror]` — so
//     `add-package` is NOT behaviour-preserving for a config-less scenario.
//
//   * `relocate-roots` rewrites the scenario's `roots` block and moves its
//     members. For a DISCOVERY scenario it carries the faulty members with their
//     tree intact — behaviour-preserving. For a CONFIG scenario it overwrites the
//     very config fault under test (and empties the new microservice root),
//     changing the reported tag — so it is NOT behaviour-preserving there.
//
// The clean discriminator between the two families is whether the scenario
// declares a `scaffold.config.json`, so `arbPerturbation(hasConfig)` selects:
// always `permute-workspaces`; plus `add-package` for a config scenario, or
// `relocate-roots` for a config-less one. `permute-workspaces` is
// behaviour-preserving for all (workspace order is load-bearing for nothing).
//
// Validates: Requirements 4.5, 4.6, 7.2, 7.5, 7.7, 7.8, 16.1, 16.3, 16.11

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  loadProjectConfig,
  type ConfigFileRead,
  type RootProbe,
} from "@microservices/build-tools/dist/config-loader.js";
import {
  PROJECT_CONFIG_FILE,
  renderDiagnostic,
} from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { discoverPackages } from "@microservices/build-tools/dist/discovery.js";
import { collectViolations } from "@microservices/build-tools/dist/repo-invariants.js";
import {
  arbBehaviourPreservingPerturbation,
  applyPerturbation,
  expectedDiagnosticOf,
  type BehaviourPreservingPerturbation,
  type PerturbationRoots,
} from "@microservices/build-tools/dist/testing/index.js";
import { fixtureClone } from "@microservices/build-tools/dist/testing/fixture-clone.js";
import type { CloneHandle } from "@microservices/build-tools/dist/testing/clone-handle.js";

import { FIXTURE_TREES_ROOT } from "./fixture-paths.js";

/** At least 100 generated inputs per scenario (R16.1). */
const NUM_RUNS = 100;

/** Cloning each scenario is cheap, but 19 scenarios x >=100 runs adds up; give
 *  each scenario's suite room. */
const SUITE_TIMEOUT_MS = 120_000;

/** The Diagnostic_Tag form: `[<category>:<detail>]`, both lowercase-and-hyphen.
 *  The regex fallback recovers a tag from rendered text where no structured tag
 *  field is available (config diagnostics ARE structured — see below — but a
 *  discovery message is only a string). */
const DIAGNOSTIC_TAG = /\[[a-z][a-z-]*:[a-z][a-z-]*\]/g;

// ---------------------------------------------------------------------------
// Reproducing the Repo_Invariant_Checker without its process.exit.
// ---------------------------------------------------------------------------

/** The cwd-relative config reader, mirroring the CLI's own
 *  `readConfigFileFromDisk`: ENOENT/ENOTDIR is `absent`, any other read failure
 *  is `unreadable`, everything else is the file text. */
function readConfigFile(configPath: string): ConfigFileRead {
  try {
    return { kind: "text", text: readFileSync(configPath, "utf8") };
  } catch (error) {
    const code: unknown = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "absent" };
    }
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The cwd-relative Discovery_Root prober, mirroring the CLI's own
 *  `probeRootFromDisk`: a missing path is `absent`, a non-directory is
 *  `not-directory`, otherwise a directory whose `holdsPackageJsonFile` answers
 *  the root-is-package question. `statSync` follows symlinks, matching the CLI. */
function probeRoot(rootPath: string): RootProbe {
  let stats;
  try {
    stats = statSync(rootPath);
  } catch (error) {
    const code: unknown = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "absent" };
    }
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!stats.isDirectory()) {
    return { kind: "not-directory" };
  }
  let holdsPackageJsonFile = false;
  try {
    holdsPackageJsonFile = statSync(join(rootPath, "package.json")).isFile();
  } catch {
    holdsPackageJsonFile = false;
  }
  return { kind: "directory", holdsPackageJsonFile };
}

/** The deduplicated, sorted set of Diagnostic_Tags in combined text. */
function tagsIn(text: string): readonly string[] {
  return [...new Set(text.match(DIAGNOSTIC_TAG) ?? [])].sort();
}

/**
 * The Diagnostic_Tag set the Repo_Invariant_Checker reports over the tree at the
 * current working directory — the same pipeline `runRepoInvariantsCli` runs,
 * minus its `process.exit`. Config first: a rejected config short-circuits to
 * exactly the config tags with NO discovery (the CLI's `requireProjectContext`
 * exits before any check on a config diagnostic). A clean config proceeds to
 * discovery and the four invariant checks.
 */
function reportedTagsForCwd(): readonly string[] {
  // 1. Load the config, cwd-relative, exactly as the CLI does.
  const outcome = loadProjectConfig(
    readConfigFile,
    probeRoot,
    join(process.cwd(), PROJECT_CONFIG_FILE),
  );

  if (outcome.kind === "rejected") {
    // Config short-circuit: the CLI exits here, before discovery. The config
    // diagnostics carry a structured `.tag` (bracket-free); render them to the
    // bracketed form the reported set uses.
    const rendered = outcome.diagnostics
      .map((diag) => renderDiagnostic(diag))
      .join("\n");
    return tagsIn(rendered);
  }

  // 2. Clean config: run discovery and the four checks. `discoverPackages`
  //    THROWS a bracketed `[discovery:*]` diagnostic; `collectViolations`
  //    RETURNS bracketed messages. Recover tags from whichever produced output.
  const context = projectContext(outcome.config);
  try {
    const violations = collectViolations(context, discoverPackages(context));
    return tagsIn(violations.join("\n"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return tagsIn(message);
  }
}

/** Run `reportedTagsForCwd` with `dir` as the working directory, restoring the
 *  previous cwd unconditionally. */
function reportedTagsFor(dir: string): readonly string[] {
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    return reportedTagsForCwd();
  } finally {
    process.chdir(previousCwd);
  }
}

// ---------------------------------------------------------------------------
// The inline PerturbationRoots generator (R16.11).
// ---------------------------------------------------------------------------

/**
 * A `PerturbationRoots` the Config_Parser accepts as a behaviour-preserving
 * relocation: three Valid_Root_Paths with three DISTINCT lead segments, none
 * equal to `packages`.
 *
 * A Valid_Root_Path is a relative POSIX path with no leading/trailing slash, no
 * whitespace at the ends, no `\`, `*`, or `?`, and no `.`, `..`, or empty
 * segment. Distinct lead segments make the three pairwise non-nesting (no
 * `[config:root-overlap]`); a lead segment other than `packages` keeps each root
 * clear of the Framework_Singleton directories under `packages/` (no
 * `[config:root-framework]`). So a relocation to any value this generator
 * produces introduces no config diagnostic of its own.
 *
 * `dist/testing/` exports no root generator, so this is defined here rather than
 * imported — the property's ONE local generator, holding no path literal that
 * names this project's own Discovery_Roots.
 */
const arbRootLeadSegment: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 2,
    maxLength: 8,
  })
  .map((letters) => letters.join(""))
  .filter((segment) => segment !== "packages");

/** An optional single extra path segment appended to a lead segment, so roots
 *  range over both single-segment (`svc`) and nested (`svc/here`) shapes while
 *  staying Valid_Root_Paths. */
const arbOptionalSubsegment: fc.Arbitrary<string> = fc.option(
  fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
      minLength: 1,
      maxLength: 6,
    })
    .map((letters) => `/${letters.join("")}`),
  { nil: "" },
);

const arbPerturbationRoots: fc.Arbitrary<PerturbationRoots> = fc
  .uniqueArray(arbRootLeadSegment, { minLength: 3, maxLength: 3 })
  .chain(([microserviceLead, commonLead, spaLead]) =>
    fc
      .tuple(
        arbOptionalSubsegment,
        arbOptionalSubsegment,
        arbOptionalSubsegment,
      )
      .map(
        ([mSub, cSub, sSub]): PerturbationRoots => ({
          microservice: `${microserviceLead}${mSub}`,
          common: `${commonLead}${cSub}`,
          spa: `${spaLead}${sSub}`,
        }),
      ),
  );

/**
 * The perturbation generator for a scenario, narrowed to the kinds that are
 * genuinely behaviour-preserving FOR THAT SCENARIO (R16.3 defines the three
 * kinds AS behaviour-preserving; the property is what knows which apply to a
 * given fixture — the design delegates exactly this to the consuming property).
 *
 * The `add-package` kind is forced to `spa`: no enumerated Tree_Fixture has a
 * fault under the spa Discovery_Root, so `spa` is the unconcerned category for
 * every scenario. `applyPerturbation` writes a well-formed spa member (a
 * `scripts.build` plus a name composed under the scenario's Configured_Scope).
 *
 * The narrowing turns on whether the scenario declares a `scaffold.config.json`,
 * which cleanly separates the two fault families of the enumerated set:
 *
 *   * A CONFIG scenario (fault in `scaffold.config.json`): the config is
 *     rejected, so the run short-circuits BEFORE discovery — an added spa member
 *     is never discovered, so `add-package` introduces no tag and IS
 *     behaviour-preserving. But `relocate-roots` rewrites the config's `roots`
 *     block (and, moving the members it can find, leaves the new microservice
 *     root empty), which changes the very config fault under test — so it is NOT
 *     behaviour-preserving for a config scenario and is excluded.
 *
 *   * A DISCOVERY scenario (fault under the microservice Discovery_Root, no
 *     config, so scope defaults to `@microservices`): the run reaches discovery,
 *     so `relocate-roots` — which moves the faulty members with their tree and
 *     re-points the roots — carries the fault intact and IS behaviour-preserving.
 *     But `add-package` composes the added member's name under the applier's
 *     fallback fixture scope (`@fx`), which does not mirror the scenario's actual
 *     `@microservices` scope, so discovery reports `[discovery:mirror]` — not
 *     behaviour-preserving for a config-less scenario, and excluded.
 *
 * `permute-workspaces` is behaviour-preserving for every scenario (workspace
 * order is load-bearing for nothing), so it is always included.
 */
function arbPerturbation(
  hasConfig: boolean,
): fc.Arbitrary<BehaviourPreservingPerturbation> {
  return arbBehaviourPreservingPerturbation(arbPerturbationRoots)
    .map((perturbation) =>
      perturbation.kind === "add-package"
        ? ({ ...perturbation, category: "spa" as const })
        : perturbation,
    )
    .filter((perturbation) =>
      perturbation.kind === "permute-workspaces"
        ? true
        : hasConfig
          ? perturbation.kind === "add-package"
          : perturbation.kind === "relocate-roots",
    );
}

// ---------------------------------------------------------------------------
// Clone once per scenario, capture a byte snapshot, restore between examples.
// ---------------------------------------------------------------------------

/** A captured snapshot of a copied subtree: relative file paths -> bytes, plus
 *  the set of relative directory paths, so a mutated copy can be restored to its
 *  post-clone state by wiping and rewriting, never through git (R7.8). */
interface Snapshot {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly dirs: readonly string[];
}

/** Capture every regular file's bytes and every directory under `root`,
 *  relative to `root`. Symlinks are not expected inside a Tree_Fixture (R2.3),
 *  so they are neither captured nor restored. */
function snapshot(root: string): Snapshot {
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];
  const walk = (absolute: string, relativeTo: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbs = join(absolute, entry.name);
      const childRel = relativeTo === "" ? entry.name : `${relativeTo}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(childRel);
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        files.set(childRel, readFileSync(childAbs));
      }
    }
  };
  walk(root, "");
  return { files, dirs };
}

/** Restore `root` to `captured` by removing the whole subtree and rewriting the
 *  captured bytes (R7.8 — restore captured bytes rather than re-cloning). Writes
 *  only under `root`, an OS-temp clone directory, never the checked-out tree. */
function restore(root: string, captured: Snapshot): void {
  for (const entry of readdirSync(root)) {
    rmSync(join(root, entry), { recursive: true, force: true });
  }
  // Recreate every captured directory (covers an empty directory the file loop
  // would not), then rewrite every captured file's bytes. None is expected to be
  // empty in a Tree_Fixture, but restoring the exact path set is what makes the
  // next example start from the post-clone state.
  for (const dir of captured.dirs) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const [rel, bytes] of captured.files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}

/** Every direct subdirectory of `fixtures/trees/` is a Fixture_Scenario. */
function discoverScenarios(): readonly string[] {
  return readdirSync(FIXTURE_TREES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const scenarios = discoverScenarios();

describe("Property 2: every Fixture_Scenario reports exactly its declared tag under perturbation", () => {
  // Sanity: there ARE scenarios, so an empty enumeration cannot pass vacuously.
  it("discovers at least one Tree_Fixture", () => {
    expect(
      scenarios.length,
      `no Fixture_Scenario found under ${FIXTURE_TREES_ROOT}`,
    ).toBeGreaterThan(0);
  });

  for (const name of scenarios) {
    const scenarioSource = resolve(FIXTURE_TREES_ROOT, name);
    // Recover the Expected_Diagnostic from the directory name; this throws
    // (naming the directory) for a malformed name, which is the loud failure
    // R4.2 wants.
    const expected = expectedDiagnosticOf(name);
    // Whether the scenario declares its own Project_Config_File, which selects
    // the behaviour-preserving perturbation kinds for it (see `arbPerturbation`).
    const hasConfig = existsSync(
      resolve(scenarioSource, "scaffold.config.json"),
    );

    describe(name, () => {
      let handle: CloneHandle | undefined;
      let baseline: Snapshot | undefined;

      beforeAll(() => {
        // Clone the committed scenario ONCE (R7.8), into an OS temp directory
        // outside the Project_Directory (R7.2). The committed scenario is never
        // written; every perturbation lands on the copy.
        handle = fixtureClone(scenarioSource);
        if (handle.available) {
          baseline = snapshot(handle.dir);
        }
      });

      afterAll(() => {
        // Unconditional teardown (R7.7): remove the temp copy even if an
        // assertion failed or a test threw. `cleanup` is idempotent and exists
        // only on an available handle (an unavailable clone copied nothing).
        if (handle !== undefined && handle.available) {
          handle.cleanup();
        }
      });

      it(
        `reports exactly { ${expected} } under every behaviour-preserving perturbation`,
        () => {
          if (handle === undefined || !handle.available || baseline === undefined) {
            const reason =
              handle !== undefined && handle.available === false
                ? handle.reason
                : "fixture clone unavailable";
            // Skip with the returned reason rather than assert against no copy.
            console.warn(`skipping Property 2 for ${name}: ${reason}`);
            return;
          }
          const dir = handle.dir;
          const captured = baseline;

          // Sanity: the UNPERTURBED copy reports exactly the one Expected tag,
          // so a bug in the reproduction of the pipeline fails loudly rather
          // than hiding behind the perturbation loop.
          expect(
            reportedTagsFor(dir),
            `${name}: the unperturbed clone must report exactly { ${expected} }`,
          ).toEqual([expected]);

          fc.assert(
            fc.property(arbPerturbation(hasConfig), (perturbation) => {
              try {
                applyPerturbation(dir, perturbation);
                const reported = reportedTagsFor(dir);
                expect(
                  reported,
                  `${name}: perturbation ${JSON.stringify(
                    perturbation,
                  )} changed the reported tag set to { ${reported.join(", ")} }; ` +
                    `it must stay exactly { ${expected} }`,
                ).toEqual([expected]);
              } finally {
                // Restore the copy to its post-clone bytes for the next example
                // (R7.8) — via fs, never git.
                restore(dir, captured);
              }
            }),
            { numRuns: NUM_RUNS },
          );
        },
        SUITE_TIMEOUT_MS,
      );
    });
  }
});

// Feature: platform-fixtures, Step 1 — the tier layout suite (task 1.2).
//
// This suite pins the STRUCTURE of the Fixture_Tier and its exclusion from every
// platform mechanism, at the source-of-truth level (the committed files and
// manifests themselves), so a regression in any of these facts is caught without
// running the build pipeline. It asserts, over this repository:
//
//   1. The tier's shape and its two partitions (R1.1, R1.2, R1.3): `fixtures/`
//      exists directly under the Project_Directory, holds exactly the two
//      scenario partitions `trees/` and `projects/`, is not itself a package,
//      and commits a `README.md`.
//   2. No root `workspaces` entry and no enumerated workspace path matches
//      anything under `fixtures/` (R1.3, R10.1, R10.2): the declared `workspaces`
//      globs match no `fixtures/` path, and the workspace set npm actually
//      enumerates (the same set the `--workspaces` lint/typecheck/test fan-out
//      walks) contains no location under `fixtures/`.
//   3. No source under `packages/build-tools/src/` spells `fixtures` as a path
//      literal (R1.7): a mechanism that cannot see the tier cannot change
//      behaviour because of it.
//   4. `scripts/emit-effective-dockerfile.sh`, `scripts/build.js`,
//      `scripts/start.js`, and `scripts/dev.js` read no path under `fixtures/`
//      (R10.11).
//   5. `.dockerignore` excludes the tier (R10.8), so a deliberately-broken
//      manifest never reaches an image build's whole-context copy.
//   6. The root Vitest run collects no test file from under `fixtures/` (R10.10):
//      every collection project root lies under `packages/`, and a `vitest list`
//      of the collected set names no file under `fixtures/`.
//   7. Every file under `fixtures/` is either tracked or ignored, failing by
//      naming the path (R11.1, R11.5): a scenario file left untracked fails here
//      rather than passing locally and failing on a fresh clone.
//
// The per-scenario enumeration (R4.7 — every direct subdirectory of `trees/` and
// of the Fixture_Projects_Root is a well-formed, declared scenario — and R4.8 —
// no two scenarios share a name across both partitions) is ACTIVATED here (task
// 4.7). It is the STRUCTURAL half of the guarantee: it reads each scenario's
// Scenario_Manifest and checks the manifest's required shape, the
// name/tag/partition agreement, and cross-partition name uniqueness, WITHOUT
// spawning any entry point. The per-scenario spawn that asserts each scenario
// reports exactly its one declared tag lives in `fixture-scenario-diagnostics.test.ts`
// (task 4.3); this suite deliberately does not duplicate it.
//
// This suite reads only; it writes nothing to the tree.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.7, 4.7, 4.8, 10.1, 10.2, 10.8, 10.9,
//   10.10, 10.11, 11.1, 11.5

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import { expectedDiagnosticOf } from "@microservices/build-tools/dist/testing/index.js";

import { FIXTURE_TREES_ROOT, FIXTURE_PROJECTS_ROOT } from "./fixture-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The Fixture_Tier root, a direct child of the Project_Directory. */
const FIXTURES_DIR = resolve(repoRoot, "fixtures");

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

interface RootManifest {
  readonly workspaces?: readonly string[];
}

function readRootManifest(): RootManifest {
  return JSON.parse(readText("package.json")) as RootManifest;
}

// ---------------------------------------------------------------------------
// 1. The tier's shape and its two partitions (R1.1, R1.2, R1.3).
// ---------------------------------------------------------------------------

describe("the Fixture_Tier exists with exactly its two partitions (R1.1)", () => {
  it("is a directory directly inside the Project_Directory", () => {
    expect(
      existsSync(FIXTURES_DIR),
      "fixtures/ must exist directly inside the Project_Directory",
    ).toBe(true);
    expect(statSync(FIXTURES_DIR).isDirectory()).toBe(true);
  });

  it("holds both scenario partitions, trees/ and projects/, as directories", () => {
    for (const partition of ["trees", "projects"] as const) {
      const dir = resolve(FIXTURES_DIR, partition);
      expect(
        existsSync(dir) && statSync(dir).isDirectory(),
        `fixtures/${partition}/ must exist as a directory`,
      ).toBe(true);
    }
  });

  it("holds no scenario partition other than trees/ and projects/", () => {
    // R1.1: the tier carries Fixture_Scenarios in those two subdirectories and
    // nowhere else. Only directories can carry scenarios; the committed
    // README.md and the JSON coverage record are files, so the qualifying set
    // (non-dot subdirectories) is exactly the two partitions.
    const subdirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    expect(subdirs).toEqual(["projects", "trees"]);
  });

  it("is not itself a workspace package (declares no package.json)", () => {
    // R1.3: the tier is neither a workspace package nor a Discovery_Root. A
    // package would declare a manifest at its root; the tier does not.
    expect(existsSync(resolve(FIXTURES_DIR, "package.json"))).toBe(false);
  });
});

describe("the Fixture_Tier commits a README.md (R1.2)", () => {
  it("holds fixtures/README.md", () => {
    const readme = resolve(FIXTURES_DIR, "README.md");
    expect(existsSync(readme) && statSync(readme).isFile()).toBe(true);
  });

  it("names the directory a new scenario of each kind belongs in", () => {
    // R1.2: the README names where a Tree_Fixture and a Project_Fixture each go,
    // so a contributor learns the partition without reading a test.
    const readme = readText("fixtures/README.md");
    expect(readme).toContain("fixtures/trees/");
    expect(readme).toContain("fixtures/projects/");
  });
});

// ---------------------------------------------------------------------------
// 2. No workspace membership reaches the tier (R1.3, R10.1, R10.2).
// ---------------------------------------------------------------------------

describe("no root workspaces entry matches anything under fixtures/ (R10.1)", () => {
  it("declares no glob or literal under fixtures/", () => {
    const workspaces = readRootManifest().workspaces ?? [];
    const offenders = workspaces.filter(
      (entry) => entry === "fixtures" || entry.startsWith("fixtures/"),
    );
    expect(
      offenders,
      `the root workspaces array must match no path under fixtures/, ` +
        `but declares:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("the enumerated workspace set reaches no fixture path (R10.2)", () => {
  it("npm enumerates no workspace location under fixtures/", () => {
    // The `--workspaces` fan-out for lint, typecheck, and test enumerates the
    // workspace set npm resolves from the root `workspaces` array. Query that
    // exact set (npm query ".workspace" reports one entry per workspace with its
    // location) and assert no location lies under fixtures/. Reached from the
    // repo root so the query resolves this repository's own workspaces.
    const run = spawnSync("npm", ["query", ".workspace"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(
      run.status,
      `npm query ".workspace" failed: ${run.stderr ?? run.error?.message ?? ""}`,
    ).toBe(0);

    const locations = (
      JSON.parse(run.stdout) as ReadonlyArray<{ readonly location?: string }>
    )
      .map((entry) => entry.location ?? "")
      .filter((location) => location.length > 0);

    // Sanity: the enumeration is non-empty, so an empty set cannot pass this
    // check vacuously.
    expect(locations.length).toBeGreaterThan(0);

    const offenders = locations.filter(
      (location) => location === "fixtures" || location.startsWith("fixtures/"),
    );
    expect(
      offenders,
      `npm enumerated a workspace under fixtures/:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The Build_System spells no `fixtures` path literal (R1.7).
// ---------------------------------------------------------------------------

/** Directory names never descended into while collecting scannable sources. */
const IGNORED_DIRS = new Set(["node_modules", "dist"]);

/**
 * Every file under `dir` (recursively) whose name matches `keep`, repo-relative.
 * `node_modules`, `dist`, and any `.git*` entry are pruned so the scan sees
 * committed source only.
 */
function collectFiles(
  dir: string,
  keep: (fileName: string) => boolean,
): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".git")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      out.push(...collectFiles(full, keep));
    } else if (entry.isFile() && keep(entry.name)) {
      out.push(relative(repoRoot, full));
    }
  }
  return out;
}

describe("no Build_System source spells 'fixtures' as a path literal (R1.7)", () => {
  it("no .ts under packages/build-tools/src/ contains the token", () => {
    // A mechanism that cannot see the tier cannot change behaviour because of
    // it, so the tier stays additive. This is a preservation obligation: the
    // token is absent today. The scan looks in every tracked TypeScript source
    // under the Build_System's own tree; this test file lives under
    // packages/integration-tests/, so it never scans itself.
    const sources = collectFiles(
      resolve(repoRoot, "packages/build-tools/src"),
      (name) => name.endsWith(".ts"),
    );
    // Sanity: the Build_System has sources, so an empty scan cannot pass this
    // check vacuously.
    expect(sources.length).toBeGreaterThan(0);

    const token = "fixtures";
    const offenders = sources.filter((file) => readText(file).includes(token));
    expect(
      offenders,
      `a Build_System source spells the '${token}' path literal in:\n` +
        `${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The named repo-level scripts read no path under fixtures/ (R10.11).
// ---------------------------------------------------------------------------

describe("the platform's repo-level scripts read no fixtures path (R10.11)", () => {
  // Exactly the four scripts R10.11 names. `record-baseline.js` is deliberately
  // out of scope: it is a one-shot developer recorder, not part of any build,
  // start, or dev path, and its comments mention "baseline fixtures" — an
  // unrelated use of the word.
  const SCANNED_SCRIPTS = [
    "scripts/emit-effective-dockerfile.sh",
    "scripts/build.js",
    "scripts/start.js",
    "scripts/dev.js",
  ] as const;

  it.each(SCANNED_SCRIPTS)("%s contains no 'fixtures' path token", (script) => {
    expect(
      existsSync(resolve(repoRoot, script)),
      `${script} must exist`,
    ).toBe(true);
    expect(
      readText(script).includes("fixtures"),
      `${script} must read no path under fixtures/`,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. `.dockerignore` excludes the tier (R10.8).
// ---------------------------------------------------------------------------

describe(".dockerignore excludes the Fixture_Tier (R10.8)", () => {
  it("declares a fixtures/ exclusion entry", () => {
    // The build stage's whole-context copy must carry no fixture, so a
    // deliberately-broken manifest never reaches an image build. A `fixtures/`
    // line (a bare `fixtures` line would also match) does that.
    const lines = readText(".dockerignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const excludesTier = lines.some(
      (line) => line === "fixtures" || line === "fixtures/",
    );
    expect(
      excludesTier,
      ".dockerignore must exclude the Fixture_Tier with a `fixtures/` entry",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. The root Vitest run collects no file from under fixtures/ (R10.10).
// ---------------------------------------------------------------------------

describe("the root Vitest run collects no file under fixtures/ (R10.10)", () => {
  it("every workspace project root lies under packages/", () => {
    // The collected test set is the union over the workspace projects' roots of
    // their include globs; every include glob is relative to a project root.
    // Every project root in vitest.workspace.ts points under packages/, so no
    // glob can reach fixtures/. Pin that here as the structural half of the
    // guarantee, independent of running collection.
    const workspaceConfig = readText("vitest.workspace.ts");
    const roots = [...workspaceConfig.matchAll(/root:\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    // Sanity: there are projects to check.
    expect(roots.length).toBeGreaterThan(0);
    const offenders = roots.filter(
      (root) =>
        root.replace(/^\.\//, "") === "fixtures" ||
        root.replace(/^\.\//, "").startsWith("fixtures/"),
    );
    expect(
      offenders,
      `a Vitest project root lies under fixtures/:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("a vitest list of the collected set names no file under fixtures/", () => {
    // The authoritative half: ask Vitest itself what the root run collects.
    // `vitest list --json` reports the collected test files without executing
    // any test, so this is safe to run as a subprocess. Reached from the repo
    // root so it uses this repository's own workspace configuration.
    const run = spawnSync("npx", ["vitest", "list", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      // Generous, since collection loads every test module. list mode runs no
      // test body, so this stays well under the deadline in practice.
      timeout: 120_000,
    });
    // If collection could not run for an environmental reason, do not silently
    // pass: the structural assertion above still stands, but this half must have
    // actually observed the collected set.
    expect(
      run.status,
      `vitest list failed: ${run.stderr ?? run.error?.message ?? ""}`,
    ).toBe(0);

    const collected = JSON.parse(run.stdout) as ReadonlyArray<{
      readonly file?: string;
    }>;
    const files = [
      ...new Set(collected.map((entry) => entry.file ?? "")),
    ].filter((file) => file.length > 0);

    // Sanity: the run collected files, so an empty set cannot pass vacuously.
    expect(files.length).toBeGreaterThan(0);

    const fixturesPrefix = `${FIXTURES_DIR}/`;
    const offenders = files.filter(
      (file) => file === FIXTURES_DIR || file.startsWith(fixturesPrefix),
    );
    expect(
      offenders,
      `the root Vitest run collected a file under fixtures/:\n` +
        `${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Every file under fixtures/ is tracked or ignored (R11.1, R11.5).
// ---------------------------------------------------------------------------

describe("every file under fixtures/ is tracked or ignored (R11.5)", () => {
  it("reports no file that is neither tracked nor ignored", () => {
    // R11.5: a scenario file left untracked must fail here rather than passing
    // locally and failing on a fresh clone. `git ls-files --others
    // --exclude-standard` lists exactly the untracked-and-not-ignored files —
    // the offence set. Restricted to `fixtures/` and NUL-delimited so paths with
    // spaces survive.
    const run = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "fixtures"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(
      run.status,
      `git ls-files failed: ${run.stderr ?? run.error?.message ?? ""}`,
    ).toBe(0);

    const offenders = run.stdout.split("\0").filter((path) => path.length > 0);
    expect(
      offenders,
      `every file under fixtures/ must be tracked or ignored; these are ` +
        `neither:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Every direct subdirectory of each partition is a well-formed, declared
//    scenario (R4.7), and no two scenarios share a name across both partitions
//    (R4.8, R10.9).
// ---------------------------------------------------------------------------

/**
 * A Scenario_Manifest (`fixture.json`) as this structural suite reads it. Every
 * field R4.7 requires a "well-formed, declared scenario" to carry is present:
 * the `expectedDiagnostic` tag (with brackets), the `entryPoint`, the one-line
 * `fault`, and the `partition` with its `kind` and `justification`.
 */
interface ScenarioManifest {
  readonly expectedDiagnostic?: unknown;
  readonly entryPoint?: unknown;
  readonly fault?: unknown;
  readonly partition?: {
    readonly kind?: unknown;
    readonly justification?: unknown;
  };
}

/** The Diagnostic_Tag form, anchored: `[<category>:<detail>]`, both lowercase. */
const TAG_SHAPE = /^\[[a-z][a-z-]*:[a-z][a-z-]*\]$/;

/**
 * The direct subdirectories of a partition root that are Fixture_Scenarios.
 *
 * A scenario is a DIRECTORY; a partition root's own files (the
 * Fixture_Projects_Root's `package.json` / `package-lock.json`, a dot-file such
 * as `.gitkeep`) are not scenarios, and `node_modules/` — which only
 * `fixtures:install` writes into the Fixture_Projects_Root — is not a scenario
 * either. The `trees/` partition currently holds nineteen scenarios; the
 * `projects/` partition holds none until task 5.1 adds them, so this returns an
 * empty list for it today and validates each member once they exist.
 */
function scenarioDirsOf(partitionRoot: string): readonly string[] {
  if (!existsSync(partitionRoot)) {
    return [];
  }
  return readdirSync(partitionRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith("."),
    )
    .map((entry) => entry.name)
    .sort();
}

/** Read a scenario's Scenario_Manifest (`fixture.json`) at its scenario root. */
function readScenarioManifest(scenarioDir: string): ScenarioManifest {
  return JSON.parse(
    readFileSync(resolve(scenarioDir, "fixture.json"), "utf8"),
  ) as ScenarioManifest;
}

interface Partition {
  /** The partition's directory name, for failure messages. */
  readonly label: string;
  /** The absolute partition root. */
  readonly root: string;
  /** The `partition.kind` a scenario in this partition must declare. */
  readonly kind: "tree" | "project";
}

const PARTITIONS: readonly Partition[] = [
  { label: "trees", root: FIXTURE_TREES_ROOT, kind: "tree" },
  { label: "projects", root: FIXTURE_PROJECTS_ROOT, kind: "project" },
];

describe("every partition subdirectory is a well-formed, declared scenario (R4.7)", () => {
  // Sanity: the trees/ partition has scenarios, so an empty enumeration cannot
  // let this section pass vacuously. (projects/ is legitimately empty until task
  // 5.1, so it is not asserted non-empty here.)
  it("discovers the nineteen Tree_Fixtures under trees/", () => {
    const treeScenarios = scenarioDirsOf(FIXTURE_TREES_ROOT);
    expect(
      treeScenarios.length,
      `expected the nineteen enumerated Tree_Fixtures under ${FIXTURE_TREES_ROOT}, ` +
        `found ${treeScenarios.length}: ${treeScenarios.join(", ")}`,
    ).toBe(19);
  });

  for (const partition of PARTITIONS) {
    const scenarios = scenarioDirsOf(partition.root);

    // A partition with no scenarios (projects/ until task 5.1) contributes no
    // describe block: Vitest treats an empty suite as an error, and there is
    // nothing to enumerate. The disjointness check below still ranges over the
    // empty set correctly.
    if (scenarios.length === 0) {
      continue;
    }

    describe(`${partition.label}/`, () => {
      for (const name of scenarios) {
        const scenarioDir = resolve(partition.root, name);

        describe(name, () => {
          it("holds a fixture.json Scenario_Manifest", () => {
            const manifestPath = resolve(scenarioDir, "fixture.json");
            expect(
              existsSync(manifestPath) && statSync(manifestPath).isFile(),
              `scenario ${partition.label}/${name} must hold a fixture.json ` +
                `Scenario_Manifest at its root`,
            ).toBe(true);
          });

          it("declares the required Scenario_Manifest fields", () => {
            const manifest = readScenarioManifest(scenarioDir);

            expect(
              typeof manifest.expectedDiagnostic === "string" &&
                TAG_SHAPE.test(manifest.expectedDiagnostic),
              `${partition.label}/${name}: expectedDiagnostic must be a ` +
                `bracketed Diagnostic_Tag, got ` +
                `${JSON.stringify(manifest.expectedDiagnostic)}`,
            ).toBe(true);

            expect(
              typeof manifest.entryPoint === "string" &&
                manifest.entryPoint.length > 0,
              `${partition.label}/${name}: entryPoint must be a non-empty string`,
            ).toBe(true);

            expect(
              typeof manifest.fault === "string" && manifest.fault.length > 0,
              `${partition.label}/${name}: fault must be a non-empty string`,
            ).toBe(true);

            expect(
              typeof manifest.partition?.kind === "string" &&
                typeof manifest.partition?.justification === "string" &&
                manifest.partition.justification.length > 0,
              `${partition.label}/${name}: partition must declare a string kind ` +
                `and a non-empty justification`,
            ).toBe(true);
          });

          it("bears a well-formed Scenario_Directory_Name recovering to its declared tag", () => {
            // `expectedDiagnosticOf` throws — naming the directory — when the
            // name holds no `--` or more than one, so a malformed name is a loud
            // failure here rather than a silent misreading (R4.7).
            const recovered = expectedDiagnosticOf(name);
            const declared = readScenarioManifest(scenarioDir)
              .expectedDiagnostic as string;
            expect(
              recovered,
              `${partition.label}/${name}: name recovers ${recovered}, but its ` +
                `Scenario_Manifest declares ${declared}`,
            ).toBe(declared);
          });

          it(`declares partition.kind "${partition.kind}", matching the partition it lives in`, () => {
            const manifest = readScenarioManifest(scenarioDir);
            expect(
              manifest.partition?.kind,
              `${partition.label}/${name}: a scenario under ${partition.label}/ ` +
                `must declare partition.kind "${partition.kind}"`,
            ).toBe(partition.kind);
          });
        });
      }
    });
  }
});

describe("no two scenarios share a name across both partitions (R4.8, R10.9)", () => {
  it("the trees/ and projects/ scenario-name sets are disjoint", () => {
    const treeNames = scenarioDirsOf(FIXTURE_TREES_ROOT);
    const projectNames = new Set(scenarioDirsOf(FIXTURE_PROJECTS_ROOT));
    const shared = treeNames.filter((name) => projectNames.has(name));
    expect(
      shared,
      shared.length === 0
        ? "expected disjoint scenario-name sets"
        : `these Scenario_Directory_Names appear in BOTH partitions:\n` +
            shared
              .map(
                (name) =>
                  `  ${name}: ${join(FIXTURE_TREES_ROOT, name)} and ` +
                  `${join(FIXTURE_PROJECTS_ROOT, name)}`,
              )
              .join("\n"),
    ).toEqual([]);
  });
});

// Feature: platform-fixtures, Step 4 — the deterministic per-scenario
// diagnostics suite (task 4.3).
//
// For every Tree_Fixture under `fixtures/trees/`, this suite asserts two things,
// deterministically (no property generation — that is task 4.4's job):
//
//   1. NAME/MANIFEST AGREEMENT (R4.2). Recover the Expected_Diagnostic from the
//      scenario's Scenario_Directory_Name with `expectedDiagnosticOf` and assert
//      it equals the `expectedDiagnostic` the scenario's Scenario_Manifest
//      declares. A failure names the directory, the recovered tag, and the
//      declared tag. `expectedDiagnosticOf` itself throws — naming the directory —
//      when the name holds no `--` or more than one, so a malformed name is a
//      loud failure here rather than a silent misreading.
//
//   2. MINIMALITY (R4.5, R4.6). Invoke the platform entry point the manifest
//      names — as a SPAWNED PROCESS with the scenario's directory as its working
//      directory (R2.6) — and assert the reported Diagnostic_Tag set is exactly
//      the one-element set holding that scenario's Expected_Diagnostic: no extra
//      tag, and not the empty set.
//
// R2.2 / R2.6 / R2.7: a Tree_Fixture is READ and its directory is passed as the
// working directory of the spawned process; the suite installs nothing, builds
// nothing, executes no fixture module, and writes no file inside a Tree_Fixture.
// Every path it would report is derived from the scenario directory, never from
// a path literal of its own. The platform's bin is resolved from the PLATFORM's
// own tree (`packages/build-tools/dist/bin/…`), reached from this file's
// location, never from a fixture's `node_modules` (R2.7, R3.7). The entry point
// under test — the Repo_Invariant_Checker — reaches the filesystem only through
// its own effect shell over the directory it is handed as cwd, which is the same
// code path a real project exercises (R2.7).
//
// Validates: Requirements 2.2, 2.6, 2.7, 4.2, 4.3, 4.4, 4.5, 4.6

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { expectedDiagnosticOf } from "@microservices/build-tools/dist/testing/index.js";

import { FIXTURE_TREES_ROOT } from "./fixture-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The platform's own bins, resolved from the PLATFORM's tree — never from a
 * fixture's `node_modules` (R2.7, R3.7). Keyed by the `entryPoint` name a
 * Scenario_Manifest declares. Every current Tree_Fixture names
 * `runRepoInvariantsCli`, whose bin is the compiled Repo_Invariant_Checker the
 * root `check:invariants` runs.
 */
const PLATFORM_BINS: Readonly<Record<string, string>> = {
  runRepoInvariantsCli: resolve(
    repoRoot,
    "packages/build-tools/dist/bin/check-repo-invariants.js",
  ),
};

/** The Diagnostic_Tag form: `[<category>:<detail>]`, both lowercase-and-hyphen. */
const DIAGNOSTIC_TAG = /\[[a-z][a-z-]*:[a-z][a-z-]*\]/g;

/** A running fixture may take a moment to load and scan; give it room. */
const RUN_TIMEOUT_MS = 60_000;

interface ScenarioManifest {
  readonly expectedDiagnostic: string;
  readonly entryPoint: string;
}

/** Every direct subdirectory of `fixtures/trees/` is a Fixture_Scenario. */
function discoverScenarios(): readonly string[] {
  return readdirSync(FIXTURE_TREES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Read a scenario's Scenario_Manifest (`fixture.json`) at its scenario root. */
function readManifest(scenarioDir: string): ScenarioManifest {
  const manifestPath = resolve(scenarioDir, "fixture.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ScenarioManifest;
}

/** The deduplicated, sorted set of Diagnostic_Tags in a run's combined output. */
function reportedTagSet(output: string): readonly string[] {
  return [...new Set(output.match(DIAGNOSTIC_TAG) ?? [])].sort();
}

const scenarios = discoverScenarios();

describe("every Tree_Fixture reports exactly its named diagnostic (R4.6)", () => {
  // Sanity: there ARE scenarios, so an empty enumeration cannot pass vacuously.
  it("discovers at least one Tree_Fixture", () => {
    expect(
      scenarios.length,
      `no Fixture_Scenario found under ${FIXTURE_TREES_ROOT}`,
    ).toBeGreaterThan(0);
  });

  for (const name of scenarios) {
    const scenarioDir = resolve(FIXTURE_TREES_ROOT, name);

    describe(name, () => {
      // ---------------------------------------------------------------------
      // 1. NAME/MANIFEST AGREEMENT (R4.2).
      // ---------------------------------------------------------------------
      it("recovers its Expected_Diagnostic from its directory name and it matches the manifest", () => {
        expect(
          statSync(scenarioDir).isDirectory(),
          `${name} must be a directory`,
        ).toBe(true);

        // `expectedDiagnosticOf` throws — naming the directory — when the name
        // holds no `--` or more than one (R4.2). Let that throw surface as the
        // failure; it is the loud failure the requirement demands.
        const recovered = expectedDiagnosticOf(name);
        const declared = readManifest(scenarioDir).expectedDiagnostic;

        expect(
          recovered,
          `Scenario_Directory_Name "${name}" recovers tag ${recovered}, ` +
            `but its Scenario_Manifest declares ${declared} — a renamed ` +
            `directory and a stale manifest must not disagree`,
        ).toBe(declared);
      });

      // ---------------------------------------------------------------------
      // 2. MINIMALITY: exactly the one declared tag (R4.5, R4.6).
      // ---------------------------------------------------------------------
      it("reports exactly the one-element set holding its Expected_Diagnostic", () => {
        const manifest = readManifest(scenarioDir);
        const expected = manifest.expectedDiagnostic;

        const bin = PLATFORM_BINS[manifest.entryPoint];
        expect(
          bin,
          `Scenario_Manifest for ${name} names an unknown entryPoint ` +
            `"${manifest.entryPoint}"; known: ${Object.keys(PLATFORM_BINS).join(", ")}`,
        ).toBeDefined();

        // Invoke the entry point as a SPAWNED PROCESS (R2.6) with the scenario's
        // directory as its working directory. The bin comes from the PLATFORM's
        // tree (R2.7); the fixture is only read. stdout and stderr are combined
        // because a diagnostic may reach either stream.
        const run = spawnSync(process.execPath, [bin], {
          cwd: scenarioDir,
          encoding: "utf8",
          timeout: RUN_TIMEOUT_MS,
          env: process.env,
        });

        expect(
          run.error,
          `spawning the platform entry point over ${name} failed: ` +
            `${run.error?.message ?? ""}`,
        ).toBeUndefined();

        const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
        const reported = reportedTagSet(output);

        expect(
          reported,
          `${name} must report exactly the one-element set { ${expected} }, ` +
            `but reported { ${reported.join(", ")} }.\n` +
            `Full output:\n${output}`,
        ).toEqual([expected]);
      });
    });
  }
});

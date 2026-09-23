// Feature: platform-fixtures, Step 7 — the Fixture_Equivalent of the
// payload-coupled Repo_Invariant_Checker claim (task 7.3).
//
// The payload-coupled Repo_Invariant_Checker tests hand the checker an in-memory
// repository and assert the reported violation set. Their Fixture_Equivalent,
// here, spawns the SAME checker bin as a PROCESS with a committed Project_Fixture
// as its working directory, and asserts the reported violation TAG set equals
// that fixture's one declared Expected_Diagnostic. This mirrors task 4.3's
// `fixture-scenario-diagnostics.test.ts` spawn shape, reframed as the Fixture_
// Equivalent over PROJECT fixtures (installed workspaces) rather than Tree_
// Fixtures.
//
// Subjects: the seven Project_Fixtures whose `entryPoint` is
// `runRepoInvariantsCli` and whose fault the checker reports over the installed
// tree — `deps--direction`, `imports--peer`, `imports--escape`, `imports--spa`,
// `barrel--invalid`, `workspaces--coverage`, `workspaces--order-source`.
//
// The bin is resolved from the PLATFORM's OWN tree, reached from this file's
// location — never from a fixture's `node_modules` (R3.7).
//
// Gating (R6.6, R6.7): a bin spawn over a Project_Fixture whose members must
// resolve needs the shared install, so the suite gates on
// `installedFixtureProjects` — SKIP locally when uninstalled, FAIL in CI.
//
// Cleanliness (R13.7): the spawn is READ-ONLY. `check-repo-invariants` is a
// read-only checker; it generates no registry and writes nothing into the
// committed fixture tree.
//
// Validates: Requirements 3.7, 6.6, 6.7, 13.1, 13.2, 13.3, 13.7

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { installedFixtureProjects } from "@microservices/build-tools/dist/testing/index.js";

import { FIXTURE_PROJECTS_ROOT } from "./fixture-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The Repo_Invariant_Checker bin, resolved from the PLATFORM's own tree — never
 * from a fixture's `node_modules` (R3.7).
 */
const CHECK_BIN = resolve(
  repoRoot,
  "packages/build-tools/dist/bin/check-repo-invariants.js",
);

/** The Diagnostic_Tag form: `[<category>:<detail>]`, both lowercase-and-hyphen. */
const DIAGNOSTIC_TAG = /\[[a-z][a-z-]*:[a-z][a-z-]*\]/g;

/** A checker run over an installed fixture may take a moment; give it room. */
const RUN_TIMEOUT_MS = 60_000;

/** The seven Project_Fixtures whose checker reports exactly their one tag. */
const SUBJECTS = [
  "deps--direction",
  "imports--peer",
  "imports--escape",
  "imports--spa",
  "barrel--invalid",
  "workspaces--coverage",
  "workspaces--order-source",
];

interface FixtureManifest {
  readonly expectedDiagnostic: string;
}

/** The deduplicated, sorted set of Diagnostic_Tags in a run's combined output. */
function reportedTagSet(output: string): readonly string[] {
  return [...new Set(output.match(DIAGNOSTIC_TAG) ?? [])].sort();
}

describe("Repo_Invariant_Checker Fixture_Equivalent: reported tag set == fixture's one tag (R13.1, R13.2)", () => {
  for (const name of SUBJECTS) {
    const fixtureDir = resolve(FIXTURE_PROJECTS_ROOT, name);

    it(`${name} reports exactly its declared Expected_Diagnostic`, () => {
      const handle = installedFixtureProjects(FIXTURE_PROJECTS_ROOT);
      if (!handle.available) {
        console.warn(handle.reason);
        return;
      }

      const expected = (
        JSON.parse(
          readFileSync(resolve(fixtureDir, "fixture.json"), "utf8"),
        ) as FixtureManifest
      ).expectedDiagnostic;

      // Spawn the checker bin as a PROCESS with the fixture as its working
      // directory (read-only). The bin comes from the PLATFORM's tree (R3.7);
      // stdout and stderr are combined because a diagnostic may reach either.
      const run = spawnSync(process.execPath, [CHECK_BIN], {
        cwd: fixtureDir,
        encoding: "utf8",
        timeout: RUN_TIMEOUT_MS,
        env: process.env,
      });

      expect(
        run.error,
        `spawning the checker over ${name} failed: ${run.error?.message ?? ""}`,
      ).toBeUndefined();

      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const reported = reportedTagSet(output);

      expect(
        reported,
        `${name} must report exactly the one-element set { ${expected} }, ` +
          `but reported { ${reported.join(", ")} }.\nFull output:\n${output}`,
      ).toEqual([expected]);
    });
  }
});

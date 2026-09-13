// Task 5.4 (spa-common-consumption spec) — two cross-package integration cases
// proving the `spa → common` edge behaves at its two observable boundaries:
//
//   Case (a) — the prerequisite-absent failure (R1.11, R1.12). With the
//     Extended_Config_Package's `dist/` removed, the Demo_Spa's `typecheck`
//     (tsc --noEmit) and `build` (vite build) each fail with a non-zero status
//     and an error naming `@microservices/extended-config` — because both
//     resolve the bare specifier through the workspace symlink to that
//     package's compiled output, which is now absent.
//
//     R1.11 and R1.12 make DIFFERENT product-untouched claims, and this case
//     mirrors that split exactly. R1.11 (the typecheck path) requires the
//     Demo_Spa's existing `dist/index.html` to be left unmodified — a
//     `tsc --noEmit` failing at resolution writes nothing — so the case asserts
//     the captured bytes are unchanged after the typecheck run. R1.12 (the
//     build path) requires ONLY a proper failure (non-zero exit + a resolution
//     error naming the package); the build is permitted to touch or partially
//     write its output, so the case makes NO bytes-unchanged assertion after
//     the build run.
//
//   Case (b) — the invariants stay silent for the new edge (R7.1, R7.2). The
//     compiled Repo_Invariant_Checker, run over the REAL tree, exits 0 and
//     names `packages/spa/demo` in no finding — in particular no
//     `[deps:direction]`, `[imports:peer]`, or `[imports:spa]`. A Spa_Package
//     declaring and importing a Common_Package is outside every rule's domain.
//
// --- This suite NEVER mutates the checked-out tree --------------------------
//
// Case (a) needs a MUTATED tree (it deletes a package's `dist/`), and the hard
// prohibition in `.kiro/steering/tech.md` forbids any test from writing to the
// working tree or using git to undo an edit. So case (a) does everything inside
// its OWN pristine copy, materialised by `pristineWorktree()` from `helpers.ts`
// into an OS temp directory: it builds the Extended_Config_Package there, reads
// and captures the Demo_Spa's `dist/index.html` bytes FROM THAT COPY, deletes
// `packages/common/extended-config/dist` IN THAT COPY, and runs the Demo_Spa's
// scripts with the copy as cwd. If the copy is unavailable (no git, or the
// archive / `npm ci` failed for an environmental reason) the case skips with
// the returned reason rather than failing. Restoration, where needed, writes
// back the captured bytes with `writeFileSync` — NEVER through git. Teardown is
// `cleanup()`; there is nothing in the real tree to undo.
//
// Case (b) only READS the real tree (it spawns the compiled bin with the real
// repo root as cwd) and writes nothing anywhere.
//
// Validates: Requirements 1.11, 1.12, 7.1, 7.2

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The compiled Repo_Invariant_Checker bin, run over the real tree in case (b). */
const invariantsBin = resolve(
  repoRoot,
  "packages",
  "build-tools",
  "dist",
  "bin",
  "check-repo-invariants.js",
);

/** Repo-relative paths, resolved against the PRISTINE copy (never repoRoot). */
const EXTENDED_CONFIG_DIST_REL = "packages/common/extended-config/dist";
const DEMO_DIST_INDEX_REL = "packages/spa/demo/dist/index.html";

/** The package name every case-(a) failure message must name. */
const EXTENDED_CONFIG_NAME = "@microservices/extended-config";

/**
 * The Tsc_Project prerequisites the Extended_Config_Package's own `tsc` build
 * needs compiled first, in dependency order: `contracts` (Framework_Singleton)
 * → `config` (Common_Package it depends on) → the Extended_Config_Package
 * itself. A fresh `pristineWorktree()` copy has no `dist/` for any of them, so
 * building the Extended_Config_Package alone would fail to resolve
 * `@microservices/config`'s declarations. Building the chain in order is the
 * copy-local equivalent of the ordered build the repository runs.
 */
const EXTENDED_CONFIG_BUILD_CHAIN = [
  "@microservices/contracts",
  "@microservices/config",
  EXTENDED_CONFIG_NAME,
] as const;

// Generous budget: `pristineWorktree()` runs `npm ci` in a fresh temp tree, and
// case (a) then runs a `tsc` build of the Extended_Config_Package plus a
// `tsc --noEmit` and a `vite build` of the Demo_Spa.
const PRISTINE_TIMEOUT_MS = 600_000;
const CASE_TIMEOUT_MS = 300_000;

/** Run an npm workspace script inside the pristine copy and capture its result. */
function runScriptInCopy(
  dir: string,
  script: "build" | "typecheck",
  workspace: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    "npm",
    ["run", script, "--workspace", workspace],
    { cwd: dir, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let pristine: PristineWorktreeResult | undefined;
let unavailableReason: string | undefined;

beforeAll(() => {
  // ONE pristine copy for the whole suite: `npm ci` is the slow step, so it
  // runs once. Everything case (a) writes happens inside `pristine.dir`.
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    unavailableReason = pristine.reason;
  }
}, PRISTINE_TIMEOUT_MS);

afterAll(() => {
  // Teardown is just removing the temp copy. Nothing in the real tree changed.
  if (pristine?.available === true) {
    pristine.cleanup();
  }
  pristine = undefined;
});

describe("the spa → common edge at its observable boundaries (spa-common-consumption)", () => {
  it(
    "case (a): with the Extended_Config_Package's dist/ absent, the Demo_Spa's typecheck and build both fail naming @microservices/extended-config; the typecheck leaves dist/index.html unmodified (R1.11) and the build merely fails properly (R1.12)",
    () => {
      if (pristine === undefined || pristine.available !== true) {
        // git (or tar / npm ci) unavailable — skip with the returned reason.
        console.warn(
          `SKIP spa-common-consumption case (a): ${
            unavailableReason ?? "pristine tree unavailable"
          }`,
        );
        return;
      }
      const dir = pristine.dir;
      const extendedConfigDist = resolve(dir, EXTENDED_CONFIG_DIST_REL);
      const demoDistIndex = resolve(dir, DEMO_DIST_INDEX_REL);

      // 1. Build the Extended_Config_Package so its dist/ (and .d.ts) exist —
      //    the precondition R1.8/R1.10 name and R1.11 removes. Its `tsc` build
      //    resolves `@microservices/config`'s declarations, which in turn need
      //    `@microservices/contracts` compiled, so build the chain in
      //    dependency order (a fresh copy has no dist/ for any of them).
      for (const workspace of EXTENDED_CONFIG_BUILD_CHAIN) {
        const built = runScriptInCopy(dir, "build", workspace);
        expect(
          built.status,
          `building ${workspace} in the pristine copy should succeed:\n` +
            `${built.stdout}\n${built.stderr}`,
        ).toBe(0);
      }
      expect(
        existsSync(extendedConfigDist),
        `${EXTENDED_CONFIG_DIST_REL} should exist after building the package`,
      ).toBe(true);

      // 2. Produce and capture the Demo_Spa's dist/index.html FROM THE COPY, so
      //    the "left unmodified" assertion has captured bytes to compare
      //    against. This build succeeds because the Extended_Config_Package's
      //    dist/ is present.
      const buildDemoOk = runScriptInCopy(dir, "build", "@microservices/demo");
      expect(
        buildDemoOk.status,
        `the Demo_Spa build should succeed while the prerequisite dist/ is present:\n` +
          `${buildDemoOk.stdout}\n${buildDemoOk.stderr}`,
      ).toBe(0);
      expect(
        existsSync(demoDistIndex),
        `${DEMO_DIST_INDEX_REL} should exist after a successful Demo_Spa build`,
      ).toBe(true);
      const capturedIndexHtml = readFileSync(demoDistIndex);

      // 3. Delete the Extended_Config_Package's dist/ IN THE COPY. This is the
      //    prerequisite-absent state of R1.11. The path is re-rooted at `dir`,
      //    never at repoRoot.
      rmSync(extendedConfigDist, { recursive: true, force: true });
      expect(existsSync(extendedConfigDist)).toBe(false);

      // 4a. The Demo_Spa's typecheck (tsc --noEmit) fails: the bare specifier
      //     resolves to the package's `types` at ./dist/index.d.ts, now absent,
      //     so tsc reports it cannot resolve @microservices/extended-config.
      const typecheck = runScriptInCopy(
        dir,
        "typecheck",
        "@microservices/demo",
      );
      expect(
        typecheck.status,
        `the Demo_Spa typecheck should fail with the prerequisite dist/ absent:\n` +
          `${typecheck.stdout}\n${typecheck.stderr}`,
      ).not.toBe(0);
      expect(
        `${typecheck.stdout}\n${typecheck.stderr}`,
        `the typecheck failure should name ${EXTENDED_CONFIG_NAME}`,
      ).toContain(EXTENDED_CONFIG_NAME);

      // The failing typecheck emits nothing, so the captured index.html is
      // unchanged.
      expect(readFileSync(demoDistIndex)).toEqual(capturedIndexHtml);

      // 4b. The Demo_Spa's build (vite build) fails too: Vite resolves the same
      //     bare specifier to the package's `main` at ./dist/index.js, now
      //     absent, and reports a failed import resolution. R1.12 requires only
      //     a proper failure here — a non-zero exit plus an error naming the
      //     package — so this asserts exactly that and makes NO product-untouched
      //     claim: the build is permitted to touch or partially write its
      //     output.
      const build = runScriptInCopy(dir, "build", "@microservices/demo");
      expect(
        build.status,
        `the Demo_Spa build should fail with the prerequisite dist/ absent:\n` +
          `${build.stdout}\n${build.stderr}`,
      ).not.toBe(0);
      expect(
        `${build.stdout}\n${build.stderr}`,
        `the build failure should name ${EXTENDED_CONFIG_NAME}`,
      ).toContain(EXTENDED_CONFIG_NAME);

      // Restore the captured bytes so a later example could rely on the
      // Demo_Spa's built product being present and correct. This is a write-back
      // of bytes captured from the copy — NEVER a git restore — and it targets
      // the copy, never repoRoot. (The failing build above is allowed to have
      // left dist/index.html partially written or removed, per R1.12.)
      writeFileSync(demoDistIndex, capturedIndexHtml);
      expect(readFileSync(demoDistIndex)).toEqual(capturedIndexHtml);
    },
    CASE_TIMEOUT_MS,
  );

  it("case (b): the Repo_Invariant_Checker exits 0 over the real tree and names packages/spa/demo in no finding (R7.1, R7.2)", () => {
    // The compiled bin is produced by the build-tools `build` script, which the
    // root `pretest` ordered build runs before this suite. Turn a missing build
    // into a legible failure rather than a spawn error.
    expect(
      existsSync(invariantsBin),
      `compiled bin missing at ${invariantsBin}; run the ordered build first`,
    ).toBe(true);

    // Run over the REAL repository (repoRoot as cwd). This only READS the tree.
    const result = spawnSync(process.execPath, [invariantsBin], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env },
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const output = `${stdout}\n${stderr}`;

    // A clean tree exits 0 and writes nothing (the bin reports findings only).
    expect(
      result.status,
      `check-repo-invariants should exit 0 over the real tree:\n${output}`,
    ).toBe(0);

    // No finding names the Demo_Spa's package directory — in particular none of
    // the three that a mis-designed rule could raise against a Spa_Package that
    // declares and imports a Common_Package.
    expect(
      output.includes("packages/spa/demo"),
      `no invariant finding should name packages/spa/demo:\n${output}`,
    ).toBe(false);
    expect(output.includes("[deps:direction]")).toBe(false);
    expect(output.includes("[imports:peer]")).toBe(false);
    expect(output.includes("[imports:spa]")).toBe(false);
  });
});

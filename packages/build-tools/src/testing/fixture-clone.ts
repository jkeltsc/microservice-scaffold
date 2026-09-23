// @microservices/build-tools/dist/testing — the Fixture_Clone helper
// (Fixture_Tier spec, task 3.3; R7.1–R7.6, R7.9).
//
// Install once, clone many: copy a Fixture_Scenario, or the whole installed
// Fixture_Projects_Root, into an operating-system temporary directory OUTSIDE
// the Project_Directory, and hand back a Clone_Handle to the copy. A suite that
// needs to mutate a fixture mutates the copy, so the checked-out tree is never
// written and the shared install runs once rather than once per suite.
//
// PATH PARAMETERISATION, and why the signature differs from the design's prose.
// This module lives under `packages/build-tools/src/`, so R1.7 applies: it must
// spell no Fixture_Tier path literal and read no path under the tier of its own
// accord. The design writes the helper as `fixtureClone(relativePath)`, but a
// relative path is only meaningful against a base — and the only base here is
// the tier root, the one token this source may not spell. So, exactly as the
// sibling availability probe `installedFixtureProjects(projectsRoot)` does, this
// helper is wholly path-parameterised on an ABSOLUTE source directory: the
// caller (a suite under `packages/*/tests/`) composes it from that package's
// single permitted tier literal in its own `fixture-paths.ts` (`FIXTURES_ROOT`
// joined with the scenario's relative path) and passes the result. This module
// knows only "an absolute directory to copy", never where the tier is.
//
// The copy reproduces the source's relative path set exactly, every regular
// file's bytes byte-for-byte, and every symlink AS A SYMLINK with the same
// target text (R7.3). The symlink clause is load-bearing: a copy of the
// installed Fixture_Projects_Root is only usable without a further install if
// the member symlinks under `node_modules/@…/` survive as symlinks. A
// dereferencing copy would duplicate each member with no link between the two,
// and the clone would have bought nothing over reinstalling.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { platform } from "node:process";

import type { CloneHandle } from "./clone-handle.js";

/**
 * Copy a fixture source — a Fixture_Scenario directory, or the whole installed
 * Fixture_Projects_Root — into an OS temp directory outside the
 * Project_Directory, and return a {@link CloneHandle} to the copy.
 *
 * `sourceDir` is the ABSOLUTE path of the source to copy, supplied by the
 * calling suite (this module holds no tier path literal, R1.7). The suite
 * composes it from its own `fixture-paths.ts` tier constant and the scenario's
 * relative path.
 *
 * Guarantees (R7.2–R7.6):
 *
 *   * On success: `{ available: true, dir, cleanup }`, where `dir` is an
 *     absolute path INSIDE an OS temp directory located outside the
 *     Project_Directory, and `cleanup` idempotently removes it. Outside the
 *     Project_Directory matters twice — a copy inside it would be caught by the
 *     Worktree_Guard, and would be discovered by npm or a `--workspaces`
 *     fan-out.
 *   * The copy reproduces the source's relative path set exactly, every regular
 *     file's bytes byte-for-byte, and every symlink as a symlink with the same
 *     target text (R7.3).
 *   * A copy-on-write / hard-linking copy is used where the host supports one
 *     (`cp -c` on APFS, `cp --reflink=auto -a` on a Linux CoW filesystem),
 *     falling back to a portable `cpSync` copy otherwise. The R7.3 contract
 *     holds identically under either mechanism (R7.4), so a test can never tell
 *     which ran.
 *   * On an environmental failure: any directory already created is removed,
 *     the handle is `{ available: false, reason }` naming the step that failed,
 *     and no partial copy is left behind (R7.5).
 *   * The source is read only; nothing inside the checked-out tree is written
 *     (R7.6), so cloning a fixture cannot modify the fixture.
 *
 * It neither calls `pristineWorktree()` nor duplicates its working-tree capture
 * (R7.9): its subject is a fixture — committed bytes plus an installed
 * `node_modules` — where there is no uncommitted state to capture.
 */
export function fixtureClone(sourceDir: string): CloneHandle {
  // Step 1: create the destination inside an OS temp directory, OUTSIDE the
  // Project_Directory (R7.2). `mkdtempSync` under `os.tmpdir()` guarantees both
  // — a unique, freshly-created directory in the host temp area.
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "fixture-clone-"));
  } catch (error) {
    return {
      available: false,
      reason: `creating the temp destination failed: ${describe(error)}`,
    };
  }

  // The copy lands at `<temp>/<basename-of-source>` so the copied tree keeps the
  // source's own top-level name; the returned `dir` is that copied root.
  const destination = join(dir, basename(sourceDir));

  // Step 2: copy. Try a copy-on-write / hard-linking `cp` first where the host
  // has one, and fall back to Node's portable `cpSync` on any failure (R7.4).
  // Both preserve symlinks as symlinks and reproduce bytes exactly (R7.3).
  const copyOutcome = copyTree(sourceDir, destination);
  if (!copyOutcome.ok) {
    // Step 3 on failure: total cleanup — remove the directory already created,
    // leave no partial copy behind, and report the step that failed (R7.5).
    safeRemove(dir);
    return {
      available: false,
      reason: `copying ${sourceDir} failed: ${copyOutcome.reason}`,
    };
  }

  let removed = false;
  return {
    available: true,
    dir: destination,
    cleanup(): void {
      // Idempotent (R7.2): a second call after the tree is gone is a no-op, so
      // an unconditional `afterAll` may call it whether or not a test threw.
      if (removed) return;
      removed = true;
      safeRemove(dir);
    },
  };
}

/** The result of one copy attempt: success, or a reason the step failed. */
type CopyOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Copy `source` to `destination`, preserving symlinks as symlinks and bytes
 * exactly. Prefers a host copy-on-write / hard-linking `cp` (near-instant for a
 * large `node_modules`), and falls back to Node's `cpSync` — the R7.3 contract
 * is identical under both (R7.4).
 */
function copyTree(source: string, destination: string): CopyOutcome {
  const cow = cowCopy(source, destination);
  if (cow.ok) return cow;

  // The CoW attempt may have created a partial `destination` before failing;
  // remove it so the fallback copies into a clean, non-existent target.
  safeRemove(destination);

  return portableCopy(source, destination);
}

/**
 * Attempt a copy-on-write / hard-linking copy using the host `cp`. Returns
 * `{ ok: false }` — never throws — on any host without a supported `cp`, so the
 * caller can fall back. `-c` (APFS clonefile) on macOS; `--reflink=auto -a` on
 * Linux, where `-a` implies `-R` and `-P` (recurse, preserve symlinks as
 * symlinks) and `--reflink=auto` uses a reflink where the filesystem supports
 * one and a plain copy otherwise.
 */
function cowCopy(source: string, destination: string): CopyOutcome {
  const args =
    platform === "darwin"
      ? ["-c", "-R", "-P", source, destination]
      : platform === "linux"
        ? ["--reflink=auto", "-a", source, destination]
        : undefined;

  // No CoW `cp` shape known for this host — signal the caller to fall back.
  if (args === undefined) {
    return { ok: false, reason: "no copy-on-write cp for this platform" };
  }

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("cp", args, { stdio: "ignore" });
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
  if (result.error !== undefined || result.status !== 0) {
    return {
      ok: false,
      reason:
        result.error !== undefined
          ? describe(result.error)
          : `cp exited with status ${String(result.status)}`,
    };
  }
  return { ok: true };
}

/**
 * The portable fallback: Node's `cpSync` with `recursive`, `dereference: false`
 * (symlinks stay symlinks — R7.3), and `preserveTimestamps: true`. Reproduces
 * the relative path set and every regular file's bytes exactly.
 */
function portableCopy(source: string, destination: string): CopyOutcome {
  try {
    cpSync(source, destination, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

/** Remove `target` and everything under it, tolerating its absence. Never
 *  throws — used on cleanup and failure paths where a throw would mask the real
 *  reason or leak a partial copy. */
function safeRemove(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort: a temp directory the OS will reclaim anyway */
  }
}

/** A human-readable one-line description of a thrown value, for a reason text. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

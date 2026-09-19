// Feature: config-driven-discovery — the Scope_Rename_Script is retired
// (design "Migration Order", Step 10; Requirements 12.1, 12.2).
//
// WHAT THIS GUARDS
// ---------------------------------------------------------------------------
// Before this feature a project rebranded its npm scope by running a POSIX sh
// script (`scripts/rename-scope.sh`) that rewrote the scope token across every
// tracked file. Config-driven discovery replaces that with a one-field edit:
// the `scope` key of `scaffold.config.json`. The script is deleted, and this
// guard keeps it — or any equivalent scope-rewriting script, or any lingering
// reference to it — from creeping back:
//
//   1. No tracked file exists at `scripts/rename-scope.sh` (R12.1).
//   2. No OTHER tracked script rewrites the Configured_Scope in place across
//      tracked files — i.e. no shell script that both enumerates tracked files
//      (`git ls-files`) and rewrites them in place with `sed -i` (R12.1).
//   3. The script's name occurs in no `package.json` `scripts` block, no file
//      under `.github/workflows/`, and no tracked Markdown file (R12.2).
//
// READ-ONLY GIT ONLY
// ---------------------------------------------------------------------------
// The one git call here is `git ls-files`, which reads the checked-out tree and
// writes nothing. No destructive git command is used, and nothing is written
// into the working tree — this suite only reads files.
//
// SELF-SCAN AVOIDANCE
// ---------------------------------------------------------------------------
// The retired script's name is assembled from fragments so this test's own
// source never contains it contiguously, and the enumeration explicitly drops
// this feature's own spec documents (which discuss the retired script by name)
// so the guard tests the repository's shipped state, not its spec prose.
//
// Validates: Requirements 12.1, 12.2

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

// Assembled from fragments: "scripts/rename-scope.sh". Keeping it split means
// this source never contains the retired script's name as one contiguous
// literal, so the guard never reports itself.
const SCRIPT_BASENAME = "rename" + "-" + "scope" + ".sh";
const SCRIPT_PATH = "scripts/" + SCRIPT_BASENAME;
// The name without extension, as it would appear referenced in a manifest
// script, a workflow, or Markdown prose.
const SCRIPT_NAME = "rename" + "-" + "scope";

/**
 * Every tracked file that still exists on disk, repo-relative. Read-only:
 * `git ls-files` enumerates the index and writes nothing.
 *
 * `git ls-files` reports the index, so a file deleted from the working tree but
 * whose deletion is not yet committed still appears. We therefore drop entries
 * with no file on disk, so the set reflects the tree AS IT IS on disk — the
 * same "tracked plus present" semantics `pristineWorktree()` captures — and the
 * guard passes on a working-tree deletion, not only after it is committed.
 */
function trackedFiles(): readonly string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => existsSync(resolve(repoRoot, p)));
}

/**
 * This feature's own spec documents mention the retired script by name (a spec
 * describing the retirement is not a live reference to it). They are excluded
 * from the reference scan so the guard tests the shipped repository, not its
 * spec prose.
 */
const SPEC_PREFIX = ".kiro/specs/config-driven-discovery/";
function isOwnSpecDoc(path: string): boolean {
  return path.startsWith(SPEC_PREFIX);
}

const tracked = trackedFiles();

describe("the Scope_Rename_Script is retired (R12.1, R12.2)", () => {
  it("enumerates tracked files (the scan is not vacuous)", () => {
    // A broken git invocation returning nothing would otherwise let every
    // assertion below pass by inspecting an empty set.
    expect(tracked.length).toBeGreaterThan(0);
    // The known live scripts and docs the later assertions read must be present
    // in the tracked set, or the scan is looking at the wrong tree.
    expect(tracked).toContain("package.json");
    expect(tracked).toContain("README.md");
  });

  it("has no tracked file at the retired script path (R12.1)", () => {
    // Both the tracked-set view and the filesystem must agree it is gone.
    expect(tracked).not.toContain(SCRIPT_PATH);
    expect(existsSync(resolve(repoRoot, SCRIPT_PATH))).toBe(false);
  });

  it("has no other tracked script that rewrites the scope in place (R12.1)", () => {
    // A replacement would be a shell script that enumerates tracked files
    // (`git ls-files`) AND rewrites them in place (`sed -i`) — the exact shape
    // of the deleted script. Flag any tracked `.sh` doing both.
    const shellScripts = tracked.filter((p) => p.endsWith(".sh"));
    const offenders = shellScripts.filter((p) => {
      const body = readFileSync(resolve(repoRoot, p), "utf8");
      const enumeratesTrackedFiles = /git\s+ls-files/.test(body);
      const rewritesInPlace = /\bsed\b[^\n]*\s-i\b/.test(body);
      return enumeratesTrackedFiles && rewritesInPlace;
    });
    expect(
      offenders,
      `a tracked script rewrites the scope in place across tracked files; ` +
        `scope is a one-field edit of scaffold.config.json now:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("names the retired script in no manifest scripts block (R12.2)", () => {
    const offenders: string[] = [];
    for (const path of tracked) {
      if (!path.endsWith("package.json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
      } catch {
        continue;
      }
      const scripts =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).scripts
          : undefined;
      if (!scripts || typeof scripts !== "object") continue;
      const serialized = JSON.stringify(scripts);
      if (serialized.includes(SCRIPT_NAME)) {
        offenders.push(path);
      }
    }
    expect(
      offenders,
      `a package.json scripts block still references ${SCRIPT_BASENAME}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("names the retired script in no workflow file (R12.2)", () => {
    const workflows = tracked.filter((p) =>
      p.startsWith(".github/workflows/"),
    );
    const offenders = workflows.filter((p) =>
      readFileSync(resolve(repoRoot, p), "utf8").includes(SCRIPT_NAME),
    );
    expect(
      offenders,
      `a workflow file still references ${SCRIPT_BASENAME}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("names the retired script in no tracked Markdown file (R12.2)", () => {
    const markdown = tracked.filter(
      (p) => p.endsWith(".md") && !isOwnSpecDoc(p),
    );
    const offenders = markdown.filter((p) =>
      readFileSync(resolve(repoRoot, p), "utf8").includes(SCRIPT_NAME),
    );
    expect(
      offenders,
      `a tracked Markdown file still references ${SCRIPT_BASENAME}:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

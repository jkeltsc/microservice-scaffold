// Feature: registry-inversion — the Retired_Testing_Specifier is gone
// (design "Relocating the arbitraries" → *The specifier is gone (R11.7)*).
//
// WHAT THIS GUARDS
// ---------------------------------------------------------------------------
// The shared `fast-check` arbitraries and test-support helpers used to live in
// the types package and were reached through the specifier
// `<Configured_Scope>/contracts/testing`. They now live under the `build-tools`
// package's own `src/testing/`, reached through that package's compiled deep
// path (`<Configured_Scope>/build-tools/dist/testing/index.js`) or, inside
// `build-tools` itself, through a relative `../src/testing/` path.
//
// The obligation R11.6 states stands over the whole set of importers as the
// build finds them, not over an enumerated list — so this guard quantifies over
// the tree rather than over a list of files. It scans every tracked `.ts`,
// `.js`, and `.json` file of every workspace package, of the Entry_Package, and
// of `scripts/`, and fails naming the offending file and line if any of them
// names the retired specifier — in an import declaration, a dynamic `import()`
// call, an `exports` map, or anywhere else, since a plain occurrence scan needs
// no parser to answer "does this string still appear".
//
// WHAT IS EXCLUDED, AND WHY
// ---------------------------------------------------------------------------
//   * `.kiro/specs/` — the specification documents record the history of the
//     relocation rather than the state of the tree, so they name the retired
//     specifier on purpose (R11.7 excludes them explicitly). They are also not
//     part of any workspace package, so the scope filter drops them anyway; the
//     explicit exclusion keeps the intent visible if the scope ever widens.
//   * This file's own source, as the worktree-safety guard excludes its own
//     (R12.7): a guard must spell the string it forbids. The specifier is also
//     assembled from fragments here, so this source never holds it contiguously.
//
// THE CONFIGURED SCOPE AND THE ENTRY ROOT
// ---------------------------------------------------------------------------
// The retired specifier is `<Configured_Scope>/contracts/testing`, so the scope
// comes from the `scope` key of `scaffold.config.json` and falls back to the
// Scope_Default when the file declares none (this repository declares no
// Project_Config_File at all). The Entry_Package's location comes from the
// `entry` key the same way, falling back to the Entry_Root_Default `app`. The
// Entry_Package is covered when it is present on disk and silently absent from
// the scanned set when it is not, so this guard holds both before and after the
// Entry_Package is created.
//
// READ-ONLY
// ---------------------------------------------------------------------------
// The one git call is `git ls-files`, which reads the index and the working tree
// and writes nothing.
// No destructive git command is used and nothing is written anywhere: every
// other filesystem call here reads.
//
// Validates: Requirements 11.7, 13.13

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(here, "..", "..", "..");

/** This guard's own repo-relative path, excluded from the scanned set. */
const SELF = `packages/integration-tests/tests/${basename(
  fileURLToPath(import.meta.url),
)}`;

/** The Scope_Default, used when the Project_Config_File declares no `scope`. */
const SCOPE_DEFAULT = "@microservices";

/** The Entry_Root_Default, used when the Project_Config_File declares no `entry`. */
const ENTRY_ROOT_DEFAULT = "app";

/** The Project_Config_File, read for its `scope` and `entry` keys. */
const CONFIG_FILE = "scaffold.config.json";

/**
 * The scope-relative tail of the Retired_Testing_Specifier, assembled from
 * fragments so this source never holds the full specifier contiguously and the
 * guard therefore never reports itself.
 */
const RETIRED_TAIL = "/contracts" + "/testing";

/** The extensions R11.7 names. */
const SCANNED_EXTENSIONS = [".ts", ".js", ".json"] as const;

/** The excluded document tree: specs record the history, not the state. */
const SPECS_PREFIX = ".kiro/specs/";

/** The Project_Config_File as an object, or `undefined` when there is none. */
function readProjectConfig(): Record<string, unknown> | undefined {
  const path = resolve(repoRoot, CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** A declared string key of the Project_Config_File, or the given default. */
function configuredString(key: string, fallback: string): string {
  const declared = readProjectConfig()?.[key];
  return typeof declared === "string" && declared.length > 0
    ? declared
    : fallback;
}

const configuredScope = configuredString("scope", SCOPE_DEFAULT);
const entryRoot = configuredString("entry", ENTRY_ROOT_DEFAULT);

/** The specifier no tracked source may name: `<Configured_Scope>/contracts/testing`. */
const RETIRED_SPECIFIER = configuredScope + RETIRED_TAIL;

/**
 * Every committed-or-committable file that exists on disk, repo-relative.
 * Read-only: `git ls-files` enumerates the index and the working tree and writes
 * nothing.
 *
 * The listing is `--cached --others --exclude-standard` — tracked PLUS
 * untracked-but-not-gitignored — the same set `pristineWorktree()` copies, and for
 * the same reason: a source that is on disk and destined for the repository is
 * part of the tree whether or not it has been committed yet. A newly added package
 * (the Entry_Package is exactly that) is therefore scanned from the moment its
 * files exist, rather than only after a commit. Gitignored generated output — the
 * Generated_Registry, each `dist/`, the generated `Dockerfile` — stays out, which
 * is what `--exclude-standard` buys.
 *
 * Entries with no file on disk are dropped, so the set reflects the tree AS IT
 * IS — a file deleted in the working tree but whose deletion is not yet
 * committed is not scanned, and the guard passes on the deletion rather than
 * only after it is committed.
 */
function trackedFiles(): readonly string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [
    ...new Set(
      out
        .split("\0")
        .filter((p) => p.length > 0)
        .filter((p) => existsSync(resolve(repoRoot, p))),
    ),
  ].sort();
}

const tracked = trackedFiles();

/**
 * One `workspaces` glob as a matcher over a repo-relative directory path. The
 * globs this repository uses are literal paths with at most one `*` segment
 * (`packages/contracts`, `packages/microservices/*`), so a `*`-to-`[^/]+`
 * translation is exact.
 */
function globMatcher(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]+")}$`);
}

/**
 * Every workspace package directory, repo-relative: the directory of each
 * tracked `package.json` that one of the Root_Manifest's `workspaces` globs
 * matches. Derived from the manifest rather than hard-coded, so a package added
 * or a Discovery_Root relocated widens the scan with no edit here. The
 * `workspaces` array declares membership only — its order is read for nothing.
 */
function workspacePackageDirs(): readonly string[] {
  const rootManifest = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ) as { readonly workspaces?: readonly string[] };
  const matchers = (rootManifest.workspaces ?? []).map(globMatcher);
  const dirs = tracked
    .filter((p) => basename(p) === "package.json")
    .map((p) => dirname(p))
    .filter((dir) => dir !== "." && matchers.some((m) => m.test(dir)));
  return [...new Set(dirs)].sort();
}

const workspaceDirs = workspacePackageDirs();

/** The directory trees R11.7 puts in scope: every workspace package, the
 *  Entry_Package, and `scripts/`. */
const scannedRoots = [...workspaceDirs, entryRoot, "scripts"];

function isInScope(path: string): boolean {
  if (path.startsWith(SPECS_PREFIX)) return false;
  if (path === SELF) return false;
  if (!SCANNED_EXTENSIONS.some((ext) => path.endsWith(ext))) return false;
  return scannedRoots.some((root) => path.startsWith(`${root}/`));
}

const scanned = tracked.filter(isInScope);

/**
 * The 1-based line numbers of a text that name the retired specifier. Factored
 * out of the file walk so the detector itself can be exercised over a synthetic
 * source held in memory — no file is written anywhere to test it.
 */
function offendingLines(text: string): readonly number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.includes(RETIRED_SPECIFIER)) lines.push(index + 1);
  });
  return lines;
}

interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findOccurrences(): readonly Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of scanned) {
    const text = readFileSync(resolve(repoRoot, file), "utf8");
    if (!text.includes(RETIRED_SPECIFIER)) continue;
    const lines = text.split("\n");
    for (const line of offendingLines(text)) {
      found.push({ file, line, text: lines[line - 1].trim() });
    }
  }
  return found;
}

function report(occurrences: readonly Occurrence[]): string {
  return occurrences.map((o) => `  ${o.file}:${o.line} — ${o.text}`).join("\n");
}

describe("no tracked source names the Retired_Testing_Specifier (R11.7)", () => {
  it("enumerates the tracked sources in scope (the scan is not vacuous)", () => {
    // A broken git invocation or a manifest whose globs stopped matching would
    // otherwise let the assertion below pass by inspecting an empty set.
    expect(tracked.length).toBeGreaterThan(0);
    expect(workspaceDirs).toContain("packages/contracts");
    expect(workspaceDirs).toContain("packages/build-tools");
    expect(workspaceDirs).toContain("packages/overseer");
    expect(workspaceDirs).toContain("packages/integration-tests");

    // The files that used to name the specifier, and the repo-level scripts
    // directory, must all be inside the scanned set.
    expect(scanned).toContain("packages/overseer/tests/boot.test.ts");
    expect(scanned).toContain(
      "packages/microservices/microservice1/tests/handler.property.test.ts",
    );
    expect(scanned).toContain(
      "packages/build-tools/tests/registry-generator.unmatched.property.test.ts",
    );
    expect(scanned).toContain("packages/integration-tests/tests/helpers.ts");
    expect(scanned).toContain("scripts/build.js");
    expect(scanned.some((p) => p.endsWith("package.json"))).toBe(true);

    // The guard's own source is scanned by nothing, and the spec documents are
    // out of scope by construction.
    expect(scanned).not.toContain(SELF);
    expect(scanned.some((p) => p.startsWith(SPECS_PREFIX))).toBe(false);
  });

  it("covers the Entry_Package's location when it is present", () => {
    // The Entry_Package is created later in this feature's migration order, so
    // this guard must hold both before and after it exists: when the Entry_Root
    // holds tracked sources they are scanned, and when it does not the scan is
    // simply narrower — never a failure.
    const entryFiles = scanned.filter((p) => p.startsWith(`${entryRoot}/`));
    if (existsSync(resolve(repoRoot, entryRoot))) {
      expect(
        entryFiles.length,
        `the Entry_Package at "${entryRoot}/" exists but contributes no scanned source`,
      ).toBeGreaterThan(0);
    } else {
      expect(entryFiles).toEqual([]);
      // The rest of the scan still has material, so the absent Entry_Package
      // does not make this guard vacuous.
      expect(scanned.length).toBeGreaterThan(0);
    }
  });

  it("detects the specifier when one is present (the detector is not vacuous)", () => {
    // Exercised over a synthetic source in memory: nothing is written to the
    // checked-out tree, and the detector is the same function the file walk uses.
    const synthetic = [
      `import { something } from "${RETIRED_SPECIFIER}";`,
      `const unrelated = 1;`,
      `const mod = await import("${RETIRED_SPECIFIER}/index.js");`,
    ].join("\n");
    expect(offendingLines(synthetic)).toEqual([1, 3]);
    expect(offendingLines(`import x from "${configuredScope}/contracts";`)).toEqual(
      [],
    );
    expect(
      offendingLines(
        `import x from "${configuredScope}/build-tools/dist/testing/index.js";`,
      ),
    ).toEqual([]);
  });

  it("names the specifier in no tracked TypeScript, JavaScript, or JSON file (R11.7)", () => {
    const occurrences = findOccurrences();
    expect(
      occurrences,
      `the Retired_Testing_Specifier "${RETIRED_SPECIFIER}" is still named; ` +
        `import the relocated Arbitraries_Module under the build-tools package instead ` +
        `("${configuredScope}/build-tools/dist/testing/index.js", or a relative ` +
        `"../src/testing/" path inside build-tools):\n${report(occurrences)}`,
    ).toEqual([]);
  });
});

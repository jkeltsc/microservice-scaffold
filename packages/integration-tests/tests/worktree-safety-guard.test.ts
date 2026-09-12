// Worktree-safety guard: no test may mutate the real working tree.
//
// THE RULE
// ---------------------------------------------------------------------------
// A test never writes to the checked-out tree, and never uses git to undo what
// it wrote. A test that needs to mutate sources, add a package, or create a
// workspace link materialises its OWN copy of the tree with
// `pristineWorktree()` (see `helpers.ts`) and mutates only inside the returned
// temp directory. If it needs the original content back mid-run, it writes back
// bytes it captured from that copy — never a git operation.
//
// WHY THIS IS A GUARD AND NOT A CONVENTION
// ---------------------------------------------------------------------------
// Two suites here once edited tracked microservice sources in the real tree and
// "restored" them with `git checkout -- <path>` via a `restoreWorktreeFile()`
// helper. `git checkout -- <path>` restores a file to its COMMITTED content, so
// it does not undo the test's edit — it discards EVERY uncommitted change in
// that file, the developer's included. It destroyed in-progress work twice
// before this guard existed, and each time it did so silently: the suite passed,
// and the loss only surfaced later as an unrelated-looking failure. Review does
// not reliably catch it, because the destructive call reads like tidy teardown.
//
// WHAT IS SCANNED, AND WHY THE SCAN IS SHAPED THIS WAY
// ---------------------------------------------------------------------------
// Every `*.test.ts` under this directory plus `helpers.ts` — the shared harness,
// which is where the deleted footgun lived and the most likely place for one to
// reappear. Sources are stripped of comments and string/template literals before
// matching, so prose (this file's own header included) and a template literal
// carrying a synthesised microservice's source text are never mistaken for a
// call. This file excludes itself from the scan, and assembles every forbidden
// token from fragments so its own source never contains one contiguously — the
// technique `migration-facts.test.ts` and `integration-scope-guard.test.ts`
// already use.
//
// Rule 2 matches the DIRECT textual form (`writeFileSync(resolve(repoRoot, …))`)
// and so can be defeated by indirection. That is a deliberate floor, not a
// claim of completeness: Rule 1 forbids the mechanism that actually caused the
// damage, and the gitignored generated registry — which one suite legitimately
// snapshots and rewrites — is reached through a named constant and stays out of
// scope, as intended.
//
// Validates: the worktree-safety prohibition recorded in `.kiro/steering/tech.md`

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

/** This guard's own file name, excluded from the scanned set. */
const SELF = basename(fileURLToPath(import.meta.url));

/**
 * Every `*.test.ts` in this directory except this guard, plus the shared
 * `helpers.ts` harness.
 */
function scannedSources(): readonly string[] {
  const tests = readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(".test.ts") && entry.name !== SELF,
    )
    .map((entry) => entry.name);
  return [...tests, "helpers.ts"];
}

/**
 * Remove line comments, block comments, and string / template literals so the
 * scan sees executable code only. A single-pass character scanner rather than
 * regexes, so a quote inside a comment (or `//` inside a string) cannot confuse
 * the state machine. Newlines inside an elided literal are preserved so
 * line-based reporting stays accurate.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Remove comments but KEEP string and template literals.
 *
 * Rule 1 needs this rather than the full stripper: a git invocation names its
 * command and subcommand as STRING LITERALS (`spawnSync("git", ["checkout", …])`
 * or a shell-string pipeline), so stripping strings would delete precisely the
 * text the rule must see, and the rule would pass on every input. Comments are
 * still removed so prose describing the prohibition — including this file's own
 * header — is never read as a call.
 */
function stripCommentsOnly(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // Skip over a string/template literal wholesale, copying it through, so a
    // `//` or `/*` inside it is never treated as a comment opener.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        out += source[i];
        if (source[i] === "\\") {
          i += 1;
          if (i < n) out += source[i];
          i += 1;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Forbidden tokens, assembled from fragments so this source never holds one
// contiguously and therefore never trips its own scan.
const GIT = "g" + "it";
const CHECKOUT = "check" + "out";
const RESET = "re" + "set";
const CLEAN = "cl" + "ean";
const STASH = "st" + "ash";
const RESTORE_HELPER = "restore" + "WorktreeFile";
const REPO_ROOT = "repo" + "Root";

/** The fs calls that mutate the filesystem. */
const MUTATING_FS = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "symlinkSync",
  "renameSync",
  "cpSync",
  "copyFileSync",
  "truncateSync",
] as const;

/**
 * A destructive git subcommand invoked from code: the subcommand name appearing
 * as an argument alongside a `git` command string. Matches the array form
 * (`["checkout", "--", path]`) and the shell-string form alike, since both reach
 * the same place through `spawnSync` / `execSync`.
 */
const DESTRUCTIVE_GIT = new RegExp(
  `\\b${GIT}\\b[\\s\\S]{0,200}?\\b(?:${CHECKOUT}|${RESET}|${CLEAN}|${STASH})\\b`,
);

/** A mutating fs call whose argument list textually names the repo root. */
const MUTATION_AT_REPO_ROOT = new RegExp(
  `\\b(?:${MUTATING_FS.join("|")})\\s*\\([^)]*\\b${REPO_ROOT}\\b`,
);

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const sources = scannedSources().map((file) => {
  const source = readFileSync(resolve(TESTS_DIR, file), "utf8");
  return {
    file,
    /** Code only: comments AND string literals elided. */
    code: stripCommentsAndStrings(source),
    /** Code plus string literals: comments elided, strings preserved. */
    codeWithStrings: stripCommentsOnly(source),
  };
});

type Projection = "code" | "codeWithStrings";

function scan(
  rule: string,
  pattern: RegExp,
  projection: Projection,
): readonly Offence[] {
  const offences: Offence[] = [];
  for (const entry of sources) {
    entry[projection].split("\n").forEach((line, index) => {
      if (pattern.test(line)) {
        offences.push({ file: entry.file, line: index + 1, rule, text: line.trim() });
      }
    });
  }
  return offences;
}

function report(offences: readonly Offence[]): string {
  return offences
    .map((o) => `  ${o.file}:${o.line} [${o.rule}] ${o.text}`)
    .join("\n");
}

describe("no test mutates the real working tree", () => {
  it("scans more than one source (the scan is not vacuous)", () => {
    // A rename or move that emptied the scanned set would otherwise let this
    // guard pass by inspecting nothing.
    expect(sources.length).toBeGreaterThan(1);
    // Both projections must be non-empty, or a rule could pass on empty input.
    expect(sources.every((entry) => entry.code.length > 0)).toBe(true);
    expect(sources.every((entry) => entry.codeWithStrings.length > 0)).toBe(true);
    expect(sources.some((s) => s.file === "helpers.ts")).toBe(true);
  });

  it("invokes no destructive git subcommand", () => {
    // `git checkout -- <path>` restores COMMITTED content, discarding every
    // uncommitted change in the file. reset/clean/stash are equally destructive
    // to a developer's working state. A test that needs original content back
    // writes back bytes it captured from its own pristine copy instead.
    const offences = scan(
      `destructive ${GIT} subcommand`,
      DESTRUCTIVE_GIT,
      // Strings preserved: the subcommand IS a string literal.
      "codeWithStrings",
    );
    expect(
      offences,
      `a test must never run a destructive ${GIT} command — it discards uncommitted work.\n` +
        `Mutate a pristineWorktree() copy and restore by writing back captured bytes:\n${report(offences)}`,
    ).toEqual([]);
  });

  it("performs no filesystem mutation at a path built from the repo root", () => {
    // Writing under the checked-out tree pollutes it (an untracked package, a
    // dangling workspace symlink) or corrupts it (an edited tracked source).
    // Every mutation belongs inside a pristineWorktree() temp directory.
    const offences = scan(
      "filesystem mutation under the repo root",
      MUTATION_AT_REPO_ROOT,
      "code",
    );
    expect(
      offences,
      `a test must not write inside the checked-out tree; mutate a pristineWorktree() copy instead.\n${report(offences)}`,
    ).toEqual([]);
  });

  it("declares no working-tree restore helper", () => {
    // The deleted `restoreWorktreeFile()` was the vector for both data-loss
    // incidents. Neither it nor a rename of it may reappear in the harness.
    const offences = scan(
      "working-tree restore helper",
      new RegExp(`\\b${RESTORE_HELPER}\\b`),
      "code",
    );
    expect(
      offences,
      `the ${RESTORE_HELPER} helper is deleted on purpose and must not return.\n${report(offences)}`,
    ).toEqual([]);
  });
});

// Worktree-safety guard: no test may mutate the real working tree.
//
// THE RULE
// ---------------------------------------------------------------------------
// A test never writes to the checked-out tree, and never uses git to undo what
// it wrote. A test that needs to mutate sources, add a package, or create a
// workspace link materialises its OWN copy of the tree with
// `pristineWorktree()` (see `helpers.ts`) and mutates only inside the returned
// temp directory. If it needs the original content back mid-run, it writes back
// bytes it captured from that copy — never a git operation. The same discipline
// now covers the Fixture_Tier: a test that needs a mutated fixture clones it
// (the Fixture_Clone / Output_Clearing helpers) and mutates the clone, never the
// committed `fixtures/` scenario.
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
// Every member of the Platform_Test_Set except this guard file (R9.8). The set
// is the single task-8.1 derivation (`platformTestSet` from
// `@microservices/build-tools/dist/testing/index.js`), the same one the
// Classification_Guard consumes — the set of files that must be classified and
// the set that must be scanned for unsafe writes are the same set, and two
// derivations meant to agree would eventually not. It spans several packages
// (`build-tools/tests`, `integration-tests/tests`, `overseer/tests`,
// `contracts/tests`, and the Entry_Package's tests), plus the `.property.test.ts`
// and `.test-d.ts` files and each shared non-test module a test imports
// (`helpers.ts` today). Each member is read by its repo-relative path.
//
// Sources are stripped of comments and string/template literals before matching,
// so prose (this file's own header included) and a template literal carrying a
// synthesised microservice's source text are never mistaken for a call. This
// file excludes itself from the scan by basename, and assembles every forbidden
// token from fragments so its own source never contains one contiguously — the
// technique `migration-facts.test.ts` and `integration-scope-guard.test.ts`
// already use, now doubly load-bearing since the widened set could otherwise
// sweep this file in via a future rename. The fixture ANCHOR classification
// (any identifier matching `FIXTURE` case-insensitively) is not a forbidden
// token but a checked-out-anchor rule, so this file scanning itself for anchors
// would be harmless even were it in the set.
//
// Rule 2 matches the DIRECT textual form (`writeFileSync(resolve(repoRoot, …))`)
// and so can be defeated by indirection. That is a deliberate floor, not a
// claim of completeness: Rule 1 forbids the mechanism that actually caused the
// damage, and the gitignored generated registry — which one suite legitimately
// snapshots and rewrites — is reached through a named constant and stays out of
// scope, as intended.
//
// THE WRITE-DESTINATION SCAN, AND THE THREE-PART SUFFICIENCY FIX
// ---------------------------------------------------------------------------
// The write-destination scan generalises Rule 2. It walks each mutating fs
// call's whole argument span — which may cross lines — and flags a write whose
// destination is INSIDE the checked-out repository and OUTSIDE the SIX permitted
// locations: a package's gitignored `dist/`, a `*.tsbuildinfo`, the generated
// Microservice_Registry at `<Entry_Root>/src/generated/microservice-registry.ts`
// (the path taken from the Build_System's single derivation, so no location
// under a Framework_Singleton is permitted), a `dist/` under `fixtures/`, a
// `*.tsbuildinfo` under `fixtures/`, and the Fixture_Projects_Root's
// `node_modules/`.
//
// The Fixture_Tier is committed source that tests point the platform at and now
// build inside. `fixtures/` IS in the checked-out tree, so a fixture path is a
// Checked_Out_Anchor (R9.3), and the anchors of R9.3 are necessary but not
// sufficient. The design specifies the sufficiency in three parts, all
// implemented below:
//
//   1. Checked-out anchors are decisive. A span carrying BOTH a checked-out
//      anchor and a temp anchor is classified checked-out (R9.3): a genuine
//      write inside a clone names the Clone_Handle's `dir` and no fixture
//      constant, so the combination is confusion, not a pattern.
//   2. A bare `dir` or `root` is a temp anchor ONLY in a file that also contains
//      a temp-CREATING call (`mkdtemp`, `tmpdir`, `pristineWorktree`, or the
//      Fixture_Clone). A file that never creates a temporary directory cannot
//      claim a temp anchor via a bare `dir`/`root`, so a `writeFileSync(resolve(
//      root, "package.json"))` two lines below `const root = resolve(FIXTURES_…)`
//      is no longer excused and falls through to the checked-out classification.
//   3. Fixture constants are checked-out anchors by name and by shape: the
//      Fixture_Tier root token, the two partition roots, the Fixture_Projects_
//      Root, and — so a new constant needs no guard edit — any identifier whose
//      name matches `FIXTURE` case-insensitively, matched on WORD BOUNDARIES so
//      `\broot\b` does not match inside `FIXTURE_PROJECTS_ROOT`.
//
// The classification stays positive — a call is flagged only when its span
// carries a checked-out anchor with no permitted location, or writes a
// `scaffold.config.json` with no temp/pristine base — so a write anchored at a
// pristine copy's directory or an OS temp path is never flagged, which is what
// lets the widened set turn nothing red for a write the guard merely fails to
// understand.
//
// Validates: the worktree-safety prohibition recorded in `.kiro/steering/tech.md`

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { generatedRegistryPath } from "@microservices/build-tools/dist/generate-registry.js";
import {
  platformTestSet,
  MUTATING_FS,
  TEMP_CREATORS,
  CONFIG_FILE,
  DIST_OR_TSBUILDINFO,
  NODE_MODULES_TOKEN,
  classifySpan,
  flagWriteSpan,
} from "@microservices/build-tools/dist/testing/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root.
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/**
 * The Generated_Registry's path — permitted write #3. Taken from the SINGLE
 * derivation `generatedRegistryPath` rather than spelled here, so it is
 * `<Entry_Root>/src/generated/microservice-registry.ts` for this project's
 * Effective_Config and moves with a relocated Entry_Root (R9.6). No path under a
 * Framework_Singleton's directory is permitted by this guard: the registry lives
 * in the consumer's tree since the registry inversion (R4.1, R12.1).
 */
const GENERATED_REGISTRY_PATH = generatedRegistryPath(
  projectContext(defaultEffectiveConfig()),
);

/** This project's Entry_Root, for the permitted-set self-check below. */
const ENTRY_ROOT = projectContext(defaultEffectiveConfig()).entryRoot;

/**
 * The directory the Generated_Registry used to occupy, under the Overseer
 * Framework_Singleton. Assembled from fragments, like every other forbidden token
 * in this file, so this source never holds it contiguously; it exists only so the
 * permitted-set self-check can prove a write there is rejected (R9.5, R9.6).
 */
const RETIRED_REGISTRY_DIR = "packages/" + "overseer" + "/src/generated";

/** This guard's own file name, excluded from the scanned set (R9.8). */
const SELF = basename(fileURLToPath(import.meta.url));

/**
 * Every member of the Platform_Test_Set except this guard, read by repo-relative
 * path (R9.8). The derivation is the shared task-8.1 module, so this set and the
 * Classification_Guard's set cannot drift apart.
 */
function scannedSources(): readonly { file: string; path: string }[] {
  return platformTestSet()
    .filter((repoRelative) => basename(repoRelative) !== SELF)
    .map((repoRelative) => ({
      file: repoRelative,
      path: resolve(REPO_ROOT, repoRelative),
    }));
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
 * text the rule must see, and the rule would pass on every input. The
 * write-destination scan needs it too: a destination is a string literal.
 * Comments are still removed so prose describing the prohibition — including this
 * file's own header — is never read as a call.
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
const REPO_ROOT_TOKEN = "repo" + "Root";

// The mutating-fs set, the temp-creator gate, the config-file token, the
// location-token predicates, and the span classifier / flagging rule are the
// shared task-9.2 module (`worktree-classifier`, imported above from
// `@microservices/build-tools/dist/testing`). The Worktree_Guard applies them to
// the real Platform_Test_Set; Property 9 applies the same `flagWriteSpan` /
// `classifySpan` to generated fragments, so the guard's verdict and the
// property's verdict cannot drift. `MUTATING_FS` is spelled once, there.

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
  `\\b(?:${MUTATING_FS.join("|")})\\s*\\([^)]*\\b${REPO_ROOT_TOKEN}\\b`,
);

// --- The write-destination scan (task 9.1, R9.1–R9.6; task 9.2 extraction) --
//
// The anchor lists, the temp-anchor gate, the location-token predicates, and
// `classifySpan` / `flagWriteSpan` now live in the shared task-9.2 module
// (`worktree-classifier`). The guard threads its ONE derived value — the
// Generated_Registry path (permitted location 3, R9.6) — into the classifier
// through the `generatedRegistryPath` option, so no location under a
// Framework_Singleton is permitted and a relocated Entry_Root is followed.

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

const sources = scannedSources().map(({ file, path }) => {
  const source = readFileSync(path, "utf8");
  const codeWithStrings = stripCommentsOnly(source);
  return {
    file,
    /** Code only: comments AND string literals elided. */
    code: stripCommentsAndStrings(source),
    /** Code plus string literals: comments elided, strings preserved. */
    codeWithStrings,
    /** File-level provenance: does it create a temporary directory at all? */
    hasTempCreator: TEMP_CREATORS.some((token) =>
      new RegExp(`\\b${token}\\b`).test(codeWithStrings),
    ),
  };
});

/**
 * Scans each mutating fs call's whole (possibly multi-line) argument span and
 * returns an offence when the destination is inside the checked-out tree and
 * outside the six permitted locations. Operates on the strings-preserved
 * projection, since destinations are string literals and variable names.
 */
function scanWriteDestinations(): readonly Offence[] {
  const offences: Offence[] = [];
  const callHead = new RegExp(`\\b(?:${MUTATING_FS.join("|")})\\s*\\(`, "g");

  for (const entry of sources) {
    const text = entry.codeWithStrings;
    const scanner = new RegExp(callHead.source, "g");
    let match = scanner.exec(text);
    while (match !== null) {
      // Capture the balanced argument span from the opening paren.
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let end = open;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === "(") depth += 1;
        else if (text[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const span = text.slice(open, end + 1);

      // The shared flagging rule (task 9.2), threading this project's derived
      // Generated_Registry path as permitted location 3 (R9.6). Checked-out
      // anchors are decisive; a config write with no temp base is flagged on its
      // own ground — the rule lives once in `flagWriteSpan`.
      const flagged = flagWriteSpan(span, {
        fileHasTempCreator: entry.hasTempCreator,
        generatedRegistryPath: GENERATED_REGISTRY_PATH,
      });

      if (flagged) {
        const line = text.slice(0, match.index).split("\n").length;
        offences.push({
          file: entry.file,
          line,
          rule: "write inside the checked-out tree",
          text: span.split("\n")[0].trim(),
        });
      }
      match = scanner.exec(text);
    }
  }
  return offences;
}

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
    // A rename or move that emptied the scanned set — or a broken
    // Platform_Test_Set derivation — would otherwise let this guard pass by
    // inspecting nothing. The floor is two, and now guards a four-step
    // derivation rather than a readdir of one directory (R9.8).
    expect(sources.length).toBeGreaterThan(1);
    // Both projections must be non-empty, or a rule could pass on empty input.
    expect(sources.every((entry) => entry.code.length > 0)).toBe(true);
    expect(sources.every((entry) => entry.codeWithStrings.length > 0)).toBe(true);
    // The one shared non-test module the set derives is still present.
    expect(
      sources.some(
        (s) => s.file === "packages/integration-tests/tests/helpers.ts",
      ),
    ).toBe(true);
  });

  it("invokes no destructive git subcommand", () => {
    // `git checkout -- <path>` restores COMMITTED content, discarding every
    // uncommitted change in the file. reset/clean/stash are equally destructive
    // to a developer's working state. A test that needs original content back
    // writes back bytes it captured from its own pristine copy or fixture clone
    // instead (R7.10, R9.8).
    const offences = scan(
      `destructive ${GIT} subcommand`,
      DESTRUCTIVE_GIT,
      // Strings preserved: the subcommand IS a string literal.
      "codeWithStrings",
    );
    expect(
      offences,
      `a test must never run a destructive ${GIT} command — it discards uncommitted work.\n` +
        `Mutate a pristineWorktree() copy or a fixture clone and restore by writing back captured bytes:\n${report(offences)}`,
    ).toEqual([]);
  });

  it("performs no filesystem mutation at a path built from the repo root", () => {
    // Writing under the checked-out tree pollutes it (an untracked package, a
    // dangling workspace symlink) or corrupts it (an edited tracked source).
    // Every mutation belongs inside a pristineWorktree() copy, a fixture clone,
    // or an OS temp directory.
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
    // incidents. Neither it nor a rename of it may reappear anywhere in the
    // widened set (R7.10, R9.8).
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

  it("writes nothing inside the checked-out tree outside the six permitted locations", () => {
    // Every write belongs in a pristineWorktree() copy, a fixture clone, or an
    // OS temp dir, never in the checked-out tree — except a package's gitignored
    // dist/, a *.tsbuildinfo, the generated Microservice_Registry, a dist/ under
    // fixtures/, a *.tsbuildinfo under fixtures/, and the Fixture_Projects_Root's
    // node_modules/ (R9.1). A scaffold.config.json written into the checked-out
    // tree is a violation, because this repository deliberately has none (R13.6);
    // a test needing a non-default config puts it inside a copy and passes the
    // copy's directory as the Project_Directory.
    const offences = scanWriteDestinations();
    expect(
      offences,
      `a test wrote inside the checked-out tree outside the permitted locations; ` +
        `write into a pristineWorktree() copy or a fixture clone instead.\n${report(offences)}`,
    ).toEqual([]);
  });

  it("permits exactly the six in-place write locations and rejects everything else", () => {
    // R9.5: hold the Permitted_Write_Location set explicitly and assert over it
    // directly, because a scan that reports nothing when every write is permitted
    // cannot distinguish a clean repository from a set that quietly widened to
    // admit everything. The SIX locations, three existing and three new under the
    // Fixture_Tier (R9.1):
    const permitted: readonly { readonly label: string; readonly span: string }[] = [
      // 1. A package's gitignored dist/.
      { label: "a gitignored dist/", span: `packages/contracts/${"dist"}/index.js` },
      // 2. A *.tsbuildinfo.
      { label: "a *.tsbuildinfo", span: `packages/contracts/tsconfig.tsbuildinfo` },
      // 3. The Generated_Registry at its Entry_Root path (derived, R9.6).
      { label: "the Generated_Registry", span: GENERATED_REGISTRY_PATH },
      // 4. A dist/ under fixtures/ — fixture-qualified (R9.1, R9.4).
      {
        label: "a fixtures-tier dist/",
        span: `resolve(FIXTURES_ROOT, "trees", "x", "${"dist"}")`,
      },
      // 5. A *.tsbuildinfo under fixtures/ — fixture-qualified (R9.1, R9.4).
      {
        label: "a fixtures-tier *.tsbuildinfo",
        span: `resolve(FIXTURES_ROOT, "trees", "x", "tsconfig.tsbuildinfo")`,
      },
      // 6. The Fixture_Projects_Root's node_modules/ (R9.1).
      {
        label: "the Fixture_Projects_Root node_modules/",
        span: `resolve(FIXTURE_PROJECTS_ROOT, "node_modules")`,
      },
    ];
    expect(permitted.length).toBe(6);

    // Location 3 names the path the Build_System actually writes, under the
    // Entry_Root (registry inversion R4.1, R12.1).
    expect(GENERATED_REGISTRY_PATH).toBe(
      `${ENTRY_ROOT}/src/generated/microservice-registry.ts`,
    );

    // Each of the six is classified permitted. Locations 4/5/6 name a fixture
    // constant, so they are checked-out-anchored yet permitted; the classifier
    // must therefore let a checked-out-anchored write pass on the strength of a
    // permitted-location token.
    for (const { label, span } of permitted) {
      const { permitted: isPermitted } = classifySpan(span, {
        fileHasTempCreator: true,
        generatedRegistryPath: GENERATED_REGISTRY_PATH,
      });
      expect(isPermitted, `expected permitted: ${label}`).toBe(true);
    }

    // And each of the five named destinations is REJECTED (R9.5) — none names a
    // permitted location, so each, being checked-out-anchored (via a checked-out
    // or fixture anchor) or a bare config write, is flagged:
    const rejected: readonly { readonly label: string; readonly span: string }[] = [
      // (a) a tracked source under a Consumer_Package's src/.
      {
        label: "a Consumer_Package source",
        span: `resolve(repoRoot, "packages/microservices/microservice1/src/index.ts")`,
      },
      // (b) a Project_Config_File written into the checked-out tree.
      {
        label: "a Project_Config_File in the checked-out tree",
        span: `resolve(repoRoot, "${CONFIG_FILE}")`,
      },
      // (c) the Generated_Registry's retired location under the Overseer (R9.6).
      {
        label: "the retired registry location",
        span: `resolve(repoRoot, "${RETIRED_REGISTRY_DIR}/microservice-registry.ts")`,
      },
      // (d) a Scenario_Manifest (a fixtures/.../fixture.json).
      {
        label: "a Scenario_Manifest",
        span: `resolve(FIXTURE_TREES_ROOT, "config--unparsable", "fixture.json")`,
      },
      // (e) a manifest inside a Fixture_Scenario (a fixtures/.../package.json).
      {
        label: "a member manifest inside a Fixture_Scenario",
        span: `resolve(FIXTURE_PROJECTS_ROOT, "barrel--invalid", "packages", "lib", "package.json")`,
      },
    ];

    for (const { label, span } of rejected) {
      const flagged = flagWriteSpan(span, {
        fileHasTempCreator: true,
        generatedRegistryPath: GENERATED_REGISTRY_PATH,
      });
      expect(flagged, `expected rejected: ${label}`).toBe(true);
    }

    // The two fixture rejections turn on tokens the tier's naming cannot supply:
    // a Scenario_Directory_Name never contains `dist` (no Diagnostic_Tag's
    // category or detail is `dist`, and a `dist` qualifier is forbidden), and a
    // member manifest path carries no `node_modules` segment — location 6 permits
    // the installed directory, not the sources beside it.
    expect(NODE_MODULES_TOKEN.test("barrel--invalid/packages/lib/package.json")).toBe(
      false,
    );
    expect(DIST_OR_TSBUILDINFO.test("config--unparsable/fixture.json")).toBe(false);

    // A node_modules write NOT under a fixture anchor stays a violation: the
    // repository's own node_modules is never a permitted destination.
    expect(
      classifySpan(`resolve(repoRoot, "node_modules", "x")`, {
        fileHasTempCreator: true,
        generatedRegistryPath: GENERATED_REGISTRY_PATH,
      }).permitted,
    ).toBe(false);
  });
});

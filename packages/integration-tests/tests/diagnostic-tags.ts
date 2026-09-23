// The emitted-tag derivation the Diagnostic_Coverage_Record guard (task 6.3)
// checks its key set against (platform-fixtures spec, task 6.1; R5.2).
//
// It computes the set of Diagnostic_Tags the Build_System emits by scanning
// every tracked TypeScript source under the platform's own
// `packages/build-tools/src/` tree, as the UNION OF TWO RECOGNISERS. The two
// forms are complementary: some tags are written as a bracketed literal (often
// only inside a `@throws` annotation), and some are never written bracketed at
// all — they are composed at render time from a string-union member, so the
// bracketed form appears only after interpolation, which no static scan sees.
//
//   Form A — bracketed literal. Every match of the bracketed tag shape in the
//   file's RAW text, comments and JSDoc INCLUDED. Comments are deliberately not
//   stripped: for several tags the sole occurrence in the raising module is a
//   `@throws` annotation, the rendered message being assembled elsewhere, so a
//   comment-stripping scan would drop them.
//
//   Form B — tag-union member. Within the span of a `type <Name>Tag = ...;`
//   declaration OR of a `readonly tag: ...;` property signature, every quoted
//   string literal whose contents match the bare tag shape. Form B is confined
//   to those two declaration positions on purpose: accepting any tag-shaped
//   literal anywhere would import phantom keys (a selector token, a map key, a
//   test name), each demanding a record entry for a tag nothing emits.
//
// Form B recovers the six tags a bracketed-only scan misses:
//   - three from the ConfigTag union in project-config.ts
//     (config plus unparsable / root-not-directory / root-is-package)
//   - three from the inline union on TsconfigViolation.tag in
//     tsconfig-verifier.ts (tsconfig plus setting / absent / unresolvable)
//
// The derived set is the union of both forms across all scanned files, in the
// SAME bracketed form the rest of the tier keys on — a Fixture_Scenario's
// `fixture.json` `expectedDiagnostic`, and the value `expectedDiagnosticOf`
// recovers, are both bracketed, so the guard can compare this set against the
// record's keys directly.
//
// This module lives under `packages/integration-tests/tests/`, NOT under any
// Build_System `src/`, so R1.7 (no `fixtures` path literal in Build_System
// source) does not apply to it and — importantly — it is NOT itself part of the
// scanned set, so nothing it writes here can inject a phantom tag into the
// result. It is a plain module, not a `*.test.ts`, so Vitest does not collect
// it.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A scanned source: its path (for provenance) paired with its raw text. */
export interface TagSource {
  readonly file: string;
  readonly text: string;
}

// --- Form A: bracketed literal in raw text --------------------------------

// A bracketed tag: `[` then a lowercase-letter-led category of lowercase
// letters and hyphens, `:`, a detail of the same shape, `]`. Applied to the
// raw file text with no comment stripping, `g` so every occurrence is taken.
const BRACKETED_TAG = /\[([a-z][a-z-]*):([a-z][a-z-]*)\]/g;

/** Every bracketed tag literal in one source's raw text (Form A). */
function bracketedTags(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(BRACKETED_TAG)) {
    // match[0] is the whole `[category:detail]` with brackets.
    found.push(match[0]);
  }
  return found;
}

// --- Form B: tag-union member inside a bounded declaration ----------------

// Opens a tag-union declaration span: either `type <Name>Tag =` (a type alias
// whose name ends `Tag`) or a `readonly tag:` property signature. The span runs
// from the match to the next `;`.
const UNION_SPAN_OPENER = /\btype\s+[A-Za-z0-9_]*Tag\s*=|\breadonly\s+tag\s*:/g;

// A quoted string literal whose CONTENTS are a bare (unbracketed) tag. Single
// and double quotes both, since a union member may use either.
const BARE_TAG_LITERAL = /["']([a-z][a-z-]*:[a-z][a-z-]*)["']/g;

/**
 * Every bare tag literal that falls inside a tag-union declaration span, each
 * returned in bracketed form (Form B).
 *
 * A span begins at a `type <Name>Tag =` or `readonly tag:` opener and ends at
 * the first `;` at or after it; within that slice every quoted literal matching
 * the bare tag shape is collected. Confining collection to these spans keeps a
 * `category:detail`-shaped string appearing elsewhere (a selector token, a map
 * key) out of the result.
 */
function unionMemberTags(text: string): string[] {
  const found: string[] = [];
  for (const opener of text.matchAll(UNION_SPAN_OPENER)) {
    const start = opener.index ?? 0;
    const semicolon = text.indexOf(";", start);
    const end = semicolon === -1 ? text.length : semicolon;
    const span = text.slice(start, end);
    for (const literal of span.matchAll(BARE_TAG_LITERAL)) {
      // literal[1] is the bare `category:detail`; bracket it to match Form A.
      found.push(`[${literal[1]}]`);
    }
  }
  return found;
}

// --- The pure core --------------------------------------------------------

/**
 * The set of Diagnostic_Tags the Build_System emits, derived from the given
 * sources as the union of Form A and Form B across every source. Each tag is in
 * bracketed `[category:detail]` form.
 *
 * Pure over its inputs: it reads no filesystem and consults no global state, so
 * a caller can exercise it with synthesised sources. The real-repository shell
 * `emittedDiagnosticTags` supplies the actual sources.
 */
export function emittedTagsFromSources(
  sources: readonly TagSource[],
): Set<string> {
  const tags = new Set<string>();
  for (const { text } of sources) {
    for (const tag of bracketedTags(text)) {
      tags.add(tag);
    }
    for (const tag of unionMemberTags(text)) {
      tags.add(tag);
    }
  }
  return tags;
}

// --- The real-repository effect shell -------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// This file sits at `packages/integration-tests/tests/`, so three `..`
// segments reach the repository root, the same anchor `fixture-paths.ts` uses.
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The single tree scanned: the platform's own Build_System sources. */
const SCANNED_ROOT = resolve(repoRoot, "packages", "build-tools", "src");

/** TypeScript source extensions the walk collects. */
const TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/** Directory names never descended into — generated output and dependencies. */
const SKIPPED_DIRECTORIES: readonly string[] = ["node_modules", "dist"];

/**
 * Lists every tracked TypeScript source under `packages/build-tools/src/`,
 * recursively, reading each. Mirrors the recursive-readdir walk
 * `scope-checks.ts` uses over the same tree: dot-entries and the generated
 * `dist/`/`node_modules/` subtrees are skipped, so only committed sources are
 * read.
 */
function listBuildToolsSources(): TagSource[] {
  const sources: TagSource[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.includes(entry.name)) {
          walk(path);
        }
        continue;
      }
      if (
        entry.isFile() &&
        TS_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      ) {
        sources.push({ file: path, text: readFileSync(path, "utf8") });
      }
    }
  };

  walk(SCANNED_ROOT);
  return sources;
}

/**
 * The set of Diagnostic_Tags the Build_System emits over the real repository,
 * in bracketed `[category:detail]` form. This is the effect shell the coverage
 * guard (task 6.3) compares against the Diagnostic_Coverage_Record's key set.
 */
export function emittedDiagnosticTags(): Set<string> {
  return emittedTagsFromSources(listBuildToolsSources());
}

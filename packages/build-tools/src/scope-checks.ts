// The scope-drift check the Repo_Invariant_Checker runs alongside the
// Tsconfig_Verifier: `[scope:literal]`. It writes nothing — the whole filesystem
// surface of this module is `readFileSync` and a recursive `readdirSync` walk,
// and it imports NO write function from `node:fs`, so "inspect only" (R12.4) is a
// fact about the module graph rather than a promise about a code path.
//
// The check parses with the TypeScript compiler in parse-only mode
// (`ts.createSourceFile`, no `Program`, no type checker, no `lib.d.ts`), because
// this repository's Build_System sources carry long comments that name the
// Scope_Default constantly: a regex over source text would report every one of
// them (R12.4's "outside a line comment and outside a block comment"). Comments
// are not nodes, so parsing excludes them structurally.
//
// The Scope_Default is imported from project-config.ts, never spelled here
// (R1.8, R12.4) — which is what makes exempting exactly project-config.ts a
// complete exemption: this check does not itself contain the literal it forbids.
//
// The Scope_Template_Check that once lived here is retired: its subject, the
// Registry_Template, no longer needs guarding, so no diagnostic replaces it
// (registry-inversion R6.1).
//
// (Requirements 12.4, 12.5, 12.6, 12.7, 7.7, 7.8.)

import { readFileSync, readdirSync } from "node:fs";

import ts from "typescript";

import { SCOPE_DEFAULT } from "./project-config.js";

// --- The scope-literal check (`[scope:literal]`, R12.4, R12.5, R12.6, R12.7) ---

const SCOPE_LITERAL = "[scope:literal]";

/** The directory the check scans, and nothing else — no `tests/`, no manifest,
 *  no Markdown, no Registry_Template, no other package (R12.6). */
const SCANNED_ROOT = "packages/build-tools/src";

/** The single module R1.8 makes the declaration site, and R12.4 exempts. This is
 *  a path literal, not a scope literal, so the exemption need not exempt itself
 *  (R12.6). */
const SCOPE_DECLARATION_FILE = "packages/build-tools/src/project-config.ts";

/** One collected occurrence of the Scope_Default in a literal outside a comment. */
export interface ScopeLiteralOccurrence {
  /** Project_Directory-relative POSIX path of the offending file (R12.4). */
  readonly file: string;
  /** 1-based line number of the occurrence (R12.4). */
  readonly line: number;
  /** The offending literal's cooked text (R12.4). */
  readonly literal: string;
}

/** The injected source lister: yields every scanned file's Project_Directory-
 *  relative path paired with its text. Injecting it keeps `collectScopeLiterals`
 *  pure over its inputs and testable without a filesystem. */
export type ListSources = () => readonly {
  readonly file: string;
  readonly text: string;
}[];

/**
 * Collects the cooked text of every string and template literal node in one
 * parsed source, each paired with its 1-based line number.
 *
 * The collected node kinds are StringLiteral, NoSubstitutionTemplateLiteral, and
 * the three template chunks (TemplateHead, TemplateMiddle, TemplateTail). A
 * template literal's substitutions are separate expression nodes and are NOT
 * collected, so `` `${context.config.scope}/contracts` `` yields the chunk texts
 * (`` `` `` and `/contracts`) but never the composed scope. Comments are not
 * nodes at all, so they are excluded structurally (R12.4).
 *
 * The `.text` of each node is the COOKED value, so `"\u0040microservices"` is
 * compared as `@microservices` (R12.4).
 */
function literalTexts(
  source: ts.SourceFile,
): readonly { readonly text: string; readonly line: number }[] {
  const collected: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      const text = (node as ts.LiteralLikeNode).text;
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      collected.push({ text, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return collected;
}

/**
 * The pure core of the `[scope:literal]` check: over the listed sources, reports
 * every literal whose cooked text contains the Scope_Default as a substring,
 * excluding the one exempt declaration file (R12.4, R12.6).
 *
 * Each source is parsed with parse-only `createSourceFile`, and every occurrence
 * carries its file, 1-based line, and the offending literal. The returned list's
 * length is what the run's status derives from; nothing here renders (R12.4).
 */
export function collectScopeLiterals(
  listSources: ListSources,
): readonly ScopeLiteralOccurrence[] {
  const occurrences: ScopeLiteralOccurrence[] = [];

  for (const { file, text } of listSources()) {
    if (file === SCOPE_DECLARATION_FILE) {
      continue;
    }
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ES2023,
      /* setParentNodes */ false,
    );
    for (const { text: literal, line } of literalTexts(source)) {
      if (literal.includes(SCOPE_DEFAULT)) {
        occurrences.push({ file, line, literal });
      }
    }
  }

  return occurrences;
}

/** `[scope:literal] "<file>":<line> — "<literal>" spells the Scope_Default … */
export function renderScopeLiteral(occurrence: ScopeLiteralOccurrence): string {
  return `${SCOPE_LITERAL} "${occurrence.file}":${String(occurrence.line)} — the literal "${occurrence.literal}" spells the Scope_Default; derive it from project-config.ts instead`;
}

/**
 * Runs the `[scope:literal]` check over the real repository: it lists every
 * `.ts` file under `packages/build-tools/src/`, recursively, parses each, and
 * renders one message per occurrence (R12.4, R12.6).
 *
 * Its steady state is silence (R12.7): after the migration deleted the last
 * scope literal from `packages/build-tools/src/`, only project-config.ts spells
 * the scope, and that one file is exempt. Any message this returns is a reader
 * the migration missed.
 */
export function checkScopeLiterals(): readonly string[] {
  return collectScopeLiterals(listBuildToolsSources).map(renderScopeLiteral);
}

/** TypeScript source extensions the walk collects. */
const TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/** Directory names never descended into. */
const SKIPPED_DIRECTORIES: readonly string[] = ["node_modules", "dist"];

/** Tells whether a filesystem error means "this path does not exist". */
function isAbsent(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Recursively lists the `.ts` sources under `SCANNED_ROOT`, reading each one. */
const listBuildToolsSources: ListSources = () => {
  const sources: { file: string; text: string }[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (isAbsent(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const path = `${dir}/${entry.name}`;
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
  return [...sources].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

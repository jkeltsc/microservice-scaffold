// The two scope-drift checks the Repo_Invariant_Checker runs alongside the
// Tsconfig_Verifier: `[scope:template]` and `[scope:literal]`. Neither writes
// anything — the whole filesystem surface of this module is `readFileSync` and a
// recursive `readdirSync` walk, and it imports NO write function from `node:fs`,
// so "leave the Registry_Template byte-identical" (R8.9) and "inspect only"
// (R12.4) are facts about the module graph rather than promises about a code
// path.
//
// Both checks parse with the TypeScript compiler in parse-only mode
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
// (Requirements 8.9, 8.10, 12.4, 12.5, 12.6, 12.7, 7.7, 7.8.)

import { readFileSync, readdirSync } from "node:fs";

import ts from "typescript";

import { SCOPE_DEFAULT } from "./project-config.js";
import { type ProjectContext } from "./project-context.js";

// --- The Registry_Template scope check (`[scope:template]`, R8.9, R8.10) ---

const SCOPE_TEMPLATE = "[scope:template]";

/** The committed Registry_Template the root `prepare` script copies. It is
 *  inspected, never rewritten or generated (R8.9). */
const REGISTRY_TEMPLATE_PATH =
  "packages/overseer/src/generated/microservice-registry.template.ts";

/** The injected Registry_Template reader (R8.10). Its `text`/`unreadable` shapes
 *  keep absence-of-a-reason distinct from a reason, which is what lets the
 *  unreadable branch name why. */
export type ReadTemplate = (
  path: string,
) =>
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The scope part of a scoped specifier: the text up to the first `/`, or the
 *  whole specifier when it holds none. A specifier is scoped when it begins with
 *  `@`. */
function scopeOf(specifier: string): string {
  const slash = specifier.indexOf("/");
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

/**
 * Collects every `import`/`export` module specifier of a parsed source, in
 * source order. Parse-only: `moduleSpecifier` is a string literal node whose
 * `.text` is the cooked specifier, so an escaped spelling is already normalised.
 */
function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * Reports whether the committed Registry_Template still imports under the run's
 * Configured_Scope, returning at most one violation ever (R8.9, R8.10).
 *
 * A template fails for one reason — the project changed its scope — so the three
 * failure branches each aggregate to a single message rather than listing every
 * specifier:
 *
 *   - unreadable: one message naming the path and the reason, no inspection.
 *   - no scoped specifier at all: one message saying none was found.
 *   - a scoped specifier whose scope differs from `context.specifierPrefix`: one
 *     message naming the scope the FIRST offending specifier declares.
 *
 * The template is parsed with the same parse-only `createSourceFile` the literal
 * check uses, so a header comment naming the right scope cannot mask an import
 * naming the wrong one.
 */
export function checkRegistryTemplateScope(
  context: ProjectContext,
  readTemplate: ReadTemplate,
): readonly string[] {
  const read = readTemplate(REGISTRY_TEMPLATE_PATH);
  if (read.kind === "unreadable") {
    return [
      `${SCOPE_TEMPLATE} "${REGISTRY_TEMPLATE_PATH}" could not be read; ${read.reason}`,
    ];
  }

  const source = ts.createSourceFile(
    REGISTRY_TEMPLATE_PATH,
    read.text,
    ts.ScriptTarget.ES2023,
    /* setParentNodes */ false,
  );

  const scoped = moduleSpecifiers(source).filter((specifier) =>
    specifier.startsWith("@"),
  );

  if (scoped.length === 0) {
    return [
      `${SCOPE_TEMPLATE} "${REGISTRY_TEMPLATE_PATH}" declares no scoped import specifier; expected the Configured_Scope "${context.config.scope}"`,
    ];
  }

  const offending = scoped.find(
    (specifier) => !specifier.startsWith(context.specifierPrefix),
  );
  if (offending !== undefined) {
    return [
      `${SCOPE_TEMPLATE} "${REGISTRY_TEMPLATE_PATH}" imports under scope "${scopeOf(offending)}"; expected the Configured_Scope "${context.config.scope}"`,
    ];
  }

  return [];
}

/** The real Registry_Template reader: one `readFileSync`, no write. */
export const readRegistryTemplate: ReadTemplate = (path) => {
  try {
    return { kind: "text", text: readFileSync(path, "utf8") };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

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

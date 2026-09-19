// Shared fast-check arbitrary for the `[scope:literal]` property suite
// (Property 18, Requirements 12.4, 12.6, 12.7).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it.
//
// `buildToolsSource()` assembles one TypeScript source text out of labelled
// fragments, each of which places the Scope_Default somewhere with a KNOWN
// verdict. The verdict is fixed by the fragment's label, so the property never
// re-implements the checker — it only compares the checker's reported lines
// against the lines the labels say should be reported.
//
// The Scope_Default the fragments embed is imported from project-config.ts so
// the arbitrary never spells it (it is not build-tools/src, so the check does
// not scan it, but keeping it derived matches the design's single-declaration
// discipline and survives a future scope change).

import * as fc from "fast-check";

import { SCOPE_DEFAULT } from "../../src/project-config.js";

/** Whether a fragment's placement of the Scope_Default should be reported. */
export type FragmentVerdict = "reported" | "clean";

/** One labelled source fragment: the exact source text it contributes and
 *  whether the `[scope:literal]` check should report the Scope_Default in it. */
export interface SourceFragment {
  readonly label: string;
  /** The fragment's source text, occupying exactly one line (no embedded `\n`). */
  readonly line: string;
  readonly verdict: FragmentVerdict;
}

/** The `@` of the Scope_Default written as a `\u0040` escape, so the source text
 *  does not literally contain the scope but its cooked form does. */
const ESCAPED_SCOPE = `\\u0040${SCOPE_DEFAULT.slice(1)}`;

/**
 * The seven fragment shapes Property 18 ranges over. Three place the scope where
 * the check reports it (a string literal, a template chunk, an escaped spelling
 * inside a string literal); four place it where the check stays silent (a line
 * comment, a block comment, a doc comment, and a template SUBSTITUTION that
 * composes it from an expression).
 *
 * Each `line` is a single physical line so its 1-based line number is exactly its
 * position in the assembled source, which is what lets the property assert line
 * numbers without re-deriving them.
 */
export const FRAGMENT_SHAPES: readonly SourceFragment[] = [
  {
    label: "line-comment",
    line: `// a comment mentioning ${SCOPE_DEFAULT}/contracts here`,
    verdict: "clean",
  },
  {
    label: "block-comment",
    line: `/* block comment mentioning ${SCOPE_DEFAULT}/thing */`,
    verdict: "clean",
  },
  {
    label: "doc-comment",
    line: `/** doc comment mentioning ${SCOPE_DEFAULT}/thing */`,
    verdict: "clean",
  },
  {
    label: "template-substitution",
    line: "const composed = `${scope}/contracts`;",
    verdict: "clean",
  },
  {
    label: "string-literal",
    line: `const s = "${SCOPE_DEFAULT}/contracts";`,
    verdict: "reported",
  },
  {
    label: "template-chunk",
    line: `const t = \`${SCOPE_DEFAULT}/\${id}\`;`,
    verdict: "reported",
  },
  {
    label: "escaped-string-literal",
    line: `const e = "${ESCAPED_SCOPE}/contracts";`,
    verdict: "reported",
  },
];

/** An assembled source and the labels/lines the checker should report. */
export interface AssembledSource {
  /** The full source text. */
  readonly text: string;
  /** The Project_Directory-relative path the source is attributed to. */
  readonly file: string;
  /** Every fragment, in assembled order, with its resolved 1-based line number. */
  readonly fragments: readonly (SourceFragment & { readonly lineNumber: number })[];
}

/**
 * Assembles a source text from a generated permutation of the fragment shapes,
 * separated by blank lines so no two share a line, and reports each fragment's
 * resolved 1-based line number.
 *
 * A leading module comment and a trailing statement bracket the fragments so the
 * generated file always parses and always exercises the walk's ability to find
 * literals among surrounding code.
 */
export function buildToolsSource(): fc.Arbitrary<AssembledSource> {
  return fc
    .shuffledSubarray(FRAGMENT_SHAPES, {
      minLength: FRAGMENT_SHAPES.length,
      maxLength: FRAGMENT_SHAPES.length,
    })
    .map((ordered): AssembledSource => {
      const header = "// generated Property 18 fixture";
      const lines: string[] = [header];
      const fragments: (SourceFragment & { lineNumber: number })[] = [];

      for (const fragment of ordered) {
        // 1-based line number: current line count + 1 for the fragment's own line.
        lines.push(fragment.line);
        fragments.push({ ...fragment, lineNumber: lines.length });
      }

      lines.push("export const done = true;");

      return {
        text: lines.join("\n"),
        file: "packages/build-tools/src/generated-fixture.ts",
        fragments,
      };
    });
}

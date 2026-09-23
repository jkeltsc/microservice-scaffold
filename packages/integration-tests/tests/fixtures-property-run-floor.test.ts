// This feature's run floor and file-name convention — the mechanical half of
// Property 12 for platform-fixtures.
//
// Feature: platform-fixtures, Property 12: Every property of Requirement 16 is a
// fast-check property over at least 100 inputs.
//
// **Validates: Requirements 16.1, 16.12**
//
// R16.12 is the one criterion of Requirement 16 whose subject is the SUITE
// rather than the fixture tier. It says each property of Requirement 16 is
// expressed with `fast-check`, lives in a file whose name ends
// `.property.test.ts`, and executes over at least 100 generated inputs per run,
// with every `fc.assert` call declaring its own run count. Every part of that is
// checkable from the property files' own text, which is what this suite does —
// and why it is itself example-based rather than a property: its subject is a
// FIXED FINITE SET (the ten files implementing this feature's Properties 1
// through 10), so there is nothing to quantify over.
//
// R16.12 also fixes what this file must NOT do: it must leave the existing
// run-floor suite (`property-run-floor.test.ts`, the registry-inversion
// feature's) and its own file list unchanged, so the two features' floors are
// checked SIDE BY SIDE rather than one replacing the other. This file is a
// separate suite listing a disjoint set of paths; it touches nothing in the
// other.
//
// The point is the failure it produces. A `numRuns` lowered to 10 while chasing a
// slow suite is invisible in a green run: the property still passes, it just
// explores a tenth of the space. Pinning the floor here makes that edit a named
// failure naming the file and the value, so a temporary speed-up cannot become a
// permanent loss of coverage.
//
// What is checked, per file:
//
//   1. It exists. A property file renamed or deleted without this list being
//      updated fails here rather than silently dropping its property.
//   2. Its name ends `.property.test.ts` — the repository's convention, and how a
//      reader tells a property file from an example-based one at a glance.
//   3. It imports `fast-check`. Both quote styles are accepted, because the
//      repository contains both.
//   4. Every `fc.assert(...)` call in it carries a `numRuns` option: the count of
//      `numRuns` occurrences equals the count of `fc.assert` occurrences, so an
//      assertion added WITHOUT a declared floor (and therefore running at
//      fast-check's own default) is a failure too.
//   5. Every declared `numRuns` value is at least 100. A value written as an
//      identifier is resolved from that file's own `const NAME = <number>`
//      declaration; an identifier that cannot be resolved is a failure rather
//      than a pass, so indirection cannot hide a lowered floor.
//
// This suite is itself example-based (its subject is a fixed set), so it appears
// in NEITHER run-floor list — not this one, and not the registry-inversion one.
//
// Comments and string literals are elided before matching, so prose mentioning
// `numRuns` (this header included, were it in a scanned file) and a template
// literal carrying generated source text are never read as declarations.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The floor R16.1 fixes. */
const RUN_FLOOR = 100;

/**
 * The ten property files implementing this feature's Properties 1 through 10,
 * each with the property it implements. A fixed finite set, listed rather than
 * globbed: a glob would pass vacuously if a file were renamed out of the pattern,
 * while this list fails naming the missing path.
 *
 * These ten are disjoint from the eleven `property-run-floor.test.ts` lists;
 * the run-floor suites themselves (this file and that one) are example-based and
 * appear in neither list.
 */
const PROPERTY_FILES: readonly { readonly property: number; readonly path: string }[] = [
  { property: 1, path: "packages/build-tools/tests/fixture-synthesized-agreement.property.test.ts" },
  { property: 2, path: "packages/integration-tests/tests/fixture-scenario-diagnostics.property.test.ts" },
  { property: 3, path: "packages/build-tools/tests/fixture-clone.property.test.ts" },
  { property: 4, path: "packages/build-tools/tests/output-clearing.property.test.ts" },
  { property: 5, path: "packages/integration-tests/tests/fixture-additive-invariance.property.test.ts" },
  { property: 6, path: "packages/build-tools/tests/scenario-naming.property.test.ts" },
  { property: 7, path: "packages/integration-tests/tests/classification-guard.property.test.ts" },
  { property: 8, path: "packages/build-tools/tests/fixture-scope-disjointness.property.test.ts" },
  { property: 9, path: "packages/integration-tests/tests/worktree-guard-fixture-anchors.property.test.ts" },
  { property: 10, path: "packages/integration-tests/tests/baseline-byte-stability.property.test.ts" },
];

/** The suffix R16.1 fixes for a property file's name. */
const PROPERTY_SUFFIX = ".property.test.ts";

/**
 * Remove line comments, block comments, and string / template literals, so the
 * scan sees executable code only. A single-pass character scanner rather than
 * regexes, so a quote inside a comment (or `//` inside a string) cannot confuse
 * the state machine. Newlines inside an elided literal are preserved so
 * line-based reporting stays accurate. The same technique
 * `worktree-safety-guard.test.ts` uses.
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

/** Remove comments only, keeping string literals — an import specifier IS a
 *  string literal, so the `fast-check` check needs this projection. */
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

/** `import ... from "fast-check"` in either quote style, and the dynamic form. */
const IMPORTS_FAST_CHECK = /from\s*['"]fast-check['"]|require\(\s*['"]fast-check['"]\s*\)/;

/** `numRuns: <literal | identifier>`. */
const NUM_RUNS = /\bnumRuns\s*:\s*([A-Za-z_$][\w$]*|\d+)/g;

/** `const NAME = 150` / `const NAME: number = 150` — the resolvable indirection. */
function resolveIdentifier(code: string, name: string): number | undefined {
  const declaration = new RegExp(
    `\\bconst\\s+${name}\\s*(?::\\s*number\\s*)?=\\s*(\\d+)\\b`,
  );
  const found = declaration.exec(code);
  return found === null ? undefined : Number.parseInt(found[1] as string, 10);
}

/** Count non-overlapping occurrences of a global regex. */
function countMatches(code: string, pattern: RegExp): number {
  const scanner = new RegExp(pattern.source, "g");
  let count = 0;
  while (scanner.exec(code) !== null) count += 1;
  return count;
}

interface ScannedFile {
  readonly property: number;
  readonly path: string;
  readonly exists: boolean;
  /** Comments and literals elided — the projection the numeric scans read. */
  readonly code: string;
  /** Comments elided, literals kept — the projection the import scan reads. */
  readonly codeWithStrings: string;
}

const scanned: readonly ScannedFile[] = PROPERTY_FILES.map((entry) => {
  const absolute = resolve(repoRoot, entry.path);
  if (!existsSync(absolute)) {
    return { ...entry, exists: false, code: "", codeWithStrings: "" };
  }
  const source = readFileSync(absolute, "utf8");
  return {
    ...entry,
    exists: true,
    code: stripCommentsAndStrings(source),
    codeWithStrings: stripCommentsOnly(source),
  };
});

describe("Property 12: every platform-fixtures property is a fast-check property over at least 100 inputs (R16.1, R16.12)", () => {
  it("ranges over the ten property files of this feature's Properties 1 through 10", () => {
    // A non-vacuity guard: the scan must have a subject, and the subject must be
    // exactly the ten properties Requirement 16 states with generated inputs.
    expect(scanned).toHaveLength(10);
    expect(scanned.map((entry) => entry.property)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(new Set(scanned.map((entry) => entry.path)).size).toBe(10);
  });

  it.each(scanned)("Property $property — $path exists", ({ path, exists }) => {
    expect(
      exists,
      `${path} is absent; a property file was renamed or deleted without updating this list`,
    ).toBe(true);
  });

  it.each(scanned)(
    "Property $property — $path is named with the .property.test.ts convention",
    ({ path }) => {
      expect(
        basename(path).endsWith(PROPERTY_SUFFIX),
        `${path} must end '${PROPERTY_SUFFIX}'`,
      ).toBe(true);
    },
  );

  it.each(scanned)(
    "Property $property — $path uses fast-check",
    ({ path, exists, codeWithStrings }) => {
      expect(exists, `${path} is absent`).toBe(true);
      expect(
        IMPORTS_FAST_CHECK.test(codeWithStrings),
        `${path} must express its property with fast-check`,
      ).toBe(true);
    },
  );

  it.each(scanned)(
    "Property $property — $path declares a run count for every fc.assert",
    ({ path, exists, code }) => {
      expect(exists, `${path} is absent`).toBe(true);
      const asserts = countMatches(code, /\bfc\.assert\s*\(/);
      const declared = countMatches(code, /\bnumRuns\s*:/);
      expect(
        asserts,
        `${path} must contain at least one fc.assert call`,
      ).toBeGreaterThan(0);
      expect(
        declared,
        `${path} declares ${declared} numRuns option(s) for ${asserts} fc.assert call(s); every assertion must declare its own run count rather than fall back to fast-check's default`,
      ).toBe(asserts);
    },
  );

  it.each(scanned)(
    "Property $property — every declared run count in $path is at least 100",
    ({ path, exists, code }) => {
      expect(exists, `${path} is absent`).toBe(true);
      const scanner = new RegExp(NUM_RUNS.source, "g");
      const values: { readonly token: string; readonly runs: number | undefined }[] =
        [];
      let match = scanner.exec(code);
      while (match !== null) {
        const token = match[1] as string;
        const runs = /^\d+$/.test(token)
          ? Number.parseInt(token, 10)
          : resolveIdentifier(code, token);
        values.push({ token, runs });
        match = scanner.exec(code);
      }

      expect(
        values.length,
        `${path} declares no numRuns option`,
      ).toBeGreaterThan(0);

      for (const { token, runs } of values) {
        expect(
          runs,
          `${path} declares numRuns as '${token}', which this scan could not resolve to a number; declare it as a literal or as a \`const ${token} = <number>\` in the same file so the floor stays checkable`,
        ).toBeDefined();
        expect(
          runs as number,
          `${path} declares numRuns: ${token} = ${String(runs)}, below the floor of ${RUN_FLOOR} R16.1 fixes`,
        ).toBeGreaterThanOrEqual(RUN_FLOOR);
      }
    },
  );
});

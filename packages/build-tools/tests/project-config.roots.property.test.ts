// Feature: config-driven-discovery, Property 6: A root path is accepted exactly
// when it is a Valid_Root_Path
//
// The path-shape half of the `roots` biconditional (R4.1–R4.4). For a string
// used as a single `roots.<category>` value, `parseProjectConfig`:
//   - accepts it, recording `config.roots[category] === value` with NO
//     normalisation (R4.1, R4.3), if and only if the value is a Valid_Root_Path;
//   - otherwise rejects it, returning exactly one `[config:root-path]`
//     Config_Diagnostic FOR THAT MEMBER (R4.2) that names the key path
//     (`roots.<category>`), reproduces the offending value verbatim, and names
//     EVERY violated Valid_Root_Path condition rather than only the first
//     (R4.2), the escape check being the `..`-segment rejection alone (R4.4).
//
// The generators come from `tests/arbitraries/config.ts`, the single home of
// this suite's inputs: `validRootPath()` for the accepted side and
// `invalidRootPath()` (seeded per condition plus deliberate two-condition
// combinations) for the rejected side. Each property parametrises over all
// three Consumer_Categories so the key-path reporting is exercised for each,
// and builds a text declaring exactly one `roots` member so nothing but the
// path shape under test can produce a diagnostic.
//
// This file is extended by later tasks with the overlap half (Property 7) and
// the framework-collision half (Property 8); the path-shape describe block
// below stands on its own so those append cleanly.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
} from "../src/project-config.js";
import { invalidRootPath, validRootPath } from "./arbitraries/config.js";

/** The three Consumer_Categories, the three `roots` members under test. */
const CATEGORIES = ["microservice", "common", "spa"] as const;
type Category = (typeof CATEGORIES)[number];

/** A config text declaring exactly one `roots` member set to `value`. */
function rootsMemberText(category: Category, value: string): string {
  return JSON.stringify({ roots: { [category]: value } });
}

/**
 * How the parser reproduces a rejected value in a diagnostic's `found` part
 * (R4.2), mirrored here as the test's oracle. The value is reproduced verbatim,
 * except that the empty string and a whitespace-only value — both of which R4.3
 * enumerates as rejectable — are reproduced in JSON-quoted form so the part
 * stays non-empty and visible (R2.13), which is the parser's stated design
 * decision. A verbatim assertion is thus checked against this expected shape,
 * not against the raw value.
 */
function expectedFound(value: string): string {
  return value.length === 0 || value.trim().length === 0
    ? JSON.stringify(value)
    : value;
}

/**
 * The Valid_Root_Path conditions, mirrored here ONLY to compute the expected
 * violation set the diagnostic must name (R4.2). This is the test's independent
 * oracle: it is written from the requirement text (R4.3, R4.4), not imported
 * from the parser, so that the property checks the parser against the spec
 * rather than against itself. Returns the human-readable reasons the parser is
 * expected to list; an empty list means the value is a Valid_Root_Path.
 */
function expectedViolations(value: string): string[] {
  const violations: string[] = [];
  if (value.length === 0) {
    violations.push("must not be empty");
  }
  if (value.length > 0 && value.trim().length === 0) {
    violations.push("must not consist only of whitespace");
  }
  if (/^\s/.test(value)) {
    violations.push("must not begin with a whitespace character");
  }
  if (/\s$/.test(value)) {
    violations.push("must not end with a whitespace character");
  }
  if (value.startsWith("/")) {
    violations.push("must not begin with '/'");
  }
  if (value.length > 1 && value.endsWith("/")) {
    violations.push("must not end with '/'");
  }
  if (value.includes("\\")) {
    violations.push("must not contain a '\\' character");
  }
  if (value.includes("*") || value.includes("?")) {
    violations.push("must not contain a '*' or '?' character");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    violations.push("must not contain a '..' path segment");
  }
  if (segments.some((segment) => segment === ".")) {
    violations.push("must not contain a '.' path segment");
  }
  if (segments.some((segment) => segment.length === 0)) {
    violations.push("must not contain an empty path segment");
  }
  return violations;
}

describe("Property 6: a root path is accepted exactly when it is a Valid_Root_Path", () => {
  it("accepts a Valid_Root_Path verbatim, with no normalisation and no diagnostic", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CATEGORIES),
        validRootPath(),
        (category, value) => {
          const outcome = parseProjectConfig(
            rootsMemberText(category, value),
            PROJECT_CONFIG_FILE,
          );

          // The value under test is a Valid_Root_Path (the oracle agrees), so
          // it is accepted (R4.1) and recorded character for character with no
          // normalisation (R4.3).
          expect(expectedViolations(value)).toEqual([]);
          expect(outcome.kind).toBe("parsed");
          if (outcome.kind !== "parsed") return;
          expect(outcome.parsed.config.roots[category]).toBe(value);
          // The two categories that took their Root_Default are untouched.
          for (const other of CATEGORIES) {
            if (other !== category) {
              expect(outcome.parsed.config.roots[other]).not.toBe(value);
            }
          }
        },
      ),
    );
  });

  it("rejects a non-Valid_Root_Path with exactly one [config:root-path] naming the key path, the value, and every violated condition", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CATEGORIES),
        invalidRootPath(),
        (category, value) => {
          const expected = expectedViolations(value);
          // Precondition: the generator is meant to yield rejected values only.
          // A generated value that is in fact a Valid_Root_Path is discarded
          // (it belongs to the accept property above), not failed.
          fc.pre(expected.length > 0);

          const outcome = parseProjectConfig(
            rootsMemberText(category, value),
            PROJECT_CONFIG_FILE,
          );

          // Rejected (R4.1 biconditional, rejecting side).
          expect(outcome.kind).toBe("rejected");
          if (outcome.kind !== "rejected") return;

          // Exactly one diagnostic, and it is the [config:root-path] for THIS
          // member — nothing else about a single wrong root produces one
          // (R4.2). This also guards R4.10/R4.11 indirectly: a rejected member
          // yields no overlap or framework diagnostic.
          const rootPathDiags = outcome.diagnostics.filter(
            (d) => d.tag === "config:root-path",
          );
          expect(outcome.diagnostics).toHaveLength(1);
          expect(rootPathDiags).toHaveLength(1);

          const diag = rootPathDiags[0]!;
          // Names the key path.
          expect(diag.at).toBe(`roots.${category}`);
          // Reproduces the offending value exactly as declared, in the quoted
          // form the parser uses for an empty or whitespace-only value so the
          // `found` part stays non-empty (R2.13); see expectedFound above.
          expect(diag.found).toBe(expectedFound(value));
          // Names EVERY violated condition, not only the first (R4.2, R4.4).
          for (const violation of expected) {
            expect(diag.reason).toContain(violation);
          }
          // All four diagnostic parts are present and non-empty (R2.13).
          expect(diag.tag.length).toBeGreaterThan(0);
          expect(diag.at.length).toBeGreaterThan(0);
          expect(diag.found.length).toBeGreaterThan(0);
          expect(diag.reason.length).toBeGreaterThan(0);
        },
      ),
    );
  });
});

// Feature: config-driven-discovery, Property 7: Root overlap is diagnosed
// exactly when two roots are equal or nested.
//
// The overlap half of the `roots` biconditional (R4.5, R4.6, R14.9). Over three
// Discovery_Roots drawn from `overlapProneRootTriple()` — the deliberately
// narrow pool (`a`, `a/b`, `a/b/c`, `ab`, `b`, `packages/contracts`, `packages`)
// in which equality, nesting at a `/` boundary, and the near-miss `a` vs `ab`
// all occur among 100 runs — `parseProjectConfig` reports a
// `[config:root-overlap]` Config_Diagnostic for an unordered pair of
// Consumer_Categories IF AND ONLY IF that pair's two roots are equal code point
// for code point (R4.5) or one begins with the other followed by a single `/`
// (R4.6), with equality suppressing the nesting report and AT MOST ONE overlap
// diagnostic per unordered pair.
//
// The oracle below is an INDEPENDENT recomputation from the requirement text —
// code-point equality and single-`/`-boundary nesting over the root triple
// alone. It is written from R4.5/R4.6, not imported from the parser, so the
// property checks the parser against the spec rather than against itself.
//
// The pool includes `packages/contracts` (and `packages`, which contains it),
// which also trigger `[config:root-framework]` — Property 8's concern. This
// property therefore focuses every assertion on the `[config:root-overlap]`
// tag, and its oracle considers only root-vs-root relations, never framework
// relations. `packages` vs `packages/contracts` is itself a legitimate overlap
// pair when those two land on two categories, and the oracle catches it the
// same way it catches `a` vs `a/b`.
//
// Validates: Requirements 4.5, 4.6, 14.9

import { overlapProneRootTriple } from "./arbitraries/config.js";

/**
 * The unordered category pairs, each named in CONSUMER_CATEGORIES order
 * (microservice, common, spa), which is the order the parser uses for the `at`
 * part of a `[config:root-overlap]` diagnostic (R4.5, R4.6). The `at` string is
 * `"${a}, ${b}"`; `index` is each category's position in the RootTriple.
 */
const CATEGORY_PAIRS = [
  { a: "microservice", b: "common", ai: 0, bi: 1 },
  { a: "microservice", b: "spa", ai: 0, bi: 2 },
  { a: "common", b: "spa", ai: 1, bi: 2 },
] as const;

/**
 * The independent overlap oracle for one pair of roots, recomputed from R4.5
 * and R4.6 and nothing else. Two roots overlap when they are equal code point
 * for code point (R4.5) or one lies inside the other at a single-`/` boundary
 * (R4.6). Considers root-vs-root only — never a Framework_Singleton relation.
 */
function rootsOverlap(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  return pathB.startsWith(`${pathA}/`) || pathA.startsWith(`${pathB}/`);
}

describe("Property 7: root overlap is diagnosed exactly when two roots are equal or nested", () => {
  it("reports a [config:root-overlap] for an unordered category pair iff its two roots are equal or nested, at most one per pair", () => {
    fc.assert(
      fc.property(overlapProneRootTriple(), (triple) => {
        const [microservice, common, spa] = triple;
        const text = JSON.stringify({
          roots: { microservice, common, spa },
        });
        const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);

        // The parser rejects when ANY diagnostic is raised — this pool also
        // trips [config:root-framework]. Collect only the overlap tag; a run
        // with no overlap and no framework collision would be "parsed", which
        // carries no diagnostics and so an empty overlap set, matching an
        // oracle that predicts none.
        const overlapDiags =
          outcome.kind === "rejected"
            ? outcome.diagnostics.filter((d) => d.tag === "config:root-overlap")
            : [];

        for (const { a, b, ai, bi } of CATEGORY_PAIRS) {
          const at = `${a}, ${b}`;
          const forPair = overlapDiags.filter((d) => d.at === at);
          const expected = rootsOverlap(triple[ai], triple[bi]);

          // Biconditional: a diagnostic exists for this pair EXACTLY when the
          // oracle says the two roots overlap (R4.5, R4.6, R14.9).
          expect(forPair.length > 0).toBe(expected);

          // At most one [config:root-overlap] per unordered pair (R4.5, R4.6);
          // equality suppresses a second, nesting report.
          expect(forPair.length).toBeLessThanOrEqual(1);

          if (expected) {
            const diag = forPair[0]!;
            // The pair is named in CONSUMER_CATEGORIES order (R4.5, R4.6).
            expect(diag.at).toBe(at);
            // All four diagnostic parts present and non-empty (R2.13).
            expect(diag.tag).toBe("config:root-overlap");
            expect(diag.found.length).toBeGreaterThan(0);
            expect(diag.reason.length).toBeGreaterThan(0);
          }
        }
      }),
    );
  });
});

// Feature: config-driven-discovery, Property 8: A root colliding with a
// Framework_Singleton is rejected, defaults included.
//
// The framework-collision half of the `roots` biconditional (R4.7, R4.8). For
// each Consumer_Category whose Discovery_Root — declared and accepted, OR taken
// from its Root_Default (R4.8) — is equal to, lies inside, or contains one of
// the four Framework_Singleton package directories (`packages/contracts`,
// `packages/overseer`, `packages/build-tools`, `packages/integration-tests`),
// `parseProjectConfig` returns exactly one `[config:root-framework]`
// Config_Diagnostic PER offending (Consumer_Category, Framework_Singleton
// directory) pair — at most four per category (R4.7). The diagnostic names the
// Consumer_Category and the directory in its `at` part, reproduces the root
// path, and states which of the three relations holds.
//
// Two independent oracles are recomputed from the requirement text, never
// imported from the parser:
//   - `frameworkRelation(root, dir)` — the code-point, case-sensitive,
//     single-`/`-boundary comparison of R4.5/R4.6 that R4.7 reuses: equal
//     ("is equal to"), root inside dir ("lies inside"), or root contains dir
//     ("contains"), else none.
//   - the four Framework_Singleton directories, spelled as literals here.
// The property asserts the biconditional on the `[config:root-framework]` tag
// per (category, dir) pair, and one diagnostic per offending pair.
//
// R4.8 ("defaults included") has two observable faces, both exercised here:
//   (a) a category whose root is DECLARED to collide is rejected, across the
//       equal / inside / contains relations and all three categories;
//   (b) a category that took its Root_Default is subject to the SAME check —
//       and, because none of the three Root_Defaults (`packages/microservices`,
//       `packages/common`, `packages/spa`) collides with a Framework_Singleton
//       directory, a defaulted category contributes NO `[config:root-framework]`
//       diagnostic. The `{}` config and any defaulted category in a mixed input
//       both witness this: the check runs over the default and passes.
//
// The generator mixes framework-colliding values (`packages/contracts`,
// `packages/contracts/x`, `packages` which CONTAINS `packages/contracts`, the
// other three framework dirs and paths inside them) with safe non-colliding
// values and with `undefined` (the member is omitted, so the category takes its
// Root_Default), independently over the three categories. A category set to
// `undefined` declares no `roots` member, so its default is what the check sees.
//
// The `packages` value is deliberately in the pool: it contains every one of
// the four framework directories, so it must yield four `[config:root-framework]`
// diagnostics for its category — the "at most four per category" bound reached.
//
// Validates: Requirements 4.7, 4.8

/**
 * The four Framework_Singleton package directories, spelled as literals for the
 * independent oracle (mirroring FRAMEWORK_SINGLETONS order). Written here, not
 * imported from the parser, so the property checks the parser against the spec.
 */
const FRAMEWORK_DIRS = [
  "packages/contracts",
  "packages/overseer",
  "packages/build-tools",
  "packages/integration-tests",
] as const;

/** The Root_Defaults, mirrored here so a defaulted category's checked value is
 *  known to the oracle (R4.8). Kept in step with ROOT_DEFAULTS in the parser. */
const ROOT_DEFAULTS_ORACLE: Readonly<Record<Category, string>> = {
  microservice: "packages/microservices",
  common: "packages/common",
  spa: "packages/spa",
};

/**
 * The independent framework-relation oracle for one root against one
 * Framework_Singleton directory, recomputed from R4.7 (which reuses the
 * code-point, case-sensitive, single-`/`-boundary comparison of R4.5/R4.6).
 * Returns the relation phrase the diagnostic's `reason` must contain, or
 * `undefined` when the root and the directory are unrelated. Considers this one
 * (root, dir) pair only.
 */
function frameworkRelation(root: string, dir: string): string | undefined {
  if (root === dir) return "is equal to";
  if (root.startsWith(`${dir}/`)) return "lies inside"; // root inside dir
  if (dir.startsWith(`${root}/`)) return "contains"; // root contains dir
  return undefined;
}

/**
 * A `roots` member value that COLLIDES with a Framework_Singleton directory:
 * one of the four dirs itself (equal), a path strictly inside one (`.../x`,
 * lies inside), or `packages` (contains all four). Every value here is a
 * Valid_Root_Path, so nothing but the framework check can reject it.
 */
function collidingRootValue(): fc.Arbitrary<string> {
  return fc.constantFrom(
    "packages/contracts", // equal to a framework dir
    "packages/overseer",
    "packages/build-tools",
    "packages/integration-tests",
    "packages/contracts/x", // lies inside a framework dir
    "packages/overseer/app/main",
    "packages/build-tools/src",
    "packages/integration-tests/tests",
    "packages", // contains ALL four framework dirs
  );
}

/**
 * A `roots` member value that is a Valid_Root_Path and collides with NO
 * Framework_Singleton directory: it neither equals, lies inside, nor contains
 * any of the four. `packages/services` shares the `packages` prefix but is not
 * nested with any framework dir; the rest avoid `packages` entirely.
 */
function safeRootValue(): fc.Arbitrary<string> {
  return fc.constantFrom(
    "packages/services",
    "packages/microservices", // a Root_Default; deliberately safe
    "packages/common",
    "packages/spa",
    "apps/web",
    "modules/api",
    "src",
  );
}

/**
 * A single category's declared value: a colliding value, a safe value, or
 * `undefined` meaning the member is omitted so the category takes its
 * Root_Default (which the check still sees — R4.8).
 */
function memberValue(): fc.Arbitrary<string | undefined> {
  return fc.oneof(
    collidingRootValue(),
    safeRootValue(),
    fc.constant(undefined),
  );
}

/** The value each category's framework check actually compares against: the
 *  declared value when present, else that category's Root_Default (R4.8). */
function checkedValue(
  declared: string | undefined,
  category: Category,
): string {
  return declared ?? ROOT_DEFAULTS_ORACLE[category];
}

describe("Property 8: a root colliding with a Framework_Singleton is rejected, defaults included", () => {
  it("reports one [config:root-framework] per offending (category, framework-dir) pair, iff the checked root equals/inside/contains that dir, over declared and defaulted roots", () => {
    fc.assert(
      fc.property(
        memberValue(),
        memberValue(),
        memberValue(),
        (microservice, common, spa) => {
          const declared: Record<Category, string | undefined> = {
            microservice,
            common,
            spa,
          };

          // Build a text declaring only the members that are present; an
          // omitted member (undefined) makes its category take its Root_Default,
          // which R4.8 subjects to the same check.
          const rootsObject: Record<string, string> = {};
          for (const category of CATEGORIES) {
            const value = declared[category];
            if (value !== undefined) rootsObject[category] = value;
          }
          const text = JSON.stringify({ roots: rootsObject });

          const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);

          // Every generated value is a Valid_Root_Path and no two-root overlap
          // is asserted here, so the parser rejects EXACTLY when some framework
          // collision exists; otherwise it parses (carrying no diagnostics).
          const frameworkDiags =
            outcome.kind === "rejected"
              ? outcome.diagnostics.filter(
                  (d) => d.tag === "config:root-framework",
                )
              : [];

          // The biconditional, per (category, framework-dir) pair (R4.7, R4.8).
          for (const category of CATEGORIES) {
            const rootPath = checkedValue(declared[category], category);
            let offendingPairsForCategory = 0;

            for (const dir of FRAMEWORK_DIRS) {
              const at = `${category}, ${dir}`;
              const forPair = frameworkDiags.filter((d) => d.at === at);
              const relation = frameworkRelation(rootPath, dir);
              const expected = relation !== undefined;

              // Diagnostic exists for this pair EXACTLY when the oracle says the
              // root collides with this framework directory (R4.7).
              expect(forPair.length > 0).toBe(expected);
              // At most one per (category, dir) pair (R4.7).
              expect(forPair.length).toBeLessThanOrEqual(1);

              if (expected) {
                offendingPairsForCategory += 1;
                const diag = forPair[0]!;
                // `at` names the category and the framework directory.
                expect(diag.at).toBe(at);
                // `found` reproduces the checked root path — the DECLARED value
                // or the substituted Root_Default (R4.8), verbatim.
                expect(diag.found).toBe(rootPath);
                // `reason` states which of the three relations holds (R4.7).
                expect(diag.reason).toContain(relation);
                expect(diag.reason).toContain(dir);
                // All four diagnostic parts present and non-empty (R2.13).
                expect(diag.tag).toBe("config:root-framework");
                expect(diag.at.length).toBeGreaterThan(0);
                expect(diag.found.length).toBeGreaterThan(0);
                expect(diag.reason.length).toBeGreaterThan(0);
              }
            }

            // At most four [config:root-framework] per Consumer_Category (R4.7);
            // reached exactly when that category's root is `packages`, which
            // contains all four framework directories.
            expect(offendingPairsForCategory).toBeLessThanOrEqual(4);
            if (rootPath === "packages") {
              expect(offendingPairsForCategory).toBe(4);
            }
          }

          // Every framework diagnostic the parser produced was predicted: no
          // stray pair outside the (category, dir) grid the oracle covers.
          const predicted = new Set<string>();
          for (const category of CATEGORIES) {
            const rootPath = checkedValue(declared[category], category);
            for (const dir of FRAMEWORK_DIRS) {
              if (frameworkRelation(rootPath, dir) !== undefined) {
                predicted.add(`${category}, ${dir}`);
              }
            }
          }
          for (const diag of frameworkDiags) {
            expect(predicted.has(diag.at)).toBe(true);
          }
        },
      ),
    );
  });

  it("subjects a defaulted root to the framework check but reports NO [config:root-framework] for it, since no Root_Default collides (R4.8)", () => {
    // The `{}` config: every category takes its Root_Default. R4.8 says the
    // check still runs over each default; since none of the three defaults
    // collides with a Framework_Singleton directory, the result carries no
    // framework diagnostic. This is the "defaults included, and they pass" face.
    const outcome = parseProjectConfig("{}", PROJECT_CONFIG_FILE);
    expect(outcome.kind).toBe("parsed");

    // The oracle agrees no default collides — the same check the parser ran.
    for (const category of CATEGORIES) {
      const def = ROOT_DEFAULTS_ORACLE[category];
      for (const dir of FRAMEWORK_DIRS) {
        expect(frameworkRelation(def, dir)).toBeUndefined();
      }
    }
  });
});

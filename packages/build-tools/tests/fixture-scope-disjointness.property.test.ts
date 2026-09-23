// Feature: platform-fixtures, Property 8: Distinct Project_Fixture scopes yield disjoint declared-name sets
//
// Each Project_Fixture declares a Configured_Scope distinct from every other
// Project_Fixture's and distinct from this project's own (R3.5). That single
// discipline is what lets the Fixture_Projects_Root's ONE hoisted `node_modules`
// hold every member of every Project_Fixture without a name collision: a member
// package's declared name is composed as `<scope>/<directory-name>`, so two
// scenarios that use different scopes can never compose the same name — even
// when they contain member directories of the same name.
//
// This property pins exactly that (R16.9, and R16.11's "derive the subject from
// a generated configuration, not a literal"):
//
//   For any generated pair of DISTINCT Configured_Scopes, each a Valid_Scope and
//   each distinct from this project's own scope (`@microservices`), and for any
//   generated pair of member-directory-name sets — EQUAL sets included — the set
//   of declared package names composed for the first (scope, directories) and
//   the set composed for the second are DISJOINT.
//
// The claim's whole force is in the "equal sets included" clause: it is the
// case where two scenarios happen to name their members identically that a
// name-composition rule keyed only on the directory would collide on. The
// distinct scope prefix is what keeps the composed name sets apart regardless.
//
// The scope pair comes from this package's own `arbitraries/config.ts`
// (`distinctScopePair`, added for this property); the directory-name sets are
// generated here from a small mirror of the Consumer_Package directory-naming
// rule (lowercase kebab-ish segments). No path literal and no scope literal is
// written as the SUBJECT of the property — the subject is the generated
// (scope, directories) pair (R16.11); `@microservices` appears only inside the
// generator as the excluded project-own scope, which is the rule the property
// states, not a subject it ranges over.
//
// Validates: Requirements 3.5, 16.1, 16.9, 16.11

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { distinctScopePair } from "./arbitraries/config.js";

const NUM_RUNS = 200;

/**
 * A member package's declared directory name: lowercase kebab-case, mirroring
 * the Consumer_Package directory-naming rule (structure.md "Naming"). Generated
 * as 1-to-4 hyphen-joined segments of `[a-z0-9]`, which is the shape a real
 * fixture member directory takes.
 */
const DIR_SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

function memberDirectoryName(): fc.Arbitrary<string> {
  return fc
    .array(
      fc
        .array(fc.constantFrom(...DIR_SEGMENT_CHARS), {
          minLength: 1,
          maxLength: 6,
        })
        .map((chars) => chars.join("")),
      { minLength: 1, maxLength: 4 },
    )
    .map((segments) => segments.join("-"));
}

/**
 * A set of member directory names, 0 to 6 of them (a Project_Fixture may hold
 * several member packages, or — for a single-package scenario — one). Modelled
 * as a set because two members of one scenario never share a directory name.
 */
function memberDirectorySet(): fc.Arbitrary<readonly string[]> {
  return fc.uniqueArray(memberDirectoryName(), { minLength: 0, maxLength: 6 });
}

/** Compose the declared package names of a scenario: `<scope>/<dir>` for each
 *  member directory. This mirrors the sole naming rule (structure.md): a
 *  Consumer_Package's name is the Configured_Scope, `/`, and its directory name. */
function declaredNames(
  scope: string,
  directories: readonly string[],
): Set<string> {
  return new Set(directories.map((dir) => `${scope}/${dir}`));
}

// Feature: platform-fixtures, Property 8: Distinct Project_Fixture scopes yield disjoint declared-name sets
describe("Property 8: Distinct Project_Fixture scopes yield disjoint declared-name sets", () => {
  it("composes disjoint declared-name sets for any two distinct scopes, even when the member-directory-name sets are equal (R3.5, R16.9)", () => {
    fc.assert(
      fc.property(
        distinctScopePair(),
        memberDirectorySet(),
        memberDirectorySet(),
        (
          [scopeA, scopeB]: readonly [string, string],
          dirsA: readonly string[],
          dirsB: readonly string[],
        ) => {
          // Precondition sanity: the generator promises two distinct Valid_Scopes,
          // each distinct from this project's own. If that ever slips, the
          // disjointness claim below would be vacuous rather than meaningful.
          expect(scopeA).not.toBe(scopeB);

          const namesA = declaredNames(scopeA, dirsA);
          const namesB = declaredNames(scopeB, dirsB);

          // The two composed declared-name sets share no member: a distinct
          // scope prefix keeps them apart no matter how the directory names line
          // up. Assert intersection is empty in both directions.
          for (const name of namesA) {
            expect(namesB.has(name)).toBe(false);
          }
          for (const name of namesB) {
            expect(namesA.has(name)).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("stays disjoint in the hardest case: identical member-directory-name sets under distinct scopes (R16.9)", () => {
    fc.assert(
      fc.property(
        distinctScopePair(),
        memberDirectorySet(),
        (
          [scopeA, scopeB]: readonly [string, string],
          dirs: readonly string[],
        ) => {
          // Deliberately reuse ONE directory-name set for both scenarios — the
          // collision-prone case a directory-only naming rule would fail. The
          // scope prefix is the only thing keeping the composed names apart.
          const namesA = declaredNames(scopeA, dirs);
          const namesB = declaredNames(scopeB, dirs);

          const intersection = [...namesA].filter((name) => namesB.has(name));
          expect(intersection).toEqual([]);

          // And when the directory set is non-empty, the scope prefix really is
          // doing the work: the two name sets have equal size but no overlap.
          if (dirs.length > 0) {
            expect(namesA.size).toBe(namesB.size);
            expect(namesA.size).toBe(dirs.length);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

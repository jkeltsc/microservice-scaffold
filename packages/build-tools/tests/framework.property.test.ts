// Feature: package-categories, Property 27: An absent Framework_Singleton directory fails, naming it
//
// For any subset of the four Framework_Singleton directories present in the
// repository, `assertFrameworkDirectoriesPresent` succeeds exactly when all four
// are present, and otherwise fails naming every absent Framework_Singleton
// together with the directory the Framework_Constants_Module declares for it.
//
// The property is expressed over the injected existence predicate, which is the
// whole observable input of the check: the production caller passes `existsSync`
// and nothing else varies. Modelling "present" as an arbitrary subset of the
// four declared directories therefore covers the real input space exactly —
// including the all-present case (the only success) and the none-present case
// (all four named in one failure).
//
// Two things beyond the pass/fail verdict are pinned, because both are what
// makes the diagnostic actionable and neither follows from the verdict alone:
// every absent singleton appears in a SINGLE failure (not just the first), and
// no present singleton is named. Clause order is pinned to FRAMEWORK_SINGLETONS
// order so the message is run-stable.
//
// Validates: Requirements 10.7

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  FRAMEWORK_SINGLETONS,
  assertFrameworkDirectoriesPresent,
  type FrameworkSingleton,
} from "../src/framework.js";

/**
 * The clause the check is required to produce for one absent singleton: its
 * declared name and its declared package directory. Written out here from the
 * requirement rather than imported, so the test pins the message text instead of
 * re-deriving it from the code under test.
 */
function absenceClause(entry: FrameworkSingleton): string {
  return `Framework_Singleton "${entry.name}" declares directory "${entry.packageDir}", which is absent from the repository`;
}

/**
 * An arbitrary "present" subset of the four declared directories, expressed as
 * one boolean per singleton in FRAMEWORK_SINGLETONS order. Sixteen possible
 * shapes, so 200 runs cover every one many times over.
 */
const arbPresence = fc.tuple(...FRAMEWORK_SINGLETONS.map(() => fc.boolean()));

/**
 * Existence predicate over a set of present directories, recording every path it
 * is asked about so the test can also observe that the check consults nothing
 * beyond the declared directories.
 */
function existenceOver(present: ReadonlySet<string>): {
  readonly exists: (packageDir: string) => boolean;
  readonly queried: string[];
} {
  const queried: string[] = [];
  return {
    exists: (packageDir) => {
      queried.push(packageDir);
      return present.has(packageDir);
    },
    queried,
  };
}

describe("Property 27: absent Framework_Singleton directories", () => {
  it("succeeds exactly when all four declared directories are present", () => {
    fc.assert(
      fc.property(arbPresence, (flags) => {
        const absent = FRAMEWORK_SINGLETONS.filter((_, i) => !flags[i]);
        const present = new Set(
          FRAMEWORK_SINGLETONS.filter((_, i) => flags[i]).map(
            (entry) => entry.packageDir,
          ),
        );
        const { exists, queried } = existenceOver(present);

        if (absent.length === 0) {
          expect(() => assertFrameworkDirectoriesPresent(exists)).not.toThrow();
        } else {
          let thrown: unknown;
          try {
            assertFrameworkDirectoriesPresent(exists);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(Error);
          const message = (thrown as Error).message;

          expect(message.startsWith("[framework:missing] ")).toBe(true);

          // Every absent singleton is named, with its declared directory, in
          // this one failure.
          for (const entry of absent) {
            expect(message).toContain(absenceClause(entry));
          }

          // No present singleton is named: a spurious offender would send a
          // reader after a directory that is actually there.
          for (const entry of FRAMEWORK_SINGLETONS) {
            if (!absent.includes(entry)) {
              expect(message).not.toContain(entry.name);
              expect(message).not.toContain(entry.packageDir);
            }
          }

          // Clauses appear in FRAMEWORK_SINGLETONS order, so the message is
          // byte-stable across runs for a given absent set.
          const positions = absent.map((entry) =>
            message.indexOf(absenceClause(entry)),
          );
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
        }

        // Either way the check consults exactly the declared directories and
        // nothing else — no derived path, no probing of a parent directory.
        expect(new Set(queried)).toEqual(
          new Set(FRAMEWORK_SINGLETONS.map((entry) => entry.packageDir)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("names all four when every declared directory is absent", () => {
    const { exists } = existenceOver(new Set());
    expect(() => assertFrameworkDirectoriesPresent(exists)).toThrow(
      /^\[framework:missing\] /,
    );
    try {
      assertFrameworkDirectoriesPresent(exists);
    } catch (error) {
      const message = (error as Error).message;
      for (const entry of FRAMEWORK_SINGLETONS) {
        expect(message).toContain(absenceClause(entry));
      }
    }
  });

  it("succeeds against the real repository tree", () => {
    // The one run that ties the generated input space back to reality: the
    // predicate production actually passes, over the actual filesystem.
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    expect(() =>
      assertFrameworkDirectoriesPresent((packageDir) =>
        existsSync(join(repoRoot, packageDir)),
      ),
    ).not.toThrow();
  });
});

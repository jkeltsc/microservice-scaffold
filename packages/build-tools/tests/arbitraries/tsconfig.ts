// Shared fast-check arbitraries for the Tsconfig_Verifier property suite
// (Requirement 14.8, Property 15).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it.
//
// `resolvedTsconfig(projectDirectory, packageDir)` spans the assignment space of
// the four Load_Bearing_Settings that Requirement 9.1 judges, wrapped in a
// self-describing case so a property can compute the expected verdict without
// re-implementing the verifier:
//
//   - `composite` and `declaration`: each `true`, `false`, or unset.
//   - `outDir` and `rootDir`: each the package's own `dist`/`src` directory
//     (satisfying), a differently-spelled absolute path resolving to that same
//     directory (satisfying, R9.4), an absolute path resolving elsewhere
//     (violating), or unset (violating).
//
// The two whole-package resolution shapes — `absent` and `failed` — are drawn
// too, because Property 15 asserts the verifier emits exactly one violation and
// no per-setting violation for each (R9.7, R9.15).

import { resolve } from "node:path";

import * as fc from "fast-check";

import type {
  ResolvedTsconfig,
  TsconfigResolution,
} from "../../src/tsconfig-verifier.js";

/** How a generated path-valued setting was constructed, which fixes whether it
 *  satisfies the setting. */
export type PathVerdict = "satisfying" | "violating";

/** A generated boolean-valued setting: its value and whether it satisfies
 *  (`=== true`). */
export interface BooleanCase {
  readonly value: boolean | undefined;
  readonly satisfies: boolean;
}

/** A generated path-valued setting: its absolute value (or unset) and whether it
 *  satisfies the target directory. */
export interface PathCase {
  readonly value: string | undefined;
  readonly satisfies: boolean;
}

/** A generated `resolved` case: the ResolvedTsconfig the verifier judges, plus
 *  the four per-setting verdicts a property compares against. */
export interface ResolvedCase {
  readonly kind: "resolved";
  readonly resolution: TsconfigResolution;
  readonly satisfies: {
    readonly composite: boolean;
    readonly declaration: boolean;
    readonly outDir: boolean;
    readonly rootDir: boolean;
  };
}

/** A generated whole-package case: absent or failed, which yields exactly one
 *  whole-package violation and no per-setting violation. */
export interface WholePackageCase {
  readonly kind: "absent" | "failed";
  readonly resolution: TsconfigResolution;
}

/** One package's generated resolution outcome, self-describing. */
export type TsconfigCase = ResolvedCase | WholePackageCase;

/** A boolean setting: `true` (satisfies), `false`, or unset (both violate). */
function booleanCase(): fc.Arbitrary<BooleanCase> {
  return fc.constantFrom<BooleanCase>(
    { value: true, satisfies: true },
    { value: false, satisfies: false },
    { value: undefined, satisfies: false },
  );
}

/**
 * A path setting for the target directory (`dist` or `src`) directly inside the
 * package's own directory, expressed absolutely because the compiler hands back
 * absolute paths (R9.4).
 *
 * Four shapes: the plain resolved directory (satisfying), a differently-spelled
 * absolute path that resolves to the same directory via a parent segment
 * (satisfying), an absolute path resolving elsewhere (violating), and unset
 * (violating).
 */
function pathCase(
  projectDirectory: string,
  packageDir: string,
  dirName: "dist" | "src",
): fc.Arbitrary<PathCase> {
  const target = resolve(projectDirectory, packageDir, dirName);
  // A differently-spelled absolute path that resolves to the SAME directory:
  // dip into a sibling name and climb back out. `resolve` collapses `..`.
  const differentlySpelled = resolve(
    projectDirectory,
    packageDir,
    "elsewhere",
    "..",
    dirName,
  );
  const trailingSep = `${target}/`;
  // An absolute path resolving somewhere else entirely.
  const elsewhere = resolve(projectDirectory, packageDir, `${dirName}-other`);

  return fc.oneof(
    fc.constant<PathCase>({ value: target, satisfies: true }),
    fc.constant<PathCase>({ value: differentlySpelled, satisfies: true }),
    fc.constant<PathCase>({ value: trailingSep, satisfies: true }),
    fc.constant<PathCase>({ value: elsewhere, satisfies: false }),
    fc.constant<PathCase>({ value: undefined, satisfies: false }),
  );
}

/**
 * A full resolution outcome for one package: a `resolved` case spanning the
 * four-setting assignment space, or one of the `absent`/`failed` whole-package
 * shapes.
 *
 * @param projectDirectory the Project_Directory the verifier resolves against
 *   (`process.cwd()` at verify time).
 * @param packageDir the package's Project_Directory-relative directory.
 */
export function resolvedTsconfig(
  projectDirectory: string,
  packageDir: string,
): fc.Arbitrary<TsconfigCase> {
  const resolvedCase: fc.Arbitrary<ResolvedCase> = fc
    .record({
      composite: booleanCase(),
      declaration: booleanCase(),
      outDir: pathCase(projectDirectory, packageDir, "dist"),
      rootDir: pathCase(projectDirectory, packageDir, "src"),
    })
    .map(({ composite, declaration, outDir, rootDir }): ResolvedCase => {
      const resolved: ResolvedTsconfig = {
        composite: composite.value,
        declaration: declaration.value,
        outDir: outDir.value,
        rootDir: rootDir.value,
      };
      return {
        kind: "resolved",
        resolution: { kind: "resolved", resolved },
        satisfies: {
          composite: composite.satisfies,
          declaration: declaration.satisfies,
          outDir: outDir.satisfies,
          rootDir: rootDir.satisfies,
        },
      };
    });

  const absentCase: fc.Arbitrary<WholePackageCase> = fc.constant<WholePackageCase>(
    {
      kind: "absent",
      resolution: { kind: "absent", configPath: `${packageDir}/tsconfig.json` },
    },
  );

  const failedCase: fc.Arbitrary<WholePackageCase> = fc
    .constantFrom(
      "the file is not readable",
      "the file is not parseable",
      "the extends target could not be resolved",
    )
    .map(
      (reason): WholePackageCase => ({
        kind: "failed",
        resolution: {
          kind: "failed",
          configPath: `${packageDir}/tsconfig.json`,
          reason,
        },
      }),
    );

  return fc.oneof(resolvedCase, absentCase, failedCase);
}

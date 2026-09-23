// @microservices/build-tools/dist/testing — the Clone_Handle type
// (Fixture_Tier spec, task 3.2; R6.8, R7.2, R7.5).
//
// The shape `pristineWorktree()` already returns, reused deliberately so a
// suite branches on `available` identically whichever helper produced it — the
// installed-projects availability probe (task 3.2), the Fixture_Clone (task
// 3.3), or a future clone-style helper. Defined once here and re-exported from
// this package's `testing` barrel, so downstream helpers and suites share one
// type rather than each declaring its own.
//
// This module lives under `packages/build-tools/src/`, so R1.7 applies: it must
// spell no Fixture_Tier path literal. Being a pure type declaration it reads no
// path and names no directory, so it satisfies R1.7 trivially.

/**
 * The outcome of a Fixture_Clone or of the Installed_Fixture_Projects
 * availability probe: either a usable directory, or a human-readable skip
 * reason.
 *
 * A consumer MUST check `available` before using `dir` or `cleanup`.
 */
export type CloneHandle =
  | {
      readonly available: true;
      /**
       * Absolute path of the usable directory. For a Fixture_Clone this is a
       * copy inside an OS temp directory located OUTSIDE the Project_Directory
       * (R7.2); for the availability probe it is the Fixture_Projects_Root
       * itself.
       */
      readonly dir: string;
      /**
       * Removes the copy. Idempotent; safe to call from an unconditional
       * `afterAll`. For the availability probe (which copies nothing) this is a
       * no-op, so a suite may call it uniformly without special-casing.
       */
      cleanup(): void;
    }
  | {
      readonly available: false;
      /**
       * Human-readable reason the directory could not be produced, suitable for
       * an `it.skip(reason)` message: the step that failed for a Fixture_Clone
       * (R7.5), or the Fixture_Install script for the availability probe
       * (R6.6, R6.7).
       */
      readonly reason: string;
    };

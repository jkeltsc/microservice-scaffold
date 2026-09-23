// The single `fixtures/` path literal this package's test tree is allowed to
// spell. Every other suite in `packages/build-tools/tests/` that needs to name
// the Fixture_Tier imports FIXTURES_ROOT from here rather than composing the
// literal itself, so the tier's location is written in exactly one place per
// test package (design "Shared helpers, and why they hold no `fixtures`
// literal").
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it —
// matching the `arbitraries/` convention. It lives under `tests/`, NOT under
// `packages/build-tools/src/`, so the R1.7 prohibition (no `fixtures` literal in
// Build_System SOURCE) does not apply: R1.7 governs `src/`, and a test-tree
// constant is precisely where the one permitted literal belongs.
//
// FIXTURES_ROOT is the constant task 9.1 teaches the Worktree_Guard to treat as
// a Checked_Out_Anchor (R9.3): a mutating filesystem call whose destination is
// composed from this path is then classified rather than passing unexamined for
// want of a recognised anchor.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// This file sits at `packages/build-tools/tests/`, so three `..` segments reach
// the repository root: tests/ -> build-tools -> packages -> repo root. The
// Fixture_Tier root is that repository root joined with `fixtures`.
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * Absolute path of this project's Fixture_Tier root, the committed `fixtures/`
 * directory directly inside the Project_Directory. Derived relative to this
 * file's own location so it is correct regardless of the working directory a
 * suite runs from.
 */
export const FIXTURES_ROOT = resolve(repoRoot, "fixtures");

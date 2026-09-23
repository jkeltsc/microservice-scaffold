// The single `fixtures/` path literal this package's test tree is allowed to
// spell. Every other suite in `packages/integration-tests/tests/` that needs to
// name the Fixture_Tier imports these constants from here rather than composing
// the literal itself, so the tier's location is written in exactly one place per
// test package (design "Shared helpers, and why they hold no `fixtures`
// literal").
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it. It
// lives under `tests/`, NOT under any Build_System `src/`, so R1.7 (which
// forbids a `fixtures` literal in Build_System SOURCE) does not apply here.
//
// FIXTURES_ROOT and the two partition roots are the constants task 9.1 teaches
// the Worktree_Guard to treat as Checked_Out_Anchors (R9.3): a mutating
// filesystem call whose destination is composed from a fixture path is then
// classified rather than passing unexamined for want of a recognised anchor.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// This file sits at `packages/integration-tests/tests/`, so three `..` segments
// reach the repository root: tests/ -> integration-tests -> packages -> repo
// root. The Fixture_Tier root is that repository root joined with `fixtures`.
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * Absolute path of this project's Fixture_Tier root, the committed `fixtures/`
 * directory directly inside the Project_Directory. Derived relative to this
 * file's own location so it is correct regardless of the working directory a
 * suite runs from.
 */
export const FIXTURES_ROOT = resolve(repoRoot, "fixtures");

/**
 * The Tree_Fixtures partition root: `fixtures/trees/`, holding scenarios whose
 * hostility an npm clean install rejects, and which are therefore never
 * installed and never built.
 */
export const FIXTURE_TREES_ROOT = resolve(FIXTURES_ROOT, "trees");

/**
 * The Project_Fixtures partition root — the Fixture_Projects_Root at
 * `fixtures/projects/`, an npm workspace root installed once through the
 * `fixtures:install` script, holding scenarios whose hostility npm does not care
 * about.
 */
export const FIXTURE_PROJECTS_ROOT = resolve(FIXTURES_ROOT, "projects");

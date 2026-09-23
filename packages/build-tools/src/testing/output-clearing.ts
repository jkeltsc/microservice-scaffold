// @microservices/build-tools/dist/testing — the Output_Clearing helper
// (Fixture_Tier spec, task 3.4; R8.1–R8.5).
//
// One shared removal walk: strip every Generated_Fixture_Output — every `dist/`
// directory and every `*.tsbuildinfo` file — from under a fixture directory
// before a build is run against it, so partial output a failed build left
// behind cannot make a later run pass for the wrong reason. `composite: true`
// makes `tsc` trust a `*.tsbuildinfo` over the (absent) `dist/` it names, so a
// build after a failed build can SKIP emitting entirely; removing both first is
// what makes "a build after a failed build" report what "a never-built
// directory" reports (R8.6).
//
// PATH PARAMETERISATION, and why the signature carries a second argument the
// design's prose does not. This module lives under `packages/build-tools/src/`,
// so R1.7 applies: it must spell no Fixture_Tier path literal and read no path
// under the tier of its own accord. The design writes the helper as
// `clearOutput(directory)`, but its refusal rule (R8.5) has to know where the
// Fixture_Tier root is to decide whether `directory` lies inside it — and that
// root is the one token this source may not spell. So, exactly as the sibling
// `fixtureClone(sourceDir)` and `installedFixtureProjects(projectsRoot)` do,
// this helper is wholly path-parameterised: the caller (a suite under
// `packages/*/tests/`) supplies the absolute Fixture_Tier root from that
// package's single permitted tier literal in its own `fixture-paths.ts`
// (`FIXTURES_ROOT`, task 3.1). This module knows only "a directory to clear"
// and "the root it must lie within", never where the tier is.

import type { Dirent } from "node:fs";
import { readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** The suffix marking a Generated_Fixture_Output buildinfo file. */
const BUILDINFO_SUFFIX = ".tsbuildinfo";
/** The directory name whose whole subtree is Generated_Fixture_Output. */
const OUTPUT_DIR_NAME = "dist";
/** The directory that must never be descended into or removed (R8.4). */
const DEPENDENCY_DIR_NAME = "node_modules";

/**
 * Remove every Generated_Fixture_Output under `directory` — every subdirectory
 * named exactly `dist` (with its whole subtree) and every `*.tsbuildinfo` file
 * — idempotently, removing nothing else.
 *
 * `directory` is the ABSOLUTE path to clear. `fixtureTierRoot` is the absolute
 * Fixture_Tier root, supplied by the calling suite (this module holds no tier
 * path literal, R1.7); it is used only by the refusal check below.
 *
 * Contract (R8.2–R8.5):
 *
 *   * Idempotent (R8.3): two applications leave `directory` in the state one
 *     leaves it in, and an application over a directory holding no
 *     Generated_Fixture_Output succeeds and removes nothing. So a suite may call
 *     it unconditionally in a `beforeEach`.
 *   * Its removal set is exactly the Generated_Fixture_Output (R8.4): it removes
 *     no file that is neither a `*.tsbuildinfo` nor inside a `dist/`, and — the
 *     expensive mistake, stated separately — it never descends into or removes a
 *     `node_modules/` directory or anything inside one, so clearing output can
 *     never force a reinstall.
 *   * It refuses a path that is neither inside `fixtureTierRoot` nor inside an
 *     OS temp directory (R8.5): it makes NO removal and throws reporting the
 *     rejected path, so a mistyped relative path resolving into `packages/`
 *     cannot silently delete the platform's own build output.
 */
export function clearOutput(directory: string, fixtureTierRoot: string): void {
  // The guard runs first and removes nothing on rejection (R8.5): a path outside
  // both the Fixture_Tier and the OS temp area is refused before any walk.
  assertClearable(directory, fixtureTierRoot);
  clearUnder(resolve(directory));
}

/**
 * Recursively remove Generated_Fixture_Output under `dir` without descending
 * into a `node_modules/` (R8.4). A `dist/` directory is removed whole; a
 * `*.tsbuildinfo` file is removed; every other directory is recursed into;
 * every other file is left untouched.
 */
function clearUnder(dir: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that is not there is a no-op — this is what makes clearing a
    // never-built (or already-cleared) directory succeed and remove nothing
    // (R8.3).
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Never touch a `node_modules/` — not its contents, not the directory
      // itself (R8.4). Clearing output must never force a reinstall.
      if (entry.name === DEPENDENCY_DIR_NAME) continue;

      // A `dist/` is Generated_Fixture_Output in whole; remove its subtree and
      // do not recurse (a `node_modules/` nested inside a `dist/` is not a real
      // dependency tree, and a `dist/` is output regardless of what it holds).
      if (entry.name === OUTPUT_DIR_NAME) {
        rmSync(full, { recursive: true, force: true });
        continue;
      }

      // Any other directory may itself contain a `dist/` or a `*.tsbuildinfo`
      // (a package's own subtree, a nested fixture) — recurse.
      clearUnder(full);
      continue;
    }

    // A `*.tsbuildinfo` file anywhere is Generated_Fixture_Output; every other
    // regular file (and every symlink) is left exactly as it is (R8.4).
    if (entry.isFile() && entry.name.endsWith(BUILDINFO_SUFFIX)) {
      rmSync(full, { force: true });
    }
  }
}

/**
 * Refuse a `directory` that is neither inside `fixtureTierRoot` nor inside an OS
 * temp directory (R8.5), throwing with the rejected path named and removing
 * nothing.
 *
 * Both the raw and the real path of every side are compared, because
 * `os.tmpdir()` is itself a symlink on macOS — the same pattern the
 * Synthesized_Tree materialiser's `assertInsideTempDirectory` uses — and here
 * the Fixture_Tier root is an additional permitted enclosing subtree.
 */
function assertClearable(directory: string, fixtureTierRoot: string): void {
  const roots = new Set<string>([resolve(tmpdir()), resolve(fixtureTierRoot)]);
  addRealPath(roots, tmpdir());
  addRealPath(roots, fixtureTierRoot);

  const candidates = new Set<string>([resolve(directory)]);
  addRealPath(candidates, directory);

  for (const candidate of candidates) {
    for (const root of roots) {
      if (candidate === root || candidate.startsWith(`${root}${sep}`)) return;
    }
  }

  throw new Error(
    `refusing Output_Clearing on a path neither inside the Fixture_Tier nor inside the OS temporary directory: "${resolve(directory)}"`,
  );
}

/** Add the resolved real path of `path` to `set`, tolerating a path that is not
 *  yet present (its resolved logical path still participates in the check). */
function addRealPath(set: Set<string>, path: string): void {
  try {
    set.add(resolve(realpathSync(path)));
  } catch {
    // Not present, or unreadable: the already-added resolved logical path guards.
  }
}

// @microservices/build-tools/dist/testing — the shared Platform_Test_Set
// derivation (platform-tier spec, task 8.1; R12.5, R13.2).
//
// ONE MODULE, TWO CONSUMERS
// ---------------------------------------------------------------------------
// Two guards need "every tracked test source the platform owns": the
// Classification_Guard (`platform-test-classification.test.ts`, task 8.3) checks
// the Classification_Record against it, and the Worktree_Guard
// (`worktree-safety-guard.test.ts`, task 9.1) scans it for unsafe writes. The
// set of files that must be classified and the set that must be scanned are the
// same set; two derivations meant to agree would eventually not, so the
// derivation lives here once and both consumers import it by compiled path from
// `@microservices/build-tools/dist/testing/index.js`. Both consumers live in
// `packages/integration-tests`, but the design's cross-package rule sends a
// shared derivation through `src/testing/`, so it lives here rather than in one
// of those packages' private `tests/`.
//
// THE DERIVATION (design "Deriving the Platform_Test_Set from the filesystem")
// ---------------------------------------------------------------------------
//   1. List tracked files — `git ls-files` — so an untracked scratch test in a
//      developer's tree is neither swept in nor able to fail a guard.
//   2. Keep those whose name ends `.test.ts`, `.property.test.ts`, or
//      `.test-d.ts`.
//   3. Keep those under a Framework_Singleton's directory OR under the
//      Entry_Root. BOTH come from THREADED CONFIGURATION — the singleton
//      directories from the Build_System's single list (`FRAMEWORK_DIRECTORIES`
//      in `framework.ts`, never the four names spelled here), the Entry_Root
//      from a `ProjectContext` (`context.entryRoot`). So this derivation spells
//      no path literal for these and follows a relocated Entry_Root (R13.2).
//   4. Add each tracked NON-test module in the SAME directory that such a kept
//      test file imports by RELATIVE path. Today that yields exactly one member,
//      `packages/integration-tests/tests/helpers.ts`; the RULE is encoded, not
//      the file, so a second shared harness joins the set by existing.
//
// Step 3 is why R12.4 holds by construction: a Payload_Owned_Test lies under a
// Consumer_Package's own directory, which is under a Discovery_Root, which is
// neither a Framework_Singleton directory nor the Entry_Root — so it is never
// derived and never classifiable.
//
// PATH PARAMETERISATION, and R1.7. This module lives under
// `packages/build-tools/src/`, so it spells no Fixture_Tier path literal (it has
// no use for one — the derivation is about test sources, not fixture scenarios)
// and takes the repository root and the `ProjectContext` as arguments rather
// than composing them from a path literal of its own. The effect shell
// defaults the repository root to `git rev-parse --show-toplevel` and the
// context to `projectContext(defaultEffectiveConfig())` so a consumer taking
// this project's defaults calls it with no arguments.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { FRAMEWORK_DIRECTORIES } from "../framework.js";
import { defaultEffectiveConfig } from "../project-config.js";
import { projectContext, type ProjectContext } from "../project-context.js";

/** The three test-source suffixes the set keeps (design step 2). `.test-d.ts`
 *  is a suffix of neither of the other two, and `.property.test.ts` is a suffix
 *  of `.test.ts`; all three are named because the requirement names all three. */
const TEST_SUFFIXES: readonly string[] = [
  ".test.ts",
  ".property.test.ts",
  ".test-d.ts",
];

/** True when `path`'s file name marks it a platform test source (step 2). */
export function isPlatformTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * True when the repo-relative POSIX `path` lies at or under `directory` — a
 * true directory-containment test, so `packages/contracts` contains
 * `packages/contracts/tests/x.test.ts` but not `packages/contracts-extra/...`.
 */
function isUnder(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/**
 * The set of prefixes step 3 keeps a test file under: every Framework_Singleton's
 * package directory (from the Build_System's single list) and the Entry_Root
 * (from the threaded context). Spelled as no path literal of this module's own.
 */
export function platformTestRoots(
  context: ProjectContext,
): readonly string[] {
  return [
    ...FRAMEWORK_DIRECTORIES.map((entry) => entry.packageDir),
    context.entryRoot,
  ];
}

/**
 * Parse the relative-specifier imports of a TypeScript source: every static
 * `import … from "<spec>"` / `export … from "<spec>"` and every dynamic
 * `import("<spec>")` whose specifier is relative (begins with `.`). Returns the
 * specifiers verbatim; resolution to a sibling path is the caller's job.
 *
 * A deliberately small scanner over the raw text: it matches the `from "…"` and
 * `import("…")` forms with both quote styles. It over-matches a specifier inside
 * a comment or string harmlessly — step 4 only adds a specifier that resolves to
 * a tracked non-test file that is really there, so a spurious specifier that
 * resolves to nothing is dropped.
 */
export function relativeImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const fromForm = /\bfrom\s*["']([^"']+)["']/g;
  const dynamicForm = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [fromForm, dynamicForm]) {
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.startsWith(".")) {
        specifiers.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

/**
 * Resolve a relative import specifier written by the test file at
 * `fromPath` (a repo-relative POSIX path) to the repo-relative POSIX path of the
 * TypeScript module it names, mapping a `.js` specifier back to its `.ts` source
 * (TS emits `.js` specifiers for `.ts` sources under NodeNext) and appending
 * `.ts` to an extensionless specifier. Returns `undefined` for a specifier that
 * escapes into a parent directory of `fromPath`'s directory (`../…`), because
 * step 4 adds only siblings in the SAME directory.
 */
export function resolveSiblingModule(
  fromPath: string,
  specifier: string,
): string | undefined {
  const fromDir = posix.dirname(fromPath);
  const resolved = posix.normalize(posix.join(fromDir, specifier));
  // Step 4 adds only a module in the SAME directory as the importing test file.
  if (posix.dirname(resolved) !== fromDir) return undefined;
  if (resolved.endsWith(".ts")) return resolved;
  if (resolved.endsWith(".js")) return `${resolved.slice(0, -3)}.ts`;
  return `${resolved}.ts`;
}

/** The reader step 4 needs: the text of a tracked repo-relative source. */
export type SourceReader = (repoRelativePath: string) => string;

/**
 * The pure core (R14.5-friendly, testable with no filesystem): given the full
 * tracked-file list, the derivation roots, and a reader for a kept test file's
 * text, compute the Platform_Test_Set as repo-relative POSIX paths, sorted by
 * ascending code-point comparison.
 *
 * @param trackedFiles every tracked repo-relative POSIX path (`git ls-files`).
 * @param roots the prefixes step 3 keeps under — {@link platformTestRoots}.
 * @param readSource reads a kept test file's text, for step 4's import scan.
 */
export function platformTestSetCore(
  trackedFiles: readonly string[],
  roots: readonly string[],
  readSource: SourceReader,
): readonly string[] {
  const tracked = new Set(trackedFiles);
  const members = new Set<string>();

  for (const path of trackedFiles) {
    // Steps 2 and 3: a test-suffixed file under a Framework_Singleton directory
    // or under the Entry_Root.
    if (!isPlatformTestFile(path)) continue;
    if (!roots.some((root) => isUnder(path, root))) continue;
    members.add(path);

    // Step 4: add each tracked NON-test sibling this test imports by relative
    // path. The RULE, not the `helpers.ts` literal.
    for (const specifier of relativeImportSpecifiers(readSource(path))) {
      const sibling = resolveSiblingModule(path, specifier);
      if (sibling === undefined) continue;
      if (!tracked.has(sibling)) continue;
      if (isPlatformTestFile(sibling)) continue; // a sibling test is its own member
      members.add(sibling);
    }
  }

  return [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Lists tracked repo-relative POSIX paths via `git ls-files`, run at `repoRoot`. */
function gitTrackedFiles(repoRoot: string): readonly string[] {
  const result = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    throw new Error(
      `platformTestSet: \`git ls-files\` failed at "${repoRoot}": ${
        result.error?.message ?? `exit status ${result.status}`
      }`,
    );
  }
  // `git ls-files` already emits repo-relative POSIX paths, one per line.
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

/** Resolves the repository root via `git rev-parse --show-toplevel`. */
function gitRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    throw new Error(
      `platformTestSet: \`git rev-parse --show-toplevel\` failed: ${
        result.error?.message ?? `exit status ${result.status}`
      }`,
    );
  }
  return result.stdout.trim();
}

/** Options for the {@link platformTestSet} effect shell; every field defaults. */
export interface PlatformTestSetOptions {
  /** The repository root `git ls-files` runs at. Defaults to
   *  `git rev-parse --show-toplevel`. */
  readonly repoRoot?: string;
  /** The threaded per-run context supplying the Entry_Root and, through
   *  `FRAMEWORK_DIRECTORIES`, the singleton directories. Defaults to
   *  `projectContext(defaultEffectiveConfig())` — this project's defaults. */
  readonly context?: ProjectContext;
}

/**
 * The effect shell: derive the Platform_Test_Set over the real filesystem,
 * returning repo-relative POSIX paths sorted by ascending code-point comparison.
 *
 * Runs `git ls-files`, reads each kept test file's text for step 4's import
 * scan, and delegates the whole computation to {@link platformTestSetCore}. With
 * no options it operates over this repository at its default configuration; a
 * consumer with a relocated Entry_Root threads a different `context`.
 */
export function platformTestSet(
  options: PlatformTestSetOptions = {},
): readonly string[] {
  const repoRoot = options.repoRoot ?? gitRepoRoot();
  const context = options.context ?? projectContext(defaultEffectiveConfig());
  const trackedFiles = gitTrackedFiles(repoRoot);
  const readSource: SourceReader = (repoRelativePath) =>
    readFileSync(joinRepo(repoRoot, repoRelativePath), "utf8");
  return platformTestSetCore(trackedFiles, platformTestRoots(context), readSource);
}

/** Joins a repo-relative POSIX path onto the (possibly OS-native) repo root. */
function joinRepo(repoRoot: string, repoRelativePath: string): string {
  // `dirname`/`join` here would inject the OS separator on Windows; a test file's
  // path uses `/`, and Node accepts `/` on every platform, so a simple join keeps
  // the read correct without normalising away the POSIX shape used everywhere else.
  const base = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${base}/${repoRelativePath}`;
}

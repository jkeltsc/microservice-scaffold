// This module runs three static checks over the repository and reports what they
// find. It builds nothing and stages nothing.
//
// It is the CI path, reached through the `check-repo-invariants` bin
// (bin/check-repo-invariants.ts) and the root `check:invariants` script. It runs
// its own package discovery (discovery.ts) and then checks:
//
//   1. workspace coverage — every workspace package is matched by exactly one
//      `workspaces` entry of the root package.json;
//   2. import discipline — no source file crosses a package boundary illegally;
//   3. dependency direction — a Common_Package points downward only.
//
// Sections 1 to 3 are those checks, each a pure function returning its violation
// messages rather than throwing, so one run reports every problem at once. Section
// 4 reads the real repository and feeds them; section 5 is the CLI the bin calls.
// Framework and category directory names all come from framework.ts (R10.5).
//
// (Requirements R8.9, R12.15–R12.20, R14.4, R14.5, R14.10, R14.13, R14.14.)

import { readFileSync, readdirSync, statSync } from "node:fs";

import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_SINGLETONS,
  OVERSEER,
  type ConsumerCategory,
} from "./framework.js";
import {
  discoverPackages,
  readDependencySpecifiers,
  type BuildKind,
  type Discovery,
} from "./discovery.js";

/** Message prefixes, one per invariant, matching the design's error catalog. */
const COVERAGE = "[workspaces:coverage]";
const ESCAPE = "[imports:escape]";
const PEER = "[imports:peer]";
const SPA = "[imports:spa]";
const DIRECTION = "[deps:direction]";

// --- 1. Workspace coverage (R12.15–R12.20) ---
//
// Exactly one `workspaces` entry must match each workspace package, which is all
// npm needs in order to discover it. Deliberately out of scope:
//   - entry order, which carries no meaning (R12.16); workspace-build-order.ts
//     derives the build order from declared dependencies instead;
//   - dependency edges between two packages one entry matches (R12.19);
//   - a glob matching zero directories, which is no violation (R12.20) — that is
//     what lets `packages/spa/*` coexist with an empty `packages/spa/`.

/** One `workspaces` entry and the package directories it matches. */
export interface WorkspaceEntry {
  /** The entry as the root package.json declares it, e.g. `packages/common/*`. */
  readonly pattern: string;
  readonly index: number;
  /** The directories it matches; {@link resolveWorkspaceEntries} resolves them. */
  readonly matches: readonly string[];
}

/**
 * One workspace package the coverage check reasons about. The caller supplies one
 * per workspace package, framework packages included (R12.15). Only `packageDir`
 * and `name` are read; the effect shell fills the rest in uniformly.
 */
export interface WorkspacePackage {
  readonly packageDir: string;
  readonly name: string;
  readonly dependencySpecifiers: readonly string[];
}

/** The suffix that makes a `workspaces` entry a glob over a category directory. */
const GLOB_SUFFIX = "/*";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders packages by `packageDir`, so message order never follows input order. */
function sortedByDir(
  packages: readonly WorkspacePackage[],
): WorkspacePackage[] {
  return [...packages].sort((a, b) =>
    compareStrings(a.packageDir, b.packageDir),
  );
}

function describe(entry: WorkspaceEntry): string {
  return `"${entry.pattern}" (index ${String(entry.index)})`;
}

function matchingEntries(
  entries: readonly WorkspaceEntry[],
  packageDir: string,
): WorkspaceEntry[] {
  return entries
    .filter((entry) => entry.matches.includes(packageDir))
    .sort((a, b) => a.index - b.index);
}

/**
 * Checks that every workspace package is matched by exactly one `workspaces`
 * entry (R12.15). First of the three checks.
 *
 * Zero matches is a violation, since npm never discovers such a package. Two or
 * more is one too, since the declaration is ambiguous, and the message then names
 * every matching entry with its index (R12.18). Packages are visited in
 * `packageDir` order, so the message list is reproducible.
 */
export function checkWorkspaceCoverage(
  entries: readonly WorkspaceEntry[],
  packages: readonly WorkspacePackage[],
): readonly string[] {
  const messages: string[] = [];

  for (const pkg of sortedByDir(packages)) {
    const matching = matchingEntries(entries, pkg.packageDir);
    if (matching.length === 1) {
      continue;
    }
    const detail =
      matching.length === 0
        ? "no workspaces entry"
        : `${String(matching.length)} workspaces entries: ${matching.map(describe).join(", ")}`;
    messages.push(
      `${COVERAGE} package "${pkg.name}" at "${pkg.packageDir}" is matched by ${detail}; exactly one entry must match it`,
    );
  }

  return messages;
}

// --- 2. Import discipline (R14.4, R14.5, R14.10) ---

/**
 * One package a source file can be attributed to. A `category` of `undefined`
 * marks one of the scaffold's own: never a microservice, so the peer rules skip it,
 * but always compiled by `tsc`, so the SPA-import rule applies.
 */
interface OwningPackage {
  readonly packageDir: string;
  readonly category: ConsumerCategory | undefined;
  readonly buildKind: BuildKind;
}

/**
 * Lists every package a walked file may belong to, longest directory first.
 *
 * {@link owningPackage} scans it top down, so the ordering lands a file in the
 * innermost package containing it — which matters when one package sits inside
 * another's private content. Both tiers share the list; the SPA rule spans both.
 */
function packagesByDepth(discovery: Discovery): OwningPackage[] {
  const consumers: OwningPackage[] = CONSUMER_CATEGORIES.flatMap((category) =>
    discovery.byCategory[category].map((pkg) => ({
      packageDir: pkg.packageDir,
      category: pkg.category,
      buildKind: pkg.buildKind,
    })),
  );
  const frameworks: OwningPackage[] = FRAMEWORK_SINGLETONS.map((singleton) => ({
    packageDir: singleton.packageDir,
    category: undefined,
    buildKind: "tsc-project",
  }));
  return [...consumers, ...frameworks].sort(
    (a, b) =>
      b.packageDir.length - a.packageDir.length ||
      compareStrings(a.packageDir, b.packageDir),
  );
}

function withinPackage(packageDir: string, path: string): boolean {
  return path === packageDir || path.startsWith(`${packageDir}/`);
}

/**
 * Finds the package a repo-relative file belongs to, or `undefined` for a file
 * outside every known package. The caller then skips it, since every rule is
 * stated relative to an owning package.
 */
function owningPackage(
  packages: readonly OwningPackage[],
  file: string,
): OwningPackage | undefined {
  return packages.find((pkg) => file.startsWith(`${pkg.packageDir}/`));
}

/** Takes the directory part of a repo-relative POSIX path; `""` at the root. */
function directoryOf(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut === -1 ? "" : file.slice(0, cut);
}

function isRelative(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/**
 * Resolves a relative specifier against the importing file's directory. Path
 * arithmetic only — no filesystem, no extension guessing — since all that matters is
 * which directory the target lands in. `undefined` means it walked above the
 * repository root, which escapes any package.
 */
function resolveRelative(
  fromDir: string,
  specifier: string,
): string | undefined {
  const segments = fromDir === "" ? [] : fromDir.split("/");
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Takes the package-name part of a specifier: the first two segments when scoped,
 * the first segment otherwise. This is what makes a subpath import of a peer
 * (`@microservices/microservice1/dist/thing.js`) resolve to that peer rather than
 * to nothing, since a peer is forbidden by any specifier at all (R14.5).
 */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") && segments.length > 1
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

/**
 * Blanks out everything in a source file that is not real code, so
 * {@link importSpecifiers} cannot mistake it for an import. A line comment becomes
 * a newline and a block comment a space, so neighbouring tokens neither merge nor
 * shift onto one line.
 *
 * `'` and `"` string bodies are kept verbatim, because a specifier IS such a
 * literal: every form {@link SPECIFIER_PATTERNS} scans for quotes it that way. A
 * backtick-quoted template body is blanked instead. No import form accepts a
 * backtick-quoted specifier, so blanking one can never drop a real specifier — and
 * a test fixture embedding a whole `import ... from "..."` statement in a template
 * literal would otherwise be scanned as a real import.
 *
 * This is a scanner, not a parser: a quote inside a regular expression literal
 * reads as opening a string. That costs a missed specifier, never a false report.
 */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i += 1;
      }
      i += 2;
      out += " ";
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const isTemplate = char === "`";
      out += char;
      i += 1;
      while (i < source.length) {
        const inner = source[i];
        if (inner === "\\") {
          out += isTemplate ? "  " : source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (inner === char) {
          out += inner;
          i += 1;
          break;
        }
        out += isTemplate && inner !== "\n" ? " " : inner;
        i += 1;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * The import forms a specifier can appear in: an `import`/`export … from` clause,
 * a side-effect import, and a dynamic import call. CommonJS `require` is
 * deliberately absent — this repository is ES modules only, enforced by ESLint.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

/**
 * Collects every import specifier a source declares, in order of appearance.
 * Repeats are dropped, so a specifier imported twice yields one message.
 */
function importSpecifiers(source: string): string[] {
  const code = withoutComments(source);
  const found: { at: number; specifier: string }[] = [];

  for (const pattern of SPECIFIER_PATTERNS) {
    // Fresh RegExp per scan: the shared patterns are `g`-flagged, so a
    // carried-over `lastIndex` would skip matches.
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match = scanner.exec(code);
    while (match !== null) {
      found.push({ at: match.index, specifier: match[2] });
      match = scanner.exec(code);
    }
  }

  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((entry) => entry.specifier))];
}

/**
 * Judges one specifier in one file, returning `undefined` when it is legal.
 *
 * A relative specifier is legal only while it stays inside the importing package's
 * own directory (R14.4). Reaching another package through `../` breaks that
 * package's independence: it compiles from the workspace root, then fails inside an
 * image, where packages ship as siblings under `node_modules/@microservices/`. A
 * by-name specifier is illegal in two cases: a microservice naming a peer or the
 * Overseer (R14.5), and anything compiled by `tsc` naming a SPA (R14.13, R14.14).
 */
function importViolation(
  discovery: Discovery,
  owner: OwningPackage,
  file: string,
  specifier: string,
): string | undefined {
  if (isRelative(specifier)) {
    const resolved = resolveRelative(directoryOf(file), specifier);
    if (resolved !== undefined && withinPackage(owner.packageDir, resolved)) {
      return undefined;
    }
    return `${ESCAPE} "${file}" imports "${specifier}", a relative path that escapes the package directory`;
  }

  const target = packageNameOf(specifier);

  if (owner.category === "microservice") {
    if (target === OVERSEER.name) {
      return `${PEER} "${file}" imports "${specifier}", the Overseer`;
    }

    const resolved = discovery.byName.get(target);
    if (
      resolved !== undefined &&
      resolved.category === "microservice" &&
      resolved.packageDir !== owner.packageDir
    ) {
      return `${PEER} "${file}" imports "${specifier}", a peer Microservice_Package`;
    }
  }

  if (owner.buildKind === "tsc-project") {
    const resolved = discovery.byName.get(target);
    if (resolved !== undefined && resolved.category === "spa") {
      return `${SPA} "${file}" imports "${specifier}", a Spa_Package; a Spa_Package exposes no importable API`;
    }
  }

  return undefined;
}

/**
 * Checks that no source file imports across a package boundary illegally. Second
 * of the three checks, applying four rules, each yielding one message per
 * offending specifier:
 *
 *   1. no relative specifier escaping its own package directory (R14.4);
 *   2. no microservice naming a peer microservice (R14.5);
 *   3. no microservice naming the Overseer (R14.5);
 *   4. nothing compiled by `tsc` naming a SPA (R14.13, R14.14).
 *
 * Rule 4 exists because a SPA exposes no importable API (R4.2); it is vacuous on the
 * shipped tree, where `packages/spa/` is empty. A specifier passed to
 * `import.meta.resolve` is deliberately not reported, which keeps the staging-only
 * `microservice -> spa` dependency expressible (R9.9, R9.10).
 *
 * The file list and reader are injected; section 4 supplies the real walk. Files are
 * visited in sorted order, one owned by no known package is skipped, and `src/` and
 * test sources are treated alike (R14.4).
 */
export function checkImportDiscipline(
  discovery: Discovery,
  files: readonly string[],
  readSource: (file: string) => string,
): readonly string[] {
  const packages = packagesByDepth(discovery);
  const messages: string[] = [];

  for (const file of [...files].sort(compareStrings)) {
    const owner = owningPackage(packages, file);
    if (owner === undefined) {
      continue;
    }
    for (const specifier of importSpecifiers(readSource(file))) {
      const violation = importViolation(discovery, owner, file, specifier);
      if (violation !== undefined) {
        messages.push(violation);
      }
    }
  }

  return messages;
}

// --- 3. Dependency direction (R8.9) ---

/**
 * Tells whether a dependency specifier points upward, at a microservice or at the
 * Overseer. Resolution goes through discovery's name index, so what counts is the
 * name a package declares, not its directory.
 *
 * A specifier resolving to nothing is third-party or one of the scaffold's own, both
 * allowed. A `common -> spa` specifier is not reported here either: R8.9 prohibits
 * exactly this pair, and required-dependencies.ts covers the SPA case.
 */
function pointsUpward(discovery: Discovery, specifier: string): boolean {
  return (
    specifier === OVERSEER.name ||
    discovery.byName.get(specifier)?.category === "microservice"
  );
}

/**
 * Checks that every Common_Package points downward only. Third of the three checks.
 *
 * A Common_Package may name third-party packages, other Common_Packages, and the
 * scaffold's own, but not a microservice and not the Overseer (R8.9) — that is what
 * keeps it a leaf library. Each offending specifier yields one message. Only
 * `@microservices`-scoped specifiers reach here; that is what discovery records.
 */
export function checkDependencyDirection(
  discovery: Discovery,
): readonly string[] {
  const messages: string[] = [];

  const commonPackages = [...discovery.byCategory.common].sort((a, b) =>
    compareStrings(a.packageDir, b.packageDir),
  );

  for (const pkg of commonPackages) {
    for (const specifier of pkg.dependencySpecifiers) {
      if (pointsUpward(discovery, specifier)) {
        messages.push(
          `${DIRECTION} Common_Package "${pkg.packageDir}" depends on "${specifier}"; a Common_Package must point downward only`,
        );
      }
    }
  }

  return messages;
}

// --- 4. The real-filesystem effect shell (R8.9, R12.17, R12.18, R14.10) ---
//
// This section reads the real repository and hands it to the three checks above: the
// `workspaces` array resolved to the directories it matches, one record per workspace
// package, and a walk of every package's source files. Paths are repo-relative,
// resolved against cwd, and composed with `/` rather than `path.join`, since the
// checks compare them against the POSIX-separated directories discovery.ts records.

/** The root package.json, repo-relative. */
const ROOT_MANIFEST = "package.json";

/**
 * The subdirectories whose contents R14.4 governs. A test colocated inside `src/`
 * is covered by the `src/` walk; a package with neither directory yields no files.
 */
const SOURCE_ROOTS: readonly string[] = ["src", "tests"];

/** Directory names never walked: build output and installed dependencies. */
const SKIPPED_DIRECTORIES: readonly string[] = ["node_modules", "dist"];

const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Tells whether a filesystem error means "this path does not exist". */
function isAbsent(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function resolvesToDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads the `workspaces` array of the root package.json, in declaration order.
 *
 * @throws when the manifest is unreadable, unparsable, or declares no `workspaces`
 *   array of strings — each of which makes coverage uncheckable, so the run fails.
 */
function readWorkspacePatterns(): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ROOT_MANIFEST, "utf8"));
  } catch (error) {
    throw new Error(
      `${COVERAGE} cannot read the "workspaces" array of "${ROOT_MANIFEST}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const declared: unknown = (parsed as { workspaces?: unknown } | null)
    ?.workspaces;
  if (
    !Array.isArray(declared) ||
    declared.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `${COVERAGE} "${ROOT_MANIFEST}" declares no "workspaces" array of strings`,
    );
  }
  return declared as readonly string[];
}

/**
 * Lists the direct subdirectories of `dir`, repo-relative and in ascending order. An
 * absent directory yields none, which is how a glob over an empty category directory
 * contributes zero matches (R12.20). Dot-prefixed names are skipped and symlinks
 * resolved, matching discovery.ts, so nothing npm would ignore counts.
 */
function directSubdirectories(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) {
      return [];
    }
    throw error;
  }

  return entries
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        (entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            resolvesToDirectory(`${dir}/${entry.name}`))),
    )
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

/**
 * Resolves each `workspaces` entry to the package directories it matches, feeding
 * {@link checkWorkspaceCoverage}. It matches the way npm does: no trailing `/*` means
 * that exact directory, a trailing `/*` means every direct subdirectory of the prefix.
 *
 * An exact entry matches its own directory whether or not it exists, which reserves
 * zero-match handling (R12.20) for globs. Any other glob shape (`packages/**`, say) is
 * treated as exact: the root manifest uses none, and guessing at a pattern npm expands
 * differently would fail worse than reporting its packages as uncovered.
 */
function resolveWorkspaceEntries(
  patterns: readonly string[],
): readonly WorkspaceEntry[] {
  return patterns.map((pattern, index) => ({
    pattern,
    index,
    matches: pattern.endsWith(GLOB_SUFFIX)
      ? directSubdirectories(pattern.slice(0, -GLOB_SUFFIX.length))
      : [pattern],
  }));
}

/**
 * Collects one record per workspace package, for {@link checkWorkspaceCoverage}:
 * every one of the scaffold's own packages plus every discovered package, which is
 * the set an entry is required for (R12.15).
 */
function workspacePackages(discovery: Discovery): readonly WorkspacePackage[] {
  return [
    ...FRAMEWORK_SINGLETONS.map((singleton) => ({
      packageDir: singleton.packageDir,
      name: singleton.name,
      dependencySpecifiers: readDependencySpecifiers(singleton.packageDir),
    })),
    ...CONSUMER_CATEGORIES.flatMap(
      (category) => discovery.byCategory[category],
    ),
  ];
}

/**
 * Collects every source file below `dir`, recursively. {@link SKIPPED_DIRECTORIES} and
 * dot-prefixed entries are not descended into, and only {@link SOURCE_EXTENSIONS} files
 * are collected. Symlinks are neither followed nor collected, so no link cycle can
 * make the walk diverge.
 */
function sourceFilesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.includes(entry.name)) {
        files.push(...sourceFilesUnder(path));
      }
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    ) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Collects the files {@link checkImportDiscipline} is asked about: the `src/` and test
 * sources of every discovered package and of every scaffold package. The scaffold's own
 * are walked because the SPA-import rule ranges over everything compiled by `tsc`; the
 * escape and peer rules never fire on those files.
 */
function consumerSourceFiles(discovery: Discovery): readonly string[] {
  const packageDirs = [
    ...CONSUMER_CATEGORIES.flatMap((category) =>
      discovery.byCategory[category].map((pkg) => pkg.packageDir),
    ),
    ...FRAMEWORK_SINGLETONS.map((singleton) => singleton.packageDir),
  ];
  return packageDirs.flatMap((packageDir) =>
    SOURCE_ROOTS.flatMap((root) => sourceFilesUnder(`${packageDir}/${root}`)),
  );
}

/** Runs all three checks over the real repository and returns every message. */
function collectViolations(): readonly string[] {
  const discovery = discoverPackages();
  const entries = resolveWorkspaceEntries(readWorkspacePatterns());

  return [
    ...checkWorkspaceCoverage(entries, workspacePackages(discovery)),
    ...checkImportDiscipline(
      discovery,
      consumerSourceFiles(discovery),
      (file) => readFileSync(file, "utf8"),
    ),
    ...checkDependencyDirection(discovery),
  ];
}

// --- 5. The CLI entry (R12.17, R12.18) ---
//
// This section holds all CLI policy, so bin/check-repo-invariants.ts can be a
// shebang, one import and one call, like its three siblings.

/**
 * Runs every check, reports what was found, and exits 1 if anything was. A clean
 * repository is silent and exits 0 (R12.17).
 *
 * All three checks always run, so one invocation reports every violation rather than
 * stopping at the first failing check — which is what makes it usable as a single CI
 * step. Nothing goes to stdout, and the root package.json is never opened for writing
 * (R12.18). A thrown error is reported as its message alone, not a stack trace, since
 * it is a finding about the repository, not a crash.
 */
export function runRepoInvariantsCli(): void {
  let messages: readonly string[];
  try {
    messages = collectViolations();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  for (const message of messages) {
    process.stderr.write(`${message}\n`);
  }
  if (messages.length > 0) {
    process.exit(1);
  }
}

// Feature: registry-inversion — nothing shipped can reach the Arbitraries_Module
// (design "Relocating the arbitraries" → *Nothing shipped can reach it*).
//
// WHAT THIS GUARDS
// ---------------------------------------------------------------------------
// The shared `fast-check` arbitraries and test-support helpers moved out of the
// `contracts` package and into the `build-tools` package's own `src/testing/`
// directory, whose compiled form lands under `build-tools`' `dist/testing/`.
// `build-tools` is staged into no image, so nothing an image contains can reach
// those helpers — as long as no module a consumer installs imports them, and no
// such module imports `fast-check` either.
//
// This guard walks import declarations OUTWARD from each shipped barrel and
// fails if any module the walk reaches imports the relocated Arbitraries_Module
// or `fast-check`, naming the reachable module, the import declaration that
// reached it, and the chain of imports from the barrel that got there. It is the
// check that catches the mistake the relocation is for: a test-support value
// drifting back into a package a consumer installs.
//
// THE ROOT SET
// ---------------------------------------------------------------------------
// One `src/index.ts` per shipped barrel: the `contracts` Framework_Singleton's,
// the Overseer's, every Common_Package's, and every Microservice_Package's, PLUS
// the Entry_Module at `<Entry_Root>/src/index.ts` (R11.10). The consumer roots come
// from the Effective_Config's Discovery_Roots and the Entry_Root from its `entry`
// value, so a project that relocates either is walked at its configured location.
// A Spa_Package declares no barrel — a microservice reaches a built bundle through
// a run-time module-resolution call, never through an import declaration — so the
// spa category contributes no root.
//
// The Entry_Module is a root because it is the one committed module a container
// executes: it statically imports the Generated_Registry and the Overseer_Library,
// so every module a running image evaluates is reachable from it. It is included
// when it exists on disk and simply absent from the root set when it does not, so
// this guard holds both before and after the Entry_Package is created.
//
// THE GENERATED REGISTRY
// ---------------------------------------------------------------------------
// The Entry_Module's import of the Generated_Registry is the one specifier this
// repository owns that may legitimately answer to no file: the registry is
// gitignored generated output, written by the Registry_Generation_Step, and absent
// on a clone that has never generated one. It is therefore exempt from the
// "unresolved specifier" report rather than being a blind spot: an absent module
// imports nothing, so it can reach nothing, and when it IS present the walk
// follows it like any other module.
//
// HOW THE WALK RESOLVES
// ---------------------------------------------------------------------------
// Source-level, read-only, and deliberately conservative:
//
//   - a relative specifier resolves inside the importing package, mapping the
//     emitted `.js` extension back to the `.ts` source;
//   - a scoped specifier resolves to the named workspace package — the bare name
//     to its `src/index.ts`, a compiled deep path such as `dist/selector.js` back
//     to `src/selector.ts` — so the walk crosses package boundaries exactly where
//     a consumer's module resolution would;
//   - every other bare specifier (`express`, `node:*`) is JUDGED but not
//     followed: a third-party package's own source is not this repository's.
//
// A specifier that resolves to no file on disk is recorded and reported in the
// failure message, but is not itself a failure: an unresolvable module imports
// nothing, so it can reach nothing.
//
// READ-ONLY
// ---------------------------------------------------------------------------
// This suite reads files and directories and writes nothing: no file is created
// or modified in the checked-out tree, no temporary tree is needed, and no git
// command is run at all.
//
// Validates: Requirements 11.10

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProjectConfig,
  type ConfigFileRead,
  type RootProbe,
} from "@microservices/build-tools/dist/config-loader.js";
import { PROJECT_CONFIG_FILE } from "@microservices/build-tools/dist/project-config.js";
import {
  projectContext,
  type ProjectContext,
} from "@microservices/build-tools/dist/project-context.js";
import { generatedRegistryPath } from "@microservices/build-tools/dist/generate-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The directory name the relocated Arbitraries_Module lives in, under the
 *  `build-tools` package's `src/` (compiled: its `dist/`). */
const ARBITRARIES_DIR = "testing";

/** The package name a shipped module must never import. */
const FAST_CHECK = "fast-check";

// ---------------------------------------------------------------------------
// The Effective_Config: one load, threaded through everything below
// ---------------------------------------------------------------------------

/** Reads the Project_Config_File, resolving its path against the repo root
 *  rather than the test runner's working directory. */
function readConfigFile(configPath: string): ConfigFileRead {
  try {
    return { kind: "text", text: readFileSync(configPath, "utf8") };
  } catch (error) {
    const code: unknown = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "absent" };
    }
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Probes one Discovery_Root, again relative to the repo root. */
function probeRoot(rootPath: string): RootProbe {
  let stats;
  try {
    stats = statSync(rootPath);
  } catch {
    return { kind: "absent" };
  }
  if (!stats.isDirectory()) {
    return { kind: "not-directory" };
  }
  let holdsPackageJsonFile = false;
  try {
    holdsPackageJsonFile = statSync(join(rootPath, "package.json")).isFile();
  } catch {
    holdsPackageJsonFile = false;
  }
  return { kind: "directory", holdsPackageJsonFile };
}

/**
 * The one ProjectContext this suite operates on. The scope and the three
 * Discovery_Roots come from the Effective_Config — never from a literal of this
 * file — so the guard follows a project that renames its scope or relocates a
 * root without an edit here.
 */
function loadContext(): ProjectContext {
  const outcome = loadProjectConfig(
    (configPath) => readConfigFile(resolve(repoRoot, configPath)),
    (rootPath) => probeRoot(resolve(repoRoot, rootPath)),
    PROJECT_CONFIG_FILE,
  );
  if (outcome.kind === "rejected") {
    throw new Error(
      `the repository's configuration was rejected, so the guard cannot know ` +
        `which locations to walk:\n${outcome.diagnostics
          .map((diag) => `${diag.tag} ${diag.at}: ${diag.reason}`)
          .join("\n")}`,
    );
  }
  return projectContext(outcome.config);
}

const context = loadContext();

/** Absolute path of the directory holding the relocated Arbitraries_Module. */
const arbitrariesDir = resolve(
  repoRoot,
  context.framework.buildTools.packageDir,
  "src",
  ARBITRARIES_DIR,
);

/**
 * Absolute path of the Generated_Registry — the one specifier this repository owns
 * that may answer to no file, because it is gitignored generated output
 * (registry-inversion R4.1, R5.1).
 */
const generatedRegistry = resolve(repoRoot, generatedRegistryPath(context));

// ---------------------------------------------------------------------------
// Workspace packages, by the name a module imports them under
// ---------------------------------------------------------------------------

/** Repo-relative POSIX path, for every reported path. */
function relPath(absolute: string): string {
  return relative(repoRoot, absolute).split("\\").join("/");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Direct subdirectories of one Discovery_Root that declare a `package.json`. */
function categoryMembers(root: string): string[] {
  const rootDir = resolve(repoRoot, root);
  if (!isDirectory(rootDir)) {
    return [];
  }
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootDir, entry.name))
    .filter((dir) => isFile(join(dir, "package.json")))
    .sort();
}

/** The declared `name` of a package, falling back to the composed scoped name
 *  its directory mandates when the manifest cannot be read. */
function packageName(dir: string): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    const declared =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).name
        : undefined;
    if (typeof declared === "string" && declared.length > 0) {
      return declared;
    }
  } catch {
    // fall through to the composed name
  }
  return context.scopedName(relPath(dir).split("/").at(-1) ?? "");
}

/** Every workspace package of this repository, indexed by the name an import
 *  declaration names it under: the four Framework_Singletons by name, and each
 *  Consumer_Package found by location under its category's Discovery_Root. */
function packageIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const singleton of context.framework.all) {
    index.set(singleton.name, resolve(repoRoot, singleton.packageDir));
  }
  for (const root of Object.values(context.roots)) {
    for (const dir of categoryMembers(root)) {
      index.set(packageName(dir), dir);
    }
  }
  return index;
}

const packages = packageIndex();

/** The modules the walk starts from: `contracts`' barrel, the Overseer's, each
 *  Common_Package's, each Microservice_Package's, and the Entry_Module — every one
 *  at `<packageDir>/src/index.ts` (R11.10). */
function walkRoots(): string[] {
  const dirs = [
    resolve(repoRoot, context.framework.contracts.packageDir),
    resolve(repoRoot, context.framework.overseer.packageDir),
    ...categoryMembers(context.roots.common),
    ...categoryMembers(context.roots.microservice),
    // The Entry_Package is known by its Entry_Root, not discovered under a
    // Discovery_Root — it belongs to no Consumer_Category.
    resolve(repoRoot, context.entryRoot),
  ];
  return dirs
    .map((dir) => join(dir, "src", "index.ts"))
    .filter((barrel) => isFile(barrel));
}

// ---------------------------------------------------------------------------
// Reading import declarations
// ---------------------------------------------------------------------------

/**
 * Blanks out everything in a source that is not code, character for character so
 * every line number and column survives: a comment's body and a template
 * literal's body become spaces, newlines are kept, and `'`/`"` string bodies are
 * kept verbatim because a specifier IS such a literal. Blanking template bodies
 * is what keeps a source that quotes an import statement inside a template
 * literal (a test fixture, a generator) from reading as a real import.
 *
 * This is a scanner, not a parser: a quote inside a regular expression literal
 * reads as opening a string, which can cost a missed specifier but never
 * invents one.
 */
function blankNonCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += i < source.length ? "  " : "";
      i += 2;
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
        if (isTemplate) {
          out += inner === "\n" ? "\n" : " ";
        } else {
          out += inner;
        }
        i += 1;
      }
      continue;
    }

    out += char;
    i += 1;
  }
  return out;
}

/** The import forms a specifier appears in: an `import`/`export … from` clause, a
 *  side-effect `import "…"`, and a dynamic `import("…")`. No `require`: this
 *  repository is ES modules only. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

interface ImportDeclaration {
  readonly specifier: string;
  /** 1-based line of the declaration, for the failure message. */
  readonly line: number;
  /** The declaration's own line, trimmed, so a failure quotes the source. */
  readonly text: string;
}

/** Every import declaration a source declares, in order of appearance. */
function importDeclarations(source: string): ImportDeclaration[] {
  const originalLines = source.split("\n");
  const codeLines = blankNonCode(source).split("\n");
  const found: ImportDeclaration[] = [];

  codeLines.forEach((codeLine, index) => {
    for (const pattern of SPECIFIER_PATTERNS) {
      // Fresh RegExp per line: the shared patterns are `g`-flagged, so a
      // carried-over `lastIndex` would skip matches.
      const scanner = new RegExp(pattern.source, pattern.flags);
      let match = scanner.exec(codeLine);
      while (match !== null) {
        const specifier = match[2];
        if (specifier !== undefined) {
          found.push({
            specifier,
            line: index + 1,
            text: (originalLines[index] ?? "").trim(),
          });
        }
        match = scanner.exec(codeLine);
      }
    }
  });

  // One entry per specifier per module: a specifier imported twice is one reach.
  const seen = new Set<string>();
  return found.filter((entry) => {
    if (seen.has(entry.specifier)) {
      return false;
    }
    seen.add(entry.specifier);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Judging and resolving one specifier
// ---------------------------------------------------------------------------

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** The package-name part of a specifier: the first two segments when scoped, the
 *  first otherwise, so a deep import of a package is judged as that package. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") && segments.length > 1
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
}

/** The part of a specifier after its package name, or `""` for a bare name. */
function subpathOf(specifier: string): string {
  const name = packageNameOf(specifier);
  return specifier.slice(name.length).replace(/^\//, "");
}

/** Whether a specifier imports `fast-check`, by any subpath. */
function namesFastCheck(specifier: string): boolean {
  return !isRelative(specifier) && packageNameOf(specifier) === FAST_CHECK;
}

/**
 * Whether a specifier names the relocated Arbitraries_Module: any subpath of the
 * `build-tools` package's `testing` directory, named through its compiled
 * `dist/testing/…` path (how every importer names it) or through the source
 * directory itself.
 *
 * A relative specifier reaching the directory is caught by the resolved path
 * instead — see {@link withinArbitraries} — which covers `build-tools`' own
 * modules, the only ones close enough to reach it relatively.
 */
function namesArbitrariesModule(specifier: string): boolean {
  if (isRelative(specifier)) {
    return false;
  }
  if (packageNameOf(specifier) !== context.framework.buildTools.name) {
    return false;
  }
  const subpath = subpathOf(specifier).replace(/^dist\//, "");
  return subpath === ARBITRARIES_DIR || subpath.startsWith(`${ARBITRARIES_DIR}/`);
}

/**
 * Whether a relative specifier from `fromFile` names the Generated_Registry —
 * compared against the single derivation of its path, mapping the emitted `.js`
 * extension back to the `.ts` source the importer's specifier spells.
 */
function namesGeneratedRegistry(fromFile: string, specifier: string): boolean {
  if (!isRelative(specifier)) {
    return false;
  }
  const target = resolve(dirname(fromFile), specifier);
  const asSource = target.endsWith(".js")
    ? `${target.slice(0, -".js".length)}.ts`
    : target;
  return asSource === generatedRegistry || target === generatedRegistry;
}

/** Whether a resolved module path lies inside the Arbitraries_Module directory. */
function withinArbitraries(absolute: string): boolean {
  return (
    absolute === arbitrariesDir ||
    absolute.startsWith(`${arbitrariesDir}${"/"}`)
  );
}

/** The TypeScript source candidates one resolved path could mean, mapping the
 *  emitted `.js` extension back to `.ts` and a directory to its barrel. */
function sourceCandidates(path: string): string[] {
  const candidates: string[] = [];
  if (path.endsWith(".js")) {
    const base = path.slice(0, -".js".length);
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.d.ts`);
  }
  candidates.push(path, `${path}.ts`, join(path, "index.ts"));
  return candidates;
}

function firstExistingSource(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => isFile(candidate));
}

/**
 * The module one specifier reaches, or `undefined` when nothing on disk answers
 * it — a third-party package (not this repository's source), or a path that
 * resolves to no file.
 */
function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (isRelative(specifier)) {
    return firstExistingSource(
      sourceCandidates(resolve(dirname(fromFile), specifier)),
    );
  }
  const packageDir = packages.get(packageNameOf(specifier));
  if (packageDir === undefined) {
    return undefined;
  }
  const subpath = subpathOf(specifier);
  if (subpath.length === 0) {
    return firstExistingSource(sourceCandidates(join(packageDir, "src")));
  }
  // A compiled deep path names `dist/…`; its source is the same path under `src/`.
  const withoutDist = subpath.replace(/^dist\//, "");
  return firstExistingSource([
    ...sourceCandidates(join(packageDir, "src", withoutDist)),
    ...sourceCandidates(join(packageDir, subpath)),
  ]);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** One import declaration followed, for the chain a failure reports. */
interface Step {
  readonly from: string;
  readonly specifier: string;
  readonly line: number;
}

interface WalkResult {
  /** Every module reached, mapped to the chain of imports that reached it. */
  readonly reached: Map<string, readonly Step[]>;
  readonly fastCheckHits: readonly string[];
  readonly arbitrariesHits: readonly string[];
  /** Specifiers that answered to no file: reported, but not failures. */
  readonly unresolved: readonly string[];
}

/** Renders the chain of import declarations from a barrel to a module. */
function renderChain(chain: readonly Step[]): string {
  if (chain.length === 0) {
    return "(the barrel itself)";
  }
  return chain
    .map((step) => `${relPath(step.from)}:${step.line} imports "${step.specifier}"`)
    .join("\n      -> ");
}

/** Walks import declarations outward from the given roots, judging every
 *  specifier of every module reached. */
function walk(roots: readonly string[]): WalkResult {
  const reached = new Map<string, readonly Step[]>();
  const fastCheckHits: string[] = [];
  const arbitrariesHits: string[] = [];
  const unresolved: string[] = [];
  const queue: { file: string; chain: readonly Step[] }[] = [];

  for (const root of roots) {
    if (!reached.has(root)) {
      reached.set(root, []);
      queue.push({ file: root, chain: [] });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const declarations = importDeclarations(readFileSync(current.file, "utf8"));

    for (const declaration of declarations) {
      const step: Step = {
        from: current.file,
        specifier: declaration.specifier,
        line: declaration.line,
      };
      const chain = [...current.chain, step];
      const resolved = resolveModule(current.file, declaration.specifier);

      const hit =
        namesFastCheck(declaration.specifier) ||
        namesArbitrariesModule(declaration.specifier) ||
        (resolved !== undefined && withinArbitraries(resolved));

      if (hit) {
        const message =
          `${relPath(current.file)}:${declaration.line} — ${declaration.text}\n` +
          `    reached from ${relPath(current.chain[0]?.from ?? current.file)} via:\n` +
          `      -> ${renderChain(chain)}`;
        if (namesFastCheck(declaration.specifier)) {
          fastCheckHits.push(message);
        } else {
          arbitrariesHits.push(message);
        }
        continue;
      }

      if (resolved === undefined) {
        // Only a specifier this repository OWNS is worth reporting as
        // unresolved; a third-party or node: builtin answers to no source here
        // by design. The Generated_Registry is exempt: it is gitignored generated
        // output and is legitimately absent on a clone that has never generated
        // one (registry-inversion R5.1).
        if (
          (isRelative(declaration.specifier) ||
            packages.has(packageNameOf(declaration.specifier))) &&
          !namesGeneratedRegistry(current.file, declaration.specifier)
        ) {
          unresolved.push(
            `${relPath(current.file)}:${declaration.line} imports "${declaration.specifier}"`,
          );
        }
        continue;
      }

      if (!reached.has(resolved)) {
        reached.set(resolved, chain);
        queue.push({ file: resolved, chain });
      }
    }
  }

  return { reached, fastCheckHits, arbitrariesHits, unresolved };
}

/**
 * Every module of this repository that DOES import the relocated
 * Arbitraries_Module: the test suites of the shipped packages, which import it
 * legitimately. None is a shipped barrel or reachable from one, so none is part
 * of the guarded set — they serve only as real input proving the walk reports
 * what it is meant to report.
 */
function arbitrariesImporters(): string[] {
  const found: string[] = [];
  for (const packageDir of new Set(packages.values())) {
    const testsDir = join(packageDir, "tests");
    if (!isDirectory(testsDir)) {
      continue;
    }
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const file = join(testsDir, entry.name);
      const imports = importDeclarations(readFileSync(file, "utf8"));
      if (imports.some((decl) => namesArbitrariesModule(decl.specifier))) {
        found.push(file);
      }
    }
  }
  return found.sort();
}

const barrels = walkRoots();
const result = walk(barrels);
const reachedPaths = [...result.reached.keys()].map(relPath).sort();

describe("no shipped barrel reaches the relocated arbitraries (R11.10)", () => {
  it("walks every shipped barrel and the Entry_Module (the scan is not vacuous)", () => {
    // `contracts`, the Overseer, one barrel per Common_Package and per
    // Microservice_Package, and the Entry_Module. A broken root derivation
    // returning nothing would otherwise let every assertion below pass over an
    // empty set.
    const expected = [
      join(context.framework.contracts.packageDir, "src/index.ts"),
      join(context.framework.overseer.packageDir, "src/index.ts"),
      ...categoryMembers(context.roots.common).map((dir) =>
        join(relPath(dir), "src/index.ts"),
      ),
      ...categoryMembers(context.roots.microservice).map((dir) =>
        join(relPath(dir), "src/index.ts"),
      ),
      ...(isFile(resolve(repoRoot, context.entryRoot, "src", "index.ts"))
        ? [join(context.entryRoot, "src/index.ts")]
        : []),
    ].sort();
    expect(barrels.map(relPath).sort()).toEqual(expected);
    expect(barrels.length).toBeGreaterThanOrEqual(4);

    // The Entry_Module exists in this repository, so it IS among the roots —
    // R11.10's own clause, and not something a future absence can silently drop.
    expect(barrels.map(relPath)).toContain(
      join(context.entryRoot, "src/index.ts"),
    );
  });

  it("follows imports outward, across package boundaries and by name", () => {
    // The walk must actually reach INTERIOR modules — a walk that stopped at the
    // roots would report nothing while proving nothing. The Overseer's barrel
    // re-exports its interior modules; the Entry_Module imports the Overseer by its
    // scoped package name; a microservice's barrel imports a Common_Package by its
    // scoped name.
    expect(reachedPaths).toContain(
      join(context.framework.overseer.packageDir, "src/boot.ts"),
    );
    // The Entry_Module's by-name import of the Overseer_Library crosses a package
    // boundary and lands on the Overseer's barrel (registry-inversion R2.6).
    expect(
      importDeclarations(
        readFileSync(resolve(repoRoot, context.entryRoot, "src", "index.ts"), "utf8"),
      ).map((decl) => decl.specifier),
    ).toContain(context.framework.overseer.name);
    expect(reachedPaths).toContain(
      join(context.framework.overseer.packageDir, "src/index.ts"),
    );
    // Every Common_Package barrel is reached — as a root, and (for the base
    // config package) through a scoped by-name import from its consumers.
    for (const dir of categoryMembers(context.roots.common)) {
      expect(reachedPaths).toContain(join(relPath(dir), "src/index.ts"));
    }
    // No module reached from any root lives under a retired
    // `packages/overseer/src/generated/` path: the Overseer imports no generated
    // file at all since the inversion (registry-inversion R3.3, R3.5).
    expect(
      reachedPaths.filter((path) =>
        path.startsWith(
          join(context.framework.overseer.packageDir, "src/generated"),
        ),
      ),
    ).toEqual([]);
    expect(
      result.unresolved,
      `a specifier this repository owns answered to no source, so part of the ` +
        `walk is blind:\n${result.unresolved.join("\n")}`,
    ).toEqual([]);
  });

  it("no reachable module imports fast-check", () => {
    expect(
      result.fastCheckHits,
      `a module reachable from a shipped barrel imports ${FAST_CHECK}, which ` +
        `ships only as a development dependency of build-tools:\n` +
        result.fastCheckHits.join("\n"),
    ).toEqual([]);
  });

  it("no reachable module imports the relocated Arbitraries_Module", () => {
    expect(
      result.arbitrariesHits,
      `a module reachable from a shipped barrel imports the arbitraries at ` +
        `${relPath(arbitrariesDir)}, which no shipped package may reach:\n` +
        result.arbitrariesHits.join("\n"),
    ).toEqual([]);
  });

  it("judges the two forbidden specifier shapes (the guard has teeth)", () => {
    // The judgement is pure over a specifier string, so it can be exercised
    // without writing a fixture into the checked-out tree. If these ever stop
    // holding, the three assertions above are silently vacuous.
    const compiled = `${context.framework.buildTools.name}/dist/${ARBITRARIES_DIR}/index.js`;
    expect(namesArbitrariesModule(compiled)).toBe(true);
    expect(
      namesArbitrariesModule(
        `${context.framework.buildTools.name}/${ARBITRARIES_DIR}/arbitraries.js`,
      ),
    ).toBe(true);
    expect(
      namesArbitrariesModule(
        `${context.framework.buildTools.name}/dist/selector.js`,
      ),
    ).toBe(false);
    expect(namesFastCheck(FAST_CHECK)).toBe(true);
    expect(namesFastCheck(`${FAST_CHECK}/lib/esm/fast-check.js`)).toBe(true);
    expect(namesFastCheck("express")).toBe(false);

    // And the compiled arbitraries path is the one the importers really name, so
    // a shipped module naming it would resolve to the guarded directory.
    expect(
      withinArbitraries(join(arbitrariesDir, "arbitraries.ts")),
    ).toBe(true);
    expect(withinArbitraries(join(dirname(arbitrariesDir), "selector.ts"))).toBe(
      false,
    );
  });

  it("reports a module that does import the arbitraries (the walk has teeth)", () => {
    // The walk, not only the specifier judgement, must produce a report. A test
    // suite of a shipped package legitimately imports the arbitraries, so
    // walking from one — which is NOT a shipped barrel, and so is not part of the
    // guard above — must yield exactly the failure shape the guard reports. No
    // fixture is written: an existing importer in the tree is the input.
    const importers = arbitrariesImporters();
    expect(
      importers.length,
      "no module imports the arbitraries, so this check cannot exercise the walk",
    ).toBeGreaterThan(0);

    const probe = walk(importers.slice(0, 1));
    expect(probe.arbitrariesHits.length).toBeGreaterThan(0);
    expect(probe.arbitrariesHits.join("\n")).toContain(
      relPath(importers[0] ?? ""),
    );
  });
});

// Feature: platform-fixtures, Property 1: Discovery over a materialised fixture
// tree agrees with discovery over the equivalent in-memory Synthesized_Tree.
//
// For any Synthesized_Tree holding 0 to 5 Consumer_Packages per Consumer_Category
// — each with a generated directory name, a declared name composed from the
// tree's generated Configured_Scope, and a generated Dependency_Specifier list —
// and for any assignment of Discovery_Roots the Config_Parser accepts:
// materialising that tree as real directories and manifests inside an OS
// temporary directory and running Package_Discovery's EFFECT SHELL
// (`discoverPackages`, with that directory as its Project_Directory) yields, for
// each Consumer_Category, a sequence of equal length and identical order to the
// sequence the PURE CORE (`discoverPackagesFrom` over the same tree as in-memory
// `ListRoot`/`ReadManifest` inputs) yields, and corresponding entries at every
// index carry equal Consumer_Category, equal directory name, equal declared name,
// equal build kind, and equal Dependency_Specifier lists compared element-by-
// element in order.
//
// This is the load-bearing agreement of R13.5: the effect shell adds nothing the
// pure core does not already produce, so a fixture read from disk and the
// in-memory transcription of the same tree are two routes through one core. The
// second, deterministic block pins that same claim against the COMMITTED
// discovery Tree_Fixtures, tying the committed fixtures to the in-memory
// synthesized-tree generators so the two families of tests cannot silently
// diverge: for each committed `discovery--*` fixture, the effect shell over the
// fixture read from disk and the pure core over the in-memory transcription of
// that same fixture report the same Diagnostic_Tag.
//
// Worktree discipline (R12.4, R12.5, R11.2, R11.3): the property materialises
// each generated tree inside ONE temporary root created in `beforeAll` and
// removed in `afterAll` whether the assertions passed or failed; the materialiser
// refuses any destination outside the OS temporary directory, so no generated
// tree can be written into the checked-out repository. The committed fixtures are
// read only — never installed, never built, never written to (R2.2).
//
// Validates: Requirements 13.5, 16.2

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";

import {
  discoverPackages,
  discoverPackagesFrom,
  type ConsumerPackage,
  type Discovery,
  type ListRoot,
  type ManifestRead,
  type PackageManifest,
  type ReadManifest,
  type RootEntry,
} from "../src/discovery.js";
import { CONSUMER_CATEGORIES, type ConsumerCategory } from "../src/framework.js";
import {
  defaultEffectiveConfig,
  PROJECT_CONFIG_FILE,
  serializeProjectConfig,
  type EffectiveConfig,
} from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import { FIXTURES_ROOT } from "./fixture-paths.js";
import {
  relocatedAs,
  relocatedRoots,
  rescopedAs,
  synthesizedTree,
  treeInputs,
  validScope,
  DEFAULT_ROOTS,
  type RootAssignment,
  type TreeDescription,
} from "./arbitraries/tree.js";

const RUNS = { numRuns: 100 } as const;

// ---------------------------------------------------------------------------
// Comparable projections
// ---------------------------------------------------------------------------

/** The fields Property 1 compares for one discovered package: Consumer_Category,
 *  directory name, declared name, build kind, and Dependency_Specifier list —
 *  the specifier list compared element-by-element in order. `packageDir` is
 *  deliberately excluded: it carries the (possibly relocated) root prefix, and
 *  both routes derive it from the same roots, so it is equal by construction and
 *  not the substance of the claim. */
function comparablePackage(pkg: ConsumerPackage) {
  return {
    category: pkg.category,
    dirName: pkg.dirName,
    name: pkg.name,
    buildKind: pkg.buildKind,
    dependencySpecifiers: [...pkg.dependencySpecifiers],
  };
}

/** A discovery result projected per category into the comparable shape, one
 *  sequence per Consumer_Category in the fixed category order. */
function comparableByCategory(
  discovery: Discovery,
): Record<ConsumerCategory, ReturnType<typeof comparablePackage>[]> {
  const out = {} as Record<
    ConsumerCategory,
    ReturnType<typeof comparablePackage>[]
  >;
  for (const category of CONSUMER_CATEGORIES) {
    out[category] = discovery.byCategory[category].map(comparablePackage);
  }
  return out;
}

/** A context at a description's own scope and roots — the single value both
 *  routes thread, so a package name and the name discovery expects it to mirror
 *  are composed from the same scope. */
function contextFor(description: TreeDescription) {
  const base = defaultEffectiveConfig();
  return projectContext({
    ...base,
    scope: description.scope,
    roots: description.roots,
  });
}

// ---------------------------------------------------------------------------
// Materialisation — the one writing helper, refusing any non-temp destination
// ---------------------------------------------------------------------------

/**
 * Refuses any destination outside the OS temporary directory. The hard worktree
 * rule made mechanical (R12.4, R12.5): the writing helper below cannot be pointed
 * at the checked-out tree by a mistaken argument. Both the raw and the real path
 * of each side are compared, because `os.tmpdir()` is itself a symlink on macOS.
 */
function assertInsideTempDirectory(target: string): void {
  const roots = new Set<string>([resolve(tmpdir())]);
  try {
    roots.add(resolve(realpathSync(tmpdir())));
  } catch {
    // An unreadable tmpdir is the caller's problem; the raw path still guards.
  }
  const candidates = new Set<string>([resolve(target)]);
  try {
    candidates.add(resolve(realpathSync(target)));
  } catch {
    // Not yet created is fine — the resolved path is what is being judged.
  }
  for (const candidate of candidates) {
    for (const root of roots) {
      if (candidate === root || candidate.startsWith(`${root}${sep}`)) return;
    }
  }
  throw new Error(
    `refusing to materialize a Synthesized_Tree outside the OS temporary directory: "${resolve(target)}"`,
  );
}

/** Writes one file, creating every absent parent directory. */
function writeFileAt(absolutePath: string, contents: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

/**
 * Materialises a plain Synthesized_Tree as real directories and manifests inside
 * `parentDir` (which MUST be inside the OS temporary directory), returning the
 * absolute path of the tree's root — the Project_Directory the effect shell takes
 * as its working directory.
 *
 * It writes exactly what discovery reads: a `scaffold.config.json` carrying the
 * tree's scope and roots so the spawned-in-process effect shell reads the same
 * scope and roots the in-memory route uses, and, under each configured
 * Discovery_Root, one `package.json` per member with the same fields
 * `treeInputs`'s `ReadManifest` returns in memory. No `src/`, no `dist/`, no
 * `node_modules`: discovery reads manifests and never builds.
 *
 * The per-member manifest is recovered from `treeInputs(...).readManifest`, so
 * the bytes on disk are the transcription of the very object the pure core reads
 * — the two routes cannot drift because there is one source of manifest truth.
 */
function materializeTree(
  description: TreeDescription,
  parentDir: string,
): string {
  assertInsideTempDirectory(parentDir);
  mkdirSync(parentDir, { recursive: true });
  const dir = mkdtempSync(join(parentDir, "synth-tree-"));
  const at = (relative: string): string => join(dir, ...relative.split("/"));

  // A config file so the effect shell reads the tree's own scope and roots.
  writeFileAt(
    at(PROJECT_CONFIG_FILE),
    serializeProjectConfig(effectiveConfigFor(description)),
  );

  const { readManifest } = treeInputs(description);
  for (const spec of description.packages) {
    const packageDir = `${description.roots[spec.category]}/${spec.dirName}`;
    const read = readManifest(packageDir);
    // Every package a conforming synthesized tree carries reads `ok`; transcribe
    // that exact manifest object to disk so both routes see one set of fields.
    if (read.kind !== "ok") continue;
    writeFileAt(
      at(`${packageDir}/package.json`),
      `${JSON.stringify(read.manifest, null, 2)}\n`,
    );
  }
  return dir;
}

/** The Effective_Config a description denotes (its scope and roots, default
 *  Entry_Root), for the materialised `scaffold.config.json`. */
function effectiveConfigFor(description: TreeDescription): EffectiveConfig {
  const base = defaultEffectiveConfig();
  return { ...base, scope: description.scope, roots: description.roots };
}

// ---------------------------------------------------------------------------
// Property 1 (generated Synthesized_Trees)
// ---------------------------------------------------------------------------

describe("Feature: platform-fixtures, Property 1: fixture/synthesized discovery agreement", () => {
  let tempRoot: string;

  beforeAll(() => {
    // ONE temporary root for the whole suite; each input gets a subdirectory of
    // it through `materializeTree`, so the cost is one `mkdtempSync` per input
    // and no `npm ci` at all.
    tempRoot = mkdtempSync(join(tmpdir(), "synth-agreement-"));
  });

  afterAll(() => {
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("the effect shell over a materialised tree agrees per category with the pure core over the same tree in memory", () => {
    let observedNonEmpty = 0;

    fc.assert(
      fc.property(
        synthesizedTree(),
        validScope(),
        fc.oneof(fc.constant<RootAssignment>(DEFAULT_ROOTS), relocatedRoots()),
        (baseTree, scope, roots) => {
          // Rewrite the base tree under the generated scope and root assignment;
          // both are pure transformations of the description, and `treeInputs`
          // recomposes every declared name and specifier from those fields.
          const tree = relocatedAs(rescopedAs(baseTree, scope), roots);
          const context = contextFor(tree);

          // Route A — the pure core over in-memory inputs.
          const { listRoot, readManifest } = treeInputs(tree);
          const inMemory = discoverPackagesFrom(context, listRoot, readManifest);

          // Route B — the effect shell over the materialised tree on disk, with
          // that directory as its Project_Directory.
          const treeDir = materializeTree(tree, tempRoot);
          const previousCwd = process.cwd();
          let onDisk: Discovery;
          try {
            process.chdir(treeDir);
            onDisk = discoverPackages(context);
          } finally {
            process.chdir(previousCwd);
            rmSync(treeDir, { recursive: true, force: true });
          }

          const memByCategory = comparableByCategory(inMemory);
          const diskByCategory = comparableByCategory(onDisk);

          for (const category of CONSUMER_CATEGORIES) {
            const mem = memByCategory[category];
            const disk = diskByCategory[category];
            // Equal length and identical order per category, and per-index field
            // equality including the specifier list element-by-element in order.
            expect(disk).toEqual(mem);
            observedNonEmpty += mem.length;
          }
        },
      ),
      RUNS,
    );

    // A conforming synthesized tree is often empty; ensure the run actually
    // exercised populated trees rather than trivially passing on empty ones.
    expect(observedNonEmpty).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The committed discovery fixtures, read only (R2.2)
// ---------------------------------------------------------------------------

const DISCOVERY_TREES_ROOT = join(FIXTURES_ROOT, "trees");

/** The bracket tag `[category:detail]` recovered from a thrown discovery error,
 *  or `undefined` when the value carries none. Discovery frames every failure as
 *  a leading bracketed tag, so the first match is the Diagnostic_Tag. */
function tagOf(value: unknown): string | undefined {
  const message = value instanceof Error ? value.message : String(value);
  const match = /\[[a-z][a-z-]*:[a-z][a-z-]*\]/.exec(message);
  return match?.[0];
}

/** The outcome of running one discovery route: either it returned, or it threw a
 *  Diagnostic_Tag. Both routes must land on the same outcome. */
type DiscoveryOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "tag"; readonly tag: string };

/** Runs a thunk and reduces it to a `DiscoveryOutcome`: `ok` if it returned, the
 *  recovered Diagnostic_Tag if it threw one. A throw carrying no recognisable
 *  tag re-propagates — that is a genuine failure, not an agreement to compare. */
function outcomeOf(run: () => Discovery): DiscoveryOutcome {
  try {
    run();
    return { kind: "ok" };
  } catch (error) {
    const tag = tagOf(error);
    if (tag === undefined) throw error;
    return { kind: "tag", tag };
  }
}

/** Reads a fixture's `scaffold.config.json` if present, else the defaults. The
 *  committed discovery fixtures declare none, so this yields the default scope
 *  and roots — which is what makes their `packages/microservices/...` layout
 *  discoverable. */
function fixtureConfig(fixtureDir: string): EffectiveConfig {
  const configPath = join(fixtureDir, PROJECT_CONFIG_FILE);
  const base = defaultEffectiveConfig();
  let declared: Record<string, unknown> = {};
  try {
    declared = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return base;
  }
  const roots = (declared.roots ?? {}) as Partial<RootAssignment>;
  return {
    scope: typeof declared.scope === "string" ? declared.scope : base.scope,
    roots: {
      microservice: roots.microservice ?? base.roots.microservice,
      common: roots.common ?? base.roots.common,
      spa: roots.spa ?? base.roots.spa,
    },
    entry: typeof declared.entry === "string" ? declared.entry : base.entry,
  };
}

/**
 * Builds the pure core's two injected readers by transcribing a fixture read from
 * disk into memory: `listRoot` answers each configured Discovery_Root with its
 * direct entries, and `readManifest` returns the exact manifest read state
 * (`ok`/`unreadable`/`unparsable`/`absent`) for each package directory. This is
 * the in-memory transcription of the SAME fixture the effect shell reads, so the
 * two routes differ only in whether they touch the real filesystem.
 */
function transcribe(
  fixtureDir: string,
  config: EffectiveConfig,
): { readonly listRoot: ListRoot; readonly readManifest: ReadManifest } {
  const rootToCategory = new Map<string, ConsumerCategory>(
    CONSUMER_CATEGORIES.map((category) => [config.roots[category], category]),
  );

  const listRoot: ListRoot = (rootDir): readonly RootEntry[] | undefined => {
    if (!rootToCategory.has(rootDir)) return undefined;
    const absolute = join(fixtureDir, ...rootDir.split("/"));
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return undefined;
    }
    return entries.map((entry) => {
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(join(absolute, entry.name)).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      return { name: entry.name, isDirectory };
    });
  };

  const readManifest: ReadManifest = (packageDir): ManifestRead => {
    const manifestPath = join(fixtureDir, ...packageDir.split("/"), "package.json");
    let text: string;
    try {
      text = readFileSync(manifestPath, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { kind: "absent" }
        : { kind: "unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "unparsable" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unparsable" };
    }
    return { kind: "ok", manifest: parsed as PackageManifest };
  };

  return { listRoot, readManifest };
}

/** The committed `discovery--*` Tree_Fixtures: the fixtures whose fault lives in
 *  Package_Discovery, so both discovery routes reach it. */
function committedDiscoveryFixtures(): readonly string[] {
  return readdirSync(DISCOVERY_TREES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("discovery--"))
    .map((entry) => entry.name)
    .sort();
}

describe("Feature: platform-fixtures, Property 1: committed discovery fixtures agree with their in-memory transcription", () => {
  const fixtures = committedDiscoveryFixtures();

  it("has committed discovery fixtures to compare", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    it(`${name}: effect shell over the fixture on disk and pure core over its transcription report the same tag`, () => {
      const fixtureDir = join(DISCOVERY_TREES_ROOT, name);
      const config = fixtureConfig(fixtureDir);
      const context = projectContext(config);

      // Route B — the effect shell, reading the fixture from disk with its
      // directory as the Project_Directory. Read only: no write, no install.
      const previousCwd = process.cwd();
      let diskOutcome: DiscoveryOutcome;
      try {
        process.chdir(fixtureDir);
        diskOutcome = outcomeOf(() => discoverPackages(context));
      } finally {
        process.chdir(previousCwd);
      }

      // Route A — the pure core over the in-memory transcription of that same
      // fixture, touching no filesystem after the transcription is built.
      const { listRoot, readManifest } = transcribe(fixtureDir, config);
      const memOutcome = outcomeOf(() =>
        discoverPackagesFrom(context, listRoot, readManifest),
      );

      // The two routes must land on the same outcome and the same Diagnostic_Tag.
      expect(diskOutcome).toEqual(memOutcome);
    });
  }
});

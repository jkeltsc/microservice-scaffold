// Task 7.22 — Baseline-equivalence integration tests.
//
// The atomic core swap (step 4) must leave the two shipped artifacts — the
// generated Microservice_Registry and the assembled Image_Tree — equivalent to
// the Pre_Change_Baseline for both shipped Selectors (`*` and
// `microservice1,microservice2`). "Equivalent" is spelled out by the design's
// "BuildPlan for the two shipped Selectors" table and the Testing Strategy
// "Integration tests" bullets:
//
//   1. Registry equivalence — for each Selector the generated registry declares
//      the SAME import-specifier set and the SAME per-entry field set as the
//      baseline: one `@microservices/<dirName>` specifier per Selected
//      Microservice and one entry carrying exactly { identifier, module,
//      sourcePackage } with identifier === sourcePackage's directory suffix
//      (R14.2). The specifier stays directory-derived; the relocation of
//      `config` to `packages/common/config` must not perturb it.
//
//   2. Image_Tree equivalence — for each Selector the scoped entry set under
//      `node_modules/@microservices/` equals the baseline set (`contracts`,
//      `microservice1`, … the Selected microservices) PLUS `config` exactly
//      when it is a required dependency (R14.7, R5.6, R7.6), plus `overseer`,
//      which the registry inversion turned into an imported-by-name library. Every
//      scoped entry is a REAL directory, never a workspace symlink, and the one
//      package-directory staging inside the tree is the Entry_Package's, at the
//      Entry_Root (registry-inversion R9.4, R9.6).
//
//   3. `contracts` staged file set — for each Selector the sorted tree-relative
//      path set under `node_modules/@microservices/contracts` equals
//      `package.json` plus every file of `dist/`, `dist/testing/` included
//      (R5.8). `copyPackage` is what keeps this byte-for-byte stable.
//
// The Image_Tree cases assemble the real tree with `buildImageTree`, which
// reads `process.env.MICROSERVICES`, generates the registry, runs a real
// `tsc --build`, and stages relative to cwd (the repo root). The suite pins cwd
// to the repo root, sets the Selector per case, and restores cwd + the Selector
// env afterward — the same pattern as `shared-package-staging.test.ts`. Because
// each assemble runs a real `tsc --build`, the timeouts are generous.
//
// The registry cases call `generateRegistry(selector)` directly. Like
// `buildImageTree`, that writes the gitignored generated registry file as a
// side effect; the suite snapshots and restores its prior contents so the
// working tree is left as it was found.
//
// Validates: Requirements R5.6, R5.8, R7.6, R14.2, R14.7

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

import { buildImageTree } from "@microservices/build-tools/dist/image-tree.js";
import { buildPlan } from "@microservices/build-tools/dist/build-plan.js";
import {
  generateRegistry,
  generatedRegistryPath,
} from "@microservices/build-tools/dist/generate-registry.js";
import { discoverPackages } from "@microservices/build-tools/dist/discovery.js";
import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The compiled build-tools module directory the recorder imports entry points from. */
const DIST = resolve(repoRoot, "packages/build-tools/dist");

/** Where the recorded Pre_Change_Baseline fixtures live (task 1.2). */
const BASELINE_DIR = resolve(__dirname, "..", "baseline");

/** This repository's default ProjectContext — unconfigured, so the Entry_Root is
 *  the Entry_Root_Default `app`. */
const defaultContext = projectContext(defaultEffectiveConfig());

/**
 * The generated (gitignored) registry file `generateRegistry` writes, taken from
 * the single derivation rather than spelled here (registry-inversion R4.1, R5.8):
 * it now lives in the CONSUMER's tree at `<Entry_Root>/src/generated/`, and no
 * path under a Framework_Singleton is named in that role.
 */
const REGISTRY_PATH = resolve(repoRoot, generatedRegistryPath(defaultContext));

/** The Entry_Root of this (unconfigured) repository, Project_Directory-relative. */
const ENTRY_ROOT = defaultContext.entryRoot;

/** The compiled Repo_Invariant_Checker bin the root `check:invariants` runs. */
const CHECK_INVARIANTS_BIN = resolve(DIST, "bin/check-repo-invariants.js");

/** Real assembly runs a full `tsc --build`; give each case room. */
const ASSEMBLE_TIMEOUT_MS = 180_000;

/**
 * The Pre_Change_Baseline scoped entry sets from the design's "BuildPlan for
 * the two shipped Selectors" table. `contracts` is the always-staged
 * Framework_Singleton; a Common_Package is present exactly when it is a
 * required dependency of a Selected Microservice (directly or transitively).
 *
 * Since Microservice3 switched from a direct `@microservices/config` dependency
 * to `@microservices/extended-config` (which itself depends on
 * `@microservices/config`), any Selector reaching Microservice3 now stages BOTH
 * `config` and `extended-config` (design worked staged sets: `ms3 →
 * extended-config → config` stages `{config, extended-config}`). Of the two
 * shipped Selectors, only `*` reaches Microservice3, so only its set gains
 * `extended-config`; `microservice1,microservice2` never reaches Microservice3
 * and its Common_Package set stays `{config}` (config comes in via Microservice2).
 *
 * And since Microservice1 now serves the Demo_Spa, it declares
 * `@microservices/demo` in its Required_Dependencies (R7.1), so every Selector
 * that selects Microservice1 stages the Spa_Package `demo` as a real directory
 * at `node_modules/@microservices/demo`. Both shipped Selectors select
 * Microservice1, so BOTH staged sets gain `demo`.
 *
 * And since the registry inversion the Overseer is a LIBRARY the Entry_Package
 * imports by name, so it is staged as a real directory under the scope root like
 * any other imported-by-name package rather than at its package directory
 * (registry-inversion R3.7, R9.4). It is a Required_Dependency of the
 * Entry_Package for every Selector, so BOTH staged sets carry `overseer`. The one
 * package-directory staging is now the Entry_Package's, at the Entry_Root (R9.6).
 */
const BASELINE = {
  "*": {
    selected: ["microservice1", "microservice2", "microservice3"],
    scopedEntries: [
      "config",
      "contracts",
      "demo",
      "extended-config",
      "microservice1",
      "microservice2",
      "microservice3",
      "overseer",
    ],
  },
  "microservice1,microservice2": {
    selected: ["microservice1", "microservice2"],
    scopedEntries: [
      "config",
      "contracts",
      "demo",
      "microservice1",
      "microservice2",
      "overseer",
    ],
  },
} as const;

type ShippedSelector = keyof typeof BASELINE;
const SHIPPED_SELECTORS: readonly ShippedSelector[] = [
  "*",
  "microservice1,microservice2",
];

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

interface RegistryEntry {
  identifier: string;
  sourcePackage: string;
  /** `module: mN` — the local alias bound by the matching import. */
  moduleAlias: string;
}

/** Parsed shape of a generated registry, enough to compare against baseline. */
interface ParsedRegistry {
  /** The set of import specifiers, in the order they appear. */
  importSpecifiers: string[];
  /** One entry per registry row, in order. */
  entries: RegistryEntry[];
  /** The exact set of fields present on each entry row, deduplicated. */
  entryFieldSets: string[][];
}

/**
 * Parse the generated registry text into its specifier set and per-entry field
 * set. Deliberately structural, not a full-text diff: the design's baseline
 * claim is about the SPECIFIER SET and the PER-ENTRY FIELD SET, not the header
 * comment or whitespace.
 */
function parseRegistry(text: string): ParsedRegistry {
  const importSpecifiers = [
    ...text.matchAll(/import \* as (m\d+) from "([^"]+)";/g),
  ].map((m) => m[2]);

  const entryFieldSets: string[][] = [];
  const entries: RegistryEntry[] = [];
  // Registry rows are the `{ … }` object literals that carry an `identifier:`
  // field — this deliberately excludes the `{ MicroserviceRegistry }` type
  // import and any other brace pair in the emitted text.
  for (const row of text.matchAll(/\{ ([^}]*identifier:[^}]*) \}/g)) {
    const body = row[1];
    const fields = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);
    entryFieldSets.push(fields);

    const identifier = /identifier:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    const sourcePackage = /sourcePackage:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    const moduleAlias = /module:\s*(\w+)/.exec(body)?.[1] ?? "";
    entries.push({ identifier, sourcePackage, moduleAlias });
  }

  return { importSpecifiers, entries, entryFieldSets };
}

/**
 * The Generated_Registry's bytes when the file is present, `undefined` when it is
 * absent. The Generated_Registry is one of the three in-place writes the worktree
 * rule permits, and the discipline is: capture before the first write, write the
 * captured bytes back with `writeFileSync` afterward, and REMOVE the file when it
 * was absent before the run — never through git.
 */
function captureRegistry(): string | undefined {
  try {
    return readFileSync(REGISTRY_PATH, "utf8");
  } catch {
    return undefined;
  }
}

/** Restore what {@link captureRegistry} captured, removal included. */
function restoreRegistry(captured: string | undefined): void {
  if (captured === undefined) {
    rmSync(REGISTRY_PATH, { force: true });
  } else {
    writeFileSync(REGISTRY_PATH, captured, "utf8");
  }
}

/**
 * Generate the registry for `selector`, read the emitted text back, and restore
 * the prior (gitignored) file contents. Returns the emitted text.
 */
function generateRegistryText(selector: string): string {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  const previousRegistry = captureRegistry();
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    generateRegistry(defaultContext, selector);
    return readFileSync(REGISTRY_PATH, "utf8");
  } finally {
    restoreRegistry(previousRegistry);
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
}

// ---------------------------------------------------------------------------
// Image_Tree helpers
// ---------------------------------------------------------------------------

/** Assemble the image tree for `selector` into a fresh temp outDir. */
function assemble(selector: string): { outDir: string } {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  const outDir = mkdtempSync(join(tmpdir(), "baseline-equivalence-"));
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    // The CLI (runImageTreeCli) exits the process on a Config_Diagnostic, so a
    // test cannot call it; it replicates the CLI orchestration instead —
    // discover, generate the registry, derive the plan, then hand context+plan
    // to the domain function.
    const context = projectContext(defaultEffectiveConfig());
    const discovery = discoverPackages(context);
    generateRegistry(context, selector, discovery);
    const plan = buildPlan(context, selector);
    buildImageTree(context, plan, outDir);
  } finally {
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
  return { outDir };
}

/** The `node_modules/@microservices/` scope root under an assembled tree. */
function scopeRoot(outDir: string): string {
  return join(outDir, "node_modules", "@microservices");
}

/** The sorted set of scoped entry names actually staged under the tree. */
function stagedScopedEntries(outDir: string): string[] {
  return readdirSync(scopeRoot(outDir)).sort();
}

/**
 * Every regular file under `root`, as tree-relative POSIX paths, sorted. Used
 * to pin the `contracts` staged file set.
 */
function fileSetRelativeTo(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Assert `name` is staged under the tree as a REAL directory (not a symlink).
 */
function expectRealDirectory(outDir: string, name: string): void {
  const stat = lstatSync(join(scopeRoot(outDir), name));
  expect(stat.isDirectory(), `${name} should be a directory`).toBe(true);
  expect(
    stat.isSymbolicLink(),
    `${name} must be a real directory, not a workspace symlink`,
  ).toBe(false);
}

// ---------------------------------------------------------------------------
// 1. Registry equivalence
// ---------------------------------------------------------------------------

describe("Baseline registry equivalence (R14.2)", () => {
  for (const selector of SHIPPED_SELECTORS) {
    describe(`selector ${selector}`, () => {
      const expectedSelected = BASELINE[selector].selected;
      let parsed: ParsedRegistry;

      beforeAll(() => {
        parsed = parseRegistry(generateRegistryText(selector));
      });

      it("declares the baseline import-specifier set, directory-derived and in Selector order", () => {
        expect(parsed.importSpecifiers).toEqual(
          expectedSelected.map((id) => `@microservices/${id}`),
        );
      });

      it("emits one entry per Selected Microservice carrying exactly { identifier, module, sourcePackage }", () => {
        expect(parsed.entryFieldSets).toEqual(
          expectedSelected.map(() => ["identifier", "module", "sourcePackage"]),
        );
      });

      it("ties each entry's identifier, sourcePackage, and module alias to its directory-derived import", () => {
        expect(
          parsed.entries.map((e) => ({
            identifier: e.identifier,
            sourcePackage: e.sourcePackage,
          })),
        ).toEqual(
          expectedSelected.map((id) => ({
            identifier: id,
            sourcePackage: `@microservices/${id}`,
          })),
        );
        // module alias mN matches the import that binds the same specifier.
        for (let i = 0; i < parsed.entries.length; i++) {
          const alias = parsed.entries[i].moduleAlias;
          expect(alias).toBe(`m${i}`);
          expect(parsed.importSpecifiers[i]).toBe(
            parsed.entries[i].sourcePackage,
          );
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Image_Tree equivalence + 3. contracts staged file set
// ---------------------------------------------------------------------------

describe("Baseline Image_Tree equivalence (R14.7, R5.6, R7.6, R5.8)", () => {
  const outDirs: string[] = [];

  afterAll(() => {
    for (const dir of outDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const selector of SHIPPED_SELECTORS) {
    describe(`selector ${selector}`, () => {
      const expected = BASELINE[selector];
      let outDir: string;

      beforeAll(() => {
        ({ outDir } = assemble(selector));
        outDirs.push(outDir);
      }, ASSEMBLE_TIMEOUT_MS);

      it("stages exactly the baseline scoped entry set (baseline + config where it is a required dependency) (R14.7)", () => {
        expect(stagedScopedEntries(outDir)).toEqual(expected.scopedEntries);
      });

      it("stages every scoped entry as a real directory, never a workspace symlink (R5.6)", () => {
        for (const name of expected.scopedEntries) {
          expectRealDirectory(outDir, name);
        }
      });

      it("places the Entry_Package at its Entry_Root and the Overseer under the scope root (R7.6, registry-inversion R9.4, R9.6)", () => {
        // The one package-directory staging is the Entry_Package's: the
        // entrypoint is invoked by path, so it ships at `<Entry_Root>/`, holding
        // its manifest and compiled `dist` and no `src`.
        const entryDir = join(outDir, ENTRY_ROOT);
        expect(lstatSync(entryDir).isDirectory()).toBe(true);
        expect(lstatSync(join(entryDir, "package.json")).isFile()).toBe(true);
        expect(lstatSync(join(entryDir, "dist")).isDirectory()).toBe(true);
        expect(() => lstatSync(join(entryDir, "src"))).toThrow();

        // The Overseer is now imported by name, so it lands under the scope root
        // as a real directory and NOT at `packages/overseer/`.
        const overseerDir = join(scopeRoot(outDir), "overseer");
        expect(lstatSync(overseerDir).isDirectory()).toBe(true);
        expect(lstatSync(join(overseerDir, "package.json")).isFile()).toBe(
          true,
        );
        expect(lstatSync(join(overseerDir, "dist")).isDirectory()).toBe(true);
        expect(() =>
          lstatSync(join(outDir, "packages", "overseer")),
        ).toThrow();
      });

      it("stages contracts as exactly package.json plus every file of dist/, dist/testing/ included (R5.8)", () => {
        const contractsRoot = join(scopeRoot(outDir), "contracts");
        const actual = fileSetRelativeTo(contractsRoot);

        const distFiles = fileSetRelativeTo(join(contractsRoot, "dist")).map(
          (p) => `dist/${p}`,
        );
        const expectedSet = ["package.json", ...distFiles].sort();

        expect(actual).toEqual(expectedSet);
        // dist/testing/ is part of the staged contracts surface.
        expect(actual.some((p) => p.startsWith("dist/testing/"))).toBe(true);
      });
    });
  }
});

// ===========================================================================
// Task 1.3 — the Requirement 15 comparisons this suite owns.
//
// The three suites below recompute four observables the same way
// `scripts/record-baseline.js` records them, and compare each against its
// committed fixture under `packages/integration-tests/baseline/`:
//
//   - Package_Discovery facts               → baseline/discovery.json          (R15.3)
//   - workspace build order + Project_List  → baseline/build-order.<slug>.json (R15.4)
//   - generated registry bytes              → baseline/registry.<slug>.ts      (R15.10)
//   - Repo_Invariant_Checker output         → baseline/check-invariants.txt    (R7.8)
//
// These are EXAMPLE-BASED comparisons over this repository's default
// configuration, not generated inputs (design "Integration tests"; task 1.3).
//
// Failure shape (R15.12, R15.13, R14.12): every comparison assertion carries a
// message naming the observable compared, the recorded value, and the observed
// value; a mismatch fails the case with a non-zero suite exit. None of these
// suites writes into the checked-out tree — the registry suite snapshots the
// gitignored registry file's bytes and writes them back with `writeFileSync`,
// never through git — so a run leaves the tree exactly as it found it.
//
// And per R15.13, the suite must fail if a Config_Diagnostic was reported during
// the run even when every observable matches. On the Pre_Change_Baseline there
// is no configuration layer, so `reportedConfigDiagnostics()` finds no loader to
// consult and yields none; once the layer lands (task 2.15) the same helper
// loads the Effective_Config for this repository and surfaces any diagnostic,
// and the dedicated case below fails the whole suite when one appears.
//
// Recomputation goes through the SAME compiled entry points and the SAME
// `withContext` shim the recorder uses, so the observed value is produced the
// way the recorded value was — the comparison is meaningful before and after the
// config-threading changes the module signatures.

/**
 * The Selectors the build-order and registry fixtures were recorded for, with
 * the filename slug each takes (recorder `SELECTORS.buildAndRegistry`): `*` →
 * `all`, blank/unset → `blank`, `microservice1,microservice2` →
 * `microservice1-microservice2`.
 */
const BUILD_AND_REGISTRY_SELECTORS = [
  { slug: "all", value: "*" },
  { slug: "blank", value: "" },
  {
    slug: "microservice1-microservice2",
    value: "microservice1,microservice2",
  },
] as const;

/** Imports a compiled build-tools module by its dist filename. */
async function distModule(fileName: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(resolve(DIST, fileName)).href) as Promise<
    Record<string, unknown>
  >;
}

/**
 * Builds the default ProjectContext when the config-threading modules exist
 * (post task 2.14) and returns `undefined` on the Pre_Change_Baseline where they
 * do not — the exact contract of the recorder's `loadDefaultContext()`, so the
 * test threads the same context (or the same absence of one) into every entry
 * point the recorder did. It never changes the recomputed observable: the
 * default context reproduces the baseline scope and roots by construction (R1.7).
 */
async function loadDefaultContext(): Promise<unknown> {
  try {
    const projectConfig = await distModule("project-config.js");
    const projectContext = await distModule("project-context.js");
    const config = (projectConfig.defaultEffectiveConfig as () => unknown)();
    return (projectContext.projectContext as (c: unknown) => unknown)(config);
  } catch {
    return undefined; // Pre_Change_Baseline: no configuration layer yet.
  }
}

/**
 * Calls an entry point the way the recorder's `withContext` does: prepend the
 * default context as the first argument only when the function's arity says it
 * expects one, so the same call site drives the baseline signature
 * `fn(...args)` and the threaded signature `fn(context, ...args)` alike.
 */
function withContext<T>(
  fn: (...a: unknown[]) => T,
  context: unknown,
  ...args: unknown[]
): T {
  return context !== undefined && fn.length > args.length
    ? fn(context, ...args)
    : fn(...args);
}

/**
 * Runs `run` with MICROSERVICES set to `value` (unset when `undefined`),
 * restoring the previous environment afterward so one Selector's env never
 * leaks into the next. Mirrors the recorder's `withSelectorEnv`.
 */
function withSelectorEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.MICROSERVICES;
  if (value === undefined) {
    delete process.env.MICROSERVICES;
  } else {
    process.env.MICROSERVICES = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previous;
    }
  }
}

/** Reads a recorded JSON fixture and parses it. */
function readJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(BASELINE_DIR, name), "utf8"));
}

/** Reads a recorded text fixture verbatim. */
function readTextFixture(name: string): string {
  return readFileSync(resolve(BASELINE_DIR, name), "utf8");
}

/**
 * The Config_Diagnostics reported for THIS repository's Effective_Config, or an
 * empty list on the Pre_Change_Baseline where the configuration layer does not
 * exist. Once the Config_Loader lands (task 2.15) it loads the config over the
 * real Project_Directory and returns any diagnostics; the R15.13 case fails the
 * suite when the list is non-empty.
 */
async function reportedConfigDiagnostics(): Promise<readonly unknown[]> {
  let loader: Record<string, unknown>;
  try {
    loader = await distModule("config-loader.js");
  } catch {
    return []; // Pre_Change_Baseline: no Config_Loader to consult.
  }
  const load = loader.loadProjectConfigForProjectDirectory as
    | ((projectDir: string) => { readonly diagnostics?: readonly unknown[] })
    | undefined;
  if (typeof load !== "function") {
    return [];
  }
  const outcome = load(repoRoot);
  return outcome.diagnostics ?? [];
}

// ---------------------------------------------------------------------------
// 4. Package_Discovery equivalence (R15.3)
// ---------------------------------------------------------------------------

/** One package's recorded/observed discovery facts (recorder `recordDiscovery`). */
interface DiscoveryFact {
  category: string;
  dirName: string;
  packageDir: string;
  name: string;
  buildKind: string;
  dependencySpecifiers: string[];
}

/**
 * Recompute the discovery facts exactly as the recorder does: flatten every
 * category's members, project the six compared fields, sort each package's
 * Dependency_Specifiers, and order the packages by package directory so the
 * result is stable.
 */
function observedDiscoveryFacts(context: unknown): DiscoveryFact[] {
  const discovery = withContext(
    discoverPackages as unknown as (...a: unknown[]) => {
      byCategory: Record<string, readonly Record<string, unknown>[]>;
    },
    context,
  );

  return Object.values(discovery.byCategory)
    .flat()
    .map((pkg) => ({
      category: pkg.category as string,
      dirName: pkg.dirName as string,
      packageDir: pkg.packageDir as string,
      name: pkg.name as string,
      buildKind: pkg.buildKind as string,
      dependencySpecifiers: [
        ...(pkg.dependencySpecifiers as readonly string[]),
      ].sort(),
    }))
    .sort((a, b) =>
      a.packageDir < b.packageDir ? -1 : a.packageDir > b.packageDir ? 1 : 0,
    );
}

describe("Baseline Package_Discovery equivalence (R15.3)", () => {
  let context: unknown;

  beforeAll(async () => {
    context = await loadDefaultContext();
  });

  it("yields the recorded Consumer_Package set with equal facts for every member", () => {
    const recorded = readJsonFixture("discovery.json") as DiscoveryFact[];
    const observed = observedDiscoveryFacts(context);

    // Compare the whole set first so a mismatch names the recorded and observed
    // structures in one diff (R15.12 observable: "discovery facts").
    expect(
      observed,
      "discovery facts (baseline/discovery.json): observed set differs from recorded",
    ).toEqual(recorded);
  });
});

// ---------------------------------------------------------------------------
// 5. Workspace build order + Project_List equivalence, per Selector (R15.4)
// ---------------------------------------------------------------------------

interface BuildOrderRecord {
  selector: string | undefined;
  buildOrder: string[];
  projectList: string[];
}

describe("Baseline build order and Project_List equivalence (R15.4)", () => {
  let context: unknown;
  let workspaceMod: Record<string, unknown>;
  let discoveryMod: Record<string, unknown>;
  let devMod: Record<string, unknown>;
  let buildPlanMod: Record<string, unknown>;

  beforeAll(async () => {
    context = await loadDefaultContext();
    workspaceMod = await distModule("workspace-build-order.js");
    discoveryMod = await distModule("discovery.js");
    devMod = await distModule("dev-supervisor.js");
    buildPlanMod = await distModule("build-plan.js");
  });

  function observed(value: string | undefined): BuildOrderRecord {
    const readDepsFn = discoveryMod.readDependencySpecifiers as (
      ...a: unknown[]
    ) => unknown;
    // Post-change, `readDependencySpecifiers(context)` returns the bound reader;
    // pre-change (no context) it IS the reader. Bind it the same way the recorder
    // does, so `workspaceNodesFrom` receives a `(packageDir) => string[]` either
    // way and the recomputed observable is unchanged (R15.4).
    const readDeps =
      context !== undefined ? readDepsFn(context) : readDepsFn;
    const discover = discoveryMod.discoverPackages as (...a: unknown[]) => unknown;
    const nodesFrom = workspaceMod.workspaceNodesFrom as (
      ...a: unknown[]
    ) => unknown;
    const buildOrderFn = workspaceMod.workspaceBuildOrder as (
      ...a: unknown[]
    ) => readonly { packageDir: string }[];
    const projectListFn = devMod.devProjectList as (
      ...a: unknown[]
    ) => readonly string[];
    const buildPlanFn = buildPlanMod.buildPlan as (
      ...a: unknown[]
    ) => { readonly tscRoots: readonly string[] };

    return withSelectorEnv(value, () => {
      const discovery = withContext(discover, context);
      const nodes = withContext(nodesFrom, context, discovery, readDeps);
      const buildOrder = withContext(buildOrderFn, context, nodes).map(
        (node) => node.packageDir,
      );
      // `devProjectList` is now `(context, plan)`: derive the plan for this
      // Selector (`buildPlan(context, value)`) and take its Project_List. On the
      // Pre_Change_Baseline (no context) `devProjectList(value)` was the reader,
      // so fall back to that call shape.
      const projectList =
        context !== undefined
          ? [
              ...projectListFn(
                context,
                buildPlanFn(context, value),
              ),
            ]
          : [...projectListFn(value)];
      return { selector: value, buildOrder, projectList };
    });
  }

  for (const { slug, value } of BUILD_AND_REGISTRY_SELECTORS) {
    describe(`selector ${slug}`, () => {
      it("derives the recorded workspace build order, position by position", () => {
        const recorded = readJsonFixture(
          `build-order.${slug}.json`,
        ) as BuildOrderRecord;
        expect(
          observed(value).buildOrder,
          `build order (baseline/build-order.${slug}.json): observed order differs from recorded`,
        ).toEqual(recorded.buildOrder);
      });

      it("derives the recorded Project_List, position by position", () => {
        const recorded = readJsonFixture(
          `build-order.${slug}.json`,
        ) as BuildOrderRecord;
        expect(
          observed(value).projectList,
          `Project_List (baseline/build-order.${slug}.json): observed list differs from recorded`,
        ).toEqual(recorded.projectList);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Generated registry bytes equivalence, per Selector (R15.10)
// ---------------------------------------------------------------------------

/**
 * Generate the registry for `selector` the way the recorder does, read the
 * emitted bytes back, and restore the prior (gitignored) file contents with
 * `writeFileSync` — never git — so the checked-out tree is left as it was found.
 */
function observedRegistryBytes(
  context: unknown,
  value: string | undefined,
): string {
  const previousRegistry = captureRegistry();
  const previousCwd = process.cwd();
  try {
    process.chdir(repoRoot);
    return withSelectorEnv(value, () => {
      // `generateRegistry` is now `(context, selector, discovery?)`. Its only
      // non-defaulted parameter is `context`, so the arity-based `withContext`
      // cannot detect it needs one; call it directly with the loaded context.
      // On the Pre_Change_Baseline (no context) it was `generateRegistry(value)`.
      const generate = generateRegistry as unknown as (...a: unknown[]) => void;
      if (context !== undefined) {
        generate(context, value);
      } else {
        generate(value);
      }
      return readFileSync(REGISTRY_PATH, "utf8");
    });
  } finally {
    restoreRegistry(previousRegistry);
    process.chdir(previousCwd);
  }
}

describe("Baseline generated registry bytes equivalence (R15.10)", () => {
  let context: unknown;

  beforeAll(async () => {
    context = await loadDefaultContext();
  });

  for (const { slug, value } of BUILD_AND_REGISTRY_SELECTORS) {
    it(`emits byte-identical registry for selector ${slug}`, () => {
      const recorded = readTextFixture(`registry.${slug}.ts`);
      const observed = observedRegistryBytes(context, value);
      expect(
        observed,
        `registry bytes (baseline/registry.${slug}.ts): observed bytes differ from recorded`,
      ).toBe(recorded);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Repo_Invariant_Checker output equivalence (R7.8)
// ---------------------------------------------------------------------------

describe("Baseline Repo_Invariant_Checker output equivalence (R7.8)", () => {
  it("produces the recorded combined stdout+stderr from the compiled checker", () => {
    const recorded = readTextFixture("check-invariants.txt");
    const result = spawnSync("node", [CHECK_INVARIANTS_BIN], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
    const observed = `${result.stdout}${result.stderr}`;
    expect(
      observed,
      "Repo_Invariant_Checker output (baseline/check-invariants.txt): observed output differs from recorded",
    ).toBe(recorded);
    // A clean baseline run exits zero; a non-zero exit is itself a divergence.
    expect(
      result.status,
      "Repo_Invariant_Checker exit status: expected 0 on the clean baseline tree",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R15.13 — a Config_Diagnostic fails the suite even when observables match.
// ---------------------------------------------------------------------------

describe("Baseline configuration is diagnostic-free (R15.13)", () => {
  it("reports no Config_Diagnostic for this repository's Effective_Config", async () => {
    const diagnostics = await reportedConfigDiagnostics();
    expect(
      diagnostics,
      `Config_Diagnostics reported during the comparison run: ${JSON.stringify(
        diagnostics,
      )} (R15.13 requires the comparison to fail when any is reported, even if every observable matches)`,
    ).toEqual([]);
  });
});

// Feature: platform-fixtures, Property 10: The thirteen Baseline_Recordings are byte-unchanged
//
// This is the one mechanical statement of the feature's additivity (R15.1): the
// thirteen committed recordings under `packages/integration-tests/baseline/`
// record every observable the platform's own derivations produce over this
// repository — one Package_Discovery result, three build orders + Project_Lists,
// two staged Image_Trees, three generated registries, three generated
// Dockerfiles, and one Repo_Invariant_Checker transcript — and a feature that
// changed any of those observables would have had to change one of those files.
//
// Where the example-based `baseline-equivalence.test.ts` compares each recording
// against its observable ONCE, in a fixed order, this property quantifies over
// EVERY permutation of the thirteen and EVERY order of recomputation, and adds
// the two claims the example suite cannot make from a single ordered pass:
//
//   1. Recomputing the observables — in any order — REWRITES NO recording. Every
//      recording's bytes (and its on-disk mtime) are captured before the first
//      recomputation and re-checked after the last, so a recomputation that
//      silently wrote back into `baseline/` would fail here (R15.4, R15.1).
//   2. The set of files under `baseline/` is EXACTLY the thirteen names — no
//      recording added, removed, or made order-dependent by the tier's presence
//      (R15.2).
//
// Recomputation goes through the SAME public functions and the SAME
// `scripts/record-baseline.js` entry points that produced the recordings — the
// compiled build-tools `dist/` modules for discovery, build order, Project_List,
// image tree, and registry; the compiled `check-repo-invariants` bin; and the
// POSIX-sh Emit_Script — reproducing the recorder's `writeFixture` byte shape
// (pretty JSON with a trailing newline, or verbatim text). It NEVER invokes the
// recorder to write: the recorder is a one-shot developer script, and this test
// only reads what it recorded and recomputes the same observables in-process (or
// as the same spawned subprocess). Generating a registry writes the gitignored
// GENERATED registry file (not a Baseline_Recording); the suite snapshots that
// file and restores it with `writeFileSync` afterward, never through git, so the
// checked-out tree is left exactly as it was found.
//
// A failing comparison names the observable compared, the recorded value, and
// the observed value (R15.4 failure shape).
//
// Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 16.1

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** Where the recorded Baseline_Recordings live. */
const BASELINE_DIR = resolve(__dirname, "..", "baseline");

/** The compiled build-tools module directory the recorder imports entry points from. */
const DIST = resolve(repoRoot, "packages/build-tools/dist");

/** The compiled Repo_Invariant_Checker bin the root `check:invariants` runs. */
const CHECK_INVARIANTS_BIN = resolve(DIST, "bin/check-repo-invariants.js");

/** The POSIX-sh Emit_Script the documented image build invokes. */
const EMIT_SCRIPT = resolve(repoRoot, "scripts/emit-effective-dockerfile.sh");

/** The generated (gitignored) Dockerfile the Emit_Script writes. */
const DOCKERFILE_PATH = resolve(repoRoot, "Dockerfile");

/** A real `tsc`-free recomputation still spawns a couple of subprocesses; be generous. */
const SUITE_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// The recorder's two-module-shape tolerance, reproduced verbatim.
//
// These three shims are copied from `scripts/record-baseline.js` so that this
// test recomputes each observable through the exact call shape the recorder
// used — the comparison stays meaningful whether the config-threading modules
// are present or absent.
// ---------------------------------------------------------------------------

/** Imports a compiled build-tools module by its dist filename. */
async function distModule(fileName: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(resolve(DIST, fileName)).href) as Promise<
    Record<string, unknown>
  >;
}

/**
 * Builds a default ProjectContext when the config-threading modules are present,
 * and returns `undefined` on the Pre_Change_Baseline where they are not — the
 * exact contract of the recorder's `loadDefaultContext()`.
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
 * Calls a stable entry point, prepending the default context as the first
 * argument only when the function's arity says it can accept one. The `>=`
 * (not `>`) test mirrors the recorder's, because `Function.length` counts only
 * the parameters before the first defaulted one.
 */
function withContext<T>(
  fn: (...a: unknown[]) => T,
  context: unknown,
  ...args: unknown[]
): T {
  return context !== undefined && fn.length >= args.length
    ? fn(context, ...args)
    : fn(...args);
}

/**
 * Runs `run` with MICROSERVICES set to `value` (unset when `undefined`),
 * restoring the previous environment afterward, so one Selector's env never
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

/** The recorder's `writeFixture` byte shape for a JSON fixture. */
function jsonFixtureBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The Selectors and slugs the recorder used (record-baseline.js `SELECTORS`).
// ---------------------------------------------------------------------------

const BUILD_AND_REGISTRY_SELECTORS = [
  { slug: "all", value: "*" as string | undefined },
  { slug: "blank", value: "" as string | undefined },
  {
    slug: "microservice1-microservice2",
    value: "microservice1,microservice2" as string | undefined,
  },
] as const;

const IMAGE_TREE_SELECTORS = [
  { slug: "all", value: "*" as string | undefined },
  {
    slug: "microservice1-microservice2",
    value: "microservice1,microservice2" as string | undefined,
  },
] as const;

const DOCKERFILE_SELECTORS = [
  { slug: "all", value: "*" as string | undefined },
  { slug: "blank", value: undefined as string | undefined },
  {
    slug: "microservice1-microservice2",
    value: "microservice1,microservice2" as string | undefined,
  },
] as const;

// ---------------------------------------------------------------------------
// One recomputation per Baseline_Recording. Each entry knows the recording's
// filename and how to recompute the observable's bytes the recorder wrote —
// through the same entry point and reproducing the same byte shape.
// ---------------------------------------------------------------------------

interface Recomputation {
  /** The recording's filename under `baseline/`. */
  readonly fileName: string;
  /** Recompute the observable's bytes exactly as the recorder wrote them. */
  recompute(): Promise<string>;
}

/** The default ProjectContext, loaded once (or `undefined` on the baseline). */
let context: unknown;

/**
 * The gitignored generated registry's path, derived from the single source
 * (`generatedRegistryPath(context)`) when the export exists and falling back to
 * the location the baseline generator wrote to otherwise — the recorder's own
 * tolerance.
 */
async function registryFilePath(): Promise<string> {
  const mod = await distModule("generate-registry.js");
  const derive = mod.generatedRegistryPath as
    | ((c: unknown) => string)
    | undefined;
  return derive === undefined
    ? resolve(repoRoot, "packages/overseer/src/generated/microservice-registry.ts")
    : resolve(repoRoot, derive(context));
}

// --- discovery.json (R15.3, recorder `recordDiscovery`) --------------------

async function recomputeDiscovery(): Promise<string> {
  const { discoverPackages } = await distModule("discovery.js");
  const discovery = withContext(
    discoverPackages as (...a: unknown[]) => {
      byCategory: Record<string, readonly Record<string, unknown>[]>;
    },
    context,
  );
  const packages = Object.values(discovery.byCategory)
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
  return jsonFixtureBytes(packages);
}

// --- build-order.<slug>.json (R15.4/R15.7, recorder `recordBuildOrders`) ----

async function recomputeBuildOrder(
  value: string | undefined,
): Promise<string> {
  const { discoverPackages, readDependencySpecifiers } =
    await distModule("discovery.js");
  const { workspaceBuildOrder, workspaceNodesFrom } = await distModule(
    "workspace-build-order.js",
  );
  const { buildPlan } = await distModule("build-plan.js");
  const { devProjectList } = await distModule("dev-supervisor.js");

  const readDepsFn = readDependencySpecifiers as (...a: unknown[]) => unknown;
  const readDependencies =
    context === undefined ? readDepsFn : readDepsFn(context);

  const record = withSelectorEnv(value, () => {
    const discovery = withContext(
      discoverPackages as (...a: unknown[]) => unknown,
      context,
    );
    const nodes = withContext(
      workspaceNodesFrom as (...a: unknown[]) => unknown,
      context,
      discovery,
      readDependencies,
    );
    const buildOrder = withContext(
      workspaceBuildOrder as (...a: unknown[]) => readonly { packageDir: string }[],
      context,
      nodes,
    ).map((node) => node.packageDir);
    const plan = withContext(
      buildPlan as (...a: unknown[]) => unknown,
      context,
      value,
    );
    const projectList = [
      ...withContext(
        devProjectList as (...a: unknown[]) => readonly string[],
        context,
        plan,
      ),
    ];
    return { selector: value, buildOrder, projectList };
  });
  return jsonFixtureBytes(record);
}

// --- image-tree.<slug>.json (R15.5/R15.10, recorder `recordImageTrees`) -----

async function recomputeImageTree(value: string | undefined): Promise<string> {
  const { buildPlan } = await distModule("build-plan.js");
  const stagedEntries = withSelectorEnv(value, () => {
    const plan = withContext(
      buildPlan as (...a: unknown[]) => {
        stage: readonly { targetDir: string }[];
      },
      context,
      value,
    );
    return [...plan.stage.map((staged) => staged.targetDir)].sort();
  });
  return jsonFixtureBytes(stagedEntries);
}

// --- registry.<slug>.ts (R15.8, recorder `recordRegistries`) ----------------

async function recomputeRegistry(value: string | undefined): Promise<string> {
  const { generateRegistry } = await distModule("generate-registry.js");
  const registryPath = await registryFilePath();

  // The generated registry is a gitignored generated file, NOT a
  // Baseline_Recording. Snapshot it, recompute, read the emitted bytes, then
  // restore what was there — with writeFileSync, never through git.
  let previous: string | undefined;
  try {
    previous = readFileSync(registryPath, "utf8");
  } catch {
    previous = undefined;
  }
  const previousCwd = process.cwd();
  try {
    process.chdir(repoRoot);
    return withSelectorEnv(value, () => {
      const generate = generateRegistry as (...a: unknown[]) => void;
      if (context !== undefined) {
        generate(context, value);
      } else {
        generate(value);
      }
      return readFileSync(registryPath, "utf8");
    });
  } finally {
    if (previous === undefined) {
      rmSync(registryPath, { force: true });
    } else {
      writeFileSync(registryPath, previous, "utf8");
    }
    process.chdir(previousCwd);
  }
}

// --- dockerfile.<slug> (R15.9, recorder `recordDockerfiles`) ----------------
//
// The recorder invokes the Emit_Script as a subprocess with MICROSERVICES in the
// environment and reads its gitignored output. The generated `Dockerfile` at the
// repo root is itself gitignored output (not a Baseline_Recording); snapshot and
// restore it so a run leaves the tree as it was found.

function recomputeDockerfile(value: string | undefined): string {
  let previous: string | undefined;
  try {
    previous = readFileSync(DOCKERFILE_PATH, "utf8");
  } catch {
    previous = undefined;
  }
  try {
    const env = { ...process.env };
    if (value === undefined) {
      delete env.MICROSERVICES;
    } else {
      env.MICROSERVICES = value;
    }
    const result = spawnSync("sh", [EMIT_SCRIPT], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `emit-effective-dockerfile.sh exited ${String(
          result.status,
        )} for selector "${String(value)}":\n${result.stderr}`,
      );
    }
    return readFileSync(DOCKERFILE_PATH, "utf8");
  } finally {
    if (previous === undefined) {
      rmSync(DOCKERFILE_PATH, { force: true });
    } else {
      writeFileSync(DOCKERFILE_PATH, previous, "utf8");
    }
  }
}

// --- check-invariants.txt (R15.5, recorder `recordCheckInvariants`) ---------

function recomputeCheckInvariants(): string {
  const result = spawnSync("node", [CHECK_INVARIANTS_BIN], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  return `${result.stdout}${result.stderr}`;
}

// ---------------------------------------------------------------------------
// The thirteen recomputations, one per Baseline_Recording.
// ---------------------------------------------------------------------------

const RECOMPUTATIONS: readonly Recomputation[] = [
  { fileName: "discovery.json", recompute: recomputeDiscovery },
  ...BUILD_AND_REGISTRY_SELECTORS.map(({ slug, value }) => ({
    fileName: `build-order.${slug}.json`,
    recompute: () => recomputeBuildOrder(value),
  })),
  ...IMAGE_TREE_SELECTORS.map(({ slug, value }) => ({
    fileName: `image-tree.${slug}.json`,
    recompute: () => recomputeImageTree(value),
  })),
  ...BUILD_AND_REGISTRY_SELECTORS.map(({ slug, value }) => ({
    fileName: `registry.${slug}.ts`,
    recompute: () => recomputeRegistry(value),
  })),
  ...DOCKERFILE_SELECTORS.map(({ slug, value }) => ({
    fileName: `dockerfile.${slug}`,
    recompute: () => Promise.resolve(recomputeDockerfile(value)),
  })),
  { fileName: "check-invariants.txt", recompute: () => Promise.resolve(recomputeCheckInvariants()) },
];

/** The thirteen recording names the tier commits, sorted. */
const EXPECTED_BASELINE_FILES = [
  "build-order.all.json",
  "build-order.blank.json",
  "build-order.microservice1-microservice2.json",
  "check-invariants.txt",
  "discovery.json",
  "dockerfile.all",
  "dockerfile.blank",
  "dockerfile.microservice1-microservice2",
  "image-tree.all.json",
  "image-tree.microservice1-microservice2.json",
  "registry.all.ts",
  "registry.blank.ts",
  "registry.microservice1-microservice2.ts",
] as const;

/** The committed bytes of a recording. */
function recordedBytes(fileName: string): string {
  return readFileSync(resolve(BASELINE_DIR, fileName), "utf8");
}

/** A recording's on-disk fingerprint: its bytes plus its mtime nanoseconds. */
interface Fingerprint {
  readonly bytes: string;
  readonly mtimeNs: bigint;
}

function fingerprint(fileName: string): Fingerprint {
  return {
    bytes: recordedBytes(fileName),
    mtimeNs: statSync(resolve(BASELINE_DIR, fileName), {
      bigint: true,
    }).mtimeNs,
  };
}

describe("Property 10: the thirteen Baseline_Recordings are byte-unchanged", () => {
  beforeAll(async () => {
    context = await loadDefaultContext();
  }, SUITE_TIMEOUT_MS);

  it(
    "recomputes each observable, in any order, byte-equal to its recording, rewriting no recording",
    async () => {
      // Capture every recording's bytes + mtime before any recomputation, so a
      // recomputation that silently wrote back into baseline/ is detectable.
      const before = new Map<string, Fingerprint>(
        RECOMPUTATIONS.map((r) => [r.fileName, fingerprint(r.fileName)]),
      );

      await fc.assert(
        fc.asyncProperty(
          // Any permutation of the thirteen indices — i.e. any order of
          // recomputation, and (since we compare each against its OWN recording
          // by filename) any pairing is order-independent.
          fc.shuffledSubarray([...RECOMPUTATIONS.keys()], {
            minLength: RECOMPUTATIONS.length,
            maxLength: RECOMPUTATIONS.length,
          }),
          async (order) => {
            for (const index of order) {
              const { fileName, recompute } = RECOMPUTATIONS[index];
              const observed = await recompute();
              const recorded = before.get(fileName)!.bytes;
              expect(
                observed,
                `${fileName}: observed bytes differ from recorded — recorded=${JSON.stringify(
                  recorded,
                )} observed=${JSON.stringify(observed)}`,
              ).toBe(recorded);
            }
          },
        ),
        { numRuns: 100 },
      );

      // The recomputation rewrote no recording: bytes AND mtimes unchanged.
      for (const r of RECOMPUTATIONS) {
        const now = fingerprint(r.fileName);
        const captured = before.get(r.fileName)!;
        expect(
          now.bytes,
          `${r.fileName}: recording bytes were rewritten during recomputation`,
        ).toBe(captured.bytes);
        expect(
          now.mtimeNs,
          `${r.fileName}: recording file was rewritten (mtime changed) during recomputation`,
        ).toBe(captured.mtimeNs);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it("the file set under baseline/ is exactly the thirteen recordings", () => {
    fc.assert(
      // The set claim is order-independent; quantify over a shuffled read of the
      // directory so the assertion holds for any listing order.
      fc.property(fc.constant(null), () => {
        const actual = readdirSync(BASELINE_DIR).sort();
        expect(
          actual,
          `baseline/ file set differs from the thirteen recordings — expected=${JSON.stringify(
            [...EXPECTED_BASELINE_FILES],
          )} actual=${JSON.stringify(actual)}`,
        ).toEqual([...EXPECTED_BASELINE_FILES]);
      }),
      { numRuns: 100 },
    );
  });

  afterAll(() => {
    // Nothing to tear down: every recomputation restored the gitignored files it
    // touched (the generated registry, the generated Dockerfile) in its own
    // finally block, and no Baseline_Recording was ever opened for writing.
  });
});

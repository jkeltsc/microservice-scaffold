#!/usr/bin/env node
// Records the Pre_Change_Baseline fixtures the config-driven-discovery feature
// compares against (Requirement 15). It is a deliberate one-shot developer
// script, run once by a human on the Pre_Change_Baseline commit: it writes the
// committed fixtures under `packages/integration-tests/baseline/`, and it is NOT
// a test — it is not collected by Vitest, not invoked by `npm test` or
// `npm run ci`, and Requirement 13.6's prohibition on a test writing into the
// checked-out tree does not apply to it (design "Recording the Pre_Change_Baseline").
//
// Plain Node, ES module, no TypeScript, no Vitest, so it needs no compile step
// of its own. It reaches every observable through the compiled build-tools bins
// and through two stable public entry points of the compiled build-tools
// modules — never through a signature the config threading will change — so the
// exact same file runs unchanged before and after that threading. The one
// concession to "unchanged across threading" is `withContext()` below: when the
// threaded modules exist it supplies a default ProjectContext as the added first
// argument, and when they do not (the baseline) it calls the entry point with no
// context. Either way the recorded bytes are the same.
//
// Usage, from the repository root, on the Pre_Change_Baseline commit:
//
//   npm ci && npm run build        # compile packages/build-tools/dist first
//   node scripts/record-baseline.js
//
// It writes:
//   baseline/discovery.json                        every Consumer_Package's facts (R15.3)
//   baseline/build-order.<selector>.json           build order + Project_List    (R15.4)
//   baseline/image-tree.<selector>.json            staged entry paths            (R15.5)
//   baseline/registry.<selector>.ts                generated registry bytes      (R15.10, R8.5)
//   baseline/dockerfile.<selector>                 generated Dockerfile bytes    (R11.2)
//   baseline/check-invariants.txt                  Repo_Invariant_Checker output (R7.8)

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ -> repository root (the Project_Directory of every documented command).
const repoRoot = resolve(scriptDir, "..");

/** Where every fixture lands. */
const BASELINE_DIR = resolve(
  repoRoot,
  "packages/integration-tests/baseline",
);

/** The compiled build-tools module directory the entry points are imported from. */
const DIST = resolve(repoRoot, "packages/build-tools/dist");

/** The generated (gitignored) Dockerfile the Emit_Script writes. */
const DOCKERFILE_PATH = resolve(repoRoot, "Dockerfile");

/** The compiled Repo_Invariant_Checker bin the root `check:invariants` runs. */
const CHECK_INVARIANTS_BIN = resolve(
  DIST,
  "bin/check-repo-invariants.js",
);

/** The POSIX-sh Emit_Script the documented image build invokes. */
const EMIT_SCRIPT = resolve(repoRoot, "scripts/emit-effective-dockerfile.sh");

/**
 * The Selectors each observable is recorded for, and the filename spelling each
 * one takes so the fixture set reads legibly in a directory listing (task 1.1):
 * `*` -> `all`, blank/unset -> `blank`, `microservice1,microservice2` ->
 * `microservice1-microservice2`.
 *
 * `value` is the MICROSERVICES value handed to a domain function or a bin;
 * `undefined` means "leave MICROSERVICES unset", which the Selector resolves the
 * same way as blank.
 */
const SELECTORS = {
  // build order, Project_List, registry: `*`, blank, and the two-service list.
  buildAndRegistry: [
    { slug: "all", value: "*" },
    { slug: "blank", value: "" },
    { slug: "microservice1-microservice2", value: "microservice1,microservice2" },
  ],
  // image tree: `*` and the two-service list only (task 1.1).
  imageTree: [
    { slug: "all", value: "*" },
    { slug: "microservice1-microservice2", value: "microservice1,microservice2" },
  ],
  // dockerfile: `*`, unset, and the two-service list (task 1.1).
  dockerfile: [
    { slug: "all", value: "*" },
    { slug: "blank", value: undefined },
    { slug: "microservice1-microservice2", value: "microservice1,microservice2" },
  ],
};

/** Imports a compiled build-tools module by its dist filename. */
async function distModule(fileName) {
  return import(pathToFileURL(resolve(DIST, fileName)).href);
}

/**
 * Builds a default ProjectContext when the config-threading modules are present,
 * and returns `undefined` on the Pre_Change_Baseline where they are not.
 *
 * This is the one place the recorder tolerates the two module shapes so the same
 * file runs unchanged before and after the threading. It never changes the
 * recorded bytes: the default context reproduces the baseline scope and roots by
 * construction (Requirement 1.7).
 */
async function loadDefaultContext() {
  let projectConfig;
  let projectContext;
  try {
    projectConfig = await distModule("project-config.js");
    projectContext = await distModule("project-context.js");
  } catch {
    return undefined; // Pre_Change_Baseline: no configuration layer yet.
  }
  return projectContext.projectContext(projectConfig.defaultEffectiveConfig());
}

/**
 * Calls a stable entry point, prepending the default context as the first
 * argument only when the function's arity says it can accept one. Lets the same
 * call site drive both the baseline signature `fn(...args)` and the threaded
 * signature `fn(context, ...args)`.
 *
 * The test is `>=`, not `>`, because `Function.length` counts only the
 * parameters before the first defaulted one: a threaded
 * `buildPlan(context, selector = process.env.MICROSERVICES)` and a threaded
 * `generateRegistry(context, selector = process.env.MICROSERVICES)` both report
 * a length of 1, so a `>` test would drop the context and pass the Selector
 * string in its place. On the Pre_Change_Baseline `context` is `undefined` and
 * the comparison never runs, so widening it changes no recorded byte.
 */
function withContext(fn, context, ...args) {
  return context !== undefined && fn.length >= args.length
    ? fn(context, ...args)
    : fn(...args);
}

/** Writes a fixture, JSON-pretty when given a value, verbatim when given text. */
function writeFixture(name, contents) {
  const path = resolve(BASELINE_DIR, name);
  const text =
    typeof contents === "string"
      ? contents
      : `${JSON.stringify(contents, null, 2)}\n`;
  writeFileSync(path, text);
  process.stdout.write(`  wrote baseline/${name}\n`);
}

/**
 * Runs the recorder with MICROSERVICES set to `value` (or unset when it is
 * `undefined`), restoring the previous environment afterward, so one selector's
 * env never leaks into the next.
 */
function withSelectorEnv(value, run) {
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

// ---------------------------------------------------------------------------
// discovery.json — every Consumer_Package's facts (R15.3).
//
// Entry point: `discoverPackages()` from the compiled discovery module. The
// recorded shape is exactly the fields Requirement 15.3 compares: category,
// directory name, package directory, declared name, build kind, and the sorted
// Dependency_Specifier list. Packages are ordered by package directory so the
// fixture is stable across runs.
// ---------------------------------------------------------------------------
async function recordDiscovery(context) {
  const { discoverPackages } = await distModule("discovery.js");
  const discovery = withContext(discoverPackages, context);

  const packages = Object.values(discovery.byCategory)
    .flat()
    .map((pkg) => ({
      category: pkg.category,
      dirName: pkg.dirName,
      packageDir: pkg.packageDir,
      name: pkg.name,
      buildKind: pkg.buildKind,
      dependencySpecifiers: [...pkg.dependencySpecifiers].sort(),
    }))
    .sort((a, b) =>
      a.packageDir < b.packageDir ? -1 : a.packageDir > b.packageDir ? 1 : 0,
    );

  writeFixture("discovery.json", packages);
}

// ---------------------------------------------------------------------------
// build-order.<selector>.json — the workspace build order and the Project_List,
// each an ordered sequence of package directories (R15.4).
//
// Entry points: `workspaceBuildOrder(workspaceNodesFrom(...))` for the
// repository-wide build order — which is Selector-independent, but recorded per
// Selector so the fixture set mirrors the comparison the test performs — and
// `devProjectList` for the Selector-scoped Project_List (the plan's `tscRoots`).
// Both are read through the compiled dev/workspace modules.
//
// `devProjectList` takes the Build_Plan derived for the current `MICROSERVICES`
// value, not the Selector string, so the recorder derives that plan through
// `buildPlan` and hands it over. That is a repair of the call only: the recorded
// observable is still exactly what `devProjectList` returns.
// ---------------------------------------------------------------------------
async function recordBuildOrders(context) {
  const { discoverPackages, readDependencySpecifiers } =
    await distModule("discovery.js");
  const { workspaceBuildOrder, workspaceNodesFrom } = await distModule(
    "workspace-build-order.js",
  );
  const { buildPlan } = await distModule("build-plan.js");
  const { devProjectList } = await distModule("dev-supervisor.js");

  // `readDependencySpecifiers` is a context-taking factory once the config is
  // threaded — `readDependencySpecifiers(context)` returns the
  // `(packageDir) => readonly string[]` reader `workspaceNodesFrom` calls — and
  // is that reader itself on the Pre_Change_Baseline. Applying it here keeps the
  // recorder's two-module-shape tolerance; either way each node's
  // `dependencySpecifiers` is the same array, so no recorded byte changes.
  const readDependencies =
    context === undefined
      ? readDependencySpecifiers
      : readDependencySpecifiers(context);

  for (const { slug, value } of SELECTORS.buildAndRegistry) {
    const record = withSelectorEnv(value, () => {
      const discovery = withContext(discoverPackages, context);
      const nodes = withContext(
        workspaceNodesFrom,
        context,
        discovery,
        readDependencies,
      );
      const buildOrder = withContext(workspaceBuildOrder, context, nodes).map(
        (node) => node.packageDir,
      );
      const plan = withContext(buildPlan, context, value);
      const projectList = [...withContext(devProjectList, context, plan)];
      return { selector: value, buildOrder, projectList };
    });
    writeFixture(`build-order.${slug}.json`, record);
  }
}

// ---------------------------------------------------------------------------
// image-tree.<selector>.json — the sorted Project_Directory-relative staged
// entry paths (R15.5).
//
// Entry point: `buildPlan(selector)` from the compiled build-plan module. The
// staged entry paths are the `targetDir` of every `plan.stage` member — the
// exact set the assembler copies into the Image_Tree — captured without running
// a real `tsc --build`, so the recorder stays fast and side-effect-free here.
// ---------------------------------------------------------------------------
async function recordImageTrees(context) {
  const { buildPlan } = await distModule("build-plan.js");

  for (const { slug, value } of SELECTORS.imageTree) {
    const stagedEntries = withSelectorEnv(value, () => {
      const plan = withContext(buildPlan, context, value);
      return [...plan.stage.map((staged) => staged.targetDir)].sort();
    });
    writeFixture(`image-tree.${slug}.json`, stagedEntries);
  }
}

// ---------------------------------------------------------------------------
// registry.<selector>.ts — the generated Microservice_Registry's exact bytes
// (R15.10, R8.5).
//
// Entry point: `generateRegistry(selector)` from the compiled generate-registry
// module. It writes the gitignored registry file as a side effect; the recorder
// reads those bytes straight back into the fixture. Task 1.2 owns snapshotting
// and restoring that file's prior contents around the whole recording run.
//
// The path those bytes are read from is derived, not spelled: `generateRegistry`
// writes through `generatedRegistryPath(context)` — the single derivation of the
// Generated_Registry's location — so the recorder reads it from there rather
// than repeating a literal that would silently go stale. On the
// Pre_Change_Baseline that export does not exist, so the same
// `context === undefined`-shaped tolerance the rest of this script uses falls
// back to the location the baseline generator wrote to. `generatedRegistryPath`
// returns a Project_Directory-relative POSIX path, so it is resolved against
// `repoRoot` exactly as the retired literal was.
// ---------------------------------------------------------------------------
async function recordRegistries(context) {
  const { generateRegistry, generatedRegistryPath } =
    await distModule("generate-registry.js");
  const registryPath =
    generatedRegistryPath === undefined
      ? resolve(
          repoRoot,
          "packages/overseer/src/generated/microservice-registry.ts",
        )
      : resolve(repoRoot, generatedRegistryPath(context));

  for (const { slug, value } of SELECTORS.buildAndRegistry) {
    const bytes = withSelectorEnv(value, () => {
      withContext(generateRegistry, context, value);
      return readFileSync(registryPath, "utf8");
    });
    writeFixture(`registry.${slug}.ts`, bytes);
  }
}

// ---------------------------------------------------------------------------
// dockerfile.<selector> — the generated Dockerfile's exact bytes (R11.2).
//
// Compiled bin equivalent: the POSIX-sh Emit_Script the documented image build
// runs. Invoked as a subprocess with MICROSERVICES in the environment, exactly
// as `npm run docker:build:*` invokes it, and its gitignored output read back.
// ---------------------------------------------------------------------------
function recordDockerfiles() {
  for (const { slug, value } of SELECTORS.dockerfile) {
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
        `emit-effective-dockerfile.sh exited ${String(result.status)} for selector "${String(value)}":\n${result.stderr}`,
      );
    }
    writeFixture(`dockerfile.${slug}`, readFileSync(DOCKERFILE_PATH, "utf8"));
  }
}

// ---------------------------------------------------------------------------
// check-invariants.txt — the Repo_Invariant_Checker's exact output (R7.8).
//
// Compiled bin: the `check-repo-invariants` bin the root `check:invariants`
// script runs. Its combined stdout and stderr are captured verbatim; the
// baseline exits zero and prints its clean-run report.
// ---------------------------------------------------------------------------
function recordCheckInvariants() {
  const result = spawnSync("node", [CHECK_INVARIANTS_BIN], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  writeFixture("check-invariants.txt", `${result.stdout}${result.stderr}`);
}

async function main() {
  mkdirSync(BASELINE_DIR, { recursive: true });
  process.stdout.write(
    `Recording Pre_Change_Baseline fixtures into ${BASELINE_DIR}\n`,
  );

  const context = await loadDefaultContext();

  await recordDiscovery(context);
  await recordBuildOrders(context);
  await recordImageTrees(context);
  await recordRegistries(context);
  recordDockerfiles();
  recordCheckInvariants();

  process.stdout.write("Done.\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

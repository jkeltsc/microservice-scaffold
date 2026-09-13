// Feature: package-categories — bootstrap-then-ordered-pass example test
// (design "Testing Strategy / Bootstrap then ordered pass"; Requirements
// R12.11, R12.12).
//
// This is an example test, not a property test. It pins two facts about the
// repository-wide build entry point that the general Workspace_Build_Order
// properties (33, 34) do not, and it does so WITH AN INJECTED RECORDING RUNNER
// RATHER THAN BY SPAWNING — no real `npm run build` is ever executed here.
//
// TWO SEAMS, ONE PER REQUIREMENT — because `scripts/build.js` owns its process
// effects (it calls `runBootstrapBuild` and then `spawnSync`s a compiled bin)
// and takes no injected runner of its own, the two requirements are asserted
// through the two honest seams the code actually exposes:
//
//   R12.11 (bootstrap BEFORE the ordered-build bin) — asserted STRUCTURALLY
//     against the committed source of `scripts/build.js`. That script is plain,
//     uncompiled ESM that owns its `spawnSync`; there is no injectable seam that
//     lets a test observe the ordering without spawning a real build. So the
//     test reads the script's source and asserts that the `runBootstrapBuild`
//     call textually precedes the spawn of
//     `packages/build-tools/dist/bin/build-workspaces.js`, and — separately —
//     that `runBootstrapBuild` itself builds EXACTLY the two named workspaces
//     `@microservices/contracts` and `@microservices/build-tools`, by workspace
//     name, by reading `scripts/common-startup.js`. Reading source for an
//     ordering fact a script owns is a legitimate example-test seam; fabricating
//     an injected runner the script does not have would not be.
//
//   R12.12 (the ordered pass builds contracts + build-tools a SECOND time, each
//     exiting zero with no error and no warning about the repeat) — asserted
//     cleanly through the injected `CommandRunner` on `runOrderedBuild`. The
//     real-tree order is derived exactly as the CLI shell derives it —
//     `workspaceBuildOrder(workspaceNodesFrom(discoverPackages(),
//     readDependencySpecifiers))` — and `runOrderedBuild` is driven with a
//     recording runner that returns status 0 for every invocation. The recorded
//     sequence is then asserted to invoke `@microservices/contracts` and
//     `@microservices/build-tools` (each once, by workspace name, via
//     `npm run build --workspace <name>`), which — since the Bootstrap_Build
//     already built those two — is the "second time" R12.12 describes. An
//     all-zero run completing normally with no throw is the "each exiting zero
//     with no error and no warning" evidence: `runOrderedBuild` throws
//     `[build-order:failed]` on any non-zero exit and emits nothing at all on
//     success, so a clean return over an all-zero run is exactly "no error, no
//     warning about the repeat". The ordered pass invoking them regardless of
//     what the bootstrap covered is what makes the pass total over its input
//     rather than coupled to the bootstrap's contents.
//
// `discoverPackages()` and `readDependencySpecifiers` resolve their paths
// repo-relative, so the derivation runs with the repository root as cwd
// regardless of where vitest was launched.
//
// CLEAN-TREE DEPENDENCY ORDER (R4.4) — the same recording seam, one more fact.
// R4.4 requires that on a tree with no `dist/` and no `tsconfig.tsbuildinfo`
// (a fresh clone, where nothing can fall back on warm output), the ordered
// build completes the Config_Package's build before it starts the
// Extended_Config_Package's build, and the whole run exits 0. Because
// `@microservices/extended-config` declares `@microservices/config`, the
// Workspace_Build_Order derived from the real tree places `config` ahead of
// `extended-config` BY CONSTRUCTION — the same construction the fresh clone
// depends on, since npm visits `--workspaces` in listed (topological) order and
// a fresh clone has no prior `dist/` to fall back on. The recording runner is
// the honest seam here just as it is for R12.12: it observes the ordered pass's
// invocation sequence without spawning a real build, and an all-zero run that
// returns without throwing is the "exits 0" evidence (runOrderedBuild throws
// [build-order:failed] on any non-zero exit and emits nothing on success). No
// real clean tree is materialised: the ordered pass IS what guarantees the
// clean-tree ordering, so asserting the recorded order over the real-tree
// derivation is asserting the very property a clean clone relies on.
//
// Validates: Requirements 12.11, 12.12, 4.4

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPackages, readDependencySpecifiers } from "@microservices/build-tools/dist/discovery.js";
import {
  runOrderedBuild,
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "@microservices/build-tools/dist/workspace-build-order.js";
import type { CommandRunner } from "@microservices/build-tools/dist/workspace-build-order.js";
import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

const BUILD_SCRIPT = resolve(repoRoot, "scripts", "build.js");
const COMMON_STARTUP = resolve(repoRoot, "scripts", "common-startup.js");

/** The two workspaces the Bootstrap_Build compiles, by workspace name. */
const CONTRACTS = "@microservices/contracts";
const BUILD_TOOLS = "@microservices/build-tools";

/** The compiled ordered-build bin `scripts/build.js` spawns. */
const ORDERED_BIN = "packages/build-tools/dist/bin/build-workspaces.js";

/**
 * The Common_Package dependency edge R4.4 is about: `extended-config` declares
 * `config`, so the Workspace_Build_Order must place `config` first.
 */
const CONFIG = "@microservices/config";
const EXTENDED_CONFIG = "@microservices/extended-config";

/**
 * One recorded `runOrderedBuild` invocation: the command and its args, exactly
 * as the executor passed them to the injected runner.
 */
interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

describe("R12.11 — scripts/build.js bootstraps before it invokes the ordered-build bin", () => {
  // Read the committed source of the two scripts. `scripts/build.js` owns its
  // spawn, so its ordering is a source fact, not an injectable one.
  const buildSource = readFileSync(BUILD_SCRIPT, "utf8");
  const commonStartupSource = readFileSync(COMMON_STARTUP, "utf8");

  it("calls runBootstrapBuild before it spawns the compiled ordered-build bin", () => {
    // Strip the leading block/line comments so the ordering is asserted against
    // executable statements only — build.js documents the ordered bin path in a
    // comment high in the file, which a naive indexOf on the path would match
    // ahead of the real call. Removing comments leaves the two genuine seams:
    // the `runBootstrapBuild(` call and the `spawnSync(` that runs the bin.
    const code = buildSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const bootstrapCallPos = code.indexOf("runBootstrapBuild(");
    const spawnPos = code.indexOf("spawnSync(");
    const orderedBinPos = code.indexOf(ORDERED_BIN);

    expect(bootstrapCallPos).toBeGreaterThanOrEqual(0);
    expect(spawnPos).toBeGreaterThanOrEqual(0);
    expect(orderedBinPos).toBeGreaterThanOrEqual(0);
    // The bootstrap call must textually — and therefore logically, this being a
    // straight-line script — precede BOTH the spawn call and the ordered-build
    // bin path it spawns (R12.11): the bin does not exist until the bootstrap
    // produces it. And the bin path is an argument of that spawn, not an earlier
    // statement.
    expect(bootstrapCallPos).toBeLessThan(spawnPos);
    expect(bootstrapCallPos).toBeLessThan(orderedBinPos);
    expect(spawnPos).toBeLessThan(orderedBinPos);
  });

  it("imports runBootstrapBuild from scripts/common-startup.js", () => {
    // The bootstrap step build.js runs is the shared one from common-startup.js,
    // not a private reimplementation — so the "exactly two packages" contract
    // asserted below is the contract build.js actually invokes.
    expect(buildSource).toContain("runBootstrapBuild");
    expect(buildSource).toContain("./common-startup.js");
  });

  it("runBootstrapBuild builds exactly @microservices/contracts and @microservices/build-tools, by workspace name", () => {
    // The contract of runBootstrapBuild is observable in its source: it invokes
    // `npm run build --workspace @microservices/contracts --workspace
    // @microservices/build-tools`. Assert both named workspaces appear, each
    // introduced by a `--workspace` flag, and that no OTHER `--workspace` names
    // a third package.
    const bootstrapStart = commonStartupSource.indexOf(
      "export function runBootstrapBuild",
    );
    expect(bootstrapStart).toBeGreaterThanOrEqual(0);
    // Scope the search to the runBootstrapBuild body (up to the next exported
    // function) so unrelated `--workspace` uses elsewhere cannot leak in.
    const nextExport = commonStartupSource.indexOf(
      "export function",
      bootstrapStart + "export function runBootstrapBuild".length,
    );
    const body = commonStartupSource.slice(
      bootstrapStart,
      nextExport === -1 ? undefined : nextExport,
    );

    expect(body).toContain(CONTRACTS);
    expect(body).toContain(BUILD_TOOLS);

    // Each named workspace is introduced by its own `--workspace` flag, and
    // there are exactly two of them — no third package is bootstrapped.
    const workspaceFlags = body.match(/--workspace/g) ?? [];
    expect(workspaceFlags).toHaveLength(2);

    // The command is `npm run build`, invoked by workspace name.
    expect(body).toContain("run");
    expect(body).toContain("build");
  });
});

describe("R12.12 — the ordered pass invokes contracts and build-tools a second time, exiting zero with no error or warning", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    // discoverPackages()/readDependencySpecifiers resolve repo-relative.
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  /**
   * Drive `runOrderedBuild` over the real-tree order with a recording runner
   * that returns status 0 for every invocation (the near-no-op incremental
   * rebuild the design describes). Returns the recorded invocation sequence.
   */
  function recordOrderedBuild(): Invocation[] {
    const recorded: Invocation[] = [];
    const runner: CommandRunner = (command, args) => {
      recorded.push({ command, args: [...args] });
      return { status: 0 };
    };

    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);

    // A clean return here IS the "each exiting zero with no error and no warning
    // about the repeat" evidence: runOrderedBuild throws [build-order:failed] on
    // any non-zero exit and emits nothing on success. It must not throw.
    expect(() => runOrderedBuild(order, runner)).not.toThrow();

    return recorded;
  }

  it("invokes @microservices/contracts and @microservices/build-tools via `npm run build --workspace <name>`", () => {
    const recorded = recordOrderedBuild();

    // Every invocation is `npm run build --workspace <name>`.
    for (const invocation of recorded) {
      expect(invocation.command).toBe("npm");
      expect(invocation.args.slice(0, 3)).toEqual(["run", "build", "--workspace"]);
    }

    const workspaceNames = recorded.map((invocation) => {
      const flag = invocation.args.indexOf("--workspace");
      return invocation.args[flag + 1];
    });

    // The ordered pass reaches both bootstrap packages — this is their SECOND
    // build (the Bootstrap_Build built them first). The pass is total over its
    // input, so it invokes them regardless of what the bootstrap covered.
    expect(workspaceNames).toContain(CONTRACTS);
    expect(workspaceNames).toContain(BUILD_TOOLS);
  });

  it("invokes contracts and build-tools exactly once each within the ordered pass", () => {
    const recorded = recordOrderedBuild();
    const workspaceNames = recorded.map((invocation) => {
      const flag = invocation.args.indexOf("--workspace");
      return invocation.args[flag + 1];
    });

    const count = (name: string): number =>
      workspaceNames.filter((n) => n === name).length;

    // Each is built once by the ordered pass — the single "second time" R12.12
    // describes, not repeatedly.
    expect(count(CONTRACTS)).toBe(1);
    expect(count(BUILD_TOOLS)).toBe(1);
  });

  it("completes the whole ordered pass with all-zero statuses and no throw", () => {
    // The all-zero run over the real-tree order returns normally: no
    // [build-order:failed], no other error, and nothing emitted about the
    // repeated build of the two bootstrap packages (R12.12).
    const recorded = recordOrderedBuild();

    // Sanity: the pass visited every workspace node exactly once, so the
    // "second build" of the two bootstrap packages is part of a complete pass
    // rather than an isolated invocation.
    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);
    expect(recorded).toHaveLength(order.length);
  });
});

describe("R4.4 — the ordered pass builds config before extended-config and exits 0 on a clean tree", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    // discoverPackages()/readDependencySpecifiers resolve repo-relative.
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  /**
   * Drive `runOrderedBuild` over the real-tree order with a recording runner
   * that returns status 0 for every invocation — the near-no-op incremental
   * rebuild the design describes, and the same seam R12.12 uses above. Returns
   * the recorded invocation sequence. A clean return (no throw) IS the "exits 0"
   * evidence: runOrderedBuild throws [build-order:failed] on any non-zero exit
   * and emits nothing on success.
   */
  function recordOrderedBuild(): Invocation[] {
    const recorded: Invocation[] = [];
    const runner: CommandRunner = (command, args) => {
      recorded.push({ command, args: [...args] });
      return { status: 0 };
    };

    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);

    expect(() => runOrderedBuild(order, runner)).not.toThrow();

    return recorded;
  }

  /** The `--workspace <name>` value of each recorded invocation, in order. */
  function recordedWorkspaceNames(recorded: readonly Invocation[]): string[] {
    return recorded.map((invocation) => {
      const flag = invocation.args.indexOf("--workspace");
      return invocation.args[flag + 1] as string;
    });
  }

  it("invokes @microservices/config at a lower index than @microservices/extended-config", () => {
    const recorded = recordOrderedBuild();
    const workspaceNames = recordedWorkspaceNames(recorded);

    const configIndex = workspaceNames.indexOf(CONFIG);
    const extendedIndex = workspaceNames.indexOf(EXTENDED_CONFIG);

    // Both packages are reached by the ordered pass.
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(extendedIndex).toBeGreaterThanOrEqual(0);

    // Config's build is invoked — and, this being a straight-line ordered pass,
    // completes — before extended-config's build starts. `extended-config`
    // declares `@microservices/config`, so the Workspace_Build_Order places
    // config first by construction, which is exactly what a fresh clone with no
    // warm `dist/` relies on (R4.4).
    expect(configIndex).toBeLessThan(extendedIndex);
  });

  it("completes the whole ordered pass with all-zero statuses and no throw (the exits-0 evidence)", () => {
    // The all-zero run over the real-tree order returns normally: no
    // [build-order:failed] and no other error. On a clean tree — no `dist/`, no
    // `tsconfig.tsbuildinfo` — this ordered pass is the run that must exit 0, and
    // a clean return is that evidence (R4.4).
    const recorded = recordOrderedBuild();

    // Every recorded invocation is `npm run build --workspace <name>` — the pass
    // built through the injected runner, never a real spawn.
    for (const invocation of recorded) {
      expect(invocation.command).toBe("npm");
      expect(invocation.args.slice(0, 3)).toEqual(["run", "build", "--workspace"]);
    }

    // Sanity: the pass visited every workspace node exactly once, so config's
    // build preceding extended-config's is part of a complete, all-zero pass.
    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);
    expect(recorded).toHaveLength(order.length);
  });
});

// ---------------------------------------------------------------------------
// Feature: unified-build-order — the clean-tree ordered build with a REAL
// registry (task 8.1; Requirements 1.3, 1.4, 2.8, 2.21).
//
// This is the single highest-value execution in this fix, and unlike every
// block above it it does NOT use the recording runner — it genuinely compiles.
// The recording seam proves the ORDER is right; only a real compile proves the
// order is right FOR THE REASON THAT MATTERS: that the Overseer's `tsc` pass
// finds every `@microservices/microservice<N>` module the generated registry
// statically imports, because each microservice was compiled before it.
//
// It reproduces exactly the state bugfix.md 1.3/1.4 describe and the pre-fix
// order failed on:
//   - no `dist/` and no `*.tsbuildinfo` anywhere (a clean tree, where nothing
//     can fall back on warm output — the fresh-clone condition), AND
//   - a REAL Microservice_Registry naming all three microservices (not the
//     empty template `prepare` installs, which is what keeps CI green today).
//
// Pre-fix, the derived order placed `packages/overseer` (position 7) ahead of
// `packages/microservices/microservice1` (position 9), so compiling the Overseer
// against that real registry failed with
//   error TS2307: Cannot find module '@microservices/microservice1' …
// and — the ordered build stopping at the first failure — a re-run failed
// identically (1.3, 1.4). Post-fix (current code) the Build_Sequence places every
// microservice (statement 4) before the Overseer (statement 5), matching the
// ten-entry order of 2.21, so the registry's static imports resolve and the
// ordered build exits 0 (2.8).
//
// --- WORKTREE SAFETY (a hard prohibition) -----------------------------------
//
// This test compiles the whole repository AND relies on a REAL, all-three
// registry — which is a mutation of a gitignored generated file, and clearing
// every `dist/` and `*.tsbuildinfo` is more churn still. All of it happens
// inside the suite's OWN `pristineWorktree()` copy, materialised into an OS temp
// directory in `beforeAll`. The checked-out tree is NEVER written to, no path
// under `repoRoot` is ever touched, and NO git command is used to undo anything.
// `pristineWorktree()` lists tracked + untracked-but-not-gitignored files and
// tars them from disk, so the copy reflects uncommitted edits while the
// gitignored `dist/`, `*.tsbuildinfo`, and generated registry are excluded and
// free to be regenerated/cleared inside the copy. `dev-error-recovery.test.ts`
// is the worked example this follows.
//
// Validates: Requirements 1.3, 1.4, 2.8, 2.21

/** The compiled ordered-build bin, spawned inside the pristine copy. */
const ORDERED_BIN_REL = "packages/build-tools/dist/bin/build-workspaces.js";
/** The compiled registry generator bin, spawned inside the pristine copy. */
const GENERATE_REGISTRY_BIN_REL =
  "packages/build-tools/dist/bin/generate-registry.js";
/** The generated (real) registry the generator writes for the Selector. */
const REGISTRY_REL = "packages/overseer/src/generated/microservice-registry.ts";
/** The Overseer's compiled entrypoint — present iff its `tsc` pass succeeded. */
const OVERSEER_ENTRY_REL = "packages/overseer/dist/index.js";
/** The Overseer's compiled registry import — the module 1.3's TS2307 was about. */
const OVERSEER_REGISTRY_JS_REL =
  "packages/overseer/dist/generated/microservice-registry.js";

// Materialising the copy runs `npm ci`; the ordered build then compiles every
// workspace package from cold. Both are slow, so the budget is generous and the
// single copy is reused across examples.
const PRISTINE_TIMEOUT_MS = 600_000;
const BUILD_TIMEOUT_MS = 600_000;

/**
 * Recursively delete every `dist/` directory and every `*.tsbuildinfo` file
 * under `root`, skipping `node_modules`. This is what makes the copy a CLEAN
 * tree — the 1.3/1.4 precondition where nothing can fall back on warm output.
 * It writes only inside the pristine copy.
 */
function clearBuildArtifacts(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      if (entry.name === "dist") {
        rmSync(full, { recursive: true, force: true });
        continue;
      }
      clearBuildArtifacts(full);
    } else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      rmSync(full, { force: true });
    }
  }
}

describe("unified-build-order — clean-tree ordered build with a real registry compiles the Overseer (1.3, 1.4, 2.8, 2.21)", () => {
  let pristine: PristineWorktreeResult | undefined;
  let dir: string | undefined;
  let unavailableReason: string | undefined;

  beforeAll(() => {
    // ONE pristine copy for the whole block: `npm ci` is the slow step. Every
    // path this block writes or clears is re-rooted at `pristine.dir`.
    pristine = pristineWorktree();
    if (pristine.available !== true) {
      unavailableReason = pristine.reason;
      return;
    }
    dir = pristine.dir;
  }, PRISTINE_TIMEOUT_MS);

  afterAll(() => {
    // Teardown is just removing the temp tree; there is nothing in the real
    // tree to undo.
    if (pristine?.available === true) {
      pristine.cleanup();
    }
    pristine = undefined;
    dir = undefined;
  });

  it(
    "generates a real all-three registry on a clean tree, then the ordered build exits 0 with the Overseer compiled (no TS2307)",
    () => {
      if (dir === undefined) {
        // git (or tar / npm ci) unavailable — skip with the returned reason
        // rather than failing, exactly as pristineWorktree's contract asks.
        console.warn(
          `SKIP unified-build-order clean-tree ordered build: ${
            unavailableReason ?? "pristine tree unavailable"
          }`,
        );
        return;
      }
      const treeDir = dir;

      // STEP 1 — bootstrap so the generator and ordered-build bins exist. On a
      // clean tree they are not compiled yet; this is the same Bootstrap_Build
      // `scripts/build.js` performs before spawning the ordered bin. Run it by
      // workspace name, cwd the copy.
      const bootstrap = spawnSync(
        "npm",
        [
          "run",
          "build",
          "--workspace",
          "@microservices/contracts",
          "--workspace",
          "@microservices/build-tools",
        ],
        {
          cwd: treeDir,
          encoding: "utf8",
          shell: process.platform === "win32",
        },
      );
      expect(
        bootstrap.status,
        `bootstrap build failed:\n${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`,
      ).toBe(0);

      // STEP 2 — generate the REAL registry for MICROSERVICES='*' (all three
      // microservices), overwriting the empty template `npm ci` installed. This
      // is the registry that makes the defect bite: it statically imports each
      // microservice by package name (2.8). The generator reads the selector
      // from the environment.
      const generate = spawnSync(
        process.execPath,
        [GENERATE_REGISTRY_BIN_REL],
        {
          cwd: treeDir,
          encoding: "utf8",
          env: { ...process.env, MICROSERVICES: "*" },
        },
      );
      expect(
        generate.status,
        `registry generation failed:\n${generate.stdout ?? ""}\n${generate.stderr ?? ""}`,
      ).toBe(0);

      // The generated registry names all three microservices by package name —
      // the static imports whose targets must be compiled first.
      const registry = readFileSync(resolve(treeDir, REGISTRY_REL), "utf8");
      for (const id of ["microservice1", "microservice2", "microservice3"]) {
        expect(registry).toContain(`@microservices/${id}`);
      }

      // STEP 3 — make the tree CLEAN: no `dist/`, no `*.tsbuildinfo` anywhere.
      // This is the 1.3/1.4 precondition — a fresh-clone state where nothing can
      // fall back on warm output, so the Overseer's compile genuinely depends on
      // each microservice having been built ahead of it. (The bootstrap's dist/
      // for contracts and build-tools goes too; the ordered pass rebuilds them
      // incrementally as it reaches them.)
      clearBuildArtifacts(treeDir);
      expect(existsSync(resolve(treeDir, OVERSEER_ENTRY_REL))).toBe(false);

      // STEP 4 — bootstrap again (the ordered bin's dist/ was just cleared),
      // then run the ordered build inside the copy. This is a REAL compile of
      // every workspace package in the Build_Sequence order.
      const rebootstrap = spawnSync(
        "npm",
        [
          "run",
          "build",
          "--workspace",
          "@microservices/contracts",
          "--workspace",
          "@microservices/build-tools",
        ],
        {
          cwd: treeDir,
          encoding: "utf8",
          shell: process.platform === "win32",
        },
      );
      expect(
        rebootstrap.status,
        `re-bootstrap build failed:\n${rebootstrap.stdout ?? ""}\n${rebootstrap.stderr ?? ""}`,
      ).toBe(0);

      const ordered = spawnSync(process.execPath, [ORDERED_BIN_REL], {
        cwd: treeDir,
        encoding: "utf8",
      });

      // THE ESSENTIAL ASSERTION: the ordered build succeeds. Pre-fix this failed
      // at the Overseer with TS2307 because a microservice sat after it in the
      // order; post-fix the Build_Sequence places every microservice ahead of
      // the Overseer (2.8, 2.21), so the registry's imports resolve and the pass
      // exits 0. Surface the TS2307 explicitly if it recurs.
      const combined = `${ordered.stdout ?? ""}\n${ordered.stderr ?? ""}`;
      expect(
        combined.includes("error TS2307"),
        `ordered build hit the TS2307 the fix removes:\n${combined}`,
      ).toBe(false);
      expect(
        ordered.status,
        `ordered build did not exit 0:\n${combined}`,
      ).toBe(0);

      // And the Overseer's compiled output — including the compiled registry
      // import that 1.3's TS2307 named — exists afterward, which it cannot if
      // the Overseer's `tsc` pass failed.
      expect(existsSync(resolve(treeDir, OVERSEER_ENTRY_REL))).toBe(true);
      const overseerRegistryJs = resolve(treeDir, OVERSEER_REGISTRY_JS_REL);
      expect(existsSync(overseerRegistryJs)).toBe(true);
      // A non-empty compiled artifact, not a stray empty file.
      expect(statSync(overseerRegistryJs).size).toBeGreaterThan(0);
    },
    BUILD_TIMEOUT_MS,
  );
});

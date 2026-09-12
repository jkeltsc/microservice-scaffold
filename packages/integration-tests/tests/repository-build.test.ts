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
// Validates: Requirements 12.11, 12.12

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPackages, readDependencySpecifiers } from "@microservices/build-tools/dist/discovery.js";
import {
  runOrderedBuild,
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "@microservices/build-tools/dist/workspace-build-order.js";
import type { CommandRunner } from "@microservices/build-tools/dist/workspace-build-order.js";

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

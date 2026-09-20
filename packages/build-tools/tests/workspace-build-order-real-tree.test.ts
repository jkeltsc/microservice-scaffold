// Feature: unified-build-order — real-tree Workspace_Build_Order (design "Data
// Models / The Build_Sequence over the committed tree at 35156ce", 2.21).
//
// An example test, not a property test: there is one committed repository and
// exactly one correct Workspace_Build_Order over it, so quantifying over inputs
// adds nothing. The general claim — that the derivation is a correct Build_Sequence
// for ANY layout — lives in the Build_Sequence property suites. This test runs the
// SAME derivation over the REAL committed tree and pins the one order that tree
// produces, so the pure primitive and reality cannot silently drift apart: a
// manifest that stops declaring a scoped dependency, a Framework_Singleton whose
// specifiers are misread, or a Namespace_Container renamed would all move an
// entry here.
//
// The derivation is run exactly as the CLI shell runs it, over the real
// filesystem:
//
//   workspaceBuildOrder(workspaceNodesFrom(discoverPackages(), readDependencySpecifiers))
//
// `discoverPackages()` supplies every Consumer_Package (reading manifests for
// their scoped dependencies), and `readDependencySpecifiers` supplies each
// Framework_Singleton's own scoped dependencies — neither is discovered, so its
// specifiers come from its manifest by directory.
//
// The order is the Build_Sequence's eight statements applied to the committed
// tree (design Data Models table, 2.21, as registry-inversion R8.1 renumbered
// it). Each position below cites the STATEMENT that emitted it, not a graph
// consequence — the derivation is the statement scaffold of 2.1, and the
// Verification_Pass, not the sort, is what honours a declared edge. Over the
// committed tree the eleven `packageDir`s come out in exactly this order:
//
//   1   packages/contracts                       (statement 1: contracts, first)
//   2   packages/build-tools                      (statement 2: build-tools)
//   3   packages/common/config                    (statement 3: Common_Packages)
//   4   packages/common/extended-config           (statement 3: Common_Packages)
//   5   packages/microservices/microservice1      (statement 4: Microservice_Packages)
//   6   packages/microservices/microservice2      (statement 4: Microservice_Packages)
//   7   packages/microservices/microservice3      (statement 4: Microservice_Packages)
//   8   packages/overseer                         (statement 5: overseer)
//   9   app                                       (statement 6: the Entry_Package)
//   10  packages/integration-tests                (statement 7: integration-tests)
//   11  packages/spa/demo                         (statement 8: Spa_Packages, last)
//
// Position 9 is the one entry that is not a `packages/…` directory: the
// Entry_Package sits at the Entry_Root, outside the Framework_Singleton container,
// and this repository declares no `scaffold.config.json`, so that root is the
// Entry_Root_Default `app`.
//
// Statement 3 (positions 3 and 4) is its own calculated order: `extended-config`
// declares `@microservices/config` as its sole scoped specifier, so the one
// declared edge — not a rule — places `config` ahead of `extended-config`.
//
// Statement 4 (positions 5 to 7) is the three Microservice_Packages in
// `packageDir` code-point order: microservice1, microservice2, microservice3.
// This is 2.3's within-statement tiebreak, not a dependency consequence.
//
// `packages/contracts` first and `packages/integration-tests` next-to-last are NOT
// graph consequences under the Build_Sequence — they are statements 1 and 7,
// emitted at those positions by the statement scaffold itself regardless of what
// any manifest declares. The focused assertions below record those positions
// against the primitive's fixed statement order.
//
// `packages/spa/demo` is the sole entry following `integration-tests`: it is the
// only member of statement 8 (the trailing Spa_Package phase), so it lands last
// at 11. Microservice1 declaring `@microservices/demo` (it serves the Demo_Spa)
// no longer pulls the Demo_Spa forward — a Spa_Package is never a
// Compile_Time_Prerequisite, so statement 8 emits it after everything else, and
// the demo→microservice1 edge imposes no ordering on the tsc pass.
//
// `discoverPackages()` and `readDependencySpecifiers` resolve their paths
// repo-relative, so the test runs with the repository root as cwd regardless of
// whether vitest was launched from the package directory or the repo root.
//
// Validates: Requirements 2.21, 3.1, 3.2

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync, statSync } from "node:fs";
import { discoverPackages, readDependencySpecifiers } from "../src/discovery.js";
import {
  loadProjectConfig,
  type ConfigFileRead,
  type RootProbe,
} from "../src/config-loader.js";
import {
  PROJECT_CONFIG_FILE,
  renderDiagnostic,
} from "../src/project-config.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> build-tools -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The eleven `packageDir`s of the design's "Build_Sequence over the committed
 * tree" table (2.21), in table order. This is the whole oracle. The three
 * Microservice_Packages occupy positions 5 to 7 in `packageDir` order (statement
 * 4), `packages/overseer` is at 8 (statement 5), `app` at 9 (statement 6, the
 * Entry_Package), `packages/integration-tests` at 10 (statement 7), and
 * `packages/spa/demo` last at 11 as the sole member of the trailing Spa_Package
 * statement 8.
 */
const EXPECTED_ORDER: readonly string[] = [
  "packages/contracts",
  "packages/build-tools",
  "packages/common/config",
  "packages/common/extended-config",
  "packages/microservices/microservice1",
  "packages/microservices/microservice2",
  "packages/microservices/microservice3",
  "packages/overseer",
  "app",
  "packages/integration-tests",
  "packages/spa/demo",
];

/** Reads the committed `scaffold.config.json` (absent here → defaults). */
function readConfigFile(configPath: string): ConfigFileRead {
  try {
    return { kind: "text", text: readFileSync(configPath, "utf8") };
  } catch (error) {
    const code: unknown = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Probes one Discovery_Root under the repository root. */
function probeRoot(rootPath: string): RootProbe {
  let stats;
  try {
    stats = statSync(resolve(repoRoot, rootPath));
  } catch (error) {
    const code: unknown = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!stats.isDirectory()) return { kind: "not-directory" };
  let holdsPackageJsonFile: boolean;
  try {
    holdsPackageJsonFile = statSync(
      resolve(repoRoot, rootPath, "package.json"),
    ).isFile();
  } catch {
    holdsPackageJsonFile = false;
  }
  return { kind: "directory", holdsPackageJsonFile };
}

/**
 * The context the derivation runs against is the LOADED Effective_Config, read
 * from `scaffold.config.json` exactly as a Build_System run reads it (R13.3,
 * R13.4). This repository ships no config file, so the load takes all four
 * defaults — under which the ten-position table's `packages/…` directories are
 * the roots — but the test substitutes no path or scope literal of its own and
 * fails with a reported reason if the config cannot load.
 */
function loadContext(): ProjectContext {
  const outcome = loadProjectConfig(
    readConfigFile,
    probeRoot,
    resolve(repoRoot, PROJECT_CONFIG_FILE),
  );
  if (outcome.kind === "rejected") {
    throw new Error(
      `the project configuration could not load; substituting no literal:\n${outcome.diagnostics
        .map(renderDiagnostic)
        .join("\n")}`,
    );
  }
  return projectContext(outcome.config);
}

/** The derivation exactly as the CLI shell runs it over the real filesystem. */
function deriveOrder(): readonly string[] {
  const context = loadContext();
  const nodes = workspaceNodesFrom(
    context,
    discoverPackages(context),
    readDependencySpecifiers(context),
  );
  return workspaceBuildOrder(context, nodes).map((node) => node.packageDir);
}

describe("Workspace_Build_Order over the committed repository (Data Models table)", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  it("yields exactly the eleven entries of the design's table, in that order", () => {
    expect(deriveOrder()).toEqual(EXPECTED_ORDER);
  });

  it("records that statement 1 places packages/contracts first", () => {
    // Not a graph consequence: contracts leads because it is statement 1 of the
    // Build_Sequence, emitted first by the statement scaffold itself (2.1).
    expect(deriveOrder()[0]).toBe("packages/contracts");
  });

  it("records that statement 7 places packages/integration-tests before the Spa phase", () => {
    // integration-tests is statement 7, emitted after the Entry_Package
    // (statement 6) and before the trailing Spa_Package statement 8. With
    // packages/spa/demo the sole member of statement 8, integration-tests sits at
    // position 10 — second to last — and spa/demo is the only entry after it.
    const order = deriveOrder();
    const integrationIdx = order.indexOf("packages/integration-tests");
    const demoIdx = order.indexOf("packages/spa/demo");
    expect(integrationIdx).toBeGreaterThanOrEqual(0);
    expect(demoIdx).toBe(integrationIdx + 1);
    expect(demoIdx).toBe(order.length - 1);
  });

  it("records that statement 6 places the Entry_Package after the Overseer and before integration-tests", () => {
    // The Entry_Package's position is statement 6's, not a graph consequence: it
    // follows every Selected_Microservice and the Overseer because the
    // Generated_Registry it compiles imports each of them, and it precedes the
    // test-only Framework_Singleton (registry-inversion R8.1).
    const order = deriveOrder();
    const overseerIdx = order.indexOf("packages/overseer");
    const entryIdx = order.indexOf("app");
    const integrationIdx = order.indexOf("packages/integration-tests");

    expect(entryIdx).toBe(overseerIdx + 1);
    expect(integrationIdx).toBe(entryIdx + 1);
  });
});

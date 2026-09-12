// Feature: package-categories — real-tree Workspace_Build_Order (design "Data
// Models / Workspace_Build_Order over the current tree").
//
// An example test, not a property test: there is one committed repository and
// exactly one correct Workspace_Build_Order over it, so quantifying over inputs
// adds nothing. The general claim — that the derivation is a correct topological
// order for ANY layout — is Property 33, already written elsewhere. This test
// runs the SAME derivation over the REAL committed tree and pins the one order
// that tree produces, so the two of them (the pure derivation and reality)
// cannot silently drift apart: a manifest that stops declaring a scoped
// dependency, a Framework_Singleton whose specifiers are misread, or a
// Namespace_Container renamed would all move an entry here.
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
// The design's "Workspace_Build_Order over the current tree" table is the
// oracle. Over the committed tree the eight `packageDir`s must come out in
// exactly this order:
//
//   1  packages/contracts                       (no scoped dependency, ready first)
//   2  packages/build-tools                      (depends on contracts)
//   3  packages/common/config                    (depends on contracts)
//   4  packages/microservices/microservice1      (depends on contracts)
//   5  packages/microservices/microservice2      (depends on config, contracts)
//   6  packages/microservices/microservice3      (depends on config, contracts)
//   7  packages/overseer                         (depends on contracts)
//   8  packages/integration-tests                (depends on all three
//                                                 microservices, the Overseer,
//                                                 build-tools, contracts)
//
// `packages/contracts` first and `packages/integration-tests` last are NOT
// asserted as rules — the derivation has no framework special case. They are
// graph consequences: every other package declares `@microservices/contracts`
// so an edge from contracts precedes each of them, and integration-tests
// declares specifiers resolving to everything else so all of them precede it
// (R12.3). The two focused assertions below therefore only RECORD that the graph
// over this one tree produces those positions; they are not a rule the code
// enforces.
//
// `discoverPackages()` and `readDependencySpecifiers` resolve their paths
// repo-relative, so the test runs with the repository root as cwd regardless of
// whether vitest was launched from the package directory or the repo root.
//
// Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPackages, readDependencySpecifiers } from "../src/discovery.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> build-tools -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The eight `packageDir`s of the design's "Workspace_Build_Order over the
 * current tree" table, in table order. This is the whole oracle.
 */
const EXPECTED_ORDER: readonly string[] = [
  "packages/contracts",
  "packages/build-tools",
  "packages/common/config",
  "packages/microservices/microservice1",
  "packages/microservices/microservice2",
  "packages/microservices/microservice3",
  "packages/overseer",
  "packages/integration-tests",
];

/** The derivation exactly as the CLI shell runs it over the real filesystem. */
function deriveOrder(): readonly string[] {
  const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
  return workspaceBuildOrder(nodes).map((node) => node.packageDir);
}

describe("Workspace_Build_Order over the committed repository (Data Models table)", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  it("yields exactly the eight entries of the design's table, in that order", () => {
    expect(deriveOrder()).toEqual(EXPECTED_ORDER);
  });

  it("records that the graph places packages/contracts first (a consequence, not a rule)", () => {
    // Not asserted as a framework special case: contracts leads because every
    // other package declares @microservices/contracts, so it is the sole node
    // ready before any other (R12.3).
    expect(deriveOrder()[0]).toBe("packages/contracts");
  });

  it("records that the graph places packages/integration-tests last (a consequence, not a rule)", () => {
    // integration-tests declares specifiers resolving to all three
    // microservices, the Overseer, build-tools, and contracts, so every other
    // node precedes it — it lands last with nothing asserting the position
    // (R12.3).
    const order = deriveOrder();
    expect(order[order.length - 1]).toBe("packages/integration-tests");
  });
});

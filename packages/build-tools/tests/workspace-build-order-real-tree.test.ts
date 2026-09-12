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
// oracle. Over the committed tree the ten `packageDir`s must come out in
// exactly this order:
//
//   1   packages/contracts                       (no scoped dependency, ready first)
//   2   packages/build-tools                      (depends on contracts)
//   3   packages/common/config                    (depends on contracts)
//   4   packages/common/extended-config           (depends on config)
//   5   packages/microservices/microservice2      (depends on config, contracts)
//   6   packages/microservices/microservice3      (depends on contracts,
//                                                  extended-config)
//   7   packages/overseer                         (depends on contracts)
//   8   packages/spa/demo                         (no scoped dependency)
//   9   packages/microservices/microservice1      (depends on contracts, demo)
//   10  packages/integration-tests                (depends on all three
//                                                  microservices, the Overseer,
//                                                  build-tools, contracts)
//
// `packages/common/extended-config` follows `packages/common/config`: it
// declares `@microservices/config` as its sole scoped dependency, so an edge
// from config precedes it, and once config is placed the tie-break by
// `packageDir` code point puts `common/extended-config` ahead of every
// `microservices/…` entry.
//
// `packages/spa/demo` before `packages/microservices/microservice1` is the
// edge this feature adds, and it is what moves microservice1 from position 5 to
// 9. The Demo_Spa declares NO scoped dependency, so it is ready from the first
// step; on its own, its `packageDir` "packages/spa/…" sorts after everything
// else, so the minimum-first ready queue (F8, the lexicographically least
// topological order) would hold it to the very end. But Microservice1 now
// declares `@microservices/demo` — it serves the Demo_Spa at its Mount_Root —
// so an edge from demo to microservice1 exists, and microservice1 cannot be
// emitted until demo has been. That single edge pulls demo forward to just
// before microservice1: demo lands at 8, microservice1 at 9. Eligibility is
// still not placement — demo was ready first — but a real dependent now fixes
// where it is emitted.
//
// `packages/contracts` first and `packages/integration-tests` last are NOT
// asserted as rules — the derivation has no framework special case. They are
// graph consequences: every other package declares `@microservices/contracts`
// so an edge from contracts precedes each of them, and integration-tests
// declares specifiers resolving to all three microservices, the Overseer,
// build-tools, and contracts, so every other node precedes it (R12.3) — and
// with microservice1 pulled to 9, integration-tests (which depends on it) lands
// at 10, last, once more. The two focused assertions below therefore only
// RECORD that the graph over this one tree produces those positions; they are
// not a rule the code enforces.
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
 * The ten `packageDir`s of the design's "Workspace_Build_Order over the
 * current tree" table, in table order. This is the whole oracle. `packages/spa/demo`
 * sits at position 8, immediately before `packages/microservices/microservice1`
 * at 9: Microservice1 now declares `@microservices/demo` (it serves the
 * Demo_Spa), so the demo→microservice1 edge pulls the otherwise-last Spa_Package
 * forward to just before its dependent, and `packages/integration-tests` — which
 * depends on every microservice — is last again at 10.
 */
const EXPECTED_ORDER: readonly string[] = [
  "packages/contracts",
  "packages/build-tools",
  "packages/common/config",
  "packages/common/extended-config",
  "packages/microservices/microservice2",
  "packages/microservices/microservice3",
  "packages/overseer",
  "packages/spa/demo",
  "packages/microservices/microservice1",
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

  it("yields exactly the ten entries of the design's table, in that order", () => {
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
    // node precedes it (R12.3) — it lands last with nothing asserting the
    // position. With Microservice1 now depending on the Demo_Spa, microservice1
    // is pulled to position 9 (just after demo at 8), and integration-tests —
    // which depends on microservice1 — is last at 10 once more.
    const order = deriveOrder();
    expect(order[order.length - 1]).toBe("packages/integration-tests");
  });

  it("records that packages/spa/demo precedes packages/microservices/microservice1 (a consequence, not a rule)", () => {
    // The edge this feature adds: Microservice1 declares @microservices/demo, so
    // the Demo_Spa must be built before it. demo lands at 8, microservice1 at 9
    // — demo immediately before its dependent. Not a framework rule; a graph
    // consequence of the one manifest edge.
    const order = deriveOrder();
    const demoIdx = order.indexOf("packages/spa/demo");
    const ms1Idx = order.indexOf("packages/microservices/microservice1");
    expect(demoIdx).toBeGreaterThanOrEqual(0);
    expect(demoIdx).toBeLessThan(ms1Idx);
    expect(order[demoIdx + 1]).toBe("packages/microservices/microservice1");
  });
});

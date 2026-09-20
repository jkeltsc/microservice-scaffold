// Feature: unified-build-order — the pre-`scaffold-demo-samples` expected order
// (task 8.3; design "Preservation Checking / 3.18", 2.22, 3.18).
//
// An example test, not a property test: it pins ONE concrete fact — that the
// Build_Sequence, applied to the repository state that PRECEDES the
// `scaffold-demo-samples` feature, reproduces that state's then-committed
// Workspace_Build_Order exactly, with statement 7 (the trailing Spa_Package
// phase) empty and no special case anywhere in the primitive. The general claim
// — that the derivation is correct for ANY layout, including layouts with no
// Spa_Package and one Common_Package — lives in the Build_Sequence property
// suites (Property 2). This test is 2.22's evidence: the fix is correct whether
// that feature's changes are present or absent.
//
// --- This suite NEVER touches the real working tree -------------------------
// The reduction to the predecessor shape happens entirely inside a
// `pristineWorktree()` copy, materialized into an OS temp directory. The real
// working tree is read (to build that copy) and NEVER written. That is a hard
// requirement (worktree-safety-guard.test.ts enforces it): no destructive git
// command, no edit to a tracked source in `packages/`, no synthesised package in
// the checked-out tree. Every path this suite writes or removes is re-rooted at
// the copy's `dir`, and the derivation runs with `process.chdir(dir)` so the
// discovery/order functions — which resolve every path repo-relative to cwd —
// scan the copy rather than the real tree. cwd is restored in `afterAll`.
//
// --- The reduction to the predecessor shape ---------------------------------
// `scaffold-demo-samples` added the Demo_Spa (`packages/spa/demo`), the
// `extended-config` Common_Package (`packages/common/extended-config`),
// microservice1's `@microservices/demo` dependency, and microservice3's
// `@microservices/extended-config` dependency. To recover the predecessor shape
// inside the copy this suite:
//
//   1. removes `packages/spa/demo`            (no Spa_Package remains → statement 7 empty)
//   2. removes `packages/common/extended-config` (one Common_Package remains: config)
//   3. drops `@microservices/demo` from microservice1's package.json
//   4. drops `@microservices/extended-config` from microservice3's package.json
//
// Steps 3 and 4 keep the reduction internally consistent: with those two
// packages gone, leaving the specifiers in place would make discovery/derivation
// fail on a dangling `@microservices`-scoped specifier. Discovery is by location
// (it scans `packages/common/*`, `packages/spa/*`, `packages/microservices/*`),
// so removing the two directories drops them from the discovered set with no
// root-manifest edit needed — the `workspaces` globs still match whatever
// remains. Manifests are edited by reading them FROM THE COPY and writing the
// reduced JSON back with `writeFileSync`; nothing is captured-and-restored
// because the copy is discarded whole in teardown.
//
// --- The expected order -----------------------------------------------------
// In the predecessor shape the Build_Sequence's statements yield the
// then-committed order, plus the Entry_Package the registry inversion inserted
// (3.18; registry-inversion R8.1–R8.3). The inversion renumbered the tail:
// the Entry_Statement is 6, the test-only Framework_Singleton is 7, and the
// trailing Spa_Package phase is 8.
//
//   1  packages/contracts                    (statement 1: contracts, first)
//   2  packages/build-tools                   (statement 2: build-tools)
//   3  packages/common/config                 (statement 3: the sole Common_Package)
//   4  packages/microservices/microservice1   (statement 4: Microservice_Packages,
//   5  packages/microservices/microservice2                  in packageDir order)
//   6  packages/microservices/microservice3
//   7  packages/overseer                       (statement 5: overseer)
//   8  app                                    (statement 6: the Entry_Package,
//                                              strictly after every microservice
//                                              and after the Overseer)
//   9  packages/integration-tests              (statement 7: integration-tests)
//
// Nothing follows integration-tests: statement 8 has no members, so the trailing
// Spa_Package phase is empty. There is no `packages/spa/demo` and no
// `packages/common/extended-config`. This is the whole oracle.
//
// The derivation is run exactly as the CLI shell runs it over the copy's tree:
//
//   workspaceBuildOrder(workspaceNodesFrom(discoverPackages(), readDependencySpecifiers))
//
// Validates: Requirements 2.22, 3.18

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  discoverPackages,
  readDependencySpecifiers,
} from "@microservices/build-tools/dist/discovery.js";
import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "@microservices/build-tools/dist/workspace-build-order.js";
import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

/** This repository's Entry_Root — unconfigured, so the Entry_Root_Default `app`.
 *  The pristine copy carries no `scaffold.config.json` either, so the copy's
 *  Entry_Root is the same value. */
const ENTRY_ROOT = projectContext(defaultEffectiveConfig()).entryRoot;

/**
 * The nine `packageDir`s of the pre-`scaffold-demo-samples` state, in
 * Build_Sequence order (3.18), with the Entry_Package at the position the
 * registry inversion gives it (statement 6 — strictly after every
 * Selected_Microservice and after the Overseer, strictly before the test-only
 * Framework_Singletons). Statement 8 contributes nothing, so
 * `packages/integration-tests` (statement 7) is last; there is no
 * `packages/spa/demo` and no `packages/common/extended-config`.
 */
const EXPECTED_ORDER: readonly string[] = [
  "packages/contracts",
  "packages/build-tools",
  "packages/common/config",
  "packages/microservices/microservice1",
  "packages/microservices/microservice2",
  "packages/microservices/microservice3",
  "packages/overseer",
  ENTRY_ROOT,
  "packages/integration-tests",
];

/** `pristineWorktree()` runs `npm ci` in a fresh temp tree — the slow step. */
const PRISTINE_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 120_000;

/** Absolute paths of the artefacts the reduction removes or edits — all inside
 *  the pristine copy. */
interface ReductionPaths {
  /** `<root>/packages/spa/demo` — the Demo_Spa, removed whole. */
  readonly demoDir: string;
  /** `<root>/packages/common/extended-config` — the Common_Package, removed whole. */
  readonly extendedConfigDir: string;
  /** `<root>/packages/microservices/microservice1/package.json`. */
  readonly ms1Manifest: string;
  /** `<root>/packages/microservices/microservice3/package.json`. */
  readonly ms3Manifest: string;
}

function reductionPaths(root: string): ReductionPaths {
  return {
    demoDir: resolve(root, "packages", "spa", "demo"),
    extendedConfigDir: resolve(root, "packages", "common", "extended-config"),
    ms1Manifest: resolve(
      root,
      "packages",
      "microservices",
      "microservice1",
      "package.json",
    ),
    ms3Manifest: resolve(
      root,
      "packages",
      "microservices",
      "microservice3",
      "package.json",
    ),
  };
}

/**
 * Drop a single `@microservices`-scoped dependency from a manifest read FROM THE
 * COPY, writing the reduced JSON back into the copy. Guards that the specifier is
 * actually present so a manifest that stops declaring it (a future edit) fails
 * loudly here rather than silently leaving the reduction inconsistent.
 */
function dropScopedDependency(manifestPath: string, specifier: string): void {
  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original) as {
    dependencies?: Record<string, string>;
  };
  const deps = manifest.dependencies ?? {};
  if (!(specifier in deps)) {
    throw new Error(
      `expected ${manifestPath} to declare "${specifier}" so the pre-feature ` +
        `reduction can drop it; it does not — the predecessor-shape reduction is ` +
        `no longer consistent and this test must be updated`,
    );
  }
  delete deps[specifier];
  manifest.dependencies = deps;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Reduce the pristine copy to the pre-`scaffold-demo-samples` shape: remove the
 * Demo_Spa and the extended-config Common_Package, and drop the two dependency
 * specifiers that named them. Every write is inside the copy.
 */
function reduceToPredecessorShape(paths: ReductionPaths): void {
  // Remove the two directories `scaffold-demo-samples` added. Discovery is by
  // location, so removing them drops them from the discovered set.
  rmSync(paths.demoDir, { recursive: true, force: true });
  rmSync(paths.extendedConfigDir, { recursive: true, force: true });
  // Drop the now-dangling scoped specifiers, keeping the derivation consistent.
  dropScopedDependency(paths.ms1Manifest, "@microservices/demo");
  dropScopedDependency(paths.ms3Manifest, "@microservices/extended-config");
}

/** The derivation exactly as the CLI shell runs it, over cwd's filesystem. */
function deriveOrder(): readonly string[] {
  const context = projectContext(defaultEffectiveConfig());
  const nodes = workspaceNodesFrom(
    context,
    discoverPackages(context),
    readDependencySpecifiers(context),
  );
  return workspaceBuildOrder(context, nodes).map((node) => node.packageDir);
}

let pristine: PristineWorktreeResult | undefined;
const originalCwd = process.cwd();

beforeAll(() => {
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    // No git (or archive / npm ci failed for an environmental reason). The test
    // body reports the reason and returns; nothing else to set up.
    return;
  }
  reduceToPredecessorShape(reductionPaths(pristine.dir));
  // discoverPackages()/readDependencySpecifiers resolve repo-relative, so point
  // cwd at the reduced copy for the derivation.
  process.chdir(pristine.dir);
}, PRISTINE_TIMEOUT_MS);

afterAll(() => {
  // Restore cwd first (the derivation chdir'd into the copy), then discard the
  // copy. There is nothing to undo in the real working tree.
  process.chdir(originalCwd);
  if (pristine?.available === true) {
    pristine.cleanup();
    pristine = undefined;
  }
});

describe("Workspace_Build_Order over the pre-`scaffold-demo-samples` state (3.18)", () => {
  it(
    "yields exactly the nine predecessor-shape entries, in that order, with statement 8 empty",
    () => {
      if (pristine === undefined || pristine.available !== true) {
        console.warn(
          `SKIP pre-demo-samples-build-order: ${
            pristine?.reason ?? "pristine tree unavailable"
          }`,
        );
        return;
      }

      const order = deriveOrder();

      // The whole oracle: the nine predecessor-shape entries in Build_Sequence
      // order (3.18). No `packages/spa/demo` and no
      // `packages/common/extended-config` appear.
      expect(order).toEqual(EXPECTED_ORDER);
      expect(order).not.toContain("packages/spa/demo");
      expect(order).not.toContain("packages/common/extended-config");

      // Statement 8 is empty: integration-tests (statement 7) is last, nothing
      // follows it (2.22, 3.18) — the trailing Spa_Package phase has no members.
      expect(order[order.length - 1]).toBe("packages/integration-tests");
    },
    TEST_TIMEOUT_MS,
  );
});

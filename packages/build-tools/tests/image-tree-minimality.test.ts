// Feature: shared-packages, Property 6: A non-required staged shared package
// fails the minimality guard.
//
// The image-tree assembler establishes minimality by construction — only the
// Required_Shared_Packages closure is ever staged — so the guard
// `assertNoNonRequiredSharedPackage` can never fire under the current
// assembler. It exists as defense in depth: a future regression that leaks a
// discovered-but-not-required shared package into the image tree must turn into
// a non-zero build failure, locally and in CI (Requirement R7.2).
//
// This is an example/unit test rather than a property test: the guard's
// contract is a single conditional over a filesystem probe, and the thing worth
// pinning is the exact operator-facing message (it names the offender and the
// location). We construct a real temp `outDir`, physically stage one stray
// non-required shared package under `node_modules/@microservices/<dirName>`,
// and assert the guard throws an error whose message names that offender. The
// complementary "does not throw when only required packages are present" case
// guards against a guard that fires spuriously.
//
// Validates: Requirements 7.2

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNoNonRequiredSharedPackage } from "../src/image-tree.js";
import type { SharedPackage } from "../src/shared-packages.js";

/** Build a discovered SharedPackage record for the given short directory name. */
function sharedPackage(dirName: string): SharedPackage {
  return {
    name: `@microservices/${dirName}`,
    dirName,
    packageDir: `packages/${dirName}`,
    sharedDependencies: [],
  };
}

/** Physically create `<outDir>/node_modules/@microservices/<dirName>`. */
function stageSharedDir(outDir: string, dirName: string): void {
  mkdirSync(join(outDir, "node_modules", "@microservices", dirName), {
    recursive: true,
  });
}

describe("Property 6: non-required staged shared package fails the minimality guard", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "image-tree-minimality-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("throws naming the offender when a discovered-but-not-required shared package is staged", () => {
    const contracts = sharedPackage("contracts");
    const stray = sharedPackage("stray");

    // Discovery found both; the closure required only `contracts`.
    const shared = new Map<string, SharedPackage>([
      [contracts.name, contracts],
      [stray.name, stray],
    ]);
    const required: readonly SharedPackage[] = [contracts];

    // A regression stages both the required package and the stray one.
    stageSharedDir(outDir, contracts.dirName);
    stageSharedDir(outDir, stray.dirName);

    expect(() =>
      assertNoNonRequiredSharedPackage(outDir, shared, required),
    ).toThrowError(
      `[image-tree] non-required shared package "${stray.name}" found in ${outDir}/node_modules/@microservices/ — the image tree must contain only required shared packages`,
    );
  });

  it("does not throw when only required shared packages are staged", () => {
    const contracts = sharedPackage("contracts");
    const stray = sharedPackage("stray");

    // Both are discovered, but the stray one is NOT staged into the tree.
    const shared = new Map<string, SharedPackage>([
      [contracts.name, contracts],
      [stray.name, stray],
    ]);
    const required: readonly SharedPackage[] = [contracts];

    stageSharedDir(outDir, contracts.dirName);

    expect(() =>
      assertNoNonRequiredSharedPackage(outDir, shared, required),
    ).not.toThrow();
  });
});

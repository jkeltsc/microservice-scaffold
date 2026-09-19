// Feature: package-categories — the `framework.ts` surface (design "Example and
// unit tests": «`framework.ts` surface»).
//
// The Framework_Constants_Module is the single declaration site for the four
// Framework_Singletons' scope-free directory facts and the Overseer entrypoint.
// Its whole contract is the *shape and content* of a handful of constants, so an
// example test is the right instrument: there is no input space to quantify
// over, only a fixed surface to pin.
//
// The point of pinning it is that other modules read these bindings instead of
// restating the literals (R10.2–R10.5), which means a silent edit here — a
// reordered collection, a renamed directory, a staging flag flipped — changes
// what a container image contains without any other file changing. This test is
// the tripwire for that.
//
// After config-driven-discovery task 8 the module holds NO scope and NO
// Discovery_Root: the deprecated `WORKSPACE_SCOPE`, `NAMESPACE_CONTAINER`,
// `FRAMEWORK_SINGLETONS`, and `frameworkSingletonByName` shims are gone, and the
// scope-composed framework name and the per-run roots live on the project
// context, asserted in `project-context.property.test.ts`. This file keeps only
// the scope-free surface: the four directory names, the staging classification,
// the composed entrypoint, and `assertFrameworkDirectoriesPresent` (that last in
// `framework.property.test.ts`).
//
// Method: every expectation is stated against an EXPECTED TABLE declared
// independently in this file, not derived from the module under test. In
// particular `ALWAYS_STAGED_SCOPED_ENTRIES` is checked against the table's own
// `staging` column, so the assertion is not a restatement of the production
// `filter`.
//
// Validates: Requirements 10.1, 10.6

import { describe, expect, it } from "vitest";

import {
  ALWAYS_STAGED_SCOPED_ENTRIES,
  CONSUMER_CATEGORIES,
  FRAMEWORK_DIRECTORIES,
  OVERSEER_ENTRYPOINT,
  PACKAGES_DIR,
  type FrameworkDirectory,
} from "../src/framework.js";

/**
 * The four framework directories as R10.1 names them, in the order R10.6 fixes,
 * with every scope-free field spelled out as a literal. This is the scope-free
 * surface: a framework record's directory facts, with no `name` — the composed
 * name is a function of the Configured_Scope and is asserted in
 * `project-context.property.test.ts`. Deliberately hand-written rather than
 * composed from `PACKAGES_DIR`: the `packageDir` composition is part of what is
 * under test.
 */
const EXPECTED_DIRECTORIES: readonly FrameworkDirectory[] = [
  {
    dirName: "contracts",
    packageDir: "packages/contracts",
    staging: "scoped-node-modules",
  },
  {
    dirName: "overseer",
    packageDir: "packages/overseer",
    staging: "package-dir",
  },
  {
    dirName: "build-tools",
    packageDir: "packages/build-tools",
    staging: "none",
  },
  {
    dirName: "integration-tests",
    packageDir: "packages/integration-tests",
    staging: "none",
  },
];

describe("framework.ts surface: FRAMEWORK_DIRECTORIES (R10.1, R10.6)", () => {
  it("enumerates exactly the four expected directory records, in a fixed order, and nothing else", () => {
    expect(
      FRAMEWORK_DIRECTORIES.map((entry) => ({
        dirName: entry.dirName,
        packageDir: entry.packageDir,
        staging: entry.staging,
      })),
    ).toEqual(EXPECTED_DIRECTORIES);
    expect(FRAMEWORK_DIRECTORIES).toHaveLength(EXPECTED_DIRECTORIES.length);
  });

  it("composes each record's packageDir from the single packages-dir declaration", () => {
    expect(PACKAGES_DIR).toBe("packages");

    for (const entry of FRAMEWORK_DIRECTORIES) {
      expect(entry.packageDir).toBe(`${PACKAGES_DIR}/${entry.dirName}`);
    }
  });

  it("enumerates the same order on every traversal", () => {
    const first = [...FRAMEWORK_DIRECTORIES].map((entry) => entry.dirName);
    const second = [...FRAMEWORK_DIRECTORIES].map((entry) => entry.dirName);

    expect(second).toEqual(first);
    expect(first).toEqual(EXPECTED_DIRECTORIES.map((entry) => entry.dirName));
  });

  it("classifies staging exactly: contracts under the scope, the Overseer at its dir, the rest never", () => {
    const staging = Object.fromEntries(
      FRAMEWORK_DIRECTORIES.map((entry) => [entry.dirName, entry.staging]),
    );

    expect(staging).toEqual({
      contracts: "scoped-node-modules",
      overseer: "package-dir",
      "build-tools": "none",
      "integration-tests": "none",
    });
  });
});

describe("framework.ts surface: composed paths and staging (R10.1)", () => {
  it("composes OVERSEER_ENTRYPOINT as packages/overseer/dist/index.js", () => {
    expect(OVERSEER_ENTRYPOINT).toBe("packages/overseer/dist/index.js");
  });

  it("holds in ALWAYS_STAGED_SCOPED_ENTRIES exactly the directories staged under the scope", () => {
    // Derived from the scope-free directories table's own `staging` column, not
    // from the module's `filter`: the staging classification lives on
    // FRAMEWORK_DIRECTORIES, so the tripwire tracks that column.
    const expected = EXPECTED_DIRECTORIES.filter(
      (entry) => entry.staging === "scoped-node-modules",
    ).map((entry) => entry.dirName);

    // The expected table says that is `contracts` alone (R5.10, R7.7); pinning
    // the literal too keeps the derivation honest.
    expect(expected).toEqual(["contracts"]);
    expect([...ALWAYS_STAGED_SCOPED_ENTRIES]).toEqual(expected);
  });
});

describe("framework.ts surface: Consumer_Categories (R10.1)", () => {
  it("covers all three Consumer_Categories, in the fixed order", () => {
    expect([...CONSUMER_CATEGORIES]).toEqual(["microservice", "common", "spa"]);
  });
});

// Feature: unified-build-order — the source-level absence of `buildPosition`.
//
// Requirement 2.2 says the Build_System must consult no per-package
// build-order position metadata to produce the Build_Sequence: the statement
// order is hardcoded and its framework members are named by name, so no
// ordering input is read from a manifest or from a declared Build_Position.
// Per requirement 1.11, the old `FrameworkSingleton.buildPosition` field was
// exactly such metadata declared here in the Framework_Constants_Module — one
// Ordering_Mechanism read it, another did not, and that split was root cause 2.
//
// Task 4.3 retired the field. 2.2 is "only checkable by inspection if there is
// no per-package position metadata left to consult" (design "framework.ts —
// buildPosition retires"), so the one mechanical check the requirement admits
// is that no file under `packages/build-tools/src/` names `buildPosition`.
// This test is the tripwire against reintroducing it.
//
// Validates: Requirements 1.11, 2.2

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("no per-package build-order position metadata survives (2.2, 1.11)", () => {
  it("no file under packages/build-tools/src/ names `buildPosition`", () => {
    // Resolve the build-tools src/ from this test file's location, the way the
    // other real-tree tests in this package resolve the repo root from __dirname.
    const here = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(here, "..", "src");

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // Skip generated/installed trees that should not live under src/ anyway.
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    walk(srcDir);

    const offenders = files.filter((file) =>
      readFileSync(file, "utf8").includes("buildPosition"),
    );

    expect(offenders).toEqual([]);
  });
});

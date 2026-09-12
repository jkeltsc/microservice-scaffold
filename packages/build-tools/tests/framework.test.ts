// Feature: package-categories — the `framework.ts` surface (design "Example and
// unit tests": «`framework.ts` surface»).
//
// The Framework_Constants_Module is the single declaration site for the four
// Framework_Singletons, the three Namespace_Container directories, the workspace
// scope, and the Overseer entrypoint. Its whole contract is the *shape and
// content* of a handful of constants, so an example test is the right instrument:
// there is no input space to quantify over, only a fixed surface to pin.
//
// The point of pinning it is that other modules read these bindings instead of
// restating the literals (R10.2–R10.5), which means a silent edit here — a
// reordered collection, a renamed directory, a staging flag flipped — changes
// what a container image contains without any other file changing. This test is
// the tripwire for that.
//
// Method: every expectation is stated against an EXPECTED TABLE declared
// independently in this file, not derived from the module under test. In
// particular `ALWAYS_STAGED_SCOPED_ENTRIES` is checked against the table's own
// `staging` column, so the assertion is not a restatement of the production
// `filter` — if both the record's staging and the derived list changed together,
// the table still disagrees.
//
// Validates: Requirements 10.1, 10.6

import { describe, expect, it } from "vitest";

import {
  ALWAYS_STAGED_SCOPED_ENTRIES,
  BUILD_TOOLS,
  CONSUMER_CATEGORIES,
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
  INTEGRATION_TESTS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  OVERSEER_ENTRYPOINT,
  PACKAGES_DIR,
  WORKSPACE_SCOPE,
  frameworkSingletonByName,
  type ConsumerCategory,
  type FrameworkSingleton,
} from "../src/framework.js";

/**
 * The four Framework_Singletons as R10.1 names them, in the order R10.6 fixes,
 * with every field spelled out as a literal. Deliberately hand-written rather
 * than composed from `WORKSPACE_SCOPE`/`PACKAGES_DIR`: the composition is part
 * of what is under test.
 */
const EXPECTED_SINGLETONS: readonly FrameworkSingleton[] = [
  {
    name: "@microservices/contracts",
    dirName: "contracts",
    packageDir: "packages/contracts",
    staging: "scoped-node-modules",
    buildPosition: "first",
  },
  {
    name: "@microservices/overseer",
    dirName: "overseer",
    packageDir: "packages/overseer",
    staging: "package-dir",
    buildPosition: "last",
  },
  {
    name: "@microservices/build-tools",
    dirName: "build-tools",
    packageDir: "packages/build-tools",
    staging: "none",
    buildPosition: "excluded",
  },
  {
    name: "@microservices/integration-tests",
    dirName: "integration-tests",
    packageDir: "packages/integration-tests",
    staging: "none",
    buildPosition: "excluded",
  },
];

/** The Namespace_Container directory of each Consumer_Category (R10.1). */
const EXPECTED_NAMESPACE_CONTAINERS: Readonly<
  Record<ConsumerCategory, string>
> = {
  microservice: "packages/microservices",
  common: "packages/common",
  spa: "packages/spa",
};

describe("framework.ts surface: FRAMEWORK_SINGLETONS (R10.6)", () => {
  it("enumerates exactly the four expected entries, in a fixed order, and nothing else", () => {
    expect(FRAMEWORK_SINGLETONS).toEqual(EXPECTED_SINGLETONS);
    expect(FRAMEWORK_SINGLETONS).toHaveLength(EXPECTED_SINGLETONS.length);
  });

  it("enumerates the same order on every traversal", () => {
    const first = [...FRAMEWORK_SINGLETONS].map((entry) => entry.name);
    const second = [...FRAMEWORK_SINGLETONS].map((entry) => entry.name);

    expect(second).toEqual(first);
    expect(first).toEqual(EXPECTED_SINGLETONS.map((entry) => entry.name));
  });

  it("is the collection the four exported singleton constants belong to", () => {
    // A check over "every Framework_Singleton" iterates this collection and needs
    // no second list: the named exports are the very elements, not copies.
    expect(FRAMEWORK_SINGLETONS).toContain(CONTRACTS);
    expect(FRAMEWORK_SINGLETONS).toContain(OVERSEER);
    expect(FRAMEWORK_SINGLETONS).toContain(BUILD_TOOLS);
    expect(FRAMEWORK_SINGLETONS).toContain(INTEGRATION_TESTS);
    expect([...FRAMEWORK_SINGLETONS]).toEqual([
      CONTRACTS,
      OVERSEER,
      BUILD_TOOLS,
      INTEGRATION_TESTS,
    ]);
  });

  it("composes each entry's three identifiers from the single scope and packages-dir declarations", () => {
    expect(WORKSPACE_SCOPE).toBe("@microservices");
    expect(PACKAGES_DIR).toBe("packages");

    for (const entry of FRAMEWORK_SINGLETONS) {
      expect(entry.name).toBe(`${WORKSPACE_SCOPE}/${entry.dirName}`);
      expect(entry.packageDir).toBe(`${PACKAGES_DIR}/${entry.dirName}`);
    }
  });

  it("resolves every entry by its exact declared name, and nothing else", () => {
    for (const expected of EXPECTED_SINGLETONS) {
      expect(frameworkSingletonByName(expected.name)).toEqual(expected);
    }

    // Case-sensitive, exact string equality: no bare name, no prefix, no path.
    expect(frameworkSingletonByName("contracts")).toBeUndefined();
    expect(
      frameworkSingletonByName("@microservices/Contracts"),
    ).toBeUndefined();
    expect(frameworkSingletonByName("packages/contracts")).toBeUndefined();
  });
});

describe("framework.ts surface: composed paths and staging (R10.1)", () => {
  it("composes OVERSEER_ENTRYPOINT as packages/overseer/dist/index.js", () => {
    expect(OVERSEER_ENTRYPOINT).toBe("packages/overseer/dist/index.js");
  });

  it("holds in ALWAYS_STAGED_SCOPED_ENTRIES exactly the singletons staged under the scope", () => {
    const expected = EXPECTED_SINGLETONS.filter(
      (entry) => entry.staging === "scoped-node-modules",
    ).map((entry) => entry.dirName);

    // The expected table says that is `contracts` alone (R5.10, R7.7); pinning
    // the literal too keeps the derivation honest.
    expect(expected).toEqual(["contracts"]);
    expect([...ALWAYS_STAGED_SCOPED_ENTRIES]).toEqual(expected);
  });
});

describe("framework.ts surface: Namespace_Containers (R10.1)", () => {
  it("covers all three Consumer_Categories and no other key", () => {
    expect([...CONSUMER_CATEGORIES]).toEqual(["microservice", "common", "spa"]);
    expect(Object.keys(NAMESPACE_CONTAINER).sort()).toEqual(
      [...CONSUMER_CATEGORIES].sort(),
    );

    for (const category of CONSUMER_CATEGORIES) {
      expect(NAMESPACE_CONTAINER[category]).toBe(
        EXPECTED_NAMESPACE_CONTAINERS[category],
      );
    }
  });

  it("gives each category a distinct directory under packages/", () => {
    const directories = CONSUMER_CATEGORIES.map(
      (category) => NAMESPACE_CONTAINER[category],
    );

    expect(new Set(directories).size).toBe(CONSUMER_CATEGORIES.length);
    for (const directory of directories) {
      expect(directory.startsWith(`${PACKAGES_DIR}/`)).toBe(true);
    }
  });
});

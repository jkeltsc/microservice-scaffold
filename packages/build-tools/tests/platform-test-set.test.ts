// Feature: platform-fixtures — the shared Platform_Test_Set derivation
// (task 8.1; R12.5, R13.2).
//
// This module is the ONE derivation two guards depend on: the
// Classification_Guard (task 8.3) and the Worktree_Guard (task 9.1). Because
// both consumers rely on its exact behaviour, a small sanity test pins it here,
// beside the module, rather than leaving every claim to the two guards' own
// property suites.
//
// The pure core (`platformTestSetCore`) is driven with a hand-built tracked-file
// list and an in-memory reader, so the derivation's four steps are asserted with
// no filesystem and no `git`. The effect shell (`platformTestSet`) is then run
// once over this repository to confirm the two facts the guards lean on: the set
// includes `packages/integration-tests/tests/helpers.ts` (step 4's one real
// member today) and excludes every Consumer_Package test (step 3, R12.4).
//
// Validates: Requirements 12.5, 13.2

import { describe, expect, it } from "vitest";

import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  isPlatformTestFile,
  platformTestRoots,
  platformTestSet,
  platformTestSetCore,
  relativeImportSpecifiers,
  resolveSiblingModule,
} from "../src/testing/platform-test-set.js";

const CONTEXT = projectContext(defaultEffectiveConfig());

describe("Platform_Test_Set — the file-name filter (step 2)", () => {
  it("keeps exactly the three test suffixes", () => {
    expect(isPlatformTestFile("packages/contracts/tests/a.test.ts")).toBe(true);
    expect(isPlatformTestFile("packages/contracts/tests/a.property.test.ts")).toBe(
      true,
    );
    expect(isPlatformTestFile("packages/contracts/tests/a.test-d.ts")).toBe(true);
  });

  it("rejects a non-test source", () => {
    expect(isPlatformTestFile("packages/contracts/src/index.ts")).toBe(false);
    expect(isPlatformTestFile("packages/integration-tests/tests/helpers.ts")).toBe(
      false,
    );
  });
});

describe("Platform_Test_Set — the roots (step 3)", () => {
  it("is the four Framework_Singleton directories plus the Entry_Root", () => {
    expect([...platformTestRoots(CONTEXT)]).toEqual([
      "packages/contracts",
      "packages/overseer",
      "packages/build-tools",
      "packages/integration-tests",
      "app",
    ]);
  });
});

describe("Platform_Test_Set — relative-import parsing and resolution (step 4)", () => {
  it("collects relative static and dynamic import specifiers only", () => {
    const source = [
      `import { a } from "./helpers.js";`,
      `import { b } from "../src/x.js";`,
      `import { c } from "@microservices/contracts";`,
      `export { d } from "./reexport.js";`,
      `const e = await import("./dynamic.js");`,
      `const f = await import("node:fs");`,
    ].join("\n");
    expect([...relativeImportSpecifiers(source)]).toEqual([
      "./helpers.js",
      "../src/x.js",
      "./reexport.js",
      "./dynamic.js",
    ]);
  });

  it("resolves a same-directory .js specifier to its .ts sibling", () => {
    expect(
      resolveSiblingModule(
        "packages/integration-tests/tests/mount-dispatch.test.ts",
        "./helpers.js",
      ),
    ).toBe("packages/integration-tests/tests/helpers.ts");
  });

  it("drops a specifier that escapes the importing file's own directory", () => {
    expect(
      resolveSiblingModule(
        "packages/integration-tests/tests/a.test.ts",
        "../src/x.js",
      ),
    ).toBeUndefined();
  });
});

describe("Platform_Test_Set — the pure core (all four steps)", () => {
  // A synthetic tracked tree exercising every branch: a kept Framework_Singleton
  // test, a kept Entry_Root test, a Consumer_Package test that must be excluded,
  // a tracked sibling helper reached by relative import (step 4), an untracked
  // sibling that must NOT be added, and a plain non-test module that matches no
  // step.
  const tracked = [
    "packages/contracts/tests/shape.test.ts",
    "packages/integration-tests/tests/mount.test.ts",
    "packages/integration-tests/tests/helpers.ts",
    "app/tests/entry.test.ts",
    "packages/microservices/microservice1/src/index.test.ts",
    "packages/build-tools/src/testing/platform-test-set.ts",
  ];
  const sources: Record<string, string> = {
    "packages/contracts/tests/shape.test.ts": `import "node:assert";`,
    "packages/integration-tests/tests/mount.test.ts": `import { buildApp } from "./helpers.js";\nimport { x } from "./missing.js";`,
    "app/tests/entry.test.ts": `import { boot } from "@microservices/overseer";`,
    "packages/microservices/microservice1/src/index.test.ts": `import { router } from "./router.js";`,
  };
  const set = platformTestSetCore(
    tracked,
    platformTestRoots(CONTEXT),
    (path) => sources[path] ?? "",
  );

  it("keeps test files under a Framework_Singleton dir or the Entry_Root", () => {
    expect(set).toContain("packages/contracts/tests/shape.test.ts");
    expect(set).toContain("packages/integration-tests/tests/mount.test.ts");
    expect(set).toContain("app/tests/entry.test.ts");
  });

  it("adds a tracked non-test sibling imported by relative path (step 4)", () => {
    expect(set).toContain("packages/integration-tests/tests/helpers.ts");
  });

  it("excludes a Consumer_Package test (R12.4) and an untracked sibling", () => {
    expect(set).not.toContain(
      "packages/microservices/microservice1/src/index.test.ts",
    );
    expect(set).not.toContain("packages/integration-tests/tests/missing.ts");
  });

  it("returns sorted, deduplicated repo-relative POSIX paths", () => {
    expect([...set]).toEqual([...set].sort());
    expect(new Set(set).size).toBe(set.length);
  });
});

describe("Platform_Test_Set — the effect shell over this repository", () => {
  const set = platformTestSet();

  it("has at least the non-vacuity floor of two members", () => {
    expect(set.length).toBeGreaterThanOrEqual(2);
  });

  it("includes the shared harness helpers.ts (step 4's one real member)", () => {
    expect(set).toContain("packages/integration-tests/tests/helpers.ts");
  });

  it("includes known Framework_Singleton and Entry_Package tests", () => {
    expect(set).toContain(
      "packages/integration-tests/tests/worktree-safety-guard.test.ts",
    );
    expect(set).toContain("packages/build-tools/tests/framework.test.ts");
  });

  it("excludes every Consumer_Package test (R12.4)", () => {
    const roots = ["packages/microservices/", "packages/common/", "packages/spa/"];
    const leaked = set.filter((path) =>
      roots.some((root) => path.startsWith(root)),
    );
    expect(leaked).toEqual([]);
  });
});

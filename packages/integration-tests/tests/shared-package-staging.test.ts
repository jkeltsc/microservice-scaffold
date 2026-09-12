// Task 7.2 — Image_Tree staging of the Selector-justified scoped packages.
//
// Assembles the real image tree with `buildImageTree` for two selectors and
// asserts the staged scoped-package layout matches what the Selector justifies:
//
//   - A selector that includes `microservice2` (which consumes
//     `@microservices/config`, the Common_Package now living at
//     `packages/common/config`) stages `@microservices/config` — it is a
//     Required_Dependencies member — AND `@microservices/contracts` — which is
//     staged unconditionally as a Framework_Singleton (known by name, always
//     staged first), not because any consumer requires it. Both land as REAL
//     directories under `node_modules/@microservices/`, each carrying
//     `package.json` + `dist/`.
//   - A `microservice1`-only selector stages NO config (no selected consumer
//     makes the `packages/common/config` package a required dependency), but still
//     stages `contracts` — the Framework_Singleton is staged regardless of
//     selector.
//
// The staged scoped entry name (`node_modules/@microservices/config`) is
// unchanged; only the source package moved to `packages/common/config`.
//
// `buildImageTree` reads `process.env.MICROSERVICES`, generates the registry,
// runs `tsc --build`, and stages relative to cwd (the repo root). The test
// therefore pins cwd to the repo root, sets the selector per case, and restores
// cwd + the selector env afterward. Because each case runs a real
// `tsc --build`, the timeouts are generous.
//
// Validates: Requirements R5.6, R5.10, R8.8, R8.11, R8.12

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { buildImageTree } from "@microservices/build-tools/dist/image-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** Real assembly runs a full `tsc --build`; give each case room. */
const ASSEMBLE_TIMEOUT_MS = 180_000;

/** Assemble the image tree for `selector` into a fresh temp outDir. */
function assemble(selector: string): { outDir: string } {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  const outDir = mkdtempSync(join(tmpdir(), "shared-package-staging-"));
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    buildImageTree(outDir);
  } finally {
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
  return { outDir };
}

/** Path to a staged shared/microservice package under the image tree. */
function scopedPackageDir(outDir: string, name: string): string {
  return join(outDir, "node_modules", "@microservices", name);
}

/**
 * Assert `name` is staged under the image tree as a REAL directory (not a
 * symlink) carrying `package.json` + `dist/`.
 */
function expectStagedRealPackage(outDir: string, name: string): void {
  const pkgDir = scopedPackageDir(outDir, name);
  const dirStat = lstatSync(pkgDir);
  expect(dirStat.isDirectory(), `${name} should be a directory`).toBe(true);
  expect(
    dirStat.isSymbolicLink(),
    `${name} must be a real directory, not a workspace symlink`,
  ).toBe(false);
  expect(lstatSync(join(pkgDir, "package.json")).isFile()).toBe(true);
  expect(lstatSync(join(pkgDir, "dist")).isDirectory()).toBe(true);
}

describe("Image_Tree staging of Selector-justified scoped packages", () => {
  const outDirs: string[] = [];

  afterAll(() => {
    for (const dir of outDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("selector includes microservice2 (a @microservices/config consumer)", () => {
    let outDir: string;

    beforeAll(() => {
      ({ outDir } = assemble("microservice1,microservice2"));
      outDirs.push(outDir);
    }, ASSEMBLE_TIMEOUT_MS);

    it("stages @microservices/config (packages/common/config) as a real directory with package.json + dist (R5.6, R8.8, R8.11)", () => {
      expectStagedRealPackage(outDir, "config");
    });

    it("stages @microservices/contracts as a real directory — justified as a Framework_Singleton, always staged (R5.10, R8.11)", () => {
      expectStagedRealPackage(outDir, "contracts");
    });
  });

  describe("microservice1-only selector (no @microservices/config consumer)", () => {
    let outDir: string;

    beforeAll(() => {
      ({ outDir } = assemble("microservice1"));
      outDirs.push(outDir);
    }, ASSEMBLE_TIMEOUT_MS);

    it("omits @microservices/config — no selected microservice requires packages/common/config (R5.6, R8.12)", () => {
      expect(() => lstatSync(scopedPackageDir(outDir, "config"))).toThrow();
    });

    it("still stages @microservices/contracts — justified as a Framework_Singleton, staged regardless of selector (R5.10, R8.11)", () => {
      expectStagedRealPackage(outDir, "contracts");
    });
  });
});

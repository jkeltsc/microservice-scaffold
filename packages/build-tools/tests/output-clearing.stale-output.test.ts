// R8.6 — a fixture build run immediately after a *failed* fixture build over
// the same directory reports what a directory that was never built reports.
//
// WHY THE FUNCTION EXISTS. A `tsc` run that failed part-way leaves some emitted
// `dist/` files and a `*.tsbuildinfo` claiming they are current. Because a
// Tsc_Project sets `composite: true`, the compiler trusts that buildinfo over
// the `dist/` it names and the next build can SKIP emitting — so a later build
// over the same directory "succeeds" carrying stale output, and a test
// asserting on the presence of output passes for entirely the wrong reason.
// `clearOutput` removes every `dist/` and every `*.tsbuildinfo` first, so the
// directory a build is about to run over holds exactly the Generated_Fixture_
// Output a never-built directory holds: none.
//
// HOW THIS SUITE MODELS "what a build reports". The observable R8.6 constrains
// is the Generated_Fixture_Output present on disk when a build begins — that is
// precisely what decides whether `tsc` emits afresh or trusts stale artefacts.
// This suite therefore compares the Generated_Fixture_Output state of two
// prepared directories after `clearOutput` runs over each:
//
//   * a NEVER-BUILT directory: a fixture source (a `src/` and manifests) with
//     no `dist/` and no `*.tsbuildinfo`;
//   * a FAILED-BUILD directory: the same fixture source PLUS the partial output
//     a failed `tsc` leaves — a populated `dist/` and a `*.tsbuildinfo`.
//
// After `clearOutput`, the two directories carry the identical set of
// Generated_Fixture_Output (empty) — so a build over the failed-build directory
// begins from the same state, and therefore reports the same result, as a build
// over the never-built one. That equivalence is the function's whole purpose,
// and it is deterministic (example-based), not a property.
//
// This suite operates entirely inside OS temp directories and writes nothing
// under the checked-out tree.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearOutput } from "../src/testing/output-clearing.js";

/** Write a fixture "source" tree — the files a never-built and a failed-build
 *  directory share. None of it is Generated_Fixture_Output. */
function writeFixtureSource(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "name": "fixture" }\n', "utf8");
  writeFileSync(join(root, "tsconfig.json"), '{ "compilerOptions": {} }\n', "utf8");
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
}

/** Add the partial output a failed `tsc` leaves: a populated `dist/` and a
 *  `*.tsbuildinfo` that (with `composite: true`) would make the next build skip
 *  emitting. */
function writeFailedBuildOutput(root: string): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "export const x = 1;\n", "utf8");
  writeFileSync(join(root, "dist", "index.d.ts"), "export declare const x: number;\n", "utf8");
  writeFileSync(join(root, "tsconfig.tsbuildinfo"), '{ "version": "stale" }\n', "utf8");
}

/** The set of Generated_Fixture_Output paths present under `root`, as
 *  root-relative POSIX paths: every `*.tsbuildinfo` file and every path that
 *  lies within a `dist/` directory (the `dist/` directory itself included).
 *  `node_modules/` is never descended into. This is the observable R8.6
 *  compares between the two directories. */
function generatedOutputPaths(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, insideDist: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (insideDist || entry.name === "dist") {
          found.push(rel);
          walk(abs, true);
        } else {
          walk(abs, false);
        }
      } else if (insideDist) {
        found.push(rel);
      } else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
        found.push(rel);
      }
    }
  };
  walk(root, false);
  return found.sort();
}

describe("R8.6: a build after a failed build reports what a never-built directory reports", () => {
  // A single temp tier root supplied to clearOutput as its fixtureTierRoot
  // argument, and the two prepared directories, all inside the OS temp
  // directory.
  let tierRoot: string;
  let neverBuilt: string;
  let failedBuild: string;

  beforeAll(() => {
    tierRoot = mkdtempSync(join(tmpdir(), "oc-stale-tier-"));

    neverBuilt = join(tierRoot, "never-built");
    failedBuild = join(tierRoot, "failed-build");
    mkdirSync(neverBuilt, { recursive: true });
    mkdirSync(failedBuild, { recursive: true });

    // Both hold the identical fixture source; only the failed-build directory
    // additionally holds the partial output a failed tsc left behind.
    writeFixtureSource(neverBuilt);
    writeFixtureSource(failedBuild);
    writeFailedBuildOutput(failedBuild);
  });

  afterAll(() => {
    if (tierRoot) rmSync(tierRoot, { recursive: true, force: true });
  });

  it("the never-built directory carries no Generated_Fixture_Output to begin with", () => {
    expect(generatedOutputPaths(neverBuilt)).toEqual([]);
  });

  it("the failed-build directory carries stale Generated_Fixture_Output before clearing", () => {
    // Guards the premise: without stale output there is nothing for R8.6 to be
    // about.
    expect(generatedOutputPaths(failedBuild)).not.toEqual([]);
    expect(existsSync(join(failedBuild, "dist"))).toBe(true);
    expect(existsSync(join(failedBuild, "tsconfig.tsbuildinfo"))).toBe(true);
  });

  it("after clearing, the failed-build directory's output state equals the never-built directory's", () => {
    clearOutput(neverBuilt, tierRoot);
    clearOutput(failedBuild, tierRoot);

    const neverBuiltOutput = generatedOutputPaths(neverBuilt);
    const failedBuildOutput = generatedOutputPaths(failedBuild);

    // Both carry the identical Generated_Fixture_Output — none — so a build over
    // the failed-build directory begins from, and reports, exactly what a build
    // over the never-built directory does.
    expect(failedBuildOutput).toEqual(neverBuiltOutput);
    expect(failedBuildOutput).toEqual([]);

    // The stale artefacts specifically are gone; the shared source survives.
    expect(existsSync(join(failedBuild, "dist"))).toBe(false);
    expect(existsSync(join(failedBuild, "tsconfig.tsbuildinfo"))).toBe(false);
    expect(existsSync(join(failedBuild, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(failedBuild, "package.json"))).toBe(true);
  });
});

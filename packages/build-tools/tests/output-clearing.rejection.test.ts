// R8.5 — Output_Clearing refuses a path that is neither inside the Fixture_Tier
// nor inside an OS temp directory: it makes NO removal and reports the rejected
// path.
//
// This is the deterministic (example-based) counterpart to the idempotence and
// exactness property (Property 4, `output-clearing.property.test.ts`). It fixes
// the refusal contract: `clearOutput` guards before it walks, so a mistyped
// relative path that resolved into `packages/` cannot silently delete the
// platform's own build output.
//
// CONSTRUCTING AN OUT-OF-TEMP, OUT-OF-TIER TARGET. `clearOutput(directory,
// fixtureTierRoot)` accepts `directory` when it lies inside `fixtureTierRoot`
// OR inside `os.tmpdir()`. To force a rejection the target must be outside
// BOTH. The technique used here:
//
//   * `fixtureTierRoot` is a fresh `mkdtemp` directory INSIDE the OS temp
//     directory — a real, isolated tier root that the target does not lie
//     under. (Passing the true FIXTURES_ROOT would work equally, but a
//     throwaway temp root keeps the suite self-contained and touches nothing
//     under the checked-out tree.)
//   * the rejected `directory` is a path under the REPOSITORY ROOT (derived
//     from this file's own location, exactly as `fixture-paths.ts` derives it)
//     — the Project_Directory is neither inside the OS temp directory nor
//     inside the temp tier root, so it is refused. The path names a
//     non-existent child of the repo root, so there is nothing there to remove
//     even if the guard were broken; the guard rejects on the resolved logical
//     path regardless of whether it exists.
//
// PROVING "nothing removed". A sentinel `dist/` directory and a sentinel
// `*.tsbuildinfo` file are materialised inside the OS temp directory and are
// NEVER passed to `clearOutput`. After the rejected call throws, they are still
// present — evidence that the throw happened before any removal walk ran, and
// that the refusal did not wander into any neighbouring tree.
//
// This suite operates entirely inside OS temp directories and writes nothing
// under the checked-out tree.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearOutput } from "../src/testing/output-clearing.js";

// The Project_Directory (repository root), derived relative to this file's own
// location the same way `fixture-paths.ts` does:
// tests/ -> build-tools -> packages -> repo root. It is neither inside the OS
// temp directory nor inside the throwaway temp tier root this suite creates, so
// a target composed from it is refused.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(__dirname, "..", "..", "..");

describe("R8.5: Output_Clearing refuses a path outside the tier and outside an OS temp directory", () => {
  // A throwaway Fixture_Tier root, itself inside the OS temp directory. The
  // rejected target does not lie under it, so the tier clause of the guard does
  // not accept the target.
  let tierRoot: string;
  // A sentinel tree inside the OS temp directory, never passed to clearOutput,
  // used to prove that the refused call removed nothing anywhere.
  let sentinelRoot: string;
  let sentinelDist: string;
  let sentinelBuildInfo: string;

  beforeAll(() => {
    tierRoot = mkdtempSync(join(tmpdir(), "oc-rejection-tier-"));

    sentinelRoot = mkdtempSync(join(tmpdir(), "oc-rejection-sentinel-"));
    sentinelDist = join(sentinelRoot, "dist");
    sentinelBuildInfo = join(sentinelRoot, "tsconfig.tsbuildinfo");
    mkdirSync(sentinelDist, { recursive: true });
    writeFileSync(join(sentinelDist, "index.js"), "export {};\n", "utf8");
    writeFileSync(sentinelBuildInfo, "{}\n", "utf8");
  });

  afterAll(() => {
    // Unconditional teardown of the temp directories this suite created.
    for (const dir of [tierRoot, sentinelRoot]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws naming the rejected path when the directory is outside both the tier and an OS temp directory", () => {
    // A non-existent child of the repository root: outside the OS temp
    // directory and outside the temp tier root, so it must be refused.
    const rejected = join(PROJECT_DIRECTORY, "oc-rejection-should-never-touch");
    expect(existsSync(rejected)).toBe(false);

    let thrown: unknown;
    try {
      clearOutput(rejected, tierRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // The rejected path is named in the message (reported as its resolved form).
    expect((thrown as Error).message).toContain(resolve(rejected));
  });

  it("performs no removal when it refuses: the sentinel output is left intact", () => {
    // Sanity: the sentinel output exists before the refused call.
    expect(existsSync(sentinelDist)).toBe(true);
    expect(existsSync(sentinelBuildInfo)).toBe(true);

    const rejected = join(PROJECT_DIRECTORY, "packages", "build-tools", "src");
    expect(() => clearOutput(rejected, tierRoot)).toThrow();

    // Nothing anywhere was removed — the guard ran before any walk. The
    // sentinel `dist/` and `*.tsbuildinfo`, which live in a temp directory the
    // guard WOULD have cleared had it been the target, are untouched.
    expect(existsSync(sentinelDist)).toBe(true);
    expect(existsSync(join(sentinelDist, "index.js"))).toBe(true);
    expect(existsSync(sentinelBuildInfo)).toBe(true);
  });
});

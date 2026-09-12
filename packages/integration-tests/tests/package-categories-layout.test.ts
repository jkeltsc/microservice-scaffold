// Structural assertions on the committed `packages/` layout for the
// package-categories taxonomy.
//
// This suite asserts facts about the Repository itself — what is checked in —
// rather than about any Build_System behavior. The fact it pins is the shape of
// the `packages/spa/` Namespace_Container. It is no longer empty: it now holds
// the `demo` Spa_Package member (the first Spa_Package), alongside the
// `.gitkeep` placeholder that was committed when the container shipped empty.
//
// "One Spa_Package" is asserted with the same qualifying-entry rule
// Package_Discovery uses (R2.4): a direct entry qualifies when it resolves to a
// directory and its name does not begin with `.`. The container therefore holds
// exactly one qualifying entry, `demo`, and one non-qualifying entry,
// `.gitkeep`, which discovery ignores twice over — it is not a directory, and
// its name is dot-prefixed.
//
// Validates: Requirements 9.2

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const spaContainer = resolve(repoRoot, "packages", "spa");

/**
 * The direct entries of a Namespace_Container that qualify as Consumer_Packages
 * under R2.4: the entry resolves to a directory (symlinks followed, matching
 * `statSync` semantics) and the entry name does not begin with `.`.
 */
function qualifyingEntries(containerDir: string): readonly string[] {
  return readdirSync(containerDir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(resolve(containerDir, name)).isDirectory();
      } catch {
        // A dangling symlink resolves to nothing, so it is not a directory.
        return false;
      }
    })
    .sort();
}

describe("packages/spa/ holds the demo Spa_Package member", () => {
  it("exists as a directory", () => {
    expect(
      existsSync(spaContainer),
      "packages/spa/ must exist in the repository",
    ).toBe(true);
    expect(statSync(spaContainer).isDirectory()).toBe(true);
  });

  it("holds exactly the demo qualifying subdirectory", () => {
    // Reported as the list rather than a count so a failure names the offender.
    expect(qualifyingEntries(spaContainer)).toEqual(["demo"]);
  });

  it("is not itself a package (no package.json)", () => {
    // A Namespace_Container declares no manifest; only its members do.
    expect(existsSync(resolve(spaContainer, "package.json"))).toBe(false);
  });

  it("still carries the .gitkeep placeholder alongside the demo member", () => {
    // The demo member was added beside the original placeholder, so both are on
    // disk. `.gitkeep` is non-qualifying on both counts of the R2.4 rule (not a
    // directory, dot-prefixed name), so discovery ignores it and finds only
    // `demo`.
    expect(readdirSync(spaContainer).sort()).toEqual([".gitkeep", "demo"]);
    expect(statSync(resolve(spaContainer, ".gitkeep")).isFile()).toBe(true);
  });

  it("discovers demo as a Spa_Package satisfying the spa category contract", () => {
    // The Spa_Package's category contract (structure.md) is a non-empty
    // `scripts.build`, and its `name` must mirror its directory as
    // `@microservices/<dirName>`. No `main`/`types` is required or expected.
    const demoDir = resolve(spaContainer, "demo");
    expect(statSync(demoDir).isDirectory()).toBe(true);

    const manifestPath = resolve(demoDir, "package.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      scripts?: { build?: unknown };
    };

    expect(manifest.name).toBe("@microservices/demo");
    expect(typeof manifest.scripts?.build).toBe("string");
    expect((manifest.scripts?.build as string).length).toBeGreaterThan(0);
  });
});

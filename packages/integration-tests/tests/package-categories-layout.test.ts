// Structural assertions on the committed `packages/` layout for the
// package-categories taxonomy.
//
// This suite asserts facts about the Repository itself — what is checked in —
// rather than about any Build_System behavior. The only fact it pins today is
// the shape of the newly introduced `packages/spa/` Namespace_Container: the
// container exists, it holds zero Spa_Packages, and it is not itself a package.
//
// "Zero Spa_Packages" is asserted with the same qualifying-entry rule
// Package_Discovery uses (R2.4): a direct entry qualifies when it resolves to a
// directory and its name does not begin with `.`. The container therefore holds
// exactly one non-qualifying entry, `.gitkeep`, which exists only because git
// cannot track an empty directory and which discovery ignores twice over — it
// is not a directory, and its name is dot-prefixed.
//
// Validates: Requirements 9.2

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
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

describe("packages/spa/ is an empty Namespace_Container", () => {
  it("exists as a directory", () => {
    expect(
      existsSync(spaContainer),
      "packages/spa/ must exist in the repository",
    ).toBe(true);
    expect(statSync(spaContainer).isDirectory()).toBe(true);
  });

  it("holds zero qualifying subdirectories", () => {
    // Reported as the list rather than a count so a failure names the offender.
    expect(qualifyingEntries(spaContainer)).toEqual([]);
  });

  it("is not itself a package (no package.json)", () => {
    // A Namespace_Container declares no manifest; only its members do.
    expect(existsSync(resolve(spaContainer, "package.json"))).toBe(false);
  });

  it("holds only the .gitkeep placeholder", () => {
    // Pins the reason the directory is trackable at all: the single entry is
    // non-qualifying on both counts of the R2.4 rule.
    expect(readdirSync(spaContainer).sort()).toEqual([".gitkeep"]);
    expect(statSync(resolve(spaContainer, ".gitkeep")).isFile()).toBe(true);
  });
});

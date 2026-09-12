// Feature: package-categories, Property 20: A staged package contributes exactly its manifest plus its `dist/` contents
//
// `copyPackage(sourceDir, targetDir)` is the single staging primitive every
// Package_Category flows through (Framework_Singleton, Microservice_Package,
// Common_Package, Spa_Package), so "manifest plus `dist/`" is one rule rather
// than four (R6.8). This property pins that rule directly: for an arbitrary
// package source tree — `package.json` and `dist/` surrounded by any number of
// extra files and directories at any depth — the set of tree-relative paths
// `copyPackage` produces in the target equals `package.json` plus every file
// under `dist/`, with nothing else from the source tree carried over and no
// `dist/` file dropped.
//
// Like `image-tree-minimality.test.ts`, this uses a real temp directory rather
// than a stubbed filesystem: `copyPackage` is pure effect (`cpSync`) with no
// injected reader, so the only faithful oracle is to build a real tree, stage
// it, and walk both sides. The Testing Strategy note keeps this property in
// `build-tools` (not `integration-tests`) precisely because it exercises one
// exported function against a temp dir.
//
// The `category` axis is modelled as a label attached to each generated tree
// rather than as a behavioural switch, because `copyPackage` reads no category:
// staging is uniform. Varying the label across every Package_Category and
// asserting the same invariant is what demonstrates the uniformity R6.8 claims.
//
// Validates: Requirements 6.8

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { copyPackage } from "../src/image-tree.js";

/** Every Package_Category, so the invariant is asserted uniformly across all. */
const CATEGORIES = [
  "framework-singleton",
  "microservice",
  "common",
  "spa",
] as const;

/**
 * A file to plant in a generated tree: a slash-separated path relative to the
 * package root plus its byte contents. Directories are implied by the path.
 */
interface PlantedFile {
  readonly path: string;
  readonly contents: string;
}

/** A single path segment: safe, non-dotted, no separators, non-empty. */
const segment = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((s) => s.replace(/[^a-zA-Z0-9]/g, "x"))
  .filter((s) => s.length > 0 && s !== "." && s !== "..");

/** A relative path of one or more segments, e.g. `a`, `a/b`, `a/b/c`. */
const relPath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));

/** File contents; arbitrary bytes are fine, kept small for run speed. */
const contents = fc.string({ maxLength: 32 });

/** Zero or more files placed *under* `dist/` — these MUST be staged. */
const distFiles = fc.array(
  fc.record({ path: relPath, contents }).map(
    ({ path, contents: c }): PlantedFile => ({
      path: `dist/${path}`,
      contents: c,
    }),
  ),
  { maxLength: 6 },
);

/**
 * Zero or more "noise" files elsewhere in the source tree (src/, tests/,
 * READMEs, nested config, even a stray top-level file) — none of these may be
 * staged. Paths are constrained to never begin with `dist/` or equal
 * `package.json`, since those are the two things that ARE staged.
 */
const noiseFiles = fc.array(
  fc.record({ path: relPath, contents }).map(
    ({ path, contents: c }): PlantedFile => ({ path, contents: c }),
  ),
  { maxLength: 8 },
).map((files) =>
  files.filter(
    (f) => f.path !== "package.json" && !f.path.startsWith("dist/"),
  ),
);

/**
 * True when the planted paths form a valid filesystem: no path repeats, and no
 * path is a strict directory-prefix of another (which would require the same
 * name to be both a file and a directory). `package.json` and the implicit
 * `dist/` directory are reserved, so no planted path may collide with them.
 *
 * Every comparison is CASE-INSENSITIVE because the target filesystem may be
 * (macOS APFS is by default), and one on-disk entry cannot hold two spellings
 * that differ only in case. fast-check found two collision classes a
 * case-sensitive check lets through:
 *   - `x/x` plus `X`: `plant()` makes directory `x` (parent of `x/x`), then
 *     `writeFileSync("X")` hits that same entry and throws `EISDIR` before
 *     `copyPackage` runs.
 *   - `dist/xX/x` plus `dist/xx/xx`: directories `xX` and `xx` are one entry on
 *     disk, so the second file lands under whichever spelling was planted
 *     first, and the walked tree no longer matches the case-preserving
 *     `expected` set.
 * Both reduce to the same rule: a directory/file name must have a single
 * canonical spelling. So we require the case-folding to be injective at every
 * path prefix — if one lowercased prefix ever appears with two different
 * original spellings, the tree would collide on disk and is rejected. This
 * mirrors how sibling discovery tests key off a lowercased name for the same
 * macOS reason. (Reserving `package.json` in the fold also rejects noise like
 * `Package.json`; `dist/` is already reserved by the `noiseFiles` filter.)
 */
function isConsistentTree(paths: readonly string[]): boolean {
  const all = ["package.json", ...paths];

  // Every lowercased prefix must map to exactly one original spelling. A prefix
  // that ends a full path is a leaf (file); a shorter prefix is a directory.
  // Recording both spelling collisions and leaf/directory clashes here catches
  // duplicates, case-variant duplicates, strict directory-prefix overlaps, and
  // case-variant sibling directories in one pass.
  const spellingOf = new Map<string, string>();
  const leafKeys = new Set<string>();
  const dirKeys = new Set<string>();

  for (const path of all) {
    const segments = path.split("/");
    let lowerPrefix = "";
    for (let i = 0; i < segments.length; i++) {
      const original = segments[i];
      lowerPrefix = lowerPrefix === ""
        ? original.toLowerCase()
        : `${lowerPrefix}/${original.toLowerCase()}`;

      const existing = spellingOf.get(lowerPrefix);
      if (existing === undefined) {
        spellingOf.set(lowerPrefix, original);
      } else if (existing !== original) {
        return false; // same on-disk entry, two spellings
      }

      const isLeaf = i === segments.length - 1;
      if (isLeaf) {
        if (leafKeys.has(lowerPrefix) || dirKeys.has(lowerPrefix)) return false;
        leafKeys.add(lowerPrefix);
      } else {
        if (leafKeys.has(lowerPrefix)) return false; // file vs directory
        dirKeys.add(lowerPrefix);
      }
    }
  }
  return true;
}

/** A generated package source tree, tagged with the category it stands in for. */
const packageTree = fc
  .record({
    category: fc.constantFrom(...CATEGORIES),
    manifest: contents.map((c) => c || "{}"),
    dist: distFiles,
    noise: noiseFiles,
  })
  .filter((tree) =>
    isConsistentTree([
      ...tree.dist.map((f) => f.path),
      ...tree.noise.map((f) => f.path),
    ]),
  );

/** Write `file` (creating parent directories) under `root`. */
function plant(root: string, file: PlantedFile): void {
  const abs = join(root, ...file.path.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, file.contents);
}

/** Every file (not directory) under `root`, as tree-relative posix paths. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const recurse = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(abs);
      } else {
        out.push(relative(root, abs).split(sep).join(posix.sep));
      }
    }
  };
  recurse(root);
  return out.sort();
}

describe("copyPackage stages exactly package.json plus dist/ (Property 20)", () => {
  it("stages the manifest and every dist/ file, and nothing else, for every category", () => {
    fc.assert(
      fc.property(packageTree, (tree) => {
        const work = mkdtempSync(join(tmpdir(), "staging-prop-"));
        try {
          const sourceDir = join(work, "source");
          const targetDir = join(work, "target");
          mkdirSync(sourceDir, { recursive: true });

          // Always present: the manifest and the dist/ directory itself.
          writeFileSync(join(sourceDir, "package.json"), tree.manifest);
          mkdirSync(join(sourceDir, "dist"), { recursive: true });

          for (const file of tree.dist) {
            plant(sourceDir, file);
          }
          for (const file of tree.noise) {
            plant(sourceDir, file);
          }

          copyPackage(sourceDir, targetDir);

          const staged = walkFiles(targetDir);
          const expected = ["package.json", ...tree.dist.map((f) => f.path)]
            .sort();

          expect(staged).toStrictEqual(expected);
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }),
      { numRuns: 200 },
    );
  });
});

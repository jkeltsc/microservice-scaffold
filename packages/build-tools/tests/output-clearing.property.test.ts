// Feature: platform-fixtures, Property 4: Output_Clearing is idempotent and removes exactly the Generated_Fixture_Output
//
// For any directory tree carrying arbitrary `dist/` directories at arbitrary
// depths, arbitrary `*.tsbuildinfo` files, arbitrary other files, and a
// `node_modules/` directory, materialised inside an OS temporary directory:
//
//   * `clearOutput` is IDEMPOTENT (R8.3): the tree left by one application
//     equals the tree left by two, compared both as a relative path set and
//     as per-file bytes. Equivalently, a second application over an
//     already-cleared directory removes nothing.
//   * `clearOutput` removes EXACTLY the Generated_Fixture_Output (R8.4): after
//     one application no `dist` directory and no `*.tsbuildinfo` file remains
//     anywhere in the tree, while every other path present before — files,
//     plain directories, and the `node_modules/` directory with every file
//     inside it — is still present with its bytes byte-for-byte unchanged.
//
// The subject is materialised, never a committed fixture: the source tree lives
// in an OS temp directory (via `materializeFsTree`), and `clearOutput` operates
// there. Because `clearOutput` refuses any path neither inside the Fixture_Tier
// nor inside an OS temp directory (R8.5), the OS-temp-dir allowance is what
// makes clearing a materialised tree permitted; a valid Fixture_Tier root is
// still passed as the second argument (the OS temp directory itself), so this
// suite spells no `packages/build-tools/src/` tier literal and needs none.
// Nothing is written inside the checked-out tree, so this suite mutates no
// worktree file (R7.6 discipline).
//
// Assertions are made against the tree AS IT IS ON DISK — walked with
// `lstatSync`/`readFileSync`/`readdirSync` — rather than against the
// generator's description alone, so what `clearOutput` actually left is what is
// checked, robust to any node-name collision the generic generator may produce
// within one directory.
//
// Validates: Requirements 8.3, 8.4, 16.1, 16.5, 16.11

import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { clearOutput } from "../src/testing/output-clearing.js";

import {
  fsTree,
  materializeFsTree,
  removeMaterializedTree,
  type FsNode,
  type FsTreeDescription,
} from "./arbitraries/tree.js";

const NUM_RUNS = { numRuns: 200 } as const;

/** The directory name whose whole subtree is Generated_Fixture_Output. */
const OUTPUT_DIR_NAME = "dist";
/** The suffix marking a Generated_Fixture_Output buildinfo file. */
const BUILDINFO_SUFFIX = ".tsbuildinfo";

// ---------------------------------------------------------------------------
// On-disk tree observation
// ---------------------------------------------------------------------------

/** One observed filesystem entry, keyed by its POSIX-normalised relative path. */
type Observed =
  | { readonly kind: "file"; readonly bytes: Buffer }
  | { readonly kind: "dir" };

/**
 * Walk a directory and record every regular file (with its bytes) and every
 * directory (as a marker, so an empty `node_modules/` or plain directory that
 * must survive is observed), keyed by the path relative to `root` in POSIX
 * form. Directories are recorded AND recursed into, so a surviving-but-empty
 * directory contributes a marker of its own.
 */
function observeTree(root: string): Map<string, Observed> {
  const observed = new Map<string, Observed>();
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        observed.set(rel, { kind: "dir" });
        walk(absolute);
      } else if (stats.isFile()) {
        observed.set(rel, { kind: "file", bytes: readFileSync(absolute) });
      }
    }
  };
  walk(root);
  return observed;
}

/** A stable, comparable snapshot of an observation: sorted `[path, descriptor]`
 *  pairs, with file bytes rendered as a hex string so two snapshots compare with
 *  `toEqual`. */
function snapshotOf(
  observed: Map<string, Observed>,
): ReadonlyArray<readonly [string, string]> {
  return [...observed.entries()]
    .map(([rel, node]): readonly [string, string] =>
      node.kind === "file"
        ? [rel, `file:${node.bytes.toString("hex")}`]
        : [rel, "dir"],
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Whether every directory in the tree has sibling entries with distinct names.
 *
 * The generic `fsTree` generator draws each directory's children from a plain
 * array, so it may place two siblings of the same name at one level. Such a
 * description is not materialisable — a real filesystem cannot hold two entries
 * at one path, and the materialiser writes children in order, so the second
 * write collides or overwrites. That ambiguity is orthogonal to the exactness
 * claim (a real tree has unique sibling names by construction), so trees with a
 * sibling-name collision are filtered out before materialisation rather than
 * the (frozen) generator being changed.
 */
function hasUniqueSiblingNames(description: FsTreeDescription): boolean {
  const check = (nodes: readonly FsNode[]): boolean => {
    const names = nodes.map((node) => node.name);
    if (new Set(names).size !== names.length) return false;
    for (const node of nodes) {
      if (node.kind === "dir" && !check(node.children)) return false;
    }
    return true;
  };
  return check(description.nodes);
}

/**
 * The subset of an observation that must SURVIVE Output_Clearing: every path
 * that is neither inside a `dist/` directory nor a `*.tsbuildinfo` file. A path
 * is inside a `dist/` when any of its POSIX segments (other than the last, for
 * the `dist` directory marker itself) equals `dist`. This is the "every other
 * path" set R8.4 requires to be present with bytes unchanged after clearing.
 */
function survivingSubset(
  observed: Map<string, Observed>,
): Map<string, Observed> {
  const survivors = new Map<string, Observed>();
  for (const [rel, node] of observed) {
    const segments = rel.split("/");
    const insideDist = segments.some((segment) => segment === OUTPUT_DIR_NAME);
    const isBuildinfo =
      node.kind === "file" && rel.endsWith(BUILDINFO_SUFFIX);
    if (!insideDist && !isBuildinfo) {
      survivors.set(rel, node);
    }
  }
  return survivors;
}

/** Whether any `dist` directory or `*.tsbuildinfo` file remains anywhere. */
function hasGeneratedOutput(observed: Map<string, Observed>): boolean {
  for (const [rel, node] of observed) {
    if (node.kind === "dir" && basename(rel) === OUTPUT_DIR_NAME) return true;
    if (node.kind === "file" && rel.endsWith(BUILDINFO_SUFFIX)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

// Feature: platform-fixtures, Property 4: Output_Clearing is idempotent and removes exactly the Generated_Fixture_Output
describe("Property 4: Output_Clearing is idempotent and removes exactly the Generated_Fixture_Output", () => {
  // One temporary root for every materialised tree, created once and removed
  // once. Each generated input gets its own subdirectory inside it via
  // `materializeFsTree`.
  let sourceParent: string;

  beforeAll(() => {
    // A per-suite parent inside the OS temp directory. `materializeFsTree`
    // refuses any destination outside it and creates its own `mkdtemp`
    // subdirectory of whatever parent it is handed.
    sourceParent = tmpdir();
  });

  afterAll(() => {
    // Nothing to tear down beyond each example's own materialised tree, which
    // is removed in the property's `finally`.
  });

  it("removes exactly dist/ and *.tsbuildinfo, preserves everything else, and is idempotent", () => {
    fc.assert(
      fc.property(
        fsTree({ maxDepth: 4, withSymlinks: false, withOutput: true }).filter(
          hasUniqueSiblingNames,
        ),
        (description: FsTreeDescription) => {
          // Materialise the generated tree inside an OS temp directory. It
          // carries arbitrary dist/ directories, *.tsbuildinfo files, other
          // files, plain directories, and node_modules/ directories.
          const source = materializeFsTree(description, sourceParent);
          try {
            // Record what must survive, computed from the ORIGINAL tree.
            const before = observeTree(source.dir);
            const expectedSurvivors = snapshotOf(survivingSubset(before));

            // The Fixture_Tier root argument: the OS temp directory. The source
            // lives under it, so the OS-temp-dir allowance permits the clear,
            // and this suite spells no build-tools/src tier literal (R8.5).
            const tierRoot = tmpdir();

            // One application.
            clearOutput(source.dir, tierRoot);
            const afterOnce = observeTree(source.dir);
            const snapshotOnce = snapshotOf(afterOnce);

            // R8.4: no dist/ directory and no *.tsbuildinfo file remains.
            expect(hasGeneratedOutput(afterOnce)).toBe(false);

            // R8.4: every OTHER path present before — files, plain directories,
            // node_modules/ and every file inside it — is still present with
            // bytes unchanged. Comparing snapshots asserts path set AND bytes:
            // a `dir` marker for a surviving directory, a `file:<hex>` value for
            // a surviving file's bytes.
            expect(snapshotOf(survivingSubset(afterOnce))).toEqual(
              expectedSurvivors,
            );
            // And nothing outside the surviving set was left behind: the whole
            // post-clear tree IS exactly the surviving set (no orphan remains).
            expect(snapshotOnce).toEqual(expectedSurvivors);

            // R8.3: a second application leaves the tree identical to the first
            // — idempotent, removes nothing more.
            clearOutput(source.dir, tierRoot);
            const afterTwice = observeTree(source.dir);
            expect(snapshotOf(afterTwice)).toEqual(snapshotOnce);
          } finally {
            // Remove this example's materialised tree.
            removeMaterializedTree(source.dir);
          }
        },
      ),
      NUM_RUNS,
    );
  });
});

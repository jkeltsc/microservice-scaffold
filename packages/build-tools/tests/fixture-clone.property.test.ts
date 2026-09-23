// Feature: platform-fixtures, Property 3: A Fixture_Clone reproduces its source's path set, bytes, and symlinks, and its cleanup removes the copy
//
// For any directory tree of 0 to 20 files across 0 to 4 nesting levels, including
// symlinks whose targets are generated relative path texts, materialised inside
// an OS temporary directory: `fixtureClone` returns a Clone_Handle carrying
// `available` true and a directory OUTSIDE the Project_Directory whose set of
// source-relative paths equals the source's exactly; every regular file's bytes
// equal the source file's bytes; every symlink is still a symlink whose target
// text equals the source symlink's target text (never a dereferenced copy);
// after the idempotent `cleanup` no path of the copy is present; and the
// source's own path set and bytes are unchanged by the clone.
//
// The subject is materialised, never a committed fixture: the source tree lives
// in an OS temp directory (via `materializeFsTree`), the clone lands in another
// OS temp directory (via `fixtureClone`). Nothing is written inside the
// checked-out tree, so this suite mutates no worktree file (R7.6).
//
// Assertions are made against the tree AS IT IS ON DISK — the source is walked
// with `lstatSync`/`readlinkSync`/`readFileSync` and compared to the clone
// walked the same way — rather than against the generator's description alone.
// Walking disk is robust to any node-name collision the generic generator may
// produce within one directory, and it is exactly what the fidelity claim is
// about: what `fixtureClone` reproduced, not what was asked for. The generator's
// own file/symlink projections are additionally checked against the source walk,
// so the materialisation itself is confirmed to hold what was described.
//
// Validates: Requirements 7.2, 7.3, 7.6, 16.1, 16.4, 16.11

import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { fixtureClone } from "../src/testing/fixture-clone.js";

import {
  fsTree,
  fsTreeFileEntries,
  fsTreeSymlinkEntries,
  materializeFsTree,
  removeMaterializedTree,
  type FsNode,
  type FsTreeDescription,
} from "./arbitraries/tree.js";

// The Project_Directory (repository root), derived relative to this file's own
// location the same way `fixture-paths.ts` derives FIXTURES_ROOT:
// tests/ -> build-tools -> packages -> repo root. A Fixture_Clone must land
// OUTSIDE this directory (R7.2), which is what the assertion below checks — a
// copy inside it would be caught by the Worktree_Guard and discovered by npm.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(__dirname, "..", "..", "..");

const NUM_RUNS = { numRuns: 200 } as const;

// ---------------------------------------------------------------------------
// On-disk tree observation
// ---------------------------------------------------------------------------

/** One observed filesystem entry, keyed by its POSIX-normalised relative path. */
type Observed =
  | { readonly kind: "file"; readonly bytes: Buffer }
  | { readonly kind: "symlink"; readonly target: string };

/**
 * Walk a directory and record every regular file (with its bytes) and every
 * symlink (with its raw link target text), keyed by the path relative to `root`
 * in POSIX form. Directories carry no entry of their own — an empty directory
 * contributes nothing, exactly as the fidelity claim scopes it — but they are
 * recursed into. Symlinks are never dereferenced: `lstatSync` classifies the
 * link itself and `readlinkSync` reads its target text verbatim.
 */
function observeTree(root: string): Map<string, Observed> {
  const observed = new Map<string, Observed>();
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        observed.set(rel, { kind: "symlink", target: readlinkSync(absolute) });
      } else if (stats.isDirectory()) {
        walk(absolute);
      } else if (stats.isFile()) {
        observed.set(rel, { kind: "file", bytes: readFileSync(absolute) });
      }
    }
  };
  walk(root);
  return observed;
}

/**
 * Whether every directory in the tree has sibling entries with distinct names.
 *
 * The generic `fsTree` generator draws each directory's children from a plain
 * array, so it may place two siblings of the same name at one level — a `dir`
 * and a `file` both named `fr`, say. Such a description is not materialisable:
 * a real filesystem cannot hold a directory and a file at one path, and the
 * materialiser writes children in order, so the second write collides. That
 * ambiguity is orthogonal to the fidelity claim (a `fixtureClone` copies a real
 * tree, and a real tree has unique sibling names by construction), so trees with
 * a sibling-name collision are filtered out before materialisation rather than
 * the (frozen) generator being changed. The bounds the property quantifies over
 * — 0 to 20 files across 0 to 4 nesting levels including symlinks — are met by
 * the surviving trees.
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

/** A stable, comparable snapshot of an observation: sorted `[path, descriptor]`
 *  pairs, with file bytes rendered as a hex string so two snapshots compare with
 *  `toEqual`. */
function snapshotOf(observed: Map<string, Observed>): ReadonlyArray<readonly [string, string]> {
  return [...observed.entries()]
    .map(([rel, node]): readonly [string, string] =>
      node.kind === "file"
        ? [rel, `file:${node.bytes.toString("hex")}`]
        : [rel, `symlink:${node.target}`],
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

// Feature: platform-fixtures, Property 3: A Fixture_Clone reproduces its source's path set, bytes, and symlinks, and its cleanup removes the copy
describe("Property 3: a Fixture_Clone reproduces its source's path set, bytes, and symlinks, and its cleanup removes the copy", () => {
  // One temporary root for every materialised SOURCE tree, created once and
  // removed once. Each generated input gets its own subdirectory inside it via
  // `materializeFsTree`. The clones `fixtureClone` produces live in their own
  // OS temp directories and are removed by their handle's `cleanup`.
  let sourceParent: string;
  const cloneCleanups: Array<() => void> = [];

  beforeAll(() => {
    // A per-suite parent inside the OS temp directory. `materializeFsTree`
    // refuses any destination outside it and creates its own `mkdtemp`
    // subdirectory of whatever parent it is handed, so the OS temp directory
    // itself is exactly the parent it accepts.
    sourceParent = tmpdir();
  });

  afterAll(() => {
    // Unconditional teardown: remove every clone still open, then the source
    // parent is left to the OS (each source tree is a mkdtemp subdir the helper
    // owns; we remove them per-example below). Any clone whose test threw before
    // its own cleanup ran is closed here.
    for (const cleanup of cloneCleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* best-effort teardown */
      }
    }
  });

  it("copies path set, bytes, and symlinks faithfully; cleanup removes the copy; the source is unchanged", () => {
    fc.assert(
      fc.property(
        fsTree({ maxDepth: 4, withSymlinks: true, withOutput: false }).filter(
          hasUniqueSiblingNames,
        ),
        (description: FsTreeDescription) => {
          // Materialise the generated source tree inside an OS temp directory.
          const source = materializeFsTree(description, sourceParent);
          let cloneCleanup: (() => void) | undefined;
          try {
            // The generator's own projections must match what landed on disk,
            // so the materialisation faithfully holds what was described.
            const sourceObserved = observeTree(source.dir);
            for (const [rel, bytes] of fsTreeFileEntries(description)) {
              const node = sourceObserved.get(rel);
              // A name collision in the description could have overwritten this
              // entry with a later node; only assert when it survived as a file.
              if (node?.kind === "file") {
                expect(node.bytes.toString("utf8")).toBe(bytes);
              }
            }
            for (const [rel, target] of fsTreeSymlinkEntries(description)) {
              const node = sourceObserved.get(rel);
              if (node?.kind === "symlink") {
                expect(node.target).toBe(target);
              }
            }

            const sourceSnapshotBefore = snapshotOf(sourceObserved);

            // Clone the materialised source.
            const handle = fixtureClone(source.dir);
            // On a healthy host the clone is always available; if the host
            // cannot clone (an environmental failure), the handle is
            // { available: false } and there is nothing to assert about a copy.
            if (!handle.available) return;
            cloneCleanup = handle.cleanup;
            cloneCleanups.push(handle.cleanup);

            // R7.2: the copy is OUTSIDE the Project_Directory.
            const cloneDir = resolve(handle.dir);
            expect(cloneDir === PROJECT_DIRECTORY).toBe(false);
            expect(cloneDir.startsWith(`${PROJECT_DIRECTORY}${sep}`)).toBe(false);

            // R7.3: path set equal, bytes equal, symlinks still symlinks with
            // equal target text. Comparing the two on-disk snapshots asserts all
            // three at once: the sorted key set is the relative path set, a
            // `file:<hex>` value carries the bytes, a `symlink:<target>` value
            // carries the link text and the fact it is a symlink.
            const cloneObserved = observeTree(cloneDir);
            expect(snapshotOf(cloneObserved)).toEqual(sourceSnapshotBefore);

            // Belt-and-braces on the symlink clause specifically: every path the
            // source records as a symlink is a symlink in the clone (never a
            // dereferenced regular file) with the same target text.
            for (const [rel, node] of sourceObserved) {
              if (node.kind === "symlink") {
                const cloned = cloneObserved.get(rel);
                expect(cloned?.kind).toBe("symlink");
                if (cloned?.kind === "symlink") {
                  expect(cloned.target).toBe(node.target);
                }
              }
            }

            // Idempotent cleanup removes the copy: after two calls, no path of
            // the copy is present.
            handle.cleanup();
            handle.cleanup();
            expect(existsAt(cloneDir)).toBe(false);

            // R7.6: the source is unchanged by the clone — its path set and
            // bytes still equal what they were before cloning.
            expect(snapshotOf(observeTree(source.dir))).toEqual(
              sourceSnapshotBefore,
            );
          } finally {
            if (cloneCleanup !== undefined) {
              try {
                cloneCleanup();
              } catch {
                /* already removed */
              }
            }
            // Remove this example's materialised source tree.
            removeMaterializedTree(source.dir);
          }
        },
      ),
      NUM_RUNS,
    );
  });
});

/** Whether any filesystem entry exists at `path`, symlinks included (an entry is
 *  present even when its target is not). */
function existsAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

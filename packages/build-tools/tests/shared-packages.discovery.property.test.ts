// Feature: shared-packages, Property 1: Discovery classifies exactly the shared packages
//
// For any set of top-level packages/* directories with arbitrary package.json
// manifests, `discoverSharedPackagesFrom` returns exactly those directories
// whose manifest declares an `@microservices`-scoped `name` with `main` and
// `types` and is not the Overseer — and never returns any
// packages/microservices/* directory, the Overseer, a bin-only tooling package
// (no `main`/`types`, e.g. `build-tools`), or a test-only package.
//
// The property is exercised through `discoverSharedPackagesFrom(directories,
// readManifest)`, the pure discovery function that takes an injected directory
// listing and manifest reader. The expected result is computed by a local
// reference oracle (`referenceDiscovery` below) derived straight from the
// design's classification rule, kept independent of the production classifier
// so the assertion checks against an oracle rather than re-deriving from the
// same code path.
//
// Validates: Requirements 1.1, 1.2, 3.2, 3.3

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  discoverSharedPackagesFrom,
  type PackageManifest,
  type ReadManifest,
} from "../src/shared-packages.js";

const WORKSPACE_SCOPE = "@microservices";
const OVERSEER_NAME = "@microservices/overseer";
const MICROSERVICES_DIR = "microservices";

/**
 * Reference classification, derived directly from the design's discovery rule
 * and kept independent of the production `classify`. A directory counts as a
 * shared package iff it is not the `microservices` namespace container, has a
 * readable manifest, and that manifest declares an `@microservices`-scoped
 * `name` (that is not the Overseer) with both `main` and `types`.
 */
function referenceDiscovery(
  entries: readonly LayoutEntry[],
): Map<string, { name: string; dirName: string; packageDir: string }> {
  const expected = new Map<
    string,
    { name: string; dirName: string; packageDir: string }
  >();
  for (const { dirName, manifest } of entries) {
    if (dirName === MICROSERVICES_DIR) continue;
    if (manifest === undefined) continue;
    const { name, main, types } = manifest;
    if (
      name === undefined ||
      !name.startsWith(`${WORKSPACE_SCOPE}/`) ||
      name === OVERSEER_NAME ||
      main === undefined ||
      types === undefined
    ) {
      continue;
    }
    expected.set(name, { name, dirName, packageDir: `packages/${dirName}` });
  }
  return expected;
}

interface LayoutEntry {
  readonly dirName: string;
  /** `undefined` models a directory with no readable package.json. */
  readonly manifest: PackageManifest | undefined;
}

/** A well-formed shared package: scoped name + main + types. */
const arbSharedManifest: fc.Arbitrary<PackageManifest> = fc.record({
  name: fc
    .stringMatching(/^[a-z][a-z0-9-]*$/)
    .filter((s) => s.length > 0 && s.length <= 20)
    .map((n) => `${WORKSPACE_SCOPE}/${n}`),
  main: fc.constant("./dist/index.js"),
  types: fc.constant("./dist/index.d.ts"),
});

/** A bin-only tooling manifest: scoped name but no main/types (e.g. build-tools). */
const arbBinOnlyManifest: fc.Arbitrary<PackageManifest> = fc.record(
  {
    name: fc
      .stringMatching(/^[a-z][a-z0-9-]*$/)
      .filter((s) => s.length > 0 && s.length <= 20)
      .map((n) => `${WORKSPACE_SCOPE}/${n}`),
    // Randomly include neither, only main, or only types — but never both.
    main: fc.option(fc.constant("./dist/index.js"), { nil: undefined }),
  },
  { requiredKeys: ["name"] },
);

/** A test-only / non-scoped library: unscoped name, may still carry main/types. */
const arbUnscopedManifest: fc.Arbitrary<PackageManifest> = fc.record(
  {
    name: fc
      .stringMatching(/^[a-z][a-z0-9-]*$/)
      .filter((s) => s.length > 0 && s.length <= 20),
    main: fc.option(fc.constant("./dist/index.js"), { nil: undefined }),
    types: fc.option(fc.constant("./dist/index.d.ts"), { nil: undefined }),
  },
  { requiredKeys: ["name"] },
);

/** The Overseer manifest: scoped as @microservices/overseer, has main+types. */
const arbOverseerManifest: fc.Arbitrary<PackageManifest> = fc.constant({
  name: OVERSEER_NAME,
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
});

/**
 * A single top-level layout entry. Mixes the categories the design calls out:
 * shared libs (with/without main/types), the Overseer, bin-only tooling,
 * unscoped/test-only packages, directories with no manifest, and the
 * `microservices` namespace container.
 */
const arbLayoutEntry: fc.Arbitrary<LayoutEntry> = fc.oneof(
  // A qualifying shared package.
  fc.record({
    dirName: fc
      .stringMatching(/^[a-z][a-z0-9-]*$/)
      .filter((s) => s.length > 0 && s.length <= 20),
    manifest: arbSharedManifest,
  }),
  // Bin-only tooling.
  fc.record({
    dirName: fc.constantFrom("build-tools", "cli-tool", "codegen"),
    manifest: arbBinOnlyManifest,
  }),
  // Unscoped / test-only.
  fc.record({
    dirName: fc.constantFrom("integration-tests", "e2e", "fixtures"),
    manifest: arbUnscopedManifest,
  }),
  // The Overseer.
  fc.record({
    dirName: fc.constant("overseer"),
    manifest: arbOverseerManifest,
  }),
  // The namespace container.
  fc.record({
    dirName: fc.constant(MICROSERVICES_DIR),
    manifest: fc.option(arbSharedManifest, { nil: undefined }),
  }),
  // A directory with no readable manifest.
  fc.record({
    dirName: fc
      .stringMatching(/^[a-z][a-z0-9-]*$/)
      .filter((s) => s.length > 0 && s.length <= 20),
    manifest: fc.constant(undefined),
  }),
);

/**
 * A layout with unique directory names (a real filesystem cannot have two
 * sibling directories with the same name). Uniqueness is enforced on `dirName`.
 */
const arbLayout: fc.Arbitrary<LayoutEntry[]> = fc
  .array(arbLayoutEntry, { maxLength: 12 })
  .map((entries) => {
    const seen = new Set<string>();
    return entries.filter((e) => {
      if (seen.has(e.dirName)) return false;
      seen.add(e.dirName);
      return true;
    });
  });

/** Build a `ReadManifest` reader over an in-memory layout. */
function readerFor(entries: readonly LayoutEntry[]): ReadManifest {
  const byDir = new Map<string, PackageManifest | undefined>();
  for (const { dirName, manifest } of entries) {
    byDir.set(`packages/${dirName}`, manifest);
  }
  return (packageDir) => byDir.get(packageDir);
}

describe("Property 1: discovery classifies exactly the shared packages", () => {
  it("returns exactly the qualifying shared packages and nothing else", () => {
    fc.assert(
      fc.property(arbLayout, (entries) => {
        const directories = entries.map((e) => e.dirName);
        const readManifest = readerFor(entries);

        const discovered = discoverSharedPackagesFrom(directories, readManifest);
        const expected = referenceDiscovery(entries);

        // Same keyed set (package names) as the oracle.
        expect(new Set(discovered.keys())).toEqual(new Set(expected.keys()));

        // Each discovered entry matches the oracle's dirName/packageDir/name.
        for (const [name, pkg] of discovered) {
          const ref = expected.get(name);
          expect(ref).toBeDefined();
          expect(pkg.name).toBe(ref!.name);
          expect(pkg.dirName).toBe(ref!.dirName);
          expect(pkg.packageDir).toBe(ref!.packageDir);
        }

        // Negative guarantees: never the namespace container, the Overseer, a
        // bin-only tooling package, or a non-@microservices-scoped package.
        for (const [name, pkg] of discovered) {
          expect(pkg.dirName).not.toBe(MICROSERVICES_DIR);
          expect(name).not.toBe(OVERSEER_NAME);
          expect(name.startsWith(`${WORKSPACE_SCOPE}/`)).toBe(true);

          const manifest = readManifest(pkg.packageDir);
          expect(manifest).toBeDefined();
          expect(manifest!.main).toBeDefined();
          expect(manifest!.types).toBeDefined();
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never discovers a package that lacks main or types (bin-only)", () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[a-z][a-z0-9-]*$/)
          .filter((s) => s.length > 0 && s.length <= 20),
        (dir) => {
          const manifest: PackageManifest = {
            name: `${WORKSPACE_SCOPE}/${dir}`,
            main: "./dist/index.js",
            // no `types`
          };
          const discovered = discoverSharedPackagesFrom(
            [dir],
            (pd) => (pd === `packages/${dir}` ? manifest : undefined),
          );
          expect(discovered.size).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never discovers the Overseer even with a valid barrel manifest", () => {
    const discovered = discoverSharedPackagesFrom(
      ["overseer"],
      () => ({
        name: OVERSEER_NAME,
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
      }),
    );
    expect(discovered.size).toBe(0);
  });
});

// Feature: package-categories — real-tree discovery (design "Data Models /
// Discovery over the current tree").
//
// An example test, not a property test: there is one committed repository and
// exactly one correct discovery result over it, so quantifying over inputs adds
// nothing. `discoverPackages()` is the effect shell that reads the real
// filesystem; the pure `discoverPackagesFrom` core is exercised against
// in-memory layouts elsewhere. What only this test can catch is the two of them
// disagreeing with reality — a Namespace_Container renamed, a manifest field
// that stops being read, or a framework directory that starts being discovered.
//
// The design's Data Models table is the oracle. Over the committed tree
// `discoverPackages()` must yield exactly these six rows and no others:
//
//   packages/microservices/microservice1  microservice  @microservices/microservice1  tsc-project     [contracts, demo]
//   packages/microservices/microservice2  microservice  @microservices/microservice2  tsc-project     [config, contracts]
//   packages/microservices/microservice3  microservice  @microservices/microservice3  tsc-project     [contracts, extended-config]
//   packages/common/config                common        @microservices/config         tsc-project     [contracts]
//   packages/common/extended-config       common        @microservices/extended-config tsc-project    [config]
//   packages/spa/demo                      spa           @microservices/demo           bundler-project []
//
// Two negatives the table calls out explicitly are asserted directly:
//   - No framework directory (contracts, overseer, build-tools,
//     integration-tests) is discovered — they are framework, known by name, and
//     never a container member (R1.6, R5.2).
//   - `build-tools` in particular is absent despite declaring `main`/`types`
//     nowhere in its manifest — the point being that discovery is by location,
//     so manifest shape cannot promote a framework package into a category
//     (R2.10). (Its manifest is bin-only; the inverse case — a manifest that
//     *does* declare main/types yet is still not discovered — is contracts and
//     overseer, also asserted absent below.)
//   - `packages/spa/` contributes exactly one row, the first Spa_Package
//     `@microservices/demo`: a Bundler_Project (buildKind `bundler-project`)
//     that declares no `@microservices`-scoped dependency, so its
//     dependencySpecifiers are empty — a true sink.
//
// `discoverPackages()` resolves the Namespace_Containers as repo-relative
// paths, so the test runs with the repository root as cwd regardless of whether
// vitest was launched from the package directory or the repo root.
//
// Validates: Requirements 2.10, 4.6, 8.5

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPackages, type ConsumerPackage } from "../src/discovery.js";
import {
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
} from "../src/framework.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> build-tools -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** One row of the design's Data Models table, in the shape discovery returns. */
interface ExpectedRow {
  readonly category: ConsumerPackage["category"];
  readonly dirName: string;
  readonly packageDir: string;
  readonly name: string;
  readonly buildKind: ConsumerPackage["buildKind"];
  readonly dependencySpecifiers: readonly string[];
}

const CONTRACTS = "@microservices/contracts";
const CONFIG = "@microservices/config";
const EXTENDED_CONFIG = "@microservices/extended-config";
const DEMO = "@microservices/demo";

/** The six rows of the design's "Discovery over the current tree" table. */
const EXPECTED_ROWS: readonly ExpectedRow[] = [
  {
    category: "microservice",
    dirName: "microservice1",
    packageDir: `${NAMESPACE_CONTAINER.microservice}/microservice1`,
    name: "@microservices/microservice1",
    buildKind: "tsc-project",
    // sorted: contracts precedes demo. microservice1 declares
    // @microservices/demo because it serves the Demo_Spa at its Mount_Root; it
    // reaches the Spa_Package's dist/ through a run-time module-resolution call,
    // but the manifest edge is what discovery records here.
    dependencySpecifiers: [CONTRACTS, DEMO],
  },
  {
    category: "microservice",
    dirName: "microservice2",
    packageDir: `${NAMESPACE_CONTAINER.microservice}/microservice2`,
    name: "@microservices/microservice2",
    buildKind: "tsc-project",
    // sorted: config precedes contracts
    dependencySpecifiers: [CONFIG, CONTRACTS],
  },
  {
    category: "microservice",
    dirName: "microservice3",
    packageDir: `${NAMESPACE_CONTAINER.microservice}/microservice3`,
    name: "@microservices/microservice3",
    buildKind: "tsc-project",
    // sorted: contracts precedes extended-config; microservice3 reaches the
    // base Config_Package transitively through @microservices/extended-config
    dependencySpecifiers: [CONTRACTS, EXTENDED_CONFIG],
  },
  {
    category: "common",
    dirName: "config",
    packageDir: `${NAMESPACE_CONTAINER.common}/config`,
    name: CONFIG,
    buildKind: "tsc-project",
    dependencySpecifiers: [CONTRACTS],
  },
  {
    category: "common",
    dirName: "extended-config",
    packageDir: `${NAMESPACE_CONTAINER.common}/extended-config`,
    name: EXTENDED_CONFIG,
    buildKind: "tsc-project",
    // only scoped dependency is the base Config_Package; contracts arrives
    // transitively through it, so discovery records just this one specifier
    dependencySpecifiers: [CONFIG],
  },
  {
    category: "spa",
    dirName: "demo",
    packageDir: `${NAMESPACE_CONTAINER.spa}/demo`,
    name: DEMO,
    // a Spa_Package is a Bundler_Project — built by its own `npm run build`,
    // never a `tsc --build` root
    buildKind: "bundler-project",
    // declares no @microservices-scoped dependency at all: the Demo_Spa is a
    // true sink
    dependencySpecifiers: [],
  },
];

/** A discovered package projected onto the comparable {@link ExpectedRow} shape. */
function rowOf(pkg: ConsumerPackage): ExpectedRow {
  return {
    category: pkg.category,
    dirName: pkg.dirName,
    packageDir: pkg.packageDir,
    name: pkg.name,
    buildKind: pkg.buildKind,
    dependencySpecifiers: [...pkg.dependencySpecifiers],
  };
}

describe("discoverPackages() over the committed repository (Data Models table)", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  it("yields exactly the six rows of the design's Data Models table", () => {
    const discovery = discoverPackages();

    const rows = [
      ...discovery.byCategory.microservice,
      ...discovery.byCategory.common,
      ...discovery.byCategory.spa,
    ].map(rowOf);

    // Order the actual rows the same way the table lists them — the three
    // microservices in code-point order, then the two common packages (config
    // before extended-config, also code-point order), then the one
    // Spa_Package (demo) — so the comparison is exact, not merely set-equal.
    expect(rows).toEqual(EXPECTED_ROWS);
  });

  it("discovers exactly one Spa_Package, demo (packages/spa now holds the Demo_Spa)", () => {
    const discovery = discoverPackages();
    expect(discovery.byCategory.spa.map(rowOf)).toEqual([
      {
        category: "spa",
        dirName: "demo",
        packageDir: `${NAMESPACE_CONTAINER.spa}/demo`,
        name: DEMO,
        buildKind: "bundler-project",
        dependencySpecifiers: [],
      },
    ]);
  });

  it("discovers no framework directory as a Consumer_Package", () => {
    const discovery = discoverPackages();

    const discoveredNames = new Set(discovery.byName.keys());
    const discoveredDirs = new Set(discovery.nameByDir.keys());

    for (const singleton of FRAMEWORK_SINGLETONS) {
      expect(
        discoveredNames.has(singleton.name),
        `${singleton.name} is framework, must not be discovered`,
      ).toBe(false);
      expect(
        discoveredDirs.has(singleton.packageDir),
        `${singleton.packageDir} is framework, must not be discovered`,
      ).toBe(false);
    }
  });

  it("does not discover build-tools despite its manifest, because membership is by location", () => {
    const discovery = discoverPackages();

    // build-tools is bin-only (no main/types), yet the negative that matters is
    // location, not shape: even were it to declare main/types tomorrow it would
    // stay undiscovered, exactly as contracts and overseer (which DO declare
    // both) stay undiscovered here (R2.10).
    expect(discovery.byName.has("@microservices/build-tools")).toBe(false);
    expect(discovery.byName.has(CONTRACTS)).toBe(false);
    expect(discovery.byName.has("@microservices/overseer")).toBe(false);
  });

  it("records only the six declared names in the resolution index", () => {
    const discovery = discoverPackages();

    expect([...discovery.byName.keys()].sort()).toEqual(
      [...EXPECTED_ROWS].map((row) => row.name).sort(),
    );
    expect([...discovery.nameByDir.keys()].sort()).toEqual(
      [...EXPECTED_ROWS].map((row) => row.packageDir).sort(),
    );
  });
});

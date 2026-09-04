// Feature: shared-packages, Property 4: Build and workspace order are topological
//
// For any discovered @microservices dependency graph, in both the
// `requiredSharedPackages` result (which is the `tsc --build` argument list for
// shared packages, in order) and the root `workspaces` array, every shared
// package appears before every package that depends on it — directly or
// transitively. The closure walk is a depth-first post-order, so a dependency
// is always emitted before the dependent that pulls it in; this file asserts
// that ordering invariant holds for random acyclic dep graphs, and pins the
// real `config → contracts` edge as a concrete case against the committed root
// `package.json` `workspaces` array.
//
// The generator mirrors the sibling closure test's in-memory graph style
// (shared packages laid out in a list, each depending only on earlier ones so
// the graph is always a DAG; `contracts` pinned at index 0). It is replicated
// here rather than imported because the closure test exports no generators.
//
// Validates: Requirements 4.1, 4.2, 6.3, 14.1

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  requiredSharedPackages,
  type ReadDependencies,
  type SharedPackage,
} from "../src/shared-packages.js";

const WORKSPACE_SCOPE = "@microservices";
const CONTRACTS_NAME = "@microservices/contracts";

// ---------------------------------------------------------------------------
// In-memory dependency-graph model (mirrors shared-packages.closure.property.test.ts)
// ---------------------------------------------------------------------------

interface Graph {
  /** Discovered shared packages, keyed by @microservices/<name>. */
  readonly shared: ReadonlyMap<string, SharedPackage>;
  /** Microservice directory name -> its @microservices-scoped dep names. */
  readonly microserviceDeps: ReadonlyMap<string, readonly string[]>;
  /** The Overseer's @microservices-scoped dep names (always includes contracts). */
  readonly overseerDeps: readonly string[];
}

/** Build a `ReadDependencies` reader over an in-memory graph. */
function readerFor(graph: Graph): ReadDependencies {
  return (packageDir) => {
    if (packageDir === "packages/overseer") return graph.overseerDeps;
    const prefix = "packages/microservices/";
    if (packageDir.startsWith(prefix)) {
      const id = packageDir.slice(prefix.length);
      return graph.microserviceDeps.get(id) ?? [];
    }
    return [];
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbSharedName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter((s) => s.length > 0 && s.length <= 12)
  .map((n) => `${WORKSPACE_SCOPE}/${n}`);

const arbMicroserviceId: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]*$/)
  .filter((s) => s.length > 0 && s.length <= 12);

/**
 * A random shared-package DAG: shared packages are laid out in a list and a
 * package may depend only on packages earlier in the list, so the graph is
 * always acyclic and every edge resolves. `contracts` is pinned at index 0 (a
 * leaf every consumer can reach), mirroring the real `config → contracts` and
 * `overseer → contracts` edges.
 */
const arbGraph: fc.Arbitrary<Graph> = fc
  .uniqueArray(arbSharedName, { minLength: 0, maxLength: 6 })
  .chain((extraNames) => {
    const sharedNames = [
      CONTRACTS_NAME,
      ...extraNames.filter((n) => n !== CONTRACTS_NAME),
    ];

    const depChoices = sharedNames.map((_, i) =>
      i === 0
        ? fc.constant<string[]>([])
        : fc.subarray(sharedNames.slice(0, i)),
    );

    return fc.tuple(...depChoices).chain((depsPerShared) => {
      const shared = new Map<string, SharedPackage>();
      sharedNames.forEach((name, i) => {
        const dirName = name.slice(`${WORKSPACE_SCOPE}/`.length);
        shared.set(name, {
          name,
          dirName,
          packageDir: `packages/${dirName}`,
          sharedDependencies: [...depsPerShared[i]].sort(),
        });
      });

      return fc
        .uniqueArray(arbMicroserviceId, { minLength: 1, maxLength: 5 })
        .chain((ids) =>
          fc
            .tuple(...ids.map(() => fc.subarray(sharedNames)))
            .chain((depsPerMs) => {
              const microserviceDeps = new Map<string, readonly string[]>();
              ids.forEach((id, i) => {
                microserviceDeps.set(id, [...depsPerMs[i]].sort());
              });

              return fc.subarray(sharedNames).map((extraOverseer) => {
                const overseerDeps = [
                  ...new Set([CONTRACTS_NAME, ...extraOverseer]),
                ].sort();
                return { shared, microserviceDeps, overseerDeps };
              });
            }),
        );
    });
  });

/** A graph paired with a selector: a subset of its microservice ids. */
const arbGraphAndSelection: fc.Arbitrary<{
  graph: Graph;
  selected: string[];
}> = arbGraph.chain((graph) => {
  const ids = [...graph.microserviceDeps.keys()];
  return fc.subarray(ids).map((selected) => ({ graph, selected }));
});

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

describe("Property 4: build and workspace order are topological", () => {
  it("places every shared dependency before every package that depends on it (directly or transitively)", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const result = requiredSharedPackages(
          selected,
          graph.shared,
          readerFor(graph),
        );

        // Position of each shared package in the ordered result.
        const position = new Map<string, number>();
        result.forEach((pkg, i) => position.set(pkg.name, i));

        // For every emitted shared package, each of its shared dependencies is
        // itself emitted and appears strictly earlier. This is exactly the
        // `tsc --build` argument order for shared packages, so the same
        // invariant guards the build list.
        for (const pkg of result) {
          for (const dep of pkg.sharedDependencies) {
            expect(position.has(dep)).toBe(true);
            expect(position.get(dep)!).toBeLessThan(position.get(pkg.name)!);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("emits each shared package exactly once", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const result = requiredSharedPackages(
          selected,
          graph.shared,
          readerFor(graph),
        );
        const names = result.map((p) => p.name);
        expect(new Set(names).size).toBe(names.length);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Concrete case: the committed root workspaces array is topological
// ---------------------------------------------------------------------------

describe("Property 4 (concrete): the root workspaces array is topological for config -> contracts", () => {
  const rootPackageJson = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { workspaces: string[] };

  const workspaces = rootPackageJson.workspaces;

  it("lists packages/contracts before packages/config (config -> contracts edge)", () => {
    const contractsIndex = workspaces.indexOf("packages/contracts");
    const configIndex = workspaces.indexOf("packages/config");

    expect(contractsIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeGreaterThanOrEqual(0);
    // contracts is a dependency of config, so it must appear first.
    expect(contractsIndex).toBeLessThan(configIndex);
  });

  it("lists packages/config before its microservice consumers and the Overseer", () => {
    const configIndex = workspaces.indexOf("packages/config");
    const microservicesIndex = workspaces.indexOf("packages/microservices/*");
    const overseerIndex = workspaces.indexOf("packages/overseer");

    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(microservicesIndex).toBeGreaterThanOrEqual(0);
    expect(overseerIndex).toBeGreaterThanOrEqual(0);

    expect(configIndex).toBeLessThan(microservicesIndex);
    expect(configIndex).toBeLessThan(overseerIndex);
  });
});

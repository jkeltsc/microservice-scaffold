// Feature: shared-packages, Property 3: The staged shared set equals the Required_Shared_Packages closure
//
// For any selector and any @microservices-scoped dependency graph over
// discovered packages, the set of shared packages staged into the Image_Tree at
// node_modules/@microservices/<name> equals `requiredSharedPackages(selected,
// …)` — the transitive @microservices dependency closure of the selected
// microservices plus the Overseer. Nothing outside the closure is staged
// (minimality) and nothing inside it is missing (completeness), so `contracts`
// — always in the closure because the Overseer depends on it — is staged for
// every selector.
//
// The staged set is exactly the set the image-tree assembler feeds to
// `copyPackage` (design "Staging and minimality": "only closure members are
// ever copied"), i.e. the name set of `requiredSharedPackages(...)`. This file
// exercises that function against injected in-memory dependency graphs (no real
// filesystem) and asserts its result equals the closure computed by an
// independent reference oracle (`referenceClosure` below), kept separate from
// the production walk so the assertion checks against an oracle rather than
// re-deriving from the same code path.
//
// Validates: Requirements 6.1, 7.1, 7.3, 7.4, 10.2, 14.2, 14.3
//
// NOTE: Property 5 (an unresolvable shared dependency fails the build) extends
// this file with its own describe block (task 2.6); shared generators and
// helpers live above both describe blocks so either can reuse them.

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
// In-memory dependency-graph model
// ---------------------------------------------------------------------------
//
// A graph is a set of discovered shared packages (keyed by @microservices name)
// plus the @microservices-scoped deps declared by each microservice and by the
// Overseer. Every shared-package edge and every consumer edge names only
// packages that exist in the graph, so the closure is always resolvable — the
// dangling-dependency case belongs to Property 5.

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

/**
 * Reference closure, derived directly from the design's definition and kept
 * independent of the production post-order walk. Returns the *set* of
 * @microservices names reachable from the selected microservices' deps plus the
 * Overseer's deps, following discovered shared-package edges transitively.
 *
 * Every edge in a generated graph resolves (Property 5 owns the dangling case),
 * so this simple worklist closure is exact.
 */
function referenceClosure(
  graph: Graph,
  selected: readonly string[],
): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [...graph.overseerDeps];
  for (const id of selected) {
    queue.push(...(graph.microserviceDeps.get(id) ?? []));
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const pkg = graph.shared.get(name);
    if (pkg !== undefined) {
      queue.push(...pkg.sharedDependencies);
    }
  }
  return reached;
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
 * A random shared-package graph with a well-defined dependency order so it is
 * always acyclic and every edge resolves. Shared packages are laid out in a
 * list; a package may only depend on packages *earlier* in the list, which
 * yields a DAG. `contracts` is pinned at index 0 (a leaf every consumer can
 * reach), mirroring the real `config → contracts` and `overseer → contracts`
 * edges.
 */
const arbGraph: fc.Arbitrary<Graph> = fc
  .uniqueArray(arbSharedName, { minLength: 0, maxLength: 6 })
  .chain((extraNames) => {
    // contracts is always present; the rest are unique and distinct from it.
    const sharedNames = [
      CONTRACTS_NAME,
      ...extraNames.filter((n) => n !== CONTRACTS_NAME),
    ];

    // For each shared package (except contracts at index 0) pick a subset of
    // earlier packages as its @microservices deps — guarantees a DAG.
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

      // Microservices: each depends on an arbitrary subset of the shared names.
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

              // The Overseer always depends on contracts (real invariant), plus
              // an arbitrary subset of the other shared packages.
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
// Property 3
// ---------------------------------------------------------------------------

describe("Property 3: the staged shared set equals the Required_Shared_Packages closure", () => {
  it("equals the closure oracle for any selector and dep graph (completeness + minimality)", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const result = requiredSharedPackages(
          selected,
          graph.shared,
          readerFor(graph),
        );
        const staged = new Set(result.map((p) => p.name));
        const expected = referenceClosure(graph, selected);

        // Completeness: nothing in the closure is missing.
        // Minimality: nothing outside the closure is staged.
        expect(staged).toEqual(expected);

        // No duplicates: each package is staged exactly once.
        expect(result.length).toBe(staged.size);

        // Every staged package is a discovered shared package (nothing invented).
        for (const pkg of result) {
          expect(graph.shared.get(pkg.name)).toBe(pkg);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("stages contracts for every selector because the Overseer depends on it", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const staged = new Set(
          requiredSharedPackages(
            selected,
            graph.shared,
            readerFor(graph),
          ).map((p) => p.name),
        );
        expect(staged.has(CONTRACTS_NAME)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("the all-selector closure unions every consumer's closure", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        const reader = readerFor(graph);
        const allIds = [...graph.microserviceDeps.keys()];

        const allStaged = new Set(
          requiredSharedPackages(allIds, graph.shared, reader).map(
            (p) => p.name,
          ),
        );

        // Union of the closure of each microservice selected alone, plus the
        // Overseer-only closure (present in every selection, including empty).
        const union = new Set<string>(
          requiredSharedPackages([], graph.shared, reader).map((p) => p.name),
        );
        for (const id of allIds) {
          for (const pkg of requiredSharedPackages(
            [id],
            graph.shared,
            reader,
          )) {
            union.add(pkg.name);
          }
        }

        expect(allStaged).toEqual(union);

        // And it matches the oracle for the all-selector directly.
        expect(allStaged).toEqual(referenceClosure(graph, allIds));
      }),
      { numRuns: 200 },
    );
  });

  it("stages nothing beyond the Overseer's closure when no microservice is selected", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        const staged = new Set(
          requiredSharedPackages([], graph.shared, readerFor(graph)).map(
            (p) => p.name,
          ),
        );
        expect(staged).toEqual(referenceClosure(graph, []));
        // The empty-selector closure is exactly the Overseer's transitive deps.
        expect(staged.has(CONTRACTS_NAME)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------
//
// Feature: shared-packages, Property 5: An unresolvable shared dependency fails the build
//
// For any selected microservice or the Overseer that declares an
// @microservices-scoped dependency naming a package absent from discovery,
// `requiredSharedPackages` raises an error naming the unresolvable package(s).
// The message contract is the `[shared:unresolved]` line produced by
// shared-packages.ts: it names the consumer's package dir and the sorted,
// deduplicated set of dangling @microservices names.
//
// Validates: Requirements 6.4

/** An @microservices name guaranteed absent from a graph's discovered set. */
const arbDanglingName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter((s) => s.length > 0 && s.length <= 12)
  .map((n) => `${WORKSPACE_SCOPE}/${n}`);

/**
 * A graph, a selector, and a non-empty set of dangling @microservices names
 * (none of which are discovered shared packages), attached to a chosen
 * consumer: either one of the selected microservices, or the Overseer. The
 * consumer's declared deps are augmented with the dangling names so the walk is
 * forced to resolve them and fail.
 */
const arbDanglingCase: fc.Arbitrary<{
  graph: Graph;
  selected: string[];
  consumerDir: string;
  dangling: string[];
}> = arbGraph.chain((graph) => {
  const ids = [...graph.microserviceDeps.keys()];
  const discovered = new Set(graph.shared.keys());

  return fc
    .uniqueArray(arbDanglingName, { minLength: 1, maxLength: 4 })
    .filter((names) => names.every((n) => !discovered.has(n)))
    .chain((dangling) =>
      // Pick the consumer: the Overseer, or one of the microservices (which is
      // then guaranteed to be selected so the walk visits its deps).
      fc
        .oneof(
          fc.constant<{ kind: "overseer" }>({ kind: "overseer" }),
          ...(ids.length > 0
            ? [
                fc
                  .constantFrom(...ids)
                  .map((id) => ({ kind: "microservice" as const, id })),
              ]
            : []),
        )
        .map((choice) => {
          if (choice.kind === "overseer") {
            const augmented: Graph = {
              shared: graph.shared,
              microserviceDeps: graph.microserviceDeps,
              overseerDeps: [
                ...new Set([...graph.overseerDeps, ...dangling]),
              ].sort(),
            };
            // Selector is any subset of ids; the Overseer is always a root.
            return {
              graph: augmented,
              selected: ids,
              consumerDir: "packages/overseer",
              dangling: [...dangling].sort(),
            };
          }

          const { id } = choice;
          const microserviceDeps = new Map(graph.microserviceDeps);
          microserviceDeps.set(
            id,
            [
              ...new Set([
                ...(graph.microserviceDeps.get(id) ?? []),
                ...dangling,
              ]),
            ].sort(),
          );
          const augmented: Graph = {
            shared: graph.shared,
            microserviceDeps,
            overseerDeps: graph.overseerDeps,
          };
          return {
            graph: augmented,
            // The offending microservice must be selected to be a root.
            selected: [id],
            consumerDir: `packages/microservices/${id}`,
            dangling: [...dangling].sort(),
          };
        }),
    );
});

describe("Property 5: an unresolvable shared dependency fails the build", () => {
  it("throws [shared:unresolved] naming the consumer and the missing package(s)", () => {
    fc.assert(
      fc.property(arbDanglingCase, ({ graph, selected, consumerDir, dangling }) => {
        let thrown: unknown;
        try {
          requiredSharedPackages(selected, graph.shared, readerFor(graph));
          throw new Error("expected requiredSharedPackages to throw");
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;

        // Tagged with the [shared:unresolved] prefix and names the consumer.
        expect(message).toContain("[shared:unresolved]");
        expect(message).toContain(`"${consumerDir}"`);

        // Names every dangling package (sorted, deduplicated in the message).
        for (const name of dangling) {
          expect(message).toContain(`"${name}"`);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("names the dangling packages sorted and deduplicated for a single consumer", () => {
    fc.assert(
      fc.property(arbDanglingCase, ({ graph, selected, consumerDir, dangling }) => {
        // Isolate the failing consumer as the sole root so the message reflects
        // exactly its dangling set (a microservice case already does this; for
        // the Overseer case any selector still routes through it).
        let message = "";
        try {
          requiredSharedPackages(selected, graph.shared, readerFor(graph));
        } catch (err) {
          message = (err as Error).message;
        }

        // Only assert exact ordering when the offending consumer is the sole
        // source of unresolved names, which the generator guarantees: dangling
        // names are absent from discovery and attached to exactly one consumer.
        const expectedNamed = dangling.map((n) => `"${n}"`).join(", ");
        expect(message).toBe(
          `[shared:unresolved] "${consumerDir}" depends on unknown @microservices package(s): ${expectedNamed}`,
        );
      }),
      { numRuns: 200 },
    );
  });
});

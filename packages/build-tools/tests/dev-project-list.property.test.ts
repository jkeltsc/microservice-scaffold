// Feature: api-dev-server, Property 1: Project_List membership and topological order
// Feature: api-dev-server, Property 2: Selector resolution is the existing behavior
//
// Property 1 — The Project_List handed to the solution builder contains exactly
// the transitive shared-package closure of the selected microservices plus the
// Overseer (each as its repo-relative `packages/<name>` dir), then the selected
// microservices (`packages/microservices/<id>`), then `packages/overseer` — and
// nothing else. `packages/build-tools` and `packages/integration-tests` are
// never members (neither is a selected microservice, the Overseer, nor a
// discovered shared package). For every dependency edge between two members the
// dependency appears strictly before its dependent, and every selected
// microservice appears before `packages/overseer`.
//
// Property 2 — The microservice members of the Project_List equal
// `resolveSelected(selector, directories)` exactly, for unset, blank, `*`,
// whitespace-padded and duplicate-bearing selectors, because `projectListFrom`
// composes `resolveSelected` rather than reimplementing selection. An unmatched
// identifier surfaces as the existing `[selector:unmatched]` error naming every
// offender.
//
// The in-memory dependency-graph model (arbGraph / readerFor / SharedPackage)
// mirrors packages/build-tools/tests/shared-packages.order.property.test.ts:
// shared packages are laid out in a list, each depending only on earlier ones
// so the graph is always a DAG, with `contracts` pinned at index 0. It is
// replicated here rather than imported because that suite exports no generators.
//
// Validates: Requirements 2.1, 2.2, 2.4, 3.1, 3.6, 3.7

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { projectListFrom } from "../src/dev-supervisor.js";
import { resolveSelected } from "../src/selector.js";
import {
  type ReadDependencies,
  type SharedPackage,
} from "../src/shared-packages.js";

const WORKSPACE_SCOPE = "@microservices";
const CONTRACTS_NAME = "@microservices/contracts";
const OVERSEER_DIR = "packages/overseer";

// ---------------------------------------------------------------------------
// In-memory dependency-graph model (mirrors shared-packages.order.property.test.ts)
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
    if (packageDir === OVERSEER_DIR) return graph.overseerDeps;
    const prefix = "packages/microservices/";
    if (packageDir.startsWith(prefix)) {
      const id = packageDir.slice(prefix.length);
      return graph.microserviceDeps.get(id) ?? [];
    }
    return [];
  };
}

/** The repo-relative dir of a discovered shared package by @microservices name. */
function sharedDirOf(graph: Graph, name: string): string {
  const pkg = graph.shared.get(name);
  if (pkg === undefined) {
    throw new Error(`test bug: unknown shared package ${name}`);
  }
  return pkg.packageDir;
}

/**
 * The expected member SET of the Project_List for a graph and a selected id
 * list, computed by an independent oracle: the transitive @microservices
 * closure (as `packages/<name>` dirs) of the selected microservices' deps plus
 * the Overseer's deps, then each selected microservice dir, then the Overseer
 * dir. Order is not asserted here — that is a separate property.
 */
function expectedMembers(graph: Graph, selected: readonly string[]): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [...graph.overseerDeps];
  for (const id of selected) {
    queue.push(...(graph.microserviceDeps.get(id) ?? []));
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const pkg = graph.shared.get(name);
    if (pkg !== undefined) {
      queue.push(...pkg.sharedDependencies);
    }
  }

  const members = new Set<string>();
  for (const name of closure) members.add(sharedDirOf(graph, name));
  for (const id of selected) members.add(`packages/microservices/${id}`);
  members.add(OVERSEER_DIR);
  return members;
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
 * `overseer → contracts` edges. Every microservice id and every shared name is
 * distinct from the others, and no microservice id collides with a shared dir
 * name (they use disjoint character classes: shared names may contain `-`).
 */
const arbGraph: fc.Arbitrary<Graph> = fc
  .uniqueArray(arbSharedName, { minLength: 0, maxLength: 6 })
  .chain((extraNames) => {
    const sharedNames = [
      CONTRACTS_NAME,
      ...extraNames.filter((n) => n !== CONTRACTS_NAME),
    ];

    const depChoices = sharedNames.map((_, i) =>
      i === 0 ? fc.constant<string[]>([]) : fc.subarray(sharedNames.slice(0, i)),
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
          fc.tuple(...ids.map(() => fc.subarray(sharedNames))).chain((depsPerMs) => {
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

/** A graph paired with a selected id subset (in selector order). */
const arbGraphAndSelection: fc.Arbitrary<{
  graph: Graph;
  selected: string[];
}> = arbGraph.chain((graph) => {
  const ids = [...graph.microserviceDeps.keys()];
  return fc.subarray(ids).map((selected) => ({ graph, selected }));
});

/**
 * Every discovered dependency edge among the members of a Project_List, as
 * (dependency dir, dependent dir) pairs: shared → its shared deps, each selected
 * microservice → its shared deps, and the Overseer → its shared deps. Used to
 * assert the topological-order invariant directly against the graph.
 */
function edgesFor(
  graph: Graph,
  selected: readonly string[],
): Array<{ dependency: string; dependent: string }> {
  const edges: Array<{ dependency: string; dependent: string }> = [];
  for (const pkg of graph.shared.values()) {
    for (const dep of pkg.sharedDependencies) {
      edges.push({ dependency: sharedDirOf(graph, dep), dependent: pkg.packageDir });
    }
  }
  for (const id of selected) {
    for (const dep of graph.microserviceDeps.get(id) ?? []) {
      edges.push({
        dependency: sharedDirOf(graph, dep),
        dependent: `packages/microservices/${id}`,
      });
    }
  }
  for (const dep of graph.overseerDeps) {
    edges.push({ dependency: sharedDirOf(graph, dep), dependent: OVERSEER_DIR });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Property 1: Project_List membership and topological order
// ---------------------------------------------------------------------------

describe("Property 1: Project_List membership and topological order", () => {
  it("membership equals the shared closure plus the selected microservices plus the Overseer", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const directories = [...graph.microserviceDeps.keys()];
        const selector = selected.join(",");
        const list = projectListFrom(
          selector,
          directories,
          graph.shared,
          readerFor(graph),
        );

        // The set actually selected is resolveSelected's output for this
        // selector (an empty subarray joins to "", which is the all-selector),
        // so the membership oracle is computed over that resolved set.
        const resolved = resolveSelected(selector, directories);
        expect(new Set(list)).toEqual(expectedMembers(graph, resolved));
      }),
      { numRuns: 200 },
    );
  });

  it("emits every member exactly once (no duplicates)", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const list = projectListFrom(
          selected.join(","),
          [...graph.microserviceDeps.keys()],
          graph.shared,
          readerFor(graph),
        );
        expect(new Set(list).size).toBe(list.length);
      }),
      { numRuns: 200 },
    );
  });

  it("never includes packages/build-tools or packages/integration-tests", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const list = projectListFrom(
          selected.join(","),
          [...graph.microserviceDeps.keys()],
          graph.shared,
          readerFor(graph),
        );
        expect(list).not.toContain("packages/build-tools");
        expect(list).not.toContain("packages/integration-tests");
      }),
      { numRuns: 200 },
    );
  });

  it("places every dependency before its dependent for every edge in the graph", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const list = projectListFrom(
          selected.join(","),
          [...graph.microserviceDeps.keys()],
          graph.shared,
          readerFor(graph),
        );
        const position = new Map<string, number>();
        list.forEach((dir, i) => position.set(dir, i));

        // Only edges whose endpoints are both members constrain the order.
        for (const { dependency, dependent } of edgesFor(graph, selected)) {
          if (position.has(dependency) && position.has(dependent)) {
            expect(position.get(dependency)!).toBeLessThan(
              position.get(dependent)!,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("places every selected microservice before packages/overseer", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const list = projectListFrom(
          selected.join(","),
          [...graph.microserviceDeps.keys()],
          graph.shared,
          readerFor(graph),
        );
        const overseerIndex = list.indexOf(OVERSEER_DIR);
        expect(overseerIndex).toBe(list.length - 1);

        for (const id of selected) {
          const msIndex = list.indexOf(`packages/microservices/${id}`);
          expect(msIndex).toBeGreaterThanOrEqual(0);
          expect(msIndex).toBeLessThan(overseerIndex);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Selector resolution is the existing behavior
// ---------------------------------------------------------------------------

describe("Property 2: selector resolution is the existing behavior", () => {
  /**
   * Extract the Project_List's microservice members (the
   * `packages/microservices/<id>` entries), in list order, as bare ids.
   */
  function microserviceMembers(list: readonly string[]): string[] {
    const prefix = "packages/microservices/";
    return list
      .filter((dir) => dir.startsWith(prefix))
      .map((dir) => dir.slice(prefix.length));
  }

  it("microservice members equal resolveSelected for an explicit id-list selector", () => {
    fc.assert(
      fc.property(arbGraphAndSelection, ({ graph, selected }) => {
        const directories = [...graph.microserviceDeps.keys()];
        const selector = selected.join(",");
        const list = projectListFrom(
          selector,
          directories,
          graph.shared,
          readerFor(graph),
        );
        expect(microserviceMembers(list)).toEqual(
          resolveSelected(selector, directories),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("selects every discovered candidate for unset, blank, and * selectors", () => {
    fc.assert(
      fc.property(
        arbGraph,
        fc.constantFrom<string | undefined>(undefined, "", "   ", "*", " * "),
        (graph, selector) => {
          const directories = [...graph.microserviceDeps.keys()];
          const list = projectListFrom(
            selector,
            directories,
            graph.shared,
            readerFor(graph),
          );
          // The all-selector semantics: every discovered candidate, in
          // discovery order — exactly what resolveSelected produces.
          expect(microserviceMembers(list)).toEqual(
            resolveSelected(selector, directories),
          );
          expect(microserviceMembers(list)).toEqual(directories);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("matches resolveSelected for whitespace-padded and duplicated identifiers", () => {
    fc.assert(
      fc.property(
        arbGraph.chain((graph) => {
          const ids = [...graph.microserviceDeps.keys()];
          return fc
            .subarray(ids, { minLength: 1 })
            .chain((picked) =>
              // Build a messy selector: pad each id with random surrounding
              // whitespace and duplicate a prefix of the list, so the raw
              // string exercises trimming and duplicate handling.
              fc
                .tuple(
                  fc.constant(picked),
                  fc.array(fc.constantFrom("", " ", "  ", "\t"), {
                    minLength: picked.length,
                    maxLength: picked.length,
                  }),
                  fc.subarray(picked),
                )
                .map(([base, pads, dups]) => {
                  const padded = base.map(
                    (id, i) => `${pads[i]}${id}${pads[i]}`,
                  );
                  const selector = [...padded, ...dups].join(",");
                  return { graph, selector };
                }),
            );
        }),
        ({ graph, selector }) => {
          const directories = [...graph.microserviceDeps.keys()];
          const list = projectListFrom(
            selector,
            directories,
            graph.shared,
            readerFor(graph),
          );
          expect(microserviceMembers(list)).toEqual(
            resolveSelected(selector, directories),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("throws [selector:unmatched] naming every unknown identifier", () => {
    const arbUnknownId: fc.Arbitrary<string> = fc
      .stringMatching(/^[a-z][a-z0-9]*$/)
      .filter((s) => s.length > 0 && s.length <= 12);

    fc.assert(
      fc.property(
        arbGraph.chain((graph) => {
          const ids = [...graph.microserviceDeps.keys()];
          const discovered = new Set(ids);
          return fc
            .uniqueArray(arbUnknownId, { minLength: 1, maxLength: 4 })
            .filter((names) => names.every((n) => !discovered.has(n)))
            .chain((unknown) =>
              // Mix the unknown identifiers among an arbitrary subset of the
              // known ones, so the offender set is exactly `unknown`.
              fc.subarray(ids).map((known) => ({
                graph,
                directories: ids,
                unknown,
                selector: [...known, ...unknown].join(","),
              })),
            );
        }),
        ({ graph, directories, unknown, selector }) => {
          let thrown: unknown;
          try {
            projectListFrom(
              selector,
              directories,
              graph.shared,
              readerFor(graph),
            );
            throw new Error("expected projectListFrom to throw");
          } catch (err) {
            thrown = err;
          }

          expect(thrown).toBeInstanceOf(Error);
          const message = (thrown as Error).message;
          expect(message).toContain("[selector:unmatched]");
          for (const name of unknown) {
            expect(message).toContain(`"${name}"`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

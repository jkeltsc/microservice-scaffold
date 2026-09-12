// Feature: package-categories, Property 33: The Workspace_Build_Order equals the topological oracle
//
// The one property that pins `workspaceBuildOrder(nodes)` — the platform-derived
// Workspace_Build_Order — against an INDEPENDENTLY written topological oracle.
// The oracle is Kahn's algorithm with a ready queue held in ascending
// code-point order of `packageDir` (R12.5, distinct from the resolver's R7.2
// `dirName` key), and it NEVER calls `workspaceBuildOrder`: it is built here
// from the requirements, so the two agreeing is evidence rather than a tautology.
//
// The world is a set of `WorkspaceNode` values — constructed directly, no
// filesystem — spanning both tiers: the four Framework_Singletons and any set of
// discovered Consumer_Packages across all three Consumer_Categories, each with an
// arbitrary assignment of `@microservices`-scoped `dependencies` resolving to
// other nodes. A specifier is resolved against the union of the declared consumer
// names AND the Framework_Singleton names; a framework match is an ordering edge
// exactly as a consumer match is (R12.3), so no node is a resolution special case.
//
// The assertions, all off one generated node set:
//   - every workspace package present exactly once and nothing else (R12.1);
//   - each package after every package it declares a specifier resolving to,
//     with a framework specifier counting as an ordering edge exactly as a
//     consumer specifier does (R12.2, R12.3);
//   - packages with no dependency relation in ascending code-point order of
//     `packageDir` (R12.5);
//   - identical element for element across repeated derivations AND independent
//     of the order the packages are presented in (R12.5, R12.16).
//
// The two consequence blocks R12.3 and R12.13 name are asserted as consequences,
// not rules: every package declaring `@microservices/contracts` follows
// `packages/contracts`, and a Common_Package declaring a specifier resolving to
// another Common_Package follows it — each with no input other than the
// declaring package's own `dependencies` (R12.4).
//
// A separate cycle block injects cycles of length 1 through k into an otherwise
// acyclic node set: the derivation fails with `[build-order:cycle]` naming
// exactly the participants, computes no order, and (because no order is computed)
// invokes no `build` script — asserted by observing that `workspaceBuildOrder`
// throws before returning anything a caller could run a build over (R12.6).
//
// Validates: Requirements R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R12.13

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  workspaceBuildOrder,
  type WorkspaceNode,
} from "../src/workspace-build-order.js";
import {
  CONTRACTS,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";

// ---------------------------------------------------------------------------
// Framework tier as data, so the oracle never touches production lookups
// ---------------------------------------------------------------------------

/** The four Framework_Singletons as WorkspaceNodes, specifiers filled in later. */
const FRAMEWORK_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.name,
);
const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

// ---------------------------------------------------------------------------
// The independent oracle: Kahn with a ready queue sorted by packageDir code point
// ---------------------------------------------------------------------------

/** Ascending code-point comparison — the primitive R12.5 is stated in. */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The set of every declared node name — consumer names AND Framework_Singleton
 * names — a specifier is resolved against here. A framework name is a resolvable
 * ordering target just like a consumer name (R12.3).
 */
function declaredNames(nodes: readonly WorkspaceNode[]): Set<string> {
  return new Set(nodes.map((node) => node.name));
}

/**
 * The keys of the nodes a node depends on: each `@microservices`-scoped
 * specifier resolved against the union of declared names, dropping a specifier
 * that names no node in the set (the generators keep every specifier resolvable,
 * so nothing is dropped in practice). Mirrors R12.2/R12.3/R12.4 — the sole input
 * is the node's own `dependencySpecifiers` — without calling any production code.
 */
function dependencyKeysOf(
  node: WorkspaceNode,
  names: ReadonlySet<string>,
): string[] {
  return node.dependencySpecifiers.filter(
    (specifier) =>
      specifier.startsWith(`${WORKSPACE_SCOPE}/`) && names.has(specifier),
  );
}

/**
 * Reference Workspace_Build_Order — Kahn's algorithm with the ready queue held
 * in ascending code-point order of `packageDir` (R12.5). Repeatedly emits the
 * least-`packageDir` node all of whose in-set dependencies are already emitted,
 * which yields the unique lexicographically-least topological order — strictly
 * stronger than "every dependency precedes its dependent".
 *
 * Independent of `workspaceBuildOrder` by construction. Assumes an acyclic node
 * set; the acyclic generators guarantee that, so reaching the cycle guard means
 * the generator is wrong.
 */
function referenceOrder(nodes: readonly WorkspaceNode[]): WorkspaceNode[] {
  const names = declaredNames(nodes);
  const emitted: WorkspaceNode[] = [];
  const done = new Set<string>();
  const pending = [...nodes];

  while (pending.length > 0) {
    const ready = pending
      .filter((node) =>
        dependencyKeysOf(node, names).every((dep) => done.has(dep)),
      )
      .sort((a, b) => compareCodePoints(a.packageDir, b.packageDir));

    if (ready.length === 0) {
      throw new Error("reference order oracle: the generated node set has a cycle");
    }

    const next = ready[0];
    emitted.push(next);
    done.add(next.name);
    pending.splice(pending.indexOf(next), 1);
  }

  return emitted;
}

// ---------------------------------------------------------------------------
// A synthetic workspace-node world spanning both tiers
// ---------------------------------------------------------------------------
//
// A node set is: the four Framework_Singletons plus a list of Consumer_Packages
// across all three categories. Consumer packages are laid out in a list and may
// declare specifiers only to nodes EARLIER in the list (or to a framework name),
// so the base graph is always acyclic and every edge resolves. Diamonds arise
// naturally (two packages both depending on an earlier one, a fifth depending on
// both). Cycles are injected against this base by the cycle block.

interface ConsumerEntry {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  /** The name this entry would declare: `@microservices/<dirName>`. */
  readonly name: string;
}

/**
 * `packageDir` values are varied deliberately so the code-point tiebreak is
 * OBSERVABLE: a consumer's directory name is the real Namespace_Container path,
 * but a per-entry `dirTag` prefix perturbs the code-point key without changing
 * the resolvable name, so nodes with no dependency relation are frequently
 * reordered by the tiebreak rather than sitting in generation order.
 */
const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter((s) => s.length > 0 && s.length <= 10);

const arbConsumerEntry: fc.Arbitrary<Omit<ConsumerEntry, "name">> = fc.record({
  category: fc.constantFrom<ConsumerCategory>("microservice", "common", "spa"),
  dirName: arbDirName,
});

/**
 * Build the consumer WorkspaceNodes and the framework WorkspaceNodes for a drawn
 * layout. Each consumer entry declares specifiers to an arbitrary subset of the
 * names EARLIER in the list plus an arbitrary subset of framework names; the
 * Overseer-modelling comes for free because every framework name is a candidate
 * target. `packageDir` is the real per-category path, which varies the
 * code-point key across categories and directory names.
 */
function consumerNode(
  entry: ConsumerEntry,
  dependencySpecifiers: readonly string[],
): WorkspaceNode {
  return {
    packageDir: `${NAMESPACE_CONTAINER[entry.category]}/${entry.dirName}`,
    name: entry.name,
    dependencySpecifiers: [...dependencySpecifiers].sort(),
    tier: entry.category,
  };
}

/** The four Framework_Singleton nodes with empty specifiers, for the small fixtures. */
function frameworkNodes(
  specifiersByDir: ReadonlyMap<string, readonly string[]>,
): WorkspaceNode[] {
  return FRAMEWORK_SINGLETONS.map((entry) => ({
    packageDir: entry.packageDir,
    name: entry.name,
    dependencySpecifiers: [...(specifiersByDir.get(entry.packageDir) ?? [])].sort(),
    tier: "framework" as const,
  }));
}

/**
 * A full acyclic node set spanning both tiers. The four Framework_Singletons and
 * the drawn Consumer_Packages are laid out in ONE combined list at arbitrary
 * global positions, and every node may declare a specifier resolving only to a
 * node STRICTLY EARLIER in that single global order. That one rule — acyclic by
 * construction across BOTH tiers at once — is what puts framework->framework,
 * framework->consumer (integration-tests trailing consumers), consumer->framework
 * (everyone naming contracts), and consumer->consumer edges in the world without
 * any cross-tier pair ever closing a cycle. Diamonds arise whenever two later
 * nodes both name the same earlier node and a third names both.
 */
const arbNodeSet: fc.Arbitrary<WorkspaceNode[]> = fc
  .uniqueArray(arbConsumerEntry, {
    minLength: 0,
    maxLength: 6,
    selector: (entry) => entry.dirName,
  })
  .filter((entries) =>
    entries.every((entry) => !FRAMEWORK_DIR_NAMES.includes(entry.dirName)),
  )
  .chain((rawEntries) => {
    const consumers: ConsumerEntry[] = rawEntries.map((entry) => ({
      ...entry,
      name: `${WORKSPACE_SCOPE}/${entry.dirName}`,
    }));

    // Each node's identity as it will appear, tier-tagged, before ordering.
    type Proto =
      | { kind: "framework"; index: number; name: string; packageDir: string }
      | { kind: "consumer"; entry: ConsumerEntry };

    const frameworkProtos: Proto[] = FRAMEWORK_SINGLETONS.map((s, index) => ({
      kind: "framework" as const,
      index,
      name: s.name,
      packageDir: s.packageDir,
    }));
    const consumerProtos: Proto[] = consumers.map((entry) => ({
      kind: "consumer" as const,
      entry,
    }));
    const allProtos = [...frameworkProtos, ...consumerProtos];

    // Draw ONE global permutation of every node. Position in this permutation is
    // the only thing that gates edges: a node may name only nodes earlier in it.
    return fc
      .shuffledSubarray(allProtos, {
        minLength: allProtos.length,
        maxLength: allProtos.length,
      })
      .chain((globalOrder) => {
        const nameAt = (i: number): string =>
          globalOrder[i].kind === "framework"
            ? (globalOrder[i] as { name: string }).name
            : (globalOrder[i] as { entry: ConsumerEntry }).entry.name;

        // Per node: a subarray of the names strictly earlier in the global order.
        const depsPerNode = fc.tuple(
          ...globalOrder.map((_proto, i) =>
            fc.subarray(globalOrder.slice(0, i).map((_p, j) => nameAt(j))),
          ),
        );

        return depsPerNode.map((deps) =>
          globalOrder.map((proto, i) => {
            if (proto.kind === "framework") {
              return {
                packageDir: proto.packageDir,
                name: proto.name,
                dependencySpecifiers: [...deps[i]].sort(),
                tier: "framework" as const,
              } satisfies WorkspaceNode;
            }
            return consumerNode(proto.entry, deps[i]);
          }),
        );
      });
  });

/** A deterministic-but-arbitrary permutation of a node set, drawn per run. */
function arbPermuted(
  nodes: readonly WorkspaceNode[],
): fc.Arbitrary<WorkspaceNode[]> {
  return fc.shuffledSubarray([...nodes], {
    minLength: nodes.length,
    maxLength: nodes.length,
  });
}

// ---------------------------------------------------------------------------
// Property 33 — acyclic: the derivation equals the oracle, in every respect
// ---------------------------------------------------------------------------

describe("Property 33: the Workspace_Build_Order equals the topological oracle", () => {
  it("contains every workspace package exactly once and nothing else (R12.1)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(nodes);

        // Same multiset of packageDirs as the input, each exactly once.
        expect([...order].map((n) => n.packageDir).sort()).toEqual(
          [...nodes].map((n) => n.packageDir).sort(),
        );
        expect(order.length).toBe(nodes.length);
        expect(new Set(order.map((n) => n.packageDir)).size).toBe(nodes.length);

        // Every element is a node handed in, not one the derivation invented.
        const byDir = new Map(nodes.map((n) => [n.packageDir, n]));
        for (const node of order) {
          expect(byDir.get(node.packageDir)).toBe(node);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("equals the code-point-sorted Kahn oracle element for element (R12.2, R12.3, R12.5)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(nodes);
        const oracle = referenceOrder(nodes);

        // The strong claim: the unique lexicographically-least topological order.
        // Equal element for element subsumes "dependency precedes dependent"
        // (R12.2/R12.3) and "unrelated packages in packageDir code-point order"
        // (R12.5) at once.
        expect(order.map((n) => n.packageDir)).toEqual(
          oracle.map((n) => n.packageDir),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("places each package after every package it declares a specifier resolving to, framework edges included (R12.2, R12.3)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(nodes);
        const names = declaredNames(nodes);
        const nameToDir = new Map(nodes.map((n) => [n.name, n.packageDir]));
        const indexOfDir = new Map(
          order.map((n, i) => [n.packageDir, i]),
        );

        for (const node of nodes) {
          for (const dep of dependencyKeysOf(node, names)) {
            const depDir = nameToDir.get(dep)!;
            // A framework target and a consumer target are treated identically:
            // both must precede the declaring package.
            expect(indexOfDir.get(depDir)!).toBeLessThan(
              indexOfDir.get(node.packageDir)!,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("orders packages with no dependency relation in ascending packageDir code-point order (R12.5)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(nodes);
        const names = declaredNames(nodes);

        // Transitive-dependency closure by declared name, so "no dependency
        // relation" is checked against the real reachability, not just direct edges.
        const directDeps = new Map(
          nodes.map((n) => [n.name, new Set(dependencyKeysOf(n, names))]),
        );
        const reaches = (fromName: string, toName: string): boolean => {
          const seen = new Set<string>();
          const stack = [...(directDeps.get(fromName) ?? [])];
          while (stack.length > 0) {
            const cur = stack.pop()!;
            if (cur === toName) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            stack.push(...(directDeps.get(cur) ?? []));
          }
          return false;
        };

        // For any adjacent pair in the order with no dependency relation either
        // way, the earlier one must have the smaller packageDir code point.
        for (let i = 0; i + 1 < order.length; i += 1) {
          const a = order[i];
          const b = order[i + 1];
          const related =
            reaches(a.name, b.name) || reaches(b.name, a.name);
          if (!related) {
            expect(compareCodePoints(a.packageDir, b.packageDir)).toBeLessThan(0);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is identical across repeated derivations and independent of presentation order (R12.5, R12.16)", () => {
    fc.assert(
      fc.property(
        arbNodeSet.chain((nodes) =>
          fc.tuple(fc.constant(nodes), arbPermuted(nodes), arbPermuted(nodes)),
        ),
        ([nodes, permA, permB]) => {
          const base = workspaceBuildOrder(nodes).map((n) => n.packageDir);

          // Repeated derivation over the same input: identical element for element.
          expect(
            workspaceBuildOrder(nodes).map((n) => n.packageDir),
          ).toEqual(base);

          // Presentation order carries no meaning: two independent permutations
          // of the same node set yield the same order.
          expect(
            workspaceBuildOrder(permA).map((n) => n.packageDir),
          ).toEqual(base);
          expect(
            workspaceBuildOrder(permB).map((n) => n.packageDir),
          ).toEqual(base);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 33 — the two consequence blocks R12.3 and R12.13 name
// ---------------------------------------------------------------------------

describe("Property 33: contracts-first and common-to-common are graph consequences", () => {
  it("places contracts ahead of every package declaring @microservices/contracts (R12.3, R12.4)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        // Make every consumer additionally declare @microservices/contracts —
        // exactly the real-repository shape — with no other input than each
        // package's own dependencies. This stays acyclic: contracts is a
        // Framework_Singleton and declares no specifier back to a consumer here
        // (its own framework deps only ever point at earlier framework nodes).
        const contractsFreeFramework = nodes.map((n) =>
          n.tier === "framework"
            ? {
                ...n,
                // Drop any framework->consumer edge so adding contracts edges
                // below cannot close a cycle through integration-tests.
                dependencySpecifiers: n.dependencySpecifiers.filter((s) =>
                  FRAMEWORK_NAMES.includes(s),
                ),
              }
            : n,
        );
        const withContracts = contractsFreeFramework.map((n) =>
          n.tier === "framework"
            ? n
            : {
                ...n,
                dependencySpecifiers: [
                  ...new Set([...n.dependencySpecifiers, CONTRACTS.name]),
                ].sort(),
              },
        );

        const order = workspaceBuildOrder(withContracts);
        const index = new Map(order.map((n, i) => [n.packageDir, i]));
        const contractsIndex = index.get(CONTRACTS.packageDir)!;

        for (const node of withContracts) {
          if (node.dependencySpecifiers.includes(CONTRACTS.name)) {
            expect(contractsIndex).toBeLessThan(index.get(node.packageDir)!);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("places a Common_Package ahead of the Common_Package that declares a specifier resolving to it (R12.13, R12.4)", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbDirName, { minLength: 2, maxLength: 2 })
          .filter((dirs) =>
            dirs.every((d) => !FRAMEWORK_DIR_NAMES.includes(d)),
          ),
        ([depDir, declarerDir]) => {
          const depName = `${WORKSPACE_SCOPE}/${depDir}`;
          const declarerName = `${WORKSPACE_SCOPE}/${declarerDir}`;

          // Two Common_Packages: the declarer names the other, and NOTHING else
          // declares that edge — the declaring package's own `dependencies` is
          // the sole input (R12.4).
          const dep = consumerNode(
            { category: "common", dirName: depDir, name: depName },
            [],
          );
          const declarer = consumerNode(
            { category: "common", dirName: declarerDir, name: declarerName },
            [depName],
          );

          const nodes = [...frameworkNodes(new Map()), dep, declarer];
          const order = workspaceBuildOrder(nodes);
          const index = new Map(order.map((n, i) => [n.packageDir, i]));

          expect(index.get(dep.packageDir)!).toBeLessThan(
            index.get(declarer.packageDir)!,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 33 — a cycle of any length fails, naming exactly the participants
// ---------------------------------------------------------------------------
//
// A cycle of length 1..k is built from a ring of Common_Packages: node i names
// node (i+1) mod k, so every member has exactly one outgoing edge and the k
// members form one closed cycle. k = 1 is a self-dependency. The framework nodes
// are included (empty specifiers) so both tiers are present, but only the ring
// is cyclic.

describe("Property 33: a cycle of any length fails naming exactly the participants (R12.6)", () => {
  it("throws [build-order:cycle] naming exactly the cycle members, computing no order and running no build", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbDirName, { minLength: 1, maxLength: 6 })
          .filter((dirs) =>
            dirs.every((d) => !FRAMEWORK_DIR_NAMES.includes(d)),
          ),
        (ringDirs) => {
          const k = ringDirs.length;
          const names = ringDirs.map((d) => `${WORKSPACE_SCOPE}/${d}`);
          const dirs = ringDirs.map(
            (d) => `${NAMESPACE_CONTAINER.common}/${d}`,
          );

          // node i -> node (i+1) mod k : one closed ring. k === 1 is "a" -> "a".
          const ring: WorkspaceNode[] = ringDirs.map((d, i) => ({
            packageDir: dirs[i],
            name: names[i],
            dependencySpecifiers: [names[(i + 1) % k]],
            tier: "common" as const,
          }));

          const nodes = [...frameworkNodes(new Map()), ...ring];
          const ringDirSet = new Set(dirs);

          let thrown: unknown;
          try {
            workspaceBuildOrder(nodes);
          } catch (error) {
            thrown = error;
          }

          // No order is computed — the derivation throws rather than returning,
          // so a caller has nothing to run a `build` script over (R12.6).
          expect(thrown).toBeInstanceOf(Error);
          const message = (thrown as Error).message;

          expect(message).toContain("[build-order:cycle]");

          // Exactly the participants: every ring member's directory is named,
          // and no NON-participant (a framework node, an unrelated package) is.
          for (const dir of dirs) {
            expect(message).toContain(`"${dir}"`);
          }
          const quotedDirs = [...message.matchAll(/"([^"]+)"/g)].map(
            (m) => m[1],
          );
          for (const named of quotedDirs) {
            expect(ringDirSet.has(named)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

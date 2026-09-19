// Feature: unified-build-order, Property 5: repeated and permuted derivations agree, over no metadata beyond category, directory, name, and declared specifiers
//
// The one property that pins `workspaceBuildOrder(CONTEXT, nodes)` — the platform-derived
// Workspace_Build_Order — against an INDEPENDENTLY written Build_Sequence oracle.
//
// The oracle used to be the lexicographically-least topological order over
// declared dependencies (Kahn with a `packageDir`-ordered ready queue). That is
// no longer the derivation: the fix collapsed every Order_Producing_Path onto the
// Build_Sequence of bugfix.md 2.1 — a fixed sequence of seven ordered statements,
// where a declared dependency is honoured by the Verification_Pass rather than by
// the sort. So the oracle here is a fresh restatement of those seven statements,
// written from the requirement and NEVER by calling `buildSequence`, so the two
// agreeing is evidence rather than a tautology.
//
// The seven statements of 2.1, restated:
//   1. `packages/contracts`;
//   2. `packages/build-tools`;
//   3. the Common_Packages in CALCULATED order — a topological sort over each
//      member's `@microservices`-scoped specifiers that resolve to ANOTHER
//      Common_Package, ready queue in ascending `packageDir` code point (2.3);
//   4. the Microservice_Packages sorted by ascending `packageDir` code point;
//   5. `packages/overseer`;
//   6. the test-only Framework_Singletons (`integration-tests`);
//   7. the Spa_Packages sorted by ascending `packageDir` code point, a trailing
//      phase after every statement above (2.4).
//
// The world is a set of `WorkspaceNode` values — constructed directly, no
// filesystem — spanning both tiers: the four Framework_Singletons and any set of
// discovered Consumer_Packages across all three Consumer_Categories, each with an
// arbitrary assignment of `@microservices`-scoped `dependencies` resolving to
// other nodes. The generators keep the base graph acyclic, so `workspaceBuildOrder`
// returns rather than failing the Verification_Pass.
//
// The assertions, all off one generated node set:
//   - every workspace package present exactly once and nothing else (R12.1);
//   - the order equals the Build_Sequence oracle element for element;
//   - each package after every one of its Compile_Time_Prerequisites — a declared
//     specifier resolving to a NON-Spa package, plus Overseer after each
//     microservice — the pass, not the sort, being what honours the edge (2.8);
//   - identical element for element across repeated derivations AND independent
//     of the order the packages are presented in (2.3, Property 5).
//
// The within-statement tiebreak (2.3, 3.3): a separate block asserts the
// `compareCodePoints(packageDir)` order governs pairs WITHIN one statement only —
// the microservices of statement 4 among themselves, the Spa_Packages of
// statement 7 among themselves — and is NOT consulted across statement boundaries,
// so a Common_Package declaring no specifier no longer leads the order ahead of
// `packages/contracts` (3.3, F11's specifier-free-Common_Package counterexample).
//
// A separate cycle block injects cycles of length 1 through k among the
// Common_Packages: statement 3's calculated order cannot be computed, so the
// derivation fails with `[build-order:cycle]` (the message builder moved into
// build-sequence.ts, byte-identical) naming exactly the participant directories,
// computes no order, and therefore runs no `build` script (3.14).
//
// Validates: Requirements 2.1, 2.3, 3.3, 3.14

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  workspaceBuildOrder,
  type WorkspaceNode,
} from "../src/workspace-build-order.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import { type ConsumerCategory } from "../src/framework.js";

/** Default-config context threaded into the Workspace_Build_Order derivation;
 *  scope and roots equal the pre-context baseline, so the order is unchanged. */
const CONTEXT = projectContext(defaultEffectiveConfig());

// Scope, per-category roots, and the four Framework_Singletons (each with its
// scope-composed name) come from the run's context, not from framework.ts's
// scope-free surface (R3.7).
const WORKSPACE_SCOPE = CONTEXT.config.scope;
const NAMESPACE_CONTAINER = CONTEXT.roots;
const FRAMEWORK_SINGLETONS = CONTEXT.framework.all;
const {
  contracts: CONTRACTS,
  overseer: OVERSEER,
  buildTools: BUILD_TOOLS,
  integrationTests: INTEGRATION_TESTS,
} = CONTEXT.framework;

// ---------------------------------------------------------------------------
// Framework tier as data, so the oracle never touches production lookups
// ---------------------------------------------------------------------------

const FRAMEWORK_DIR_NAMES: readonly string[] = FRAMEWORK_SINGLETONS.map(
  (entry) => entry.dirName,
);

// ---------------------------------------------------------------------------
// The independent oracle: the seven statements of 2.1, restated by hand
// ---------------------------------------------------------------------------

/** Ascending code-point comparison — the primitive 2.3 and 3.3 are stated in. */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The set of every declared node name a specifier is resolved against. */
function declaredNames(nodes: readonly WorkspaceNode[]): Set<string> {
  return new Set(nodes.map((node) => node.name));
}

/**
 * The keys of the nodes a node depends on: each `@microservices`-scoped specifier
 * resolved against the union of declared names, dropping a specifier naming no
 * node (the generators keep every specifier resolvable, so nothing is dropped in
 * practice). The sole input is the node's own `dependencySpecifiers`.
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
 * Statement 3, restated: the Common_Packages in calculated order — a Kahn sort
 * over the edges each Common_Package declares to ANOTHER Common_Package, ready
 * queue held in ascending `packageDir` code point (2.3). An edge to any package
 * outside the Common set (a Framework_Singleton, a microservice) is NOT a
 * statement-3 edge; it is left to the Verification_Pass, exactly as the primitive
 * restricts `commonOrder`'s predicate to Common_Package targets.
 *
 * Independent of `buildSequence` by construction. Assumes the Common set is
 * acyclic; the acyclic generators guarantee that.
 */
function commonOrderOracle(
  common: readonly WorkspaceNode[],
): WorkspaceNode[] {
  const commonNames = new Set(common.map((node) => node.name));
  const done = new Set<string>();
  const emitted: WorkspaceNode[] = [];
  const pending = [...common];

  while (pending.length > 0) {
    const ready = pending
      .filter((node) =>
        node.dependencySpecifiers
          .filter((specifier) => commonNames.has(specifier))
          .every((dep) => done.has(dep)),
      )
      .sort((a, b) => compareCodePoints(a.packageDir, b.packageDir));

    if (ready.length === 0) {
      throw new Error("common-order oracle: the generated Common set has a cycle");
    }

    const next = ready[0];
    emitted.push(next);
    done.add(next.name);
    pending.splice(pending.indexOf(next), 1);
  }

  return emitted;
}

/**
 * Reference Workspace_Build_Order — the seven statements of 2.1, in order, over
 * the full workspace membership (`buildTools` and `testOnly` both present, no
 * Selector). Built here from the requirement, NEVER by calling `buildSequence`,
 * so `workspaceBuildOrder` agreeing with it is evidence.
 *
 * Statement order is what decides a cross-statement pair; the `packageDir`
 * tiebreak is consulted only within statements 4 and 7 (statement 3 is
 * calculated). Assumes an acyclic node set.
 */
function referenceOrder(nodes: readonly WorkspaceNode[]): WorkspaceNode[] {
  const byDir = new Map(nodes.map((node) => [node.packageDir, node]));
  const pick = (packageDir: string): WorkspaceNode | undefined =>
    byDir.get(packageDir);

  const order: WorkspaceNode[] = [];
  const push = (node: WorkspaceNode | undefined): void => {
    if (node !== undefined) {
      order.push(node);
    }
  };

  const byTier = (tier: WorkspaceNode["tier"]): WorkspaceNode[] =>
    nodes.filter((node) => node.tier === tier);

  // Statement 1 — contracts.
  push(pick(CONTRACTS.packageDir));
  // Statement 2 — build-tools (always present on the repository-wide path).
  push(pick(BUILD_TOOLS.packageDir));
  // Statement 3 — the Common_Packages in calculated order.
  for (const node of commonOrderOracle(byTier("common"))) {
    order.push(node);
  }
  // Statement 4 — the microservices, ascending packageDir code point.
  for (const node of [...byTier("microservice")].sort((a, b) =>
    compareCodePoints(a.packageDir, b.packageDir),
  )) {
    order.push(node);
  }
  // Statement 5 — the Overseer.
  push(pick(OVERSEER.packageDir));
  // Statement 6 — the test-only Framework_Singletons.
  push(pick(INTEGRATION_TESTS.packageDir));
  // Statement 7 — the Spa_Packages, ascending packageDir code point, trailing.
  for (const node of [...byTier("spa")].sort((a, b) =>
    compareCodePoints(a.packageDir, b.packageDir),
  )) {
    order.push(node);
  }

  return order;
}

// ---------------------------------------------------------------------------
// A synthetic workspace-node world spanning both tiers
// ---------------------------------------------------------------------------
//
// A node set is: the four Framework_Singletons plus a list of Consumer_Packages
// across all three categories. Consumer packages are laid out in a global order
// and may declare specifiers only to nodes EARLIER in that order (or to a
// framework name), so the base graph is always acyclic and every specifier
// resolves. Cycles are injected against this base only by the cycle block.

interface ConsumerEntry {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  /** The name this entry would declare: `@microservices/<dirName>`. */
  readonly name: string;
}

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9-]*$/)
  .filter((s) => s.length > 0 && s.length <= 10);

const arbConsumerEntry: fc.Arbitrary<Omit<ConsumerEntry, "name">> = fc.record({
  category: fc.constantFrom<ConsumerCategory>("microservice", "common", "spa"),
  dirName: arbDirName,
});

/**
 * Build one Consumer_Package node. `packageDir` is the real per-category path, so
 * the code-point key varies across categories and directory names.
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

/** The four Framework_Singleton nodes with empty specifiers, for small fixtures. */
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
 * The Build_Sequence statement a node falls in, from its tier alone (2.1). This
 * is what the generator gates edges by: under the Build_Sequence, a package's
 * position is its statement, so an edge only stays a SOUND prerequisite when its
 * target sits in a strictly earlier statement (a target in the same or a later
 * statement would make `workspaceBuildOrder` reject the order rather than return
 * — the pass doing its job — which is what the dedicated verification suites
 * cover, not this equality property).
 */
function statementOf(node: WorkspaceNode): number {
  switch (node.tier) {
    case "common":
      return 3;
    case "microservice":
      return 4;
    case "spa":
      return 7;
    default: {
      // A Framework_Singleton, by its packageDir: contracts 1, build-tools 2,
      // overseer 5, integration-tests 6.
      if (node.packageDir === CONTRACTS.packageDir) return 1;
      if (node.packageDir === BUILD_TOOLS.packageDir) return 2;
      if (node.packageDir === OVERSEER.packageDir) return 5;
      return 6;
    }
  }
}

/**
 * A node set spanning both tiers that stays inside the SOUND region of the
 * Build_Sequence, so `workspaceBuildOrder` returns and equals the oracle. The
 * four Framework_Singletons participate (with no declared specifiers — their
 * position is their statement, named by `framework.ts`, so a declared framework
 * edge would either be ignored or rejected by the pass), and each drawn
 * Consumer_Package may declare a specifier resolving to any node in a STRICTLY
 * EARLIER statement, plus any Spa_Package unconditionally (a `... -> spa` edge is
 * never a prerequisite, 2.6, so it never constrains the order). Diamonds arise
 * whenever two later nodes name the same earlier one; `config -> extended-config`
 * style common-to-common edges arise within statement 3 and drive its calculated
 * order.
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
    const consumers: WorkspaceNode[] = rawEntries.map((entry) =>
      consumerNode({ ...entry, name: `${WORKSPACE_SCOPE}/${entry.dirName}` }, []),
    );
    const frameworks = frameworkNodes(new Map());
    const allNodes = [...frameworks, ...consumers];

    const spaNames = allNodes
      .filter((node) => node.tier === "spa")
      .map((node) => node.name);

    // Per consumer node: a subarray of the names it may soundly declare — every
    // node in a strictly earlier statement, plus every Spa_Package (a Spa target
    // is never a prerequisite). Framework nodes declare nothing.
    const consumerDeps = fc.tuple(
      ...consumers.map((node) => {
        const myStatement = statementOf(node);
        const earlier = allNodes
          .filter((other) => statementOf(other) < myStatement)
          .map((other) => other.name);
        // Spa targets in the same or a later statement are still legal edges,
        // just not prerequisites; include them so `... -> spa` edges appear.
        const candidates = [
          ...new Set([
            ...earlier,
            ...spaNames.filter((name) => name !== node.name),
          ]),
        ];
        return fc.subarray(candidates);
      }),
    );

    return consumerDeps.map((deps) => [
      ...frameworks,
      ...consumers.map((node, i) => ({
        ...node,
        dependencySpecifiers: [...deps[i]].sort(),
      })),
    ]);
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
// The Workspace_Build_Order equals the Build_Sequence oracle, in every respect
// ---------------------------------------------------------------------------

describe("the Workspace_Build_Order equals the Build_Sequence oracle", () => {
  it("contains every workspace package exactly once and nothing else (R12.1)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(CONTEXT, nodes);

        expect([...order].map((n) => n.packageDir).sort()).toEqual(
          [...nodes].map((n) => n.packageDir).sort(),
        );
        expect(order.length).toBe(nodes.length);
        expect(new Set(order.map((n) => n.packageDir)).size).toBe(nodes.length);

        const byDir = new Map(nodes.map((n) => [n.packageDir, n]));
        for (const node of order) {
          expect(byDir.get(node.packageDir)).toBe(node);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("equals the seven-statement Build_Sequence oracle element for element (2.1)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(CONTEXT, nodes);
        const oracle = referenceOrder(nodes);

        // The full claim: the order is exactly the seven statements of 2.1,
        // restated independently. Equal element for element subsumes the
        // statement order and the within-statement `packageDir` tiebreak at once.
        expect(order.map((n) => n.packageDir)).toEqual(
          oracle.map((n) => n.packageDir),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("places each package after every one of its Compile_Time_Prerequisites, honoured by the pass not the sort (2.1, 2.8)", () => {
    fc.assert(
      fc.property(arbNodeSet, (nodes) => {
        const order = workspaceBuildOrder(CONTEXT, nodes);
        const names = declaredNames(nodes);
        const nameToDir = new Map(nodes.map((n) => [n.name, n.packageDir]));
        const spaNames = new Set(
          nodes.filter((n) => n.tier === "spa").map((n) => n.name),
        );
        const indexOfDir = new Map(order.map((n, i) => [n.packageDir, i]));

        // A declared specifier is a Compile_Time_Prerequisite unless it resolves
        // to a Spa_Package (2.6): no Tsc_Project compiles against a Spa_Package,
        // so a `... -> spa` edge imposes no ordering constraint.
        for (const node of nodes) {
          for (const dep of dependencyKeysOf(node, names)) {
            if (spaNames.has(dep)) {
              continue;
            }
            const depDir = nameToDir.get(dep)!;
            expect(indexOfDir.get(depDir)!).toBeLessThan(
              indexOfDir.get(node.packageDir)!,
            );
          }
        }

        // The synthesised Overseer -> Selected_Microservice edges: every
        // microservice precedes the Overseer, the registry importing each.
        const overseerIndex = indexOfDir.get(OVERSEER.packageDir)!;
        for (const node of nodes) {
          if (node.tier === "microservice") {
            expect(indexOfDir.get(node.packageDir)!).toBeLessThan(overseerIndex);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is identical across repeated derivations and independent of presentation order (2.3, Property 5)", () => {
    fc.assert(
      fc.property(
        arbNodeSet.chain((nodes) =>
          fc.tuple(fc.constant(nodes), arbPermuted(nodes), arbPermuted(nodes)),
        ),
        ([nodes, permA, permB]) => {
          const base = workspaceBuildOrder(CONTEXT, nodes).map((n) => n.packageDir);

          expect(
            workspaceBuildOrder(CONTEXT, nodes).map((n) => n.packageDir),
          ).toEqual(base);

          // Presentation order carries no meaning: two independent permutations
          // of the same node set yield the same order.
          expect(
            workspaceBuildOrder(CONTEXT, permA).map((n) => n.packageDir),
          ).toEqual(base);
          expect(
            workspaceBuildOrder(CONTEXT, permB).map((n) => n.packageDir),
          ).toEqual(base);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// The within-statement tiebreak governs pairs WITHIN one statement only (2.3, 3.3)
// ---------------------------------------------------------------------------
//
// 3.3 as it now stands: the `packageDir` code-point tiebreak governs a pair only
// when both members fall in the SAME statement and no calculated order constrains
// them. For a pair drawn from two DIFFERENT statements the statement order of 2.1
// decides and the tiebreak is not consulted — so a Common_Package declaring no
// specifier no longer leads the order ahead of `packages/contracts`, even though
// `packages/common/...` sorts before `packages/contracts` by code point.

describe("the within-statement tiebreak governs same-statement pairs only (2.3, 3.3)", () => {
  it("orders the microservices of statement 4 among themselves by ascending packageDir", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbDirName, { minLength: 2, maxLength: 5 })
          .filter((dirs) =>
            dirs.every((d) => !FRAMEWORK_DIR_NAMES.includes(d)),
          ),
        (microserviceDirs) => {
          const nodes: WorkspaceNode[] = [
            ...frameworkNodes(new Map()),
            ...microserviceDirs.map((d) =>
              consumerNode(
                {
                  category: "microservice",
                  dirName: d,
                  name: `${WORKSPACE_SCOPE}/${d}`,
                },
                [],
              ),
            ),
          ];

          const order = workspaceBuildOrder(CONTEXT, nodes);
          const microserviceDirsInOrder = order
            .filter((n) => n.tier === "microservice")
            .map((n) => n.packageDir);

          // The microservices, among themselves, are in ascending code point.
          const expected = [...microserviceDirsInOrder].sort(compareCodePoints);
          expect(microserviceDirsInOrder).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("orders the Spa_Packages of statement 7 among themselves by ascending packageDir", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbDirName, { minLength: 2, maxLength: 5 })
          .filter((dirs) =>
            dirs.every((d) => !FRAMEWORK_DIR_NAMES.includes(d)),
          ),
        (spaDirs) => {
          const nodes: WorkspaceNode[] = [
            ...frameworkNodes(new Map()),
            ...spaDirs.map((d) =>
              consumerNode(
                { category: "spa", dirName: d, name: `${WORKSPACE_SCOPE}/${d}` },
                [],
              ),
            ),
          ];

          const order = workspaceBuildOrder(CONTEXT, nodes);
          const spaDirsInOrder = order
            .filter((n) => n.tier === "spa")
            .map((n) => n.packageDir);

          const expected = [...spaDirsInOrder].sort(compareCodePoints);
          expect(spaDirsInOrder).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("does not let a specifier-free Common_Package lead ahead of packages/contracts, despite the smaller code point (3.3)", () => {
    fc.assert(
      fc.property(
        arbDirName.filter((d) => !FRAMEWORK_DIR_NAMES.includes(d)),
        (commonDir) => {
          // A Common_Package declaring NO scoped specifier. `packages/common/...`
          // sorts before `packages/contracts` (`com` < `con`), so a whole-order
          // code-point ranking would emit it first. The statement order forbids
          // that: contracts is statement 1, the Common_Package statement 3.
          const commonName = `${WORKSPACE_SCOPE}/${commonDir}`;
          const nodes: WorkspaceNode[] = [
            ...frameworkNodes(new Map()),
            consumerNode(
              { category: "common", dirName: commonDir, name: commonName },
              [],
            ),
          ];

          const order = workspaceBuildOrder(CONTEXT, nodes);
          const index = new Map(order.map((n, i) => [n.packageDir, i]));

          const commonDirPath = `${NAMESPACE_CONTAINER.common}/${commonDir}`;
          // Sanity: the code-point key really would put the Common_Package first.
          expect(
            compareCodePoints(commonDirPath, CONTRACTS.packageDir),
          ).toBeLessThan(0);
          // The statement order wins: contracts still leads.
          expect(index.get(CONTRACTS.packageDir)!).toBeLessThan(
            index.get(commonDirPath)!,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("places config ahead of extended-config as a calculated consequence of the one declared edge (statement 3)", () => {
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
          // the sole input. Statement 3's calculated order must place the
          // dependency first regardless of the two code points.
          const dep = consumerNode(
            { category: "common", dirName: depDir, name: depName },
            [],
          );
          const declarer = consumerNode(
            { category: "common", dirName: declarerDir, name: declarerName },
            [depName],
          );

          const nodes = [...frameworkNodes(new Map()), dep, declarer];
          const order = workspaceBuildOrder(CONTEXT, nodes);
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
// A cycle among the Common_Packages fails, naming exactly the participants (3.14)
// ---------------------------------------------------------------------------
//
// A cycle of length 1..k is built from a ring of Common_Packages: node i names
// node (i+1) mod k, so every member has exactly one outgoing edge to another
// Common_Package and the k members form one closed cycle. k = 1 is a
// self-dependency. Statement 3's calculated order cannot be computed, so
// `commonOrder` raises `[build-order:cycle]` — the message builder moved into
// build-sequence.ts with its wording byte-identical — naming the participant
// DIRECTORIES, computing no order and running no build. The framework nodes are
// present (empty specifiers) so both tiers exist, but only the ring is cyclic.

describe("a cycle among the Common_Packages fails naming exactly the participants (3.14)", () => {
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
            workspaceBuildOrder(CONTEXT, nodes);
          } catch (error) {
            thrown = error;
          }

          // No order is computed — the derivation throws rather than returning,
          // so a caller has nothing to run a `build` script over (3.14).
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

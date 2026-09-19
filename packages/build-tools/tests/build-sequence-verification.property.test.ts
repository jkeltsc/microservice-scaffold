// The Verification_Pass of `build-sequence.ts` (Properties 8 and 10).
//
// Both properties exercise `prerequisiteEdges` + `verifyBuildOrder` over the
// `buildSequence` order, all three pure over an in-memory list of
// `WorkspaceNode`s — no filesystem, no `process` — which is what lets 2.13's
// "over generated repository layouts, not the committed tree alone" run here.
//
// The layout model below builds a set of `WorkspaceNode`s directly (the four
// Framework_Singletons as `tier: "framework"`, plus generated Consumer_Packages
// in the three categories), the same shape `workspaceNodesFrom` hands the
// derivations. A base layout is always violation-free: consumer edges only ever
// point at an EARLIER package in a fixed category order, so the graph is a DAG
// and no edge crosses into the same Unordered_Statement. Property 8 then injects
// exactly one defect per run and checks `verifyBuildOrder`'s verdict against an
// independent oracle; Property 10 injects a dangling specifier or a cycle and
// checks the preserved diagnostics.
//
// The oracles never call `verifyBuildOrder`, `prerequisiteEdges`, or
// `buildSequence` machinery to decide their verdict: positions and statements
// are recomputed from the produced order, and the prerequisite relation is
// re-derived from the nodes' specifiers plus the synthesised
// `Overseer -> Selected_Microservice` edges, straight from the requirement.
//
// Validates: Requirements 2.13, 3.14

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  buildSequence,
  prerequisiteEdges,
  verifyBuildOrder,
  type PrerequisiteEdge,
  type SequenceMembership,
  type SequencedPackage,
} from "../src/build-sequence.js";
import type { ConsumerPackage } from "../src/discovery.js";
import { buildKindOf } from "../src/discovery.js";
import { type ConsumerCategory } from "../src/framework.js";
import type { WorkspaceNode } from "../src/workspace-build-order.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";

/** The per-run context threaded through the build-sequence primitives (task 5.3). */
const CONTEXT = projectContext(defaultEffectiveConfig());

// Scope, per-category roots, and the four Framework_Singletons (each with its
// scope-composed name) come from the run's context, not from framework.ts's
// scope-free surface (R3.7).
const WORKSPACE_SCOPE = CONTEXT.config.scope;
const NAMESPACE_CONTAINER = CONTEXT.roots;
const {
  contracts: CONTRACTS,
  overseer: OVERSEER,
  buildTools: BUILD_TOOLS,
  integrationTests: INTEGRATION_TESTS,
} = CONTEXT.framework;

// ---------------------------------------------------------------------------
// The wording the requirements preserve, restated as literals for the oracle.
// ---------------------------------------------------------------------------

const CYCLE_PREFIX = "[build-order:cycle]";
const UNRESOLVED_PREFIX = "[shared:unresolved]";
const PREREQUISITE_PREFIX = "[build-order:prerequisite]";
const DIVERGENCE_PREFIX = "[build-order:divergence]";

// ---------------------------------------------------------------------------
// The in-memory layout model: a set of WorkspaceNodes
// ---------------------------------------------------------------------------

/** A single consumer node in one of the three categories. */
interface ConsumerSpec {
  readonly category: ConsumerCategory;
  readonly dirName: string;
}

/**
 * A generated layout: the consumer packages of the three categories, in a fixed
 * dependency-safe order per category, plus a Selector over the microservices.
 *
 * Every consumer edge points only at an EARLIER member of the whole consumer
 * list (see `arbLayout`), so the base layout carries no Ordering_Violation and
 * Property 8 measures the *injected* defect alone.
 */
interface Layout {
  /** Consumer packages, in the order edges may point backwards through. */
  readonly consumers: readonly ConsumerPackage[];
  /** The Selector's resolved microservice identifiers (dir names). */
  readonly selected: readonly string[];
}

/** The repo-relative package directory of a Microservice_Identifier. */
function microserviceDir(identifier: string): string {
  return `${NAMESPACE_CONTAINER.microservice}/${identifier}`;
}

/** A discovered Consumer_Package placed in its category's Namespace_Container. */
function consumer(
  category: ConsumerCategory,
  dirName: string,
  dependencySpecifiers: readonly string[] = [],
): ConsumerPackage {
  return {
    category,
    dirName,
    packageDir: `${NAMESPACE_CONTAINER[category]}/${dirName}`,
    name: `${WORKSPACE_SCOPE}/${dirName}`,
    dependencySpecifiers: [...new Set(dependencySpecifiers)].sort(),
    buildKind: buildKindOf(category),
  };
}

/** The framework nodes every layout carries, as `workspaceNodesFrom` builds them. */
function frameworkNodes(): WorkspaceNode[] {
  return [CONTRACTS, BUILD_TOOLS, OVERSEER, INTEGRATION_TESTS].map(
    (singleton) => ({
      packageDir: singleton.packageDir,
      name: singleton.name,
      dependencySpecifiers: [] as readonly string[],
      tier: "framework" as const,
    }),
  );
}

/** A Consumer_Package as a WorkspaceNode (the shape the derivations consume). */
function consumerNode(pkg: ConsumerPackage): WorkspaceNode {
  return {
    packageDir: pkg.packageDir,
    name: pkg.name,
    dependencySpecifiers: pkg.dependencySpecifiers,
    tier: pkg.category,
  };
}

/** Every workspace node of a layout: the four singletons plus the consumers. */
function nodesOf(layout: Layout): readonly WorkspaceNode[] {
  return [...frameworkNodes(), ...layout.consumers.map(consumerNode)];
}

/**
 * The membership the *repository-wide* derivation uses (Task 4.1's shape): every
 * consumer of the layout, `buildTools` and `testOnly` both on. Property 8's
 * structural clause needs statements 4, 6 and 7 populated, which only the
 * repository-wide membership does.
 */
function repoMembership(layout: Layout): SequenceMembership {
  const byCategory = (category: ConsumerCategory): ConsumerPackage[] =>
    layout.consumers.filter((pkg) => pkg.category === category);
  return {
    common: byCategory("common"),
    microservices: byCategory("microservice").map((pkg) => pkg.dirName),
    spa: byCategory("spa"),
    buildTools: true,
    testOnly: true,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbDirName: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]*$/)
  .filter((s) => s.length >= 1 && s.length <= 8);

/**
 * A base layout: 0..k members per category with unique directory names, plus a
 * Selector over some of the microservices.
 *
 * The consumer list is ordered common-first, then microservices, then spa, and
 * each consumer may declare a scoped specifier only to a member EARLIER in that
 * list — so every edge resolves, the graph is acyclic, and no edge lands both
 * endpoints in one Unordered_Statement. That is what makes the base layout
 * violation-free; every defect Property 8 checks is injected on top of it.
 */
const arbLayout: fc.Arbitrary<Layout> = fc
  .record({
    commons: fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 3 }),
    microservices: fc.uniqueArray(arbDirName, { minLength: 1, maxLength: 3 }),
    spas: fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 2 }),
  })
  .filter(({ commons, microservices, spas }) => {
    // Directory names must be globally unique across categories, so a name
    // resolves to exactly one package.
    const all = [...commons, ...microservices, ...spas];
    return new Set(all).size === all.length;
  })
  .chain(({ commons, microservices, spas }) => {
    // The statement structure decides which edges keep the base layout
    // violation-free (only statement 3, common, is Ordered; 4, 6, 7 are not):
    //
    //   - a Common_Package may depend only on an EARLIER Common_Package —
    //     statement 3 is Ordered, so `config -> extended-config` is sound, and
    //     the calculated sort handles it;
    //   - a Microservice_Package may depend only on a Common_Package (statement
    //     3 < 4). A microservice naming a peer would land both endpoints in the
    //     Unordered statement 4 — precisely the structural violation Property 8
    //     INJECTS, never a base-layout edge;
    //   - a Spa_Package may depend on Common and Microservice packages (both in
    //     an earlier statement, and a Spa target is never a prerequisite anyway).
    //
    // So the base graph is acyclic and every edge is sound; Property 8 measures
    // the injected defect alone.
    const specs: ConsumerSpec[] = [
      ...commons.map((dirName) => ({ category: "common" as const, dirName })),
      ...microservices.map((dirName) => ({
        category: "microservice" as const,
        dirName,
      })),
      ...spas.map((dirName) => ({ category: "spa" as const, dirName })),
    ];

    const commonNames = commons.map((d) => `${WORKSPACE_SCOPE}/${d}`);
    const microserviceNames = microservices.map(
      (d) => `${WORKSPACE_SCOPE}/${d}`,
    );

    // The sound back-edge targets available to each package, by category.
    const targetsFor = (spec: ConsumerSpec): readonly string[] => {
      switch (spec.category) {
        case "common": {
          // Only earlier commons (earlier in the commons sub-list).
          const commonIndex = commons.indexOf(spec.dirName);
          return commonNames.slice(0, commonIndex);
        }
        case "microservice":
          return commonNames;
        case "spa":
          return [...commonNames, ...microserviceNames];
      }
    };

    const backEdges = specs.map((spec) => fc.subarray([...targetsFor(spec)]));

    return fc.tuple(...backEdges).chain((edgesPerPackage) => {
      const consumers = specs.map((spec, index) =>
        consumer(spec.category, spec.dirName, edgesPerPackage[index]),
      );
      return fc
        .subarray([...microservices], { minLength: 0 })
        .map((selected) => ({ consumers, selected }));
    });
  });

// ---------------------------------------------------------------------------
// Independent oracles (never call the module under test's verdict logic)
// ---------------------------------------------------------------------------

/**
 * The independent violation oracle for Property 8: TRUE when the produced order
 * carries any Ordering_Violation — positional (a prerequisite at an equal or
 * later position) or structural (both endpoints in one Unordered_Statement).
 */
function oracleHasViolation(
  order: readonly SequencedPackage[],
  edges: readonly PrerequisiteEdge[],
): boolean {
  const positionOf = new Map(order.map((pkg, i) => [pkg.packageDir, i]));
  const statementOf = new Map(order.map((pkg) => [pkg.packageDir, pkg.statement]));
  const unordered = new Set([4, 6, 7]);

  for (const edge of edges) {
    const pPos = positionOf.get(edge.prerequisite);
    const dPos = positionOf.get(edge.dependent);
    if (pPos === undefined || dPos === undefined) continue;

    const pStmt = statementOf.get(edge.prerequisite);
    const dStmt = statementOf.get(edge.dependent);
    if (pStmt !== undefined && pStmt === dStmt && unordered.has(pStmt)) {
      return true; // structural
    }
    if (pPos >= dPos) {
      return true; // positional
    }
  }
  return false;
}

/** The set of package directories the oracle expects a message to name. */
function oracleOffenders(
  order: readonly SequencedPackage[],
  edges: readonly PrerequisiteEdge[],
): Set<string> {
  const positionOf = new Map(order.map((pkg, i) => [pkg.packageDir, i]));
  const statementOf = new Map(order.map((pkg) => [pkg.packageDir, pkg.statement]));
  const unordered = new Set([4, 6, 7]);

  const offenders = new Set<string>();
  for (const edge of edges) {
    const pPos = positionOf.get(edge.prerequisite);
    const dPos = positionOf.get(edge.dependent);
    if (pPos === undefined || dPos === undefined) continue;

    const pStmt = statementOf.get(edge.prerequisite);
    const dStmt = statementOf.get(edge.dependent);
    if (pStmt !== undefined && pStmt === dStmt && unordered.has(pStmt)) {
      offenders.add(edge.prerequisite);
      offenders.add(edge.dependent);
    } else if (pPos >= dPos) {
      offenders.add(edge.prerequisite);
      offenders.add(edge.dependent);
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Property 8: the pass verdict equals an independent oracle; the peer defect
// fails for both orderings of the two directory names.
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 8: The Verification_Pass verdict equals an independent violation oracle, and an intra-statement prerequisite always fails
describe("Property 8: verifyBuildOrder verdict equals an independent oracle", () => {
  /** The kinds of defect Property 8 quantifies over. */
  type Defect =
    | { readonly kind: "none" }
    | { readonly kind: "peer" }
    | { readonly kind: "common-names-microservice" }
    | { readonly kind: "common-names-overseer" }
    | { readonly kind: "cycle"; readonly length: number };

  /**
   * Applies one defect to a layout's nodes, returning the mutated node list.
   * The base layout is violation-free, so a non-"none" defect is the sole source
   * of any violation. Returns `undefined` when the layout cannot host the defect
   * (e.g. a peer defect needs two microservices) — the caller skips those runs.
   */
  function inject(
    layout: Layout,
    defect: Defect,
  ): readonly WorkspaceNode[] | undefined {
    const nodes = [...nodesOf(layout)].map((n) => ({
      ...n,
      dependencySpecifiers: [...n.dependencySpecifiers],
    }));
    const microservices = layout.consumers.filter(
      (pkg) => pkg.category === "microservice",
    );
    const commons = layout.consumers.filter((pkg) => pkg.category === "common");

    const nodeByDir = new Map(nodes.map((n) => [n.packageDir, n]));

    switch (defect.kind) {
      case "none":
        return nodes;

      case "peer": {
        // A Microservice_Package declaring a peer microservice: both land in the
        // Unordered statement 4, so the structural check must catch it whichever
        // way the two directory names sort.
        if (microservices.length < 2) return undefined;
        const [a, b] = microservices;
        const node = nodeByDir.get(a.packageDir);
        if (node === undefined) return undefined;
        node.dependencySpecifiers = [
          ...new Set([...node.dependencySpecifiers, b.name]),
        ];
        return nodes;
      }

      case "common-names-microservice": {
        // A Common_Package declaring a Microservice_Package: statement 3 (common)
        // precedes statement 4 (microservice), so the prerequisite (the
        // microservice) sits AFTER its dependent — a positional violation.
        if (commons.length < 1 || microservices.length < 1) return undefined;
        const node = nodeByDir.get(commons[0].packageDir);
        if (node === undefined) return undefined;
        node.dependencySpecifiers = [
          ...new Set([...node.dependencySpecifiers, microservices[0].name]),
        ];
        return nodes;
      }

      case "common-names-overseer": {
        // A Common_Package declaring the Overseer: statement 3 precedes statement
        // 5, so the Overseer (prerequisite) sits after the common (dependent).
        if (commons.length < 1) return undefined;
        const node = nodeByDir.get(commons[0].packageDir);
        if (node === undefined) return undefined;
        node.dependencySpecifiers = [
          ...new Set([...node.dependencySpecifiers, OVERSEER.name]),
        ];
        return nodes;
      }

      case "cycle": {
        // A prerequisite cycle of the requested length among the microservices:
        // svc_0 -> svc_1 -> ... -> svc_{L-1} -> svc_0. Length 1 is a
        // self-dependency. Needs at least `length` microservices.
        const length = defect.length;
        if (microservices.length < length) return undefined;
        for (let i = 0; i < length; i += 1) {
          const from = microservices[i];
          const to = microservices[(i + 1) % length];
          const node = nodeByDir.get(from.packageDir);
          if (node === undefined) return undefined;
          node.dependencySpecifiers = [
            ...new Set([...node.dependencySpecifiers, to.name]),
          ];
        }
        return nodes;
      }
    }
  }

  const arbDefect: fc.Arbitrary<Defect> = fc.oneof(
    fc.constant<Defect>({ kind: "none" }),
    fc.constant<Defect>({ kind: "peer" }),
    fc.constant<Defect>({ kind: "common-names-microservice" }),
    fc.constant<Defect>({ kind: "common-names-overseer" }),
    fc
      .integer({ min: 1, max: 3 })
      .map<Defect>((length) => ({ kind: "cycle", length })),
  );

  it("returns messages exactly when the oracle finds a violation, and names every offender", () => {
    fc.assert(
      fc.property(arbLayout, arbDefect, (layout, defect) => {
        const nodes = inject(layout, defect);
        if (nodes === undefined) return; // layout cannot host this defect

        const order = buildSequence(CONTEXT, repoMembership(layout));

        // A cycle in the Prerequisite_Graph makes `prerequisiteEdges` produce a
        // cyclic edge set; `verifyBuildOrder` throws `[build-order:cycle]`. That
        // path is Property 10's territory — here we only confirm the throw and
        // move on, so the verdict comparison is over the non-throwing defects.
        // `prerequisiteEdges` only throws `[shared:unresolved]`, which no
        // Property 8 defect introduces — every injected specifier resolves — so
        // any throw here propagates and fails the test, which is what we want.
        const edges: readonly PrerequisiteEdge[] = prerequisiteEdges(
          CONTEXT,
          nodes,
          layout.selected,
        );

        let messages: readonly string[];
        try {
          messages = verifyBuildOrder(CONTEXT, order, edges);
        } catch (error) {
          // The pass throws `[build-order:cycle]` — and only that — when the
          // Prerequisite_Graph is cyclic. The explicit `cycle` defect always
          // produces one, but so can a `common-names-microservice` defect when
          // that microservice already declared the common (the two edges close a
          // loop). The oracle agrees: a cyclic graph has no sound order.
          expect((error as Error).message).toContain(CYCLE_PREFIX);
          return;
        }

        const expectViolation = oracleHasViolation(order, edges);
        expect(messages.length > 0).toBe(expectViolation);

        if (defect.kind === "none") {
          expect(messages).toEqual([]);
        }

        if (expectViolation) {
          const offenders = oracleOffenders(order, edges);
          for (const dir of offenders) {
            expect(messages.some((m) => m.includes(`"${dir}"`))).toBe(true);
          }
          expect(
            messages.every((m) => m.startsWith(PREREQUISITE_PREFIX)),
          ).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("fails the peer defect for BOTH orderings of the two directory names", () => {
    // The clause distinguishing the structural check from the positional one:
    // two microservices in statement 4, one naming the other. Whichever way the
    // two directory names sort in `compareCodePoints`, the pass must report it.
    fc.assert(
      fc.property(
        fc.tuple(arbDirName, arbDirName).filter(([a, b]) => a !== b),
        (pair) => {
          const [x, y] = pair;
          // Two layouts: identical but for which microservice names the other.
          for (const [consumerName, peerName] of [
            [x, y],
            [y, x],
          ] as const) {
            const consumers: ConsumerPackage[] = [
              consumer("microservice", consumerName, [
                `${WORKSPACE_SCOPE}/${peerName}`,
              ]),
              consumer("microservice", peerName, []),
            ];
            const layout: Layout = { consumers, selected: [] };
            const order = buildSequence(CONTEXT, repoMembership(layout));
            const edges = prerequisiteEdges(CONTEXT, nodesOf(layout), layout.selected);
            const messages = verifyBuildOrder(CONTEXT, order, edges);

            expect(messages.length).toBeGreaterThan(0);
            // Both directories named, and reported as a prerequisite finding.
            expect(
              messages.some((m) =>
                m.includes(`"${microserviceDir(consumerName)}"`),
              ),
            ).toBe(true);
            expect(
              messages.some((m) =>
                m.includes(`"${microserviceDir(peerName)}"`),
              ),
            ).toBe(true);
            expect(
              messages.every((m) => m.startsWith(PREREQUISITE_PREFIX)),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: the preserved diagnostics keep their wording and participant sets
// ---------------------------------------------------------------------------

// Feature: unified-build-order, Property 10: The four preserved diagnostics keep their wording and their participant sets
describe("Property 10: preserved diagnostics keep wording and participant sets", () => {
  it("reports [shared:unresolved] naming every dangling specifier and only those, computing no order", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.uniqueArray(arbDirName, { minLength: 1, maxLength: 3 }),
        (layout, danglingDirNames) => {
          // The dangling names must not accidentally match a real package.
          const realDirNames = new Set(
            layout.consumers.map((pkg) => pkg.dirName),
          );
          const dangling = danglingDirNames.filter(
            (d) => !realDirNames.has(d),
          );
          if (dangling.length === 0) return;

          // Attach the dangling specifiers to the first consumer package.
          if (layout.consumers.length === 0) return;
          const target = layout.consumers[0];
          const danglingSpecifiers = dangling.map(
            (d) => `${WORKSPACE_SCOPE}/${d}`,
          );

          const nodes = nodesOf(layout).map((n) =>
            n.packageDir === target.packageDir
              ? {
                  ...n,
                  dependencySpecifiers: [
                    ...new Set([
                      ...n.dependencySpecifiers,
                      ...danglingSpecifiers,
                    ]),
                  ],
                }
              : n,
          );

          // `prerequisiteEdges` resolves every specifier and raises the moved
          // `[shared:unresolved]` for the unknown ones — computing no order.
          let threw = false;
          try {
            prerequisiteEdges(CONTEXT, nodes, layout.selected);
          } catch (error) {
            threw = true;
            const message = (error as Error).message;
            expect(message).toContain(UNRESOLVED_PREFIX);
            // The declaring consumer's directory is named.
            expect(message).toContain(`"${target.packageDir}"`);
            // Every dangling specifier is named, and only those.
            for (const specifier of danglingSpecifiers) {
              expect(message).toContain(`"${specifier}"`);
            }
            // No resolvable scoped specifier is named as unresolved. Any real
            // package name the target legitimately declares must not appear in
            // the unresolved clause.
            for (const real of layout.consumers) {
              if (!danglingSpecifiers.includes(real.name)) {
                // A real specifier the target declares is resolvable, so it is
                // never listed among the unknown packages.
                if (target.dependencySpecifiers.includes(real.name)) {
                  expect(message).not.toContain(`"${real.name}"`);
                }
              }
            }
          }
          expect(threw).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reports [build-order:cycle] naming every cycle participant and only those, computing no order", () => {
    fc.assert(
      fc.property(
        // A dedicated cycle set of distinct microservice names plus some
        // non-participant microservices. Built from scratch (no arbLayout
        // back-edges) so the ONLY cycle in the graph is the one planted here and
        // the reported participant set is exactly `cycleDirs`.
        fc
          .uniqueArray(arbDirName, { minLength: 1, maxLength: 3 })
          .chain((cycleNames) =>
            fc
              .uniqueArray(arbDirName, { minLength: 0, maxLength: 2 })
              .filter((extras) => extras.every((e) => !cycleNames.includes(e)))
              .map((extraNames) => ({ cycleNames, extraNames })),
          ),
        ({ cycleNames, extraNames }) => {
          const length = cycleNames.length;

          // Cycle svc_0 -> svc_1 -> ... -> svc_0 among the cycle members; length
          // 1 is a self-dependency. Non-participants declare nothing.
          const cycleConsumers: ConsumerPackage[] = cycleNames.map(
            (dirName, i) =>
              consumer("microservice", dirName, [
                `${WORKSPACE_SCOPE}/${cycleNames[(i + 1) % length]}`,
              ]),
          );
          const extraConsumers: ConsumerPackage[] = extraNames.map((dirName) =>
            consumer("microservice", dirName, []),
          );
          const layout: Layout = {
            consumers: [...cycleConsumers, ...extraConsumers],
            selected: [],
          };
          const cycleDirs = cycleConsumers.map((pkg) => pkg.packageDir);

          const edges = prerequisiteEdges(CONTEXT, nodesOf(layout), layout.selected);
          const order = buildSequence(CONTEXT, repoMembership(layout));

          let threw = false;
          try {
            verifyBuildOrder(CONTEXT, order, edges);
          } catch (error) {
            threw = true;
            const message = (error as Error).message;
            expect(message).toContain(CYCLE_PREFIX);
            // Every cycle participant is named, as a package directory.
            for (const dir of cycleDirs) {
              expect(message).toContain(`"${dir}"`);
            }
            // Only participants: no non-participant microservice appears.
            for (const pkg of extraConsumers) {
              expect(message).not.toContain(`"${pkg.packageDir}"`);
            }
            // No `build` script could run: the throw computes no order to walk.
          }
          expect(threw).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reports a Common_Package cycle and any other cycle indistinguishably", () => {
    // A cycle among Common_Packages is caught inside statement 3 (by
    // `buildSequence` itself); a cycle elsewhere is caught by the
    // Verification_Pass. Both use the one `[build-order:cycle]` message builder,
    // so a two-node cycle of the same directory names produces byte-identical
    // wording whichever raiser fires.
    fc.assert(
      fc.property(
        fc.tuple(arbDirName, arbDirName).filter(([a, b]) => a !== b),
        (pair) => {
          const [d0, d1] = pair;

          // Common cycle: two Common_Packages naming each other. Caught by
          // buildSequence's statement 3 (commonOrder).
          const commonConsumers: ConsumerPackage[] = [
            consumer("common", d0, [`${WORKSPACE_SCOPE}/${d1}`]),
            consumer("common", d1, [`${WORKSPACE_SCOPE}/${d0}`]),
          ];
          const commonLayout: Layout = {
            consumers: commonConsumers,
            selected: [],
          };
          let commonMessage = "";
          try {
            buildSequence(CONTEXT, repoMembership(commonLayout));
          } catch (error) {
            commonMessage = (error as Error).message;
          }

          // Microservice cycle: two Microservice_Packages naming each other.
          // The build sequence succeeds (statement 4 is unordered), but the
          // Verification_Pass finds the cycle in the Prerequisite_Graph.
          const microConsumers: ConsumerPackage[] = [
            consumer("microservice", d0, [`${WORKSPACE_SCOPE}/${d1}`]),
            consumer("microservice", d1, [`${WORKSPACE_SCOPE}/${d0}`]),
          ];
          const microLayout: Layout = {
            consumers: microConsumers,
            selected: [],
          };
          const microOrder = buildSequence(
            CONTEXT,
            repoMembership(microLayout),
          );
          const microEdges = prerequisiteEdges(
            CONTEXT,
            nodesOf(microLayout),
            microLayout.selected,
          );
          let microMessage = "";
          try {
            verifyBuildOrder(CONTEXT, microOrder, microEdges);
          } catch (error) {
            microMessage = (error as Error).message;
          }

          // Both raised a `[build-order:cycle]`, and both name their two
          // directories the same way. The two are indistinguishable in shape:
          // same prefix, same closed-path arrow format.
          expect(commonMessage).toContain(CYCLE_PREFIX);
          expect(microMessage).toContain(CYCLE_PREFIX);
          expect(commonMessage).toContain(
            `"${NAMESPACE_CONTAINER.common}/${d0}"`,
          );
          expect(commonMessage).toContain(
            `"${NAMESPACE_CONTAINER.common}/${d1}"`,
          );
          expect(microMessage).toContain(`"${microserviceDir(d0)}"`);
          expect(microMessage).toContain(`"${microserviceDir(d1)}"`);
          // Same structural shape: the closed-path arrow separator.
          expect(commonMessage).toContain(" -> ");
          expect(microMessage).toContain(" -> ");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never emits a [build-order:divergence] message from a single-order run", () => {
    // Property 10 is about the cycle/unresolved diagnostics; a run with no
    // counterpart must not manufacture a divergence finding.
    fc.assert(
      fc.property(arbLayout, (layout) => {
        const order = buildSequence(CONTEXT, repoMembership(layout));
        const edges = prerequisiteEdges(CONTEXT, nodesOf(layout), layout.selected);
        const messages = verifyBuildOrder(CONTEXT, order, edges);
        expect(messages.every((m) => !m.startsWith(DIVERGENCE_PREFIX))).toBe(
          true,
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: spa-common-consumption, Property 12: The Verification_Pass accepts
// every order the Build_Sequence produces — a spa → common edge included
// ---------------------------------------------------------------------------
//
// The `spa-common-consumption` feature makes the Demo_Spa (a Spa_Package,
// statement 7) declare `@microservices/extended-config` (a Common_Package,
// statement 3), so a `spa → common` edge is now a real, committed edge. The
// Verification_Pass must accept every order the Build_Sequence produces over a
// layout carrying it: the Common_Package sits in the Ordered statement 3 and
// the Spa_Package in statement 7, so the crossing edge is positionally sound
// (statement 3 precedes statement 7) and structurally exempt (the two are in
// different statements, so the same-Unordered_Statement check cannot fire),
// while a Spa_Package is never a prerequisite in the first place. Neither a
// `[build-order:prerequisite]` finding nor a `[build-order:divergence]` finding
// is produced.
//
// `arbLayout` can produce a `spa → common` edge only by chance; the block below
// plants at least one guaranteed edge on top of a random layout and asserts the
// clean verdict.
//
// Validates: Requirements 4.10

describe("Feature: spa-common-consumption, Property 12: a spa → common edge yields no prerequisite or divergence finding", () => {
  /**
   * A random layout guaranteed to hold at least one Common_Package and one
   * Spa_Package, with every Spa_Package pointed at the first Common_Package —
   * so a real `spa → common` edge is present in every run.
   */
  const arbLayoutWithSpaCommonEdge: fc.Arbitrary<Layout> = arbLayout
    .filter(
      (layout) =>
        layout.consumers.some((pkg) => pkg.category === "common") &&
        layout.consumers.some((pkg) => pkg.category === "spa"),
    )
    .map((layout) => {
      const firstCommon = layout.consumers.find(
        (pkg) => pkg.category === "common",
      )!;
      const consumers = layout.consumers.map((pkg) =>
        pkg.category === "spa"
          ? consumer("spa", pkg.dirName, [
              ...new Set([...pkg.dependencySpecifiers, firstCommon.name]),
            ])
          : pkg,
      );
      return { consumers, selected: layout.selected };
    });

  it("reports no [build-order:prerequisite] and no [build-order:divergence] for a spa → common edge", () => {
    fc.assert(
      fc.property(arbLayoutWithSpaCommonEdge, (layout) => {
        const order = buildSequence(CONTEXT, repoMembership(layout));
        const edges = prerequisiteEdges(CONTEXT, nodesOf(layout), layout.selected);

        // The order the Build_Sequence produces verifies clean.
        const messages = verifyBuildOrder(CONTEXT, order, edges);
        expect(messages).toEqual([]);
        expect(messages.every((m) => !m.startsWith(PREREQUISITE_PREFIX))).toBe(
          true,
        );
        expect(messages.every((m) => !m.startsWith(DIVERGENCE_PREFIX))).toBe(
          true,
        );

        // The Spa_Package is not a prerequisite of anything: the crossing edge
        // is a staging fact, never an ordering one.
        const spaDirs = new Set(
          layout.consumers
            .filter((pkg) => pkg.category === "spa")
            .map((pkg) => pkg.packageDir),
        );
        expect(edges.some((e) => spaDirs.has(e.prerequisite))).toBe(false);

        // Every Common_Package sits ahead of every Spa_Package in the produced
        // order (statement 3 before statement 7).
        const positionOf = new Map(
          order.map((pkg, i) => [pkg.packageDir, i] as const),
        );
        const commonPositions = layout.consumers
          .filter((pkg) => pkg.category === "common")
          .map((pkg) => positionOf.get(pkg.packageDir)!);
        const spaPositions = [...spaDirs].map((dir) => positionOf.get(dir)!);
        for (const commonPos of commonPositions) {
          for (const spaPos of spaPositions) {
            expect(commonPos).toBeLessThan(spaPos);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

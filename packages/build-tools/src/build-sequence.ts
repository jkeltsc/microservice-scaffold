// The one ordering primitive: the Build_Sequence of requirement 2.1.
//
// Every Order_Producing_Path reaches its build order through this module, each
// calling `buildSequence` with a different membership (2.5, 2.7). The statement
// order is hardcoded here and nowhere else, so neither the Workspace_Build_Order
// nor the Tsc_Root_Order can be corrected without the other and no second copy
// of the order exists.
//
// The module consults no per-package build-order position metadata (2.2): the
// framework members of statements 1, 2, 5 and 6 are named by name through
// framework.ts's exported records, not read from a manifest or a declared
// position. It touches no filesystem and reads no `process` state — that purity
// is what lets the properties over generated layouts run against it (2.13).
//
// It also owns the Verification_Pass (§3, requirements 2.13, 2.14, 3.14): the
// single check that fails a produced order carrying an Ordering_Violation and
// fails a disagreement between two paths. Because a dangling specifier can be
// declared by any package in any statement, the specifier resolver
// (`declaredNames`, `dependencyKeysOf`, `unresolvedSpecifierError`) lives here —
// the one place every specifier is resolved — so `[shared:unresolved]` is raised
// exactly once per offending consumer with its existing wording (D3).
//
// (Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.13, 2.14, 3.12, 3.14.)

import type { ConsumerPackage } from "./discovery.js";
import {
  BUILD_TOOLS,
  CONTRACTS,
  INTEGRATION_TESTS,
  NAMESPACE_CONTAINER,
  OVERSEER,
  WORKSPACE_SCOPE,
} from "./framework.js";
import {
  compareCodePoints,
  findCyclePath,
  leastTopologicalOrder,
} from "./topological-order.js";
// Type-only import: `WorkspaceNode` lives in workspace-build-order.ts, which in
// turn imports the shared specifier helpers below from this module. The import
// is erased at runtime (`import type`), so the two modules form no runtime cycle
// — build-sequence.ts is the single home for the helpers and the Verification_Pass.
import type { WorkspaceNode } from "./workspace-build-order.js";

/** Which packages take part in one Build_Sequence derivation (2.5). */
export interface SequenceMembership {
  /** Statement 3's members: the Common_Packages this derivation orders. */
  readonly common: readonly ConsumerPackage[];
  /** Statement 4's members, as Microservice_Identifiers. */
  readonly microservices: readonly string[];
  /** Statement 7's members: the Spa_Packages this derivation orders. */
  readonly spa: readonly ConsumerPackage[];
  /** Statement 2. False on the image and dev paths (3.15). */
  readonly buildTools: boolean;
  /** Statement 6. False on the image and dev paths (3.15). */
  readonly testOnly: boolean;
}

/** One entry of a produced order, carrying the statement that placed it. */
export interface SequencedPackage {
  readonly packageDir: string;
  /** The declared package name; `runOrderedBuild` invokes `--workspace <name>`. */
  readonly name: string;
  /** 1..7, the statement of 2.1 that emitted it. */
  readonly statement: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/**
 * Builds the error that names every package in a dependency cycle (R12.6).
 *
 * The path {@link findCyclePath} returns is closed, so a self-dependency reads
 * `"a" -> "a"` and a two-node cycle `"a" -> "b" -> "a"`.
 *
 * @param participants the cycle in traversal order, closed by its entry point.
 */
function cycleError(participants: readonly string[]): Error {
  const path = participants.map((name) => `"${name}"`).join(" -> ");
  return new Error(
    `[build-order:cycle] the ${WORKSPACE_SCOPE} workspace dependency graph contains a cycle: ${path}`,
  );
}

/**
 * Builds the error for a dependency specifier that names no known package.
 *
 * Moved here from `workspace-build-order.ts` with its wording byte-identical, so
 * a typo'd specifier reads the same wherever it is caught: this is now the single
 * home in which every specifier is resolved, and required-dependencies.ts raises
 * the same tag for the same defect (3.14).
 *
 * Exported so `workspace-build-order.ts` can keep raising it until Task 4.1
 * rewrites `workspaceBuildOrder` over the primitive; this module is its single
 * home meanwhile.
 *
 * @param consumer the repo-relative directory of the declaring package.
 * @param unresolved deduplicated and sorted by the caller.
 */
export function unresolvedSpecifierError(
  consumer: string,
  unresolved: readonly string[],
): Error {
  const named = unresolved.map((name) => `"${name}"`).join(", ");
  return new Error(
    `[shared:unresolved] "${consumer}" depends on unknown ${WORKSPACE_SCOPE} package(s): ${named}`,
  );
}

/**
 * Statement 3 of 2.1 — the Common_Packages in calculated order.
 *
 * A topological sort over each member's declared `@microservices`-scoped
 * dependencies that resolve to **another member of this same set**, keyed by
 * declared name, with the ready queue held in `compareCodePoints` order of
 * `packageDir` for reproducibility (2.3). `config` before `extended-config`
 * follows from the one declared edge (`extended-config` naming
 * `@microservices/config`), not from a rule.
 *
 * The edge predicate is deliberately restricted to Common_Package targets:
 * a specifier resolving to any package outside `common` — a Framework_Singleton,
 * a microservice — is not a statement-3 edge and is left to the Verification_Pass
 * to resolve. `resolveDependencySets` is not reused here; it walks out from roots
 * so it cannot enumerate every Common_Package, and its direction rules must not
 * be applied repository-wide (F5).
 *
 * @throws `[build-order:cycle]` when the Common_Packages form a dependency cycle,
 *   naming every participant as a package directory, with the wording moved
 *   byte-identical from `workspace-build-order.ts` (3.14).
 */
function commonOrder(
  common: readonly ConsumerPackage[],
): readonly ConsumerPackage[] {
  const names = new Set(common.map((pkg) => pkg.name));
  const keyOf = (pkg: ConsumerPackage): string => pkg.name;
  const dependenciesOf = (pkg: ConsumerPackage): readonly string[] =>
    pkg.dependencySpecifiers.filter((specifier) => names.has(specifier));

  const cycle = findCyclePath(common, keyOf, dependenciesOf);
  if (cycle !== undefined) {
    // Report directories, not declared names, as every build-order failure does.
    const dirByName = new Map(common.map((pkg) => [pkg.name, pkg.packageDir]));
    throw cycleError(cycle.map((name) => dirByName.get(name) ?? name));
  }

  return leastTopologicalOrder(common, keyOf, dependenciesOf, (a, b) =>
    compareCodePoints(a.packageDir, b.packageDir),
  );
}

/**
 * The Build_Sequence: the fixed statement order of 2.1 applied to one membership.
 *
 * The seven statements run literally and in order — `contracts`, `build-tools`
 * (when included), the Common_Packages in calculated order, the microservices in
 * `packageDir` order, the Overseer, the test-only Framework_Singletons (when
 * included), and finally the Spa_Packages in `packageDir` order as a trailing
 * phase (2.4). Statements 4 and 7 iterate in `compareCodePoints` order of
 * `packageDir` for reproducibility, no correctness resting on it (2.3).
 *
 * Consults no per-package position metadata (2.2): statements 1, 2, 5 and 6 name
 * their framework members through framework.ts's exported records.
 *
 * @throws `[build-order:cycle]` when statement 3's calculated order cannot be
 *   computed, with the existing wording (3.14).
 */
export function buildSequence(
  membership: SequenceMembership,
): readonly SequencedPackage[] {
  const sequenced: SequencedPackage[] = [];

  // Statement 1 — contracts, always first.
  sequenced.push({
    packageDir: CONTRACTS.packageDir,
    name: CONTRACTS.name,
    statement: 1,
  });

  // Statement 2 — build-tools, when this membership includes it.
  if (membership.buildTools) {
    sequenced.push({
      packageDir: BUILD_TOOLS.packageDir,
      name: BUILD_TOOLS.name,
      statement: 2,
    });
  }

  // Statement 3 — the Common_Packages, in calculated order.
  for (const pkg of commonOrder(membership.common)) {
    sequenced.push({
      packageDir: pkg.packageDir,
      name: pkg.name,
      statement: 3,
    });
  }

  // Statement 4 — the microservices, in ascending packageDir order (2.3, D1).
  const microservicePackageDir = (identifier: string): string =>
    `${NAMESPACE_CONTAINER.microservice}/${identifier}`;
  const microservices = [...membership.microservices].sort((a, b) =>
    compareCodePoints(microservicePackageDir(a), microservicePackageDir(b)),
  );
  for (const identifier of microservices) {
    sequenced.push({
      packageDir: microservicePackageDir(identifier),
      name: `${WORKSPACE_SCOPE}/${identifier}`,
      statement: 4,
    });
  }

  // Statement 5 — the Overseer, after every microservice.
  sequenced.push({
    packageDir: OVERSEER.packageDir,
    name: OVERSEER.name,
    statement: 5,
  });

  // Statement 6 — the test-only Framework_Singletons, when included.
  if (membership.testOnly) {
    sequenced.push({
      packageDir: INTEGRATION_TESTS.packageDir,
      name: INTEGRATION_TESTS.name,
      statement: 6,
    });
  }

  // Statement 7 — the Spa_Packages, a trailing bundler phase (2.4).
  const spa = [...membership.spa].sort((a, b) =>
    compareCodePoints(a.packageDir, b.packageDir),
  );
  for (const pkg of spa) {
    sequenced.push({
      packageDir: pkg.packageDir,
      name: pkg.name,
      statement: 7,
    });
  }

  return sequenced;
}

// ---------------------------------------------------------------------------
// The Verification_Pass (§3 — requirements 2.13, 2.14, 2.6, 3.12, 3.14)
// ---------------------------------------------------------------------------

/** One Compile_Time_Prerequisite edge, over repo-relative package directories. */
export interface PrerequisiteEdge {
  /** The package whose compiled output the dependent's compilation reads. */
  readonly prerequisite: string;
  /** The package that reads it, so it must appear later in the order. */
  readonly dependent: string;
}

/**
 * The set of package names a dependency specifier may resolve against.
 *
 * Moved here from `workspace-build-order.ts` unchanged. Both tiers go into the
 * one set: a scaffold package's name is an ordering edge like any other, so a
 * `@microservices/contracts` specifier resolves and is simply not followed as a
 * prerequisite (it names a Framework_Singleton, never a build-order edge here).
 *
 * Exported for `workspace-build-order.ts`'s use until Task 4.1 (see above).
 */
export function declaredNames(
  nodes: readonly WorkspaceNode[],
): ReadonlySet<string> {
  return new Set(nodes.map((node) => node.name));
}

/**
 * Resolves one package's `@microservices`-scoped specifiers to declared names.
 *
 * Moved here from `workspace-build-order.ts` unchanged. A specifier resolving to
 * nothing fails the run rather than being dropped, so every specifier is resolved
 * once, in this module, and the message is raised once per offending consumer.
 *
 * Exported for `workspace-build-order.ts`'s use until Task 4.1 (see above).
 *
 * @throws `[shared:unresolved]` for an `@microservices`-scoped specifier matching
 *   no declared package name.
 */
export function dependencyKeysOf(
  node: WorkspaceNode,
  names: ReadonlySet<string>,
): readonly string[] {
  const keys: string[] = [];
  const unresolved: string[] = [];

  for (const specifier of node.dependencySpecifiers) {
    // Both suppliers already filter by scope; the guard keeps the rule true of
    // this function on its own account (R3.10).
    if (!specifier.startsWith(`${WORKSPACE_SCOPE}/`)) {
      continue;
    }
    if (names.has(specifier)) {
      keys.push(specifier);
    } else {
      unresolved.push(specifier);
    }
  }

  if (unresolved.length > 0) {
    throw unresolvedSpecifierError(
      node.packageDir,
      [...new Set(unresolved)].sort(),
    );
  }

  return keys;
}

/**
 * Builds the Prerequisite_Graph for one produced order (2.6).
 *
 * Its edges are every declared `@microservices`-scoped specifier that resolves to
 * a **non-Spa** package, plus the `Overseer → Selected_Microservice` edges the
 * generated Microservice_Registry creates by statically importing each selected
 * microservice. The Spa_Package exclusion is unconditional: no Tsc_Project ever
 * compiles against a Spa_Package (it is reached through a run-time
 * module-resolution call), so a declared `microservice → spa` or `overseer → spa`
 * dependency is a staging fact, never an ordering one (2.6).
 *
 * The `Overseer → Selected_Microservice` edges are synthesised here rather than
 * declared, for two independent reasons that make no manifest able to carry them
 * (1.8, 1.9): `required-dependencies.ts`'s `peerDependencyError` rejects any
 * manifest naming a Microservice_Package with `[deps:peer]` and grants the
 * Overseer no exemption, and the set of microservices is Selector-dependent
 * anyway. No manifest gains such a dependency as part of this fix, and the
 * resolver keeps rejecting one (3.12) — so the edge exists only in this graph.
 *
 * @param nodes every workspace package, as `workspaceNodesFrom` collects them.
 * @param selectedMicroservices the identifiers the Selector resolved to; each
 *   becomes the prerequisite of an `Overseer →` edge.
 * @throws `[shared:unresolved]` with the existing wording for a scoped specifier
 *   matching no declared package name (3.14).
 */
export function prerequisiteEdges(
  nodes: readonly WorkspaceNode[],
  selectedMicroservices: readonly string[],
): readonly PrerequisiteEdge[] {
  const names = declaredNames(nodes);
  const dirByName = new Map(nodes.map((node) => [node.name, node.packageDir]));
  // A Spa_Package is never the prerequisite half of an edge (2.6). It is the only
  // category so excluded; every other resolved specifier is a real edge.
  const spaNames = new Set(
    nodes.filter((node) => node.tier === "spa").map((node) => node.name),
  );

  const edges: PrerequisiteEdge[] = [];

  // Declared edges: every scoped specifier resolving to a non-Spa package. Each
  // specifier is resolved once, here, so `[shared:unresolved]` is raised once per
  // offending consumer (D3).
  for (const node of nodes) {
    for (const specifier of dependencyKeysOf(node, names)) {
      if (spaNames.has(specifier)) {
        continue;
      }
      const prerequisite = dirByName.get(specifier);
      if (prerequisite !== undefined) {
        edges.push({ prerequisite, dependent: node.packageDir });
      }
    }
  }

  // Synthesised edges: the Overseer's registry imports each Selected_Microservice
  // (1.8, 1.9). De-duplicated so a repeated identifier in the Selector adds one
  // edge, matching the solution builder treating a repeated root as a no-op.
  for (const identifier of new Set(selectedMicroservices)) {
    edges.push({
      prerequisite: `${NAMESPACE_CONTAINER.microservice}/${identifier}`,
      dependent: OVERSEER.packageDir,
    });
  }

  return edges;
}

/** The statements whose within-statement order is not guaranteed (D3, 2.13):
 *  statement 3 is an Ordered_Statement and is deliberately absent. */
const UNORDERED_STATEMENTS: ReadonlySet<number> = new Set([4, 6, 7]);

/**
 * Builds a `[build-order:prerequisite]` positional finding: a package placed
 * ahead of one of its own Compile_Time_Prerequisites (the Ordering_Violation of
 * the Bug_Condition, verbatim). One of the tag's two clause shapes.
 */
function positionalViolation(edge: PrerequisiteEdge): string {
  return `[build-order:prerequisite] "${edge.dependent}" is built before its prerequisite "${edge.prerequisite}"`;
}

/**
 * Builds a `[build-order:prerequisite]` structural finding: an edge whose two
 * endpoints sit in the same Unordered_Statement, where no order is guaranteed.
 * The second of the tag's two clause shapes; reported whichever way the two sort.
 */
function structuralViolation(
  edge: PrerequisiteEdge,
  statement: number,
): string {
  return `[build-order:prerequisite] "${edge.dependent}" and its prerequisite "${edge.prerequisite}" are both in unordered statement ${String(statement)}; their relative order is not guaranteed`;
}

/**
 * Builds a `[build-order:divergence]` finding: two paths disagree on the relative
 * order of a pair both contain (2.14, 2.11).
 */
function divergenceViolation(earlier: string, later: string): string {
  return `[build-order:divergence] the Workspace_Build_Order and the Tsc_Root_Order disagree on the relative order of "${earlier}" and "${later}"`;
}

/**
 * The Verification_Pass: returns every violation message of one run, empty when
 * the order is sound (2.13, 2.14). {@link assertBuildOrder} is the throwing
 * wrapper the two derivations call before any `build` script is spawned.
 *
 * All four checks run on every invocation, in this fixed order, so one call
 * reports everything:
 *
 * 1. **Cycle** — `findCyclePath` over the Prerequisite_Graph. A cycle means no
 *    valid order exists for a reason no statement structure can fix; reported with
 *    the existing `[build-order:cycle]` wording, directories not declared names.
 *    It runs **first** on purpose (D3): an input carrying both a cycle and a
 *    dangling specifier now reports the cycle — a precedence no requirement fixes
 *    and no existing test asserts, but one this ordering makes deterministic. The
 *    Common_Package-only cycle is caught earlier still, inside statement 3, with
 *    the same message builder, so the two are indistinguishable in output.
 * 2. **Positional** — each edge's prerequisite strictly earlier than its
 *    dependent, the Ordering_Violation of the Bug_Condition verbatim.
 * 3. **Structural** — an edge whose endpoints sit in the same Unordered_Statement
 *    (4, 6, or 7), reported whichever way the two sort. This is how a
 *    Microservice_Package declaring a peer is caught: both endpoints land in
 *    statement 4, so the positional check alone would pass on the pairs that
 *    happen to sort favourably. Statement 3 is an Ordered_Statement and is exempt.
 * 4. **Divergence** — `counterpart` and `order` must agree on the relative order
 *    of every package both contain (2.14). Omitted when only one order exists.
 *
 * The positional and structural findings share the new `[build-order:prerequisite]`
 * tag (two clause shapes); divergence uses `[build-order:divergence]`. No new tag
 * replaces or narrows `[shared:unresolved]` or `[build-order:cycle]`.
 *
 * @param order the produced order, as {@link buildSequence} returned it.
 * @param edges the Prerequisite_Graph, from {@link prerequisiteEdges}.
 * @param counterpart the other path's order for the same state and Selector, for
 *   the divergence check; omitted when only one order exists.
 * @throws `[build-order:cycle]` — the cycle check throws directly, computing no
 *   further findings, exactly as the pre-fix derivation did.
 */
export function verifyBuildOrder(
  order: readonly SequencedPackage[],
  edges: readonly PrerequisiteEdge[],
  counterpart?: readonly SequencedPackage[],
): readonly string[] {
  // 1. Cycle. Runs first (D3). The nodes are the edges' endpoints; a returned
  //    path names directories, matching every other build-order failure.
  const cycleNodes = [
    ...new Set(edges.flatMap((edge) => [edge.prerequisite, edge.dependent])),
  ];
  const dependentsOf = (dir: string): readonly string[] =>
    edges.filter((edge) => edge.prerequisite === dir).map((edge) => edge.dependent);
  const cycle = findCyclePath(
    cycleNodes,
    (dir) => dir,
    dependentsOf,
  );
  if (cycle !== undefined) {
    // Byte-identical wording with statement 3's Common_Package cycle, so a cycle
    // reported here and one reported by the calculated sort are indistinguishable.
    throw cycleError(cycle);
  }

  const messages: string[] = [];
  const positionOf = new Map(order.map((pkg, index) => [pkg.packageDir, index]));
  const statementOf = new Map(
    order.map((pkg) => [pkg.packageDir, pkg.statement]),
  );

  // 2. Positional and 3. Structural, per edge. Both endpoints of a real edge are
  //    always present in the order the edge was built for.
  for (const edge of edges) {
    const prerequisitePos = positionOf.get(edge.prerequisite);
    const dependentPos = positionOf.get(edge.dependent);
    if (prerequisitePos === undefined || dependentPos === undefined) {
      continue;
    }

    const prerequisiteStatement = statementOf.get(edge.prerequisite);
    const dependentStatement = statementOf.get(edge.dependent);
    if (
      prerequisiteStatement !== undefined &&
      prerequisiteStatement === dependentStatement &&
      UNORDERED_STATEMENTS.has(prerequisiteStatement)
    ) {
      // Structural: same Unordered_Statement, so no order is guaranteed either
      // way. Reported whichever direction the positions happen to fall.
      messages.push(structuralViolation(edge, prerequisiteStatement));
      continue;
    }

    if (prerequisitePos >= dependentPos) {
      messages.push(positionalViolation(edge));
    }
  }

  // 4. Divergence. For every pair both orders contain, the two must agree.
  if (counterpart !== undefined) {
    messages.push(...divergenceMessages(order, counterpart));
  }

  return messages;
}

/**
 * Collects one `[build-order:divergence]` message per pair the two orders place
 * in opposite relative order. Quantifies over the intersection: a package in only
 * one order constrains nothing.
 */
function divergenceMessages(
  order: readonly SequencedPackage[],
  counterpart: readonly SequencedPackage[],
): readonly string[] {
  const counterpartPos = new Map(
    counterpart.map((pkg, index) => [pkg.packageDir, index]),
  );
  // The packages both orders contain, in `order`'s sequence.
  const shared = order
    .map((pkg) => pkg.packageDir)
    .filter((dir) => counterpartPos.has(dir));

  const messages: string[] = [];
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      // `shared[i]` precedes `shared[j]` in `order`; a divergence is the
      // counterpart placing them the other way round.
      const iInCounterpart = counterpartPos.get(shared[i]) ?? 0;
      const jInCounterpart = counterpartPos.get(shared[j]) ?? 0;
      if (iInCounterpart > jInCounterpart) {
        messages.push(divergenceViolation(shared[i], shared[j]));
      }
    }
  }
  return messages;
}

/**
 * The throwing wrapper the two derivations call: runs {@link verifyBuildOrder}
 * and raises the first finding when the order is unsound, so no `build` script is
 * spawned over a bad order. The cycle check inside already throws directly.
 *
 * @throws an `Error` carrying every finding of the run, or the `[build-order:cycle]`
 *   error the pass raised, when the order is not sound.
 */
export function assertBuildOrder(
  order: readonly SequencedPackage[],
  edges: readonly PrerequisiteEdge[],
  counterpart?: readonly SequencedPackage[],
): void {
  const findings = verifyBuildOrder(order, edges, counterpart);
  if (findings.length > 0) {
    throw new Error(findings.join("\n"));
  }
}

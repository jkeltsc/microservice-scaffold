// Orders a dependency graph and finds cycles in it.
//
// This is the shared graph machinery two callers use: the dependency resolver
// behind pipeline step 5 (`required-dependencies.ts`) and the repository-wide
// build order (`workspace-build-order.ts`). See design "Components and
// Interfaces / topological-order.ts"; Requirements R7.2, R12.5, R12.6.
//
// The module holds no domain knowledge — no package, no Package_Category, no
// Dependency_Specifier, no error prefix. Each caller formats its own errors,
// because the prefixes differ (`[deps:cycle]` versus `[build-order:cycle]`) and
// the shape of a cycle path is all the two have in common.

/** Compares two strings by code point, ascending — the order R7.2 and R12.5 require. */
export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns the nodes of an acyclic graph in dependency order.
 *
 * Kahn's algorithm with the ready queue held in `compareNodes` order, so a node
 * is emitted only once everything it depends on has been emitted, and the least
 * ready node is taken next. That order is the unique lexicographically-least
 * one, so repeated runs over an unchanged graph agree element for element by
 * construction rather than by the traversal happening to be stable.
 *
 * The callers agree on node identity but differ on the ready-queue order — the
 * dependency resolver sorts by `dirName` (R7.2), the repository-wide build order
 * by `packageDir` (R12.5) — which is why `keyOf` and `compareNodes` are separate
 * parameters. A dependency key naming no node in `nodes` is ignored, since the
 * graph is only the nodes handed in, so a caller may pass edges to nodes it
 * excluded without affecting the order.
 *
 * Run {@link findCyclePath} before this. On a cyclic graph it drops the nodes
 * reachable into the cycle instead of failing, and its leftovers include nodes
 * merely downstream of the cycle, so naming those as participants would
 * over-report.
 *
 * @param nodes every node of the graph, each appearing once.
 * @param keyOf the identity of a node; edges are expressed in these keys.
 * @param dependenciesOf the keys of the nodes a given node depends on.
 * @param compareNodes the total order the ready queue is held in.
 */
export function leastTopologicalOrder<T>(
  nodes: readonly T[],
  keyOf: (node: T) => string,
  dependenciesOf: (node: T) => readonly string[],
  compareNodes: (a: T, b: T) => number,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const node of nodes) {
    byKey.set(keyOf(node), node);
  }

  // Reverse edges (dependency -> dependents), plus each node's count of
  // not-yet-emitted dependencies. A key naming no node in the graph contributes
  // neither an edge nor a count.
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const key of byKey.keys()) {
    dependents.set(key, []);
    remaining.set(key, 0);
  }
  for (const node of nodes) {
    const key = keyOf(node);
    let count = 0;
    for (const dep of dependenciesOf(node)) {
      if (byKey.has(dep)) {
        count += 1;
        dependents.get(dep)?.push(key);
      }
    }
    remaining.set(key, count);
  }

  const ready = nodes.filter((node) => remaining.get(keyOf(node)) === 0);
  const ordered: T[] = [];

  while (ready.length > 0) {
    // Sorted at each step rather than on insertion: the queue is tiny, and this
    // keeps "the least ready node is taken next" literal in the code.
    ready.sort(compareNodes);
    const next = ready[0];
    ready.shift();
    ordered.push(next);

    for (const dependentKey of dependents.get(keyOf(next)) ?? []) {
      const left = (remaining.get(dependentKey) ?? 0) - 1;
      remaining.set(dependentKey, left);
      if (left === 0) {
        const dependent = byKey.get(dependentKey);
        if (dependent !== undefined) {
          ready.push(dependent);
        }
      }
    }
  }

  return ordered;
}

/**
 * Finds one cycle in a graph and returns its path, or `undefined` when the graph
 * is acyclic.
 *
 * Both callers run this before {@link leastTopologicalOrder} and turn a returned
 * path into their own error. The path is closed — first and last element equal —
 * and names every participant and only the participants: a self-dependency reads
 * `["a", "a"]`, a two-node cycle `["a", "b", "a"]`.
 *
 * The walk is depth-first over three colours, with a live stack. White is not
 * yet visited, grey is on the current stack, black is finished; re-entering a
 * grey node closes a cycle, and the stack sliced from that node's first
 * occurrence gives the participants in traversal order. A dependency key naming
 * no node in `nodes` is ignored, matching {@link leastTopologicalOrder}, so the
 * two agree on what the graph is.
 *
 * @param nodes every node of the graph, each appearing once.
 * @param keyOf the identity of a node; the returned path is in these keys.
 * @param dependenciesOf the keys of the nodes a given node depends on.
 */
export function findCyclePath<T>(
  nodes: readonly T[],
  keyOf: (node: T) => string,
  dependenciesOf: (node: T) => readonly string[],
): readonly string[] | undefined {
  const byKey = new Map<string, T>();
  for (const node of nodes) {
    byKey.set(keyOf(node), node);
  }

  const grey = new Set<string>();
  const black = new Set<string>();
  const stack: string[] = [];

  const visit = (key: string): readonly string[] | undefined => {
    if (black.has(key)) {
      return undefined;
    }
    if (grey.has(key)) {
      return [...stack.slice(stack.indexOf(key)), key];
    }

    grey.add(key);
    stack.push(key);

    const node = byKey.get(key);
    if (node !== undefined) {
      for (const dep of dependenciesOf(node)) {
        if (byKey.has(dep)) {
          const cycle = visit(dep);
          if (cycle !== undefined) {
            return cycle;
          }
        }
      }
    }

    stack.pop();
    grey.delete(key);
    black.add(key);
    return undefined;
  };

  for (const node of nodes) {
    const cycle = visit(keyOf(node));
    if (cycle !== undefined) {
      return cycle;
    }
  }

  return undefined;
}

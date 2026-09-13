# Unified Build Order Bugfix Design

## Overview

The repository has three order-producing mechanisms across four Order_Producing_Paths, and only one
of the three is correct by construction. This fix collapses them to one: a single **Build_Sequence**
primitive — the hardcoded statement order of requirement 2.1 — that every path calls with a
different *membership*, plus one **Verification_Pass** that fails a produced order carrying an
Ordering_Violation and fails a disagreement between two paths.

The shape of the change, in four moves:

- **One primitive, one new module.** `packages/build-tools/src/build-sequence.ts` holds the statement
  order and nothing else's business. `workspaceBuildOrder()` stops being a topological sort over
  declared dependencies and becomes a call into it with "everything" as membership;
  `tscRootsOf()` in `build-plan.ts` disappears and `buildPlanFrom` calls the same primitive with the
  Selector-scoped membership. Neither ordering can be corrected without the other (2.7), and the two
  differ only in what they are handed (2.5).
- **Spa_Packages move to a trailing phase on the repository-wide path.** The image path already runs
  every bundler after the single `tsc --build` (F6); the repository-wide path currently interleaves
  them into one sorted sequence, which is what put `packages/spa/demo` at position 8 and
  `packages/microservices/microservice1` at 9 (F3). Statement 7 makes the two phase structures
  identical.
- **One Verification_Pass, invoked from both derivations.** It resolves every package's
  Dependency_Specifiers into Compile_Time_Prerequisites, excludes Spa_Packages from that relation
  (2.6), and reports a package placed ahead of a prerequisite, a prerequisite edge inside an
  unordered statement (which is how a Microservice_Package naming a peer is caught), a cycle, and a
  disagreement between the Workspace_Build_Order and the Tsc_Root_Order.
- **`npm start` stops reading the `workspaces` array.** `scripts/start.js` spawns the compiled
  `build-workspaces` bin exactly as `scripts/build.js` does, so the Declared_Array_Sequence is an
  order source for no path (2.10) and npm's `workspaces` field declares membership only (2.17).

The one place the requirements pull in two directions is the within-statement order of the
Microservice_Packages: 2.3 mandates deterministic directory order while `tscRootsOf` emits them in
Selector order. That conflict is resolved in favour of directory order on **every** path, with the
residual behaviour change confined to a Selector hand-written out of directory order or repeating an
identifier; the resolution and its blast radius are D1, and the argument that 3.4 still holds exactly
as written rests on F2.

Nothing about *what* is built, staged, served, or reported changes. `BuildPlan.selected`,
`stageOf`'s staging order, and the Microservice_Registry's import order all stay in Selector order —
only `tscRoots` ordering moves (D1, F9).

---

## Glossary

Every term the requirements define is used here with that meaning and is not restated. Four terms
this design introduces:

- **Sequence_Membership**: the argument to the Build_Sequence primitive. Which Common_Packages, which
  Microservice_Packages, which Spa_Packages, and whether `packages/build-tools` and
  `packages/integration-tests` participate. It is the *only* thing that differs between the
  repository-wide call and the Selector-scoped call (2.5).
- **Unordered_Statement**: a statement of the Build_Sequence that 2.1 says loops "in any order" —
  statements 4, 6, and 7. Correctness must not depend on the order within one; 2.3 fixes it to
  ascending code-point comparison of `packageDir` for reproducibility only.
- **Ordered_Statement**: statement 3, whose within-statement order is *calculated* — a topological
  sort over the Common_Packages' declared `@microservices`-scoped dependencies.
- **Prerequisite_Graph**: the directed graph the Verification_Pass builds, whose nodes are the
  packages of the produced order and whose edges are the Compile_Time_Prerequisite relation. Its
  edges are declared Dependency_Specifiers resolving to a non-Spa package, plus the
  Overseer → Selected_Microservice edges the Microservice_Registry creates and no manifest may
  declare.

---

## Verified findings

Every finding below was read out of the code in this repository, with the file named so each can be
re-checked. Nothing here is inferred from the requirements.

### F1 — `tscRootsOf` composes the Selected_Microservices in Selector order, not directory order

`packages/build-tools/src/build-plan.ts`, `tscRootsOf(selected, required)`:

```ts
return [
  ...positioned("first"),
  ...required
    .filter((pkg) => pkg.buildKind === "tsc-project")
    .map((pkg) => pkg.packageDir),
  ...selected.map(microserviceDir),
  ...positioned("last"),
];
```

`selected` is `resolveSelected`'s return value, and `resolveSelected` (`selector.ts`) returns
`[...parsed.identifiers]` for a list Selector — the identifiers **in the order given**, duplicates
preserved. So for `MICROSERVICES=microservice3,microservice1` the pre-fix Tsc_Root_Order holds
`microservices/microservice3` before `microservices/microservice1`. This is the conflict with 2.3 that
D1 resolves.

### F2 — Discovery enumerates each category's members in ascending directory-name order, so an all-Selector's order already **is** directory order

Confirmed, and this is the load-bearing fact behind D1's claim that 3.4 survives:

- `discovery.ts`, `candidatesOf()` ends with
  `.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0))`, so the candidates
  of one Namespace_Container come back sorted by directory name.
- `discoverPackagesFrom()` builds `packages` from `named` (which preserves candidate order through
  `readManifests` → `readDeclaredNames`) and then groups with
  `grouped[category] = packages.filter((pkg) => pkg.category === category)` — a filter, so the sorted
  order survives into `byCategory`.
- `buildPlanFrom` passes `discovery.byCategory.microservice.map((pkg) => pkg.dirName)` to
  `resolveSelected`, whose all-branch returns `[...directories]` unchanged.

For a Microservice_Package, `packageDir` is `packages/microservices/${dirName}`, so ordering by
`dirName` and ordering by `packageDir` are the same ordering. Therefore for the Selector `*` the
pre-fix Tsc_Root_Order is already in directory order, and for `microservice1,microservice2` Selector
order and directory order coincide. The recommended resolution changes neither. `generateRegistry`
resolves the Selector through the same `resolveSelected` call, so the registry's import order is the
same list.

### F3 — The repository-wide path interleaves Spa_Packages; the image path already runs them as a trailing phase

`workspace-build-order.ts` derives one flat order with `leastTopologicalOrder(...)` over every
workspace package and `runOrderedBuild` walks it invoking `npm run build --workspace <name>` once per
node. A Spa_Package is a node like any other, so it lands wherever the sort puts it — position 8 on
the committed tree, ahead of `packages/microservices/microservice1` at 9
(`tests/workspace-build-order-real-tree.test.ts` pins exactly that, and its fourth `it` block asserts
`order[demoIdx + 1] === "packages/microservices/microservice1"`, which is an assertion **of the
defect**).

The image path is already two phases. `image-tree.ts`, `executeBuildPlan`:

```ts
runner("npx", ["tsc", "--build", ...plan.tscRoots]); // step 7 (R6.5)
for (const spa of plan.spaBuilds) {
  runner("npm", ["run", "build"], { cwd: spa.packageDir }); // step 8 (R6.4)
}
stage(plan, outDir);
```

`spaBuilds` and `tscRoots` partition the BUILD set by `buildKind` — `build-plan.ts` filters
`required` on `buildKind === "bundler-project"` for the former and on `buildKind === "tsc-project"`
for the latter, with the comment recording that the two filters are complements. So a Spa_Package
cannot reach `tscRoots` and a Tsc_Project cannot reach `spaBuilds`, and 2.4 on the image path is a
structural fact rather than something to enforce.

### F4 — `buildPosition` is read in exactly one place, and its `"excluded"` value decides nothing

`grep buildPosition` over `packages/**/*.ts` outside `dist/`: one production reader,
`tscRootsOf`'s local `positioned()` helper, which filters `FRAMEWORK_SINGLETONS` on
`entry.buildPosition === position` for `"first"` and `"last"` only. `"excluded"` is never compared
against. `packages/build-tools` and `packages/integration-tests` are absent from `tscRoots` because
they are neither a Required_Dependency (they are Framework_Singletons, and
`resolveSpecifiers` resolves a framework name without following it) nor a Selected_Microservice — not
because of the field. The three remaining readers are tests: `framework.test.ts` (pins all four
values), `build-plan.property.test.ts` (uses `singleton.buildPosition !== "excluded"` as a root-membership
oracle), and `required-dependencies.property.test.ts` (`expect(CONTRACTS.buildPosition).toBe("first")`).

### F5 — `resolveDependencySets` cannot supply statement 3's repository-wide order, but `topological-order.ts` can

`resolveDependencySets` (`required-dependencies.ts`) walks **out from roots** —
`rootDirectories(selected)` is the Selected_Microservices plus `OVERSEER.packageDir` — and applies
the four direction rules on the way (`[deps:peer]`, `[deps:common-to-spa]`, `[deps:spa-to-spa]`,
`[shared:unresolved]`). Two consequences:

- It returns the *reachable* subgraph, so a Common_Package nothing selects is absent. The
  repository-wide statement 3 needs **every** Common_Package, reachable or not, so this function is
  not reusable for that case.
- Its direction rules must not be applied repository-wide: `workspace-build-order.ts` documents that
  it deliberately applies none, because `packages/integration-tests` legitimately depends on nearly
  everything.

What *is* reusable is the layer below: `topological-order.ts` exports `leastTopologicalOrder(nodes,
keyOf, dependenciesOf, compareNodes)` and `findCyclePath(nodes, keyOf, dependenciesOf)`, both free of
domain knowledge (its own module comment says so — no package, no category, no error prefix). Both
already serve two callers with different comparators. Statement 3 is a third caller over the
Common_Packages alone.

One comparator detail matters and is benign: `required-dependencies.ts` holds its ready queue in
`dirName` order (`byDirName`) while `workspace-build-order.ts` holds it in `packageDir` order. Within
`packages/common/`, every member's `packageDir` is `packages/common/${dirName}`, so the two
comparators induce the same order on Common_Packages and statement 3 can be stated in `packageDir`
terms (2.3, 3.3) without changing any existing result.

### F6 — Required_Dependencies is closed under the dependency relation, which is why 2.14 holds structurally rather than by luck

`reachableSubgraph`'s `visit()` recurses into every resolved dependency of every member it reaches,
including a Spa_Package's dependencies (only *phase 3*, `stagedSubset`, declines to expand a
Spa_Package). So `required` is dependency-closed: if a package is in it, everything it declares is
too.

That closure is what makes the divergence check of 2.14 pass by construction rather than by
coincidence. For a dependency-closed subset S of the nodes, the least-first Kahn order over S equals
the subsequence of the least-first Kahn order over the full node set: the readiness of an S-node
depends only on S-predecessors, so the two runs have the same ready S-sets at every step, and when
the full run emits an S-node it emitted the globally least ready node, which is therefore also the
least ready S-node. Statement 3 over "every Common_Package" and statement 3 over "the required
Common_Packages" therefore agree on the relative order of every pair the second contains. Without
closure this would be false: with commons `a` (declaring `c`) and `b` (declaring nothing), the full
order is `b, c, a` while the order over `{a, b}` alone is `a, b`.

### F7 — `tsc --build` will not repair a bad root order, and no path is protected by project references

Verified across the package `tsconfig.json` files: only `packages/overseer/tsconfig.json` declares
`references`, and only `[{ "path": "../contracts" }]`. There is no project-reference graph for the
solution builder to schedule from, so `tsc --build` builds roots in command-line order, and
`ts.createSolutionBuilderWithWatch(host, [...projectList], ...)` in `dev-supervisor.ts` inherits the
same property. The order the primitive produces is the order that runs.

### F8 — `scripts/start.js` is the only remaining `--workspaces` build, and `ci-wiring.test.ts` already forbids it in root scripts

`scripts/start.js` runs `runOrExit("npm", ["run", "build", "--workspaces"])`. The root manifest does
not: `build` and `pretest` are `node scripts/build.js` and `ci`'s leading segment is `npm run build`.
`packages/integration-tests/tests/ci-wiring.test.ts` already asserts that **no root script** contains
`npm run build --workspaces` — the assertion simply never ranged over `scripts/*.js`, which is where
the last occurrence lives. That is the gap 2.15 closes.

`scripts/common-startup.js`'s module comment states that generating the registry before the full
build "is sound only because the root `workspaces` array is in topological order", and
`packages/integration-tests/tests/dev-start-parity.test.ts` pins that wording:
`expect(/topological/i.test(commonStartupSrc)).toBe(true)` together with `false` for both entry
points. That rationale becomes false with 2.9, so the comment and the test both change.

### F9 — Only `tscRoots` is ordered by the composition; `selected`, `stage`, and the registry are separate lists

`buildPlanFrom` returns `selected` verbatim from `resolveSelected` and builds `stage` through
`stageOf(selected, staged)`, whose third group is `...selected.map((identifier) => scopedStage(...))`
— Selector order, independently of `tscRootsOf`. `generateRegistry` calls `resolveSelected` itself and
emits `import * as m${i} from "@microservices/${id}"` in that order. So changing the order in which
`tscRoots` lists the microservices touches none of the three. `assertImageTreeIntegrity` compares
`plan.stage`'s `scopedEntry` values as a **`Set`** against `listScopedEntries`, which is itself
`readdirSync(...).sort()`, so the Integrity_Assertion is order-insensitive in both directions (3.5).

### F10 — Ten suites assert facts this fix changes

Read from the test sources, so the tasks phase has the list up front:

| Suite | What changes |
| --- | --- |
| `build-tools/tests/workspace-build-order-real-tree.test.ts` | `EXPECTED_ORDER` becomes 2.21's ten entries; the `demo`-immediately-before-`microservice1` block is deleted as an assertion of the defect |
| `build-tools/tests/workspace-build-order.property.test.ts` | its oracle *is* the lexicographically-least topological order over declared dependencies; that is no longer the derivation. Rewritten against a Build_Sequence oracle; the determinism block and the cycle block survive, retargeted |
| `build-tools/tests/ordered-build.property.test.ts` | the effects claims survive; the R12.9 assertion that a Spa build sits "within the same single pass, with no phase boundary" is now false and inverts to "after every Tsc_Project invocation" |
| `build-tools/tests/build-plan.property.test.ts` | `referenceTscRoots` restated in Build_Sequence terms; the `buildPosition !== "excluded"` oracle rewritten to name `BUILD_TOOLS` and `INTEGRATION_TESTS` |
| `build-tools/tests/framework.test.ts` | drops the four `buildPosition` field pins |
| `build-tools/tests/required-dependencies.property.test.ts` | drops `expect(CONTRACTS.buildPosition).toBe("first")` |
| `build-tools/tests/dev-project-list.property.test.ts` | most assertions survive (contracts first, Overseer last, no Spa, no build-tools/integration-tests). **One block breaks by design:** "matches resolveSelected for whitespace-padded and duplicated identifiers" asserts the Project_List's microservice members equal `resolveSelected`'s output *element for element including duplicates*, which D1 changes. It must be re-scoped to the `plan.selected` list, where Selector order and duplicates do survive (_Property 12_). Its header comment's `buildPosition` explanation is also stale |
| `build-tools/tests/spa-build-sequencing.property.test.ts` | survives unchanged — it already asserts `tsc --build` first, bundlers after |
| `integration-tests/tests/ci-wiring.test.ts` | the "no `npm run build --workspaces`" assertion extends from root scripts to `scripts/*.js` |
| `integration-tests/tests/dev-start-parity.test.ts` | the three `/topological/i` assertions retarget onto the corrected rationale (F8) |

### F11 — The two mechanisms break unconstrained ties differently, which falsified the general preservation form

Read off the two order-producing mechanisms, and the reason bugfix.md's Preservation Checking property
was corrected before this design was accepted.

The Pre_Fix_Baseline repository-wide order is the lexicographically least topological order over
declared dependencies (`workspace-build-order.ts`, `leastTopologicalOrder`); the post-fix order is the
Build_Sequence. Both break unconstrained ties deterministically, and they break them **differently**,
so any layout holding an unconstrained pair the two rank oppositely comes out different — while
carrying no Ordering_Violation at all, which puts it outside the Bug_Condition. Two such layouts, one
per mechanism:

- The Overseer declaring `@microservices/demo` is a legal `overseer → spa` edge. Pre-fix the order is
  `packages/spa/demo` then `packages/overseer`, the topological sort honouring the declared edge;
  post-fix the Overseer is statement 5 and the Spa_Package statement 7.
- A Common_Package declaring no scoped specifier at all. Pre-fix it is ready from the first step and
  `packages/common/…` sorts before `packages/contracts` (`com` < `con`), so it is emitted **first**.
  Post-fix `contracts` is statement 1.

Neither difference is an Ordering_Violation — a Spa_Package is not a Compile_Time_Prerequisite (2.6),
and a specifier-free Common_Package has no prerequisite to follow — so both inputs lie outside the
Bug_Condition, and both differences are the fix working exactly as specified: 2.4 requires the
Spa_Package to move, and 2.1's statement 1 requires `contracts` to lead. The general form —
`orderProducedBy(X) = orderProducedBy'(X)` for every input outside the Bug_Condition, including every
pair the ordering rules leave unconstrained — is therefore unsatisfiable by any fix that changes the
ordering *mechanism* rather than adding edges to the old one. That form predated the choice of fix
model, and this design falsified it.

**Where that leaves the two documents.** bugfix.md's Preservation Checking property now states
preservation over the **prerequisite-forced pairs** of the produced order, and 3.3's `packageDir`
tiebreak now governs pairs within one statement only, naming the specifier-free Common_Package as the
consequence. Both match what this design asserts, so no gap between design and requirements remains.
What the design asserts, and what the unchanged-behavior clauses ask for: the prerequisite-forced pairs
(_Property 2_), the two shipped Selectors' Tsc_Root_Order element for element (3.4, _Property 11_),
Selector order wherever it is observable (3.5, 3.13, 3.17, _Property 12_), and the two pinned real-tree
orders (2.21, 3.18). Every clause of 3.1 through 3.18 is covered by one of those.

---

## Bug Details

### Bug Condition

The input is a pair of a repository state and an Order_Producing_Path; the output is the order that
path produces. The predicate is 1:1 with `isBugCondition` in bugfix.md and is restated here only to
fix the two details the design has to implement — how `isCompileTimePrerequisite` is computed, and
that the Spa_Package exclusion is part of the relation rather than a filter applied afterwards.

```
FUNCTION isBugCondition(X)
  INPUT: X of type (RepositoryState, Order_Producing_Path)
  OUTPUT: boolean

  order ← orderProducedBy(X.path, X.state)

  RETURN EXISTS a, b IN order WHERE
      isCompileTimePrerequisite(b, a)
      AND positionOf(a, order) < positionOf(b, order)
END FUNCTION

FUNCTION isCompileTimePrerequisite(b, a)
  INPUT: b, a workspace packages
  OUTPUT: boolean

  IF categoryOf(b) = spa THEN RETURN false          // 2.6, unconditional
  IF b IN resolvedSpecifiersOf(a) THEN RETURN true  // any declared @microservices edge
  IF a = Overseer AND b IN selectedMicroservices THEN RETURN true
  RETURN false
END FUNCTION
```

The second clause of `isCompileTimePrerequisite` is the edge no manifest may declare: the
Dependency_Resolver rejects any declarer naming a Microservice_Package with `[deps:peer]` and grants
the Overseer no exemption, and the set of microservices is Selector-dependent anyway.

The divergence predicate is `isDivergenceBugCondition` as bugfix.md states it, over the pair
(Workspace_Build_Order, Tsc_Root_Order) for one unchanged state and one Selector.

### Examples

- **The live violation.** Committed tree at `35156ce`, path = Ordered_Build. `packages/overseer` at
  position 7, `packages/microservices/microservice1` at 9, and `microservice1` is a
  Compile_Time_Prerequisite of the Overseer through the generated registry. Expected: microservice1
  before the Overseer. Actual: after it.
- **What the violation costs.** With a real registry naming `microservice1` and that package's
  `dist/` absent, `tsc` in `packages/overseer` fails with
  `src/generated/microservice-registry.ts(3,21): error TS2307: Cannot find module
  '@microservices/microservice1' or its corresponding type declarations.`, and the ordered build stops
  there without ever reaching microservice1, so a re-run fails identically.
- **The non-violation that must not be reported.** `microservice1` declares `@microservices/demo`, a
  Spa_Package. On the image path `microservice1` compiles as a `tsc --build` root while `demo`'s
  bundle does not exist yet. Expected: no diagnostic — `demo` is not a Compile_Time_Prerequisite
  (2.6). Actual, if the exclusion were omitted: a false Ordering_Violation on every build.
- **The silent case the order cannot see.** A Microservice_Package declaring a peer. Both sit in
  statement 4, whose within-statement order is unconstrained, so whether the declared edge happens to
  point backwards depends on the two directory names. Expected: reported whichever way they sort.
- **The divergence.** `MICROSERVICES=microservice3,microservice1`. Pre-fix, the Tsc_Root_Order holds
  microservice3 before microservice1 while the Workspace_Build_Order holds microservice1 before
  microservice3 — a disagreement over a pair both contain, which 2.14 fails the build on and which
  harms nothing. This is the requirement conflict D1 resolves.

---

## Expected Behavior

### Preservation Requirements

**Unchanged behaviours.** These are the obligations the fix is designed against, each with its
mechanism named; the concrete evidence per clause is in "Preservation evidence" below.

- The Tsc_Root_Order for the Selector `*` and for `microservice1,microservice2`, entry for entry
  (3.4) — preserved because the Build_Sequence statement order reproduces `tscRootsOf`'s
  composition, and because for both of those Selectors directory order and Selector order coincide
  (F2).
- The Image_Assembler's staged path set and its Integrity_Assertion (3.5) — untouched: `stageOf` and
  `assertImageTreeIntegrity` are not on the ordering path, and the latter compares sets (F9).
- The Selector-scoped root exclusions, the per-Spa `npm run build`, and the bundler phase entered
  only after a zero-status `tsc --build` (3.15) — the first becomes an explicit membership decision,
  the other two are `executeBuildPlan`, unmodified (F3).
- The pre-`scaffold-demo-samples` expected order (3.18) — reproduced by the statement order with no
  special case.
- Every Dev_Server restart decision, diagnostic, and failure message (3.6); the `npm start`
  bootstrap, registry regeneration, abort-before-start, and one-shot exit status (3.7); building
  every workspace rather than a Selector-scoped subset, with no second Selector parser under
  `scripts/` (3.8); `dotenvx` env injection and the inline `MICROSERVICES` override (3.9); the
  Repo_Invariant_Checker's three existing checks and their message shapes (3.10); the `workspaces`
  globs (3.11); `[deps:peer]` with no Overseer exemption (3.12); Selector resolution and its two
  errors (3.13); `[shared:unresolved]`, `[build-order:cycle]`, `[build-order:failed]` wording and the
  one-invocation, stop-at-first-failure execution (3.14); `npm ci && npm run ci` exiting zero on a
  clean clone with the empty registry template (3.16); runtime mounting and toggles (3.17).

**Scope.** For every input whose pre-fix order carries no Ordering_Violation, the pairs whose order is
forced by a Compile_Time_Prerequisite come out unchanged, as do the enumerated real-tree and
per-Selector oracles above. That is what the bugfix document's Preservation Checking property states,
and the design meets it. A pair the prerequisite relation leaves unconstrained is unconstrained in
*both* mechanisms and the two break such ties differently, so no fix replacing the mechanism could hold
those pairs fixed; F11 carries the two counterexamples and the argument.

---

## Hypothesized Root Cause

This bugfix reuses the completed root-cause evaluation recorded as D11 in
`.kiro/specs/scaffold-demo-samples/design.md`; the causes below were re-verified against the code in
F1 through F9 rather than re-derived. There is no exploratory phase to run: the defect is measured,
not suspected.

1. **A necessarily incomplete input, not a sorting bug.** `workspaceBuildOrder()` computes the
   lexicographically least topological order over its input faithfully. The decisive edge — the
   Overseer's compile-time dependency on the Selected_Microservices — cannot be in that input:
   `peerDependencyError` rejects any manifest declaring it, and the set of microservices is
   Selector-dependent. Confirmed at `required-dependencies.ts`'s `peerDependencyError` and at
   `rootDirectories()`, which makes the Selected_Microservices and the Overseer *sibling roots*, so
   the relation is in no graph the Build_System builds (F5).
2. **Position knowledge exists but is not shared.** `framework.ts` declares
   `CONTRACTS.buildPosition === "first"` and `OVERSEER.buildPosition === "last"`, and exactly one
   function reads either (F4). The repository-wide derivation reads neither. One mechanism is correct
   because it knows the positions; another is incorrect because the same knowledge is not in scope.
3. **A code-point tiebreak has been standing in for the missing edge.** `packages/microservices/…`
   precedes `packages/overseer` because `m` < `o`. Adding one legal edge — `microservice1` →
   `@microservices/demo` at `packages/spa/demo`, where `s` > `o` — pulls microservice1 behind the
   Overseer. Nothing downstream repairs it (F7).
4. **No check asserts either claim.** Neither "a produced order has no Ordering_Violation" nor "two
   paths agree" is checked anywhere, and `checkWorkspaceCoverage()` deliberately ignores entry order,
   its comment reading "entry order, which carries no meaning". So the defect could return silently
   after being fixed — which is why 2.13 through 2.15 are part of the fix rather than of its
   verification.

---

## Components and Interfaces

### 1. `build-sequence.ts` — the one ordering primitive (2.1, 2.2, 2.3, 2.5, 2.7)

A new module at `packages/build-tools/src/build-sequence.ts`. It owns the statement order and the
Verification_Pass, imports `framework.ts` for the four singleton records and
`topological-order.ts` for the graph machinery, and holds no filesystem access — which is what lets
every property below run over generated layouts.

```ts
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
 * The Build_Sequence: the fixed statement order of 2.1 applied to one membership.
 * Consults no per-package position metadata (2.2) — statements 1, 2, 5 and 6 name
 * their framework members through framework.ts's exported records.
 *
 * @throws `[build-order:cycle]` when statement 3's calculated order cannot be
 *   computed, with the existing wording (3.14).
 */
export function buildSequence(
  membership: SequenceMembership,
): readonly SequencedPackage[];
```

The body is the seven statements, literally:

1. `CONTRACTS`;
2. `BUILD_TOOLS` when `membership.buildTools`;
3. `commonOrder(membership.common)` — `findCyclePath` then `leastTopologicalOrder`, keyed by declared
   name, edges being each member's Dependency_Specifiers that resolve to another member of
   `membership.common`, ready queue held in `compareCodePoints` order of `packageDir`. `config` before
   `extended-config` follows from the one declared edge, not from a rule;
4. `membership.microservices`, sorted by `compareCodePoints` on `packageDir` (2.3, and D1);
5. `OVERSEER`;
6. `INTEGRATION_TESTS` when `membership.testOnly`;
7. `membership.spa`, sorted by `compareCodePoints` on `packageDir`.

**What is reused and what is new.** Reused unchanged: `leastTopologicalOrder`, `findCyclePath`,
`compareCodePoints` from `topological-order.ts`, and the `[build-order:cycle]` message builder, moved
from `workspace-build-order.ts` with its wording byte-identical (3.14). New: the statement scaffold
itself, `commonOrder`'s edge predicate (restricted to Common_Package targets, where
`resolveDependencySets` would follow every category and apply direction rules it must not apply
repository-wide — F5), and the whole Verification_Pass. `resolveDependencySets` is **not** reused for
statement 3: it walks out from roots and so cannot enumerate all Common_Packages, and its direction
rules are wrong for a repository-wide derivation. It stays exactly as it is for what it does own —
computing the two dependency sets on the image path — and the image path's statement 3 membership is
its `required`, filtered to `category === "common"`.

`[shared:unresolved]` moves into the Verification_Pass (§3) rather than into `commonOrder`: a dangling
specifier can be declared by any package in any statement, so resolving specifiers once, in the pass
that already resolves them all, keeps the message raised exactly once per offending consumer with its
existing wording (3.14).

### 2. The two call sites, differing only in membership (2.5, 2.7, 2.11)

**Repository-wide** — `workspace-build-order.ts`. `workspaceNodesFrom` stays as it is (it is the
only place a Framework_Singleton's own specifiers are read, and the Verification_Pass needs them).
`workspaceBuildOrder(nodes)` keeps its exported signature and its return type — `runOrderedBuild` and
three test suites consume `WorkspaceNode[]` — and its body becomes: partition `nodes` by tier and
category, call `buildSequence` with everything, run the Verification_Pass, map back to the input
nodes.

```ts
buildSequence({
  common:         nodes for tier "common",
  microservices:  dirNames of nodes for tier "microservice",
  spa:            nodes for tier "spa",
  buildTools:     true,
  testOnly:       true,
})
```

**Selector-scoped** — `build-plan.ts`. `tscRootsOf` is deleted, along with its `positioned()` helper.
`buildPlanFrom` calls:

```ts
buildSequence({
  common:         required.filter((pkg) => pkg.category === "common"),
  microservices:  selected,     // membership; the primitive orders them (D1)
  spa:            [],           // a Spa_Package is never a tsc --build root
  buildTools:     false,        // 3.15
  testOnly:       false,        // 3.15
})
```

and `tscRoots` is that sequence's `packageDir` list. Two things to note. First, `spa: []` here is not
the primitive omitting statement 7 — it is the *image path* handing statement 7 no members, because
`plan.spaBuilds` is where its Spa_Packages live and `executeBuildPlan` already runs them after the
`tsc --build` (F3). Statement 7's placement and `spaBuilds`' phase are **two different facts that
agree**, not one claim expressed twice. Statement 7 governs the whole-repository build order, where
each package runs its own `build` script in sequence, so sequence position is the only lever there is.
`executeBuildPlan`'s line order is forced independently, by two things unrelated to statement 7:
`tsc --build` is a **batch** invocation over all roots at once, and a Spa_Package's bundler may read a
Common_Package's compiled `dist/` while no Tsc_Project ever reads a Spa_Package's output — the
reasoning that function's own doc comment already records (a Spa_Package is a sink in the import graph,
R6.12/R6.13). That the two agree is what 2.4 and 2.5 ask for; D7 records why the agreement is guarded
rather than collapsed into a single expression. Second, `buildTools: false` / `testOnly: false` is
where 3.15's exclusion becomes a stated decision instead of the emergent consequence F4 describes.

The Project_List needs no change at all: `projectListFrom` is `buildPlanFrom(...).tscRoots`, so it
inherits the primitive through the plan and 2.11 holds because it is literally the same array
(`dev-supervisor.ts`'s comment already makes this its design point).

### 3. The Verification_Pass (2.13, 2.14, 2.6, 3.14)

One exported function, called from both derivations, reporting every finding of one run before it
fails:

```ts
/** One Compile_Time_Prerequisite edge, over repo-relative package directories. */
export interface PrerequisiteEdge {
  readonly prerequisite: string;
  readonly dependent: string;
}

/**
 * The Prerequisite_Graph for one produced order: every declared
 * `@microservices`-scoped specifier that resolves to a NON-Spa package, plus the
 * Overseer → Selected_Microservice edges the Microservice_Registry creates (2.6).
 *
 * @throws `[shared:unresolved]` with the existing wording for a scoped specifier
 *   matching no declared package name (3.14).
 */
export function prerequisiteEdges(
  nodes: readonly WorkspaceNode[],
  selectedMicroservices: readonly string[],
): readonly PrerequisiteEdge[];

/**
 * The Verification_Pass. Returns every violation message, empty when the order is
 * sound; `assertBuildOrder` is the throwing wrapper the derivations call.
 *
 * @param order the produced order, as `buildSequence` returned it.
 * @param edges the Prerequisite_Graph.
 * @param counterpart the other path's order for the same state and Selector, for
 *   the divergence check of 2.14; omitted when only one order exists.
 */
export function verifyBuildOrder(
  order: readonly SequencedPackage[],
  edges: readonly PrerequisiteEdge[],
  counterpart?: readonly SequencedPackage[],
): readonly string[];
```

Four checks, in this order, all four always run so one invocation reports everything:

- **Cycle.** `findCyclePath` over the Prerequisite_Graph. A cycle means no valid order exists for a
  reason no statement structure can fix, and it is reported with the existing `[build-order:cycle]`
  wording, directories not declared names, exactly as `workspace-build-order.ts`'s `cycleError` does
  today. This is 3.14's "where no valid order exists for any other reason" clause; the
  Common_Package-only case is caught earlier, inside statement 3, with the same message builder.
- **Positional.** For each edge, the prerequisite must appear at a strictly earlier position than the
  dependent. This is the Ordering_Violation of the Bug_Condition, verbatim.
- **Structural.** An edge whose two endpoints sit in the *same* Unordered_Statement is reported
  whichever way the two happen to sort, because within such a statement no order is guaranteed. This
  is the check 2.13 names explicitly: a Microservice_Package declaring a peer puts both endpoints in
  statement 4, so the positional check alone would pass on the half of the directory-name pairs that
  happen to sort favourably and the defect would be reported only sometimes. Statement 3 is an
  Ordered_Statement and is deliberately not covered by this check — an intra-statement edge there is
  exactly what its calculated order exists to honour.
- **Divergence.** For every pair of packages both orders contain, the two must agree on relative
  order (2.14, 2.11). Reported as `[build-order:divergence]`.

The positional, structural, and divergence findings share one new tag family
(`[build-order:prerequisite]` with two clause shapes, and `[build-order:divergence]`); the two
pre-existing tags keep their exact wording. No new tag replaces or narrows an existing one.

**Where it runs, and what it reads.** Both derivations, in-process, on every invocation, before any
`build` script is spawned:

- `workspaceBuildOrder()` calls `assertBuildOrder(order, prerequisiteEdges(nodes, allIdentifiers))`
  before returning, so `runOrderedBuildCli` cannot run a build over an unsound order and
  `[build-order:failed]` cannot be reached for an ordering reason.
- `buildPlanFrom()` derives the repository-wide order from the same `discovery` and
  `readDependencies` it already holds — `workspaceNodesFrom(discovery, readDependencies)` needs
  nothing more — and calls `assertBuildOrder(tscSequence, edges, workspaceOrder)`. The divergence
  check therefore runs on the image path *and* the dev path, over the real Selector, with no extra
  I/O beyond three manifest reads (the Overseer's is already read) and no spawned process.

That is one implementation, one diagnostic family, and one call per produced order — 2.13's "no
second or third mechanism for the same claim".

**Behind `check:invariants` as well? No — with one exception.** The pass belongs where the order is
produced, not in a separate checker, for two reasons. It needs the produced order and the Selector,
neither of which the Repo_Invariant_Checker has; and putting it in the checker would make it a
*second* mechanism asserting what the derivations already assert, which 2.13 forbids. Its coverage
over generated layouts (2.13's "not over the committed tree alone") is the build-tools property suite
of Properties 1, 3, and 8. The one thing that *does* go into the Repo_Invariant_Checker is 2.15's
distinct claim — that no repository script derives a build order from the Declared_Array_Sequence —
because that is a static fact about files, which is exactly what the checker already reads, and it
needs no order at all. It becomes a fourth check there, `[workspaces:order-source]`, scanning the
Root_Manifest's `scripts` values and every `scripts/*.js` source for a `--workspaces` build
invocation. It generalises the assertion `ci-wiring.test.ts` already makes over root scripts (F8) and
brings `scripts/start.js` into its range.

### 4. `framework.ts` — `buildPosition` retires (2.2, 1.11)

`buildPosition` and `FrameworkBuildPosition` are **removed**, and with them `singleton()`'s third
parameter. Reasons, all from F4: the field's only production reader is `tscRootsOf`'s `positioned()`,
which this fix deletes; its `"excluded"` value decides nothing today, so removing it changes no
behaviour; and 2.2 is only checkable by inspection if there is no per-package position metadata left
to consult. Membership decisions do not need it either — they are made at the two call sites, by
name, in §2.

Consequences, all mechanical: `positioned()` disappears with `tscRootsOf`; the four records shorten
to `singleton(dirName, staging)`; `framework.test.ts` drops four field pins;
`build-plan.property.test.ts`'s `buildPosition !== "excluded"` oracle becomes an explicit
`BUILD_TOOLS`/`INTEGRATION_TESTS` exclusion; `required-dependencies.property.test.ts` drops one
assertion. `FrameworkStaging` and `staging` stay untouched — staging is a different axis, still read
by `build-plan.ts`'s `ALWAYS_STAGED_SCOPED` and `ALWAYS_STAGED_AT_PACKAGE_DIR` filters and by
`ALWAYS_STAGED_SCOPED_ENTRIES` in the Integrity_Assertion (3.5).

The alternative — keeping the field declared but unread — was rejected: an unread field describing
build order is precisely the "position knowledge in one place, not read in another" shape that root
cause 2 identifies.

### 5. `scripts/start.js` — the last Declared_Array_Sequence consumer (2.9, 2.12, 3.7, 3.8)

One statement changes. `runOrExit("npm", ["run", "build", "--workspaces"])` becomes a spawn of the
compiled bin, the same one `scripts/build.js` spawns:

```js
const ordered = spawnSync(
  process.execPath,
  ["packages/build-tools/dist/bin/build-workspaces.js"],
  { stdio: "inherit" },
);
```

with a non-zero status keeping the existing `[start] … refusing to start the Overseer` framing and
`process.exit`. What is preserved and how:

- **3.7** — `runCommonStartup({ tag: "start" })` still runs first and unchanged, so the
  Bootstrap_Build and registry regeneration still happen in that order, a selector error or failed
  step still aborts before the Overseer, and the trailing one-shot `spawnSync` of
  `packages/overseer/dist/index.js` with `process.exit(server.status)` is untouched. The bin exists by
  the time it is spawned because `runCommonStartup`'s first step is the Bootstrap_Build that compiles
  `build-tools` — the same guarantee `scripts/build.js` relies on, reached one call earlier.
- **3.8** — `build-workspaces` never consults the Selector (its module comment says so) and builds
  every workspace package, so the start path still builds everything and no Selector parser appears
  under `scripts/`.
- **3.9** — untouched: `dotenvx run --` wraps the npm script before Node starts.

`scripts/common-startup.js`'s module comment loses the sentence attributing soundness to the
topological `workspaces` array and gains the actual reason — the registry is generated before the
build so the Overseer compiles against a fresh one, and the build order comes from the Build_Sequence
(F8). `dev-start-parity.test.ts`'s three `/topological/i` assertions retarget onto the replacement
wording.

**2.12 is a task-ordering obligation, not a design one.** Nothing in this design can express "do not
land §5 before §1": the two touch different files and neither imports the other. It is recorded here
for the tasks phase as a hard constraint — the task implementing §1 and §3 must precede the task
implementing §5, because `npm start` is today saved only by the hand-topological array, and removing
that mechanism while the order still comes from the incomplete derivation puts every fresh clone's
`npm start` on the TS2307 of 1.3. A task sequence placing §5 first is invalid.

---

## Data Models

### The Build_Sequence over the committed tree at `35156ce` (2.21)

| # | Statement | `packageDir` |
| --- | --- | --- |
| 1 | 1 | `packages/contracts` |
| 2 | 2 | `packages/build-tools` |
| 3 | 3 | `packages/common/config` |
| 4 | 3 | `packages/common/extended-config` |
| 5 | 4 | `packages/microservices/microservice1` |
| 6 | 4 | `packages/microservices/microservice2` |
| 7 | 4 | `packages/microservices/microservice3` |
| 8 | 5 | `packages/overseer` |
| 9 | 6 | `packages/integration-tests` |
| 10 | 7 | `packages/spa/demo` |

Positions 3 and 4 are statement 3's calculated order: `extended-config` declares
`@microservices/config` as its only scoped specifier. Positions 5 to 7 are statement 4 in `packageDir`
code-point order. This replaces `EXPECTED_ORDER` in
`packages/build-tools/tests/workspace-build-order-real-tree.test.ts`, which currently encodes
`packages/overseer` at 7, `packages/spa/demo` at 8, and `packages/microservices/microservice1` at 9.

### The Tsc_Root_Order over the same tree, per shipped Selector (3.4)

| Selector | `tscRoots`, in order |
| --- | --- |
| `*` | `contracts`, `common/config`, `common/extended-config`, `microservices/microservice1`, `microservices/microservice2`, `microservices/microservice3`, `overseer` |
| `microservice1,microservice2` | `contracts`, `common/config`, `microservices/microservice1`, `microservices/microservice2`, `overseer` |

Both are identical to what `tscRootsOf` produces at the Pre_Fix_Baseline. For `*`, because
`resolveSelected`'s all-branch already returns directory order (F2). For
`microservice1,microservice2`, because Selector order and directory order coincide. `common/config`
alone appears for the second Selector because `extended-config` is reachable only through
`microservice3`; `spa/demo` appears in neither, being a Bundler_Project.

### Statement membership per path (2.5)

| Statement | Repository-wide | Image / dev (Selector-scoped) |
| --- | --- | --- |
| 1 `contracts` | yes | yes |
| 2 `build-tools` | yes | no (3.15) |
| 3 Common_Packages | every discovered one | the `required` members with `category === "common"` |
| 4 Microservice_Packages | every discovered one | the Selected_Microservices |
| 5 `overseer` | yes | yes |
| 6 `integration-tests` | yes | no (3.15) |
| 7 Spa_Packages | every discovered one | none as roots; `plan.spaBuilds` as the trailing bundler phase |

The statement order is the same column to column; only the cells differ. That is 2.5 in full, and the
row-3 pair is what F6's closure argument makes safe for 2.14.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a
system — essentially, a formal statement about what the system should do. Properties serve as the
bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Twelve properties. Each is implemented as a **single** `fast-check` property test executed by
`vitest --run`, in a `*.property.test.ts` file under `packages/build-tools/tests/`, with `numRuns` of
at least 100 (200 where the suite it joins already uses 200) and a header comment tagged
`Feature: unified-build-order, Property N: <property text>` — the convention every existing property
suite in this repository follows. Oracles are written from the requirements, never by calling the
function under test.

The generated world is shared by most of them and is the in-memory layout model
`build-plan.property.test.ts` and `dev-project-list.property.test.ts` already use, widened in three
ways: every Consumer_Category is generated (not only the library categories), the four
Framework_Singletons participate as nodes with their own specifiers, and a generator variant plants an
intra-statement edge on purpose (a Microservice_Package naming a peer) so the structural check has
something to catch. No filesystem is touched — the primitive and the Verification_Pass are pure over
an injected `Discovery` and `ReadDependencies`, which is what makes 2.13's "over generated repository
layouts, not the committed tree alone" mechanically true.

Two properties are deliberately conditional, and each says so in its own text: _Property 2_ is scoped
to prerequisite-forced pairs (F11), and _Property 11_ is scoped to Selectors listed in ascending
directory order (D1).

### Property 1: Bug Condition — no produced order contains an Ordering_Violation

*For any* generated repository layout and *any* Selector over it, both orders the Build_Sequence
produces — the Workspace_Build_Order for the whole-repository membership and the Tsc_Root_Order for
the Selector-scoped membership — contain no pair `(a, b)` such that `b` is a Compile_Time_Prerequisite
of `a` and `a` appears at an earlier position than `b`, where the prerequisite relation is computed by
an oracle written from the Bug_Condition (declared scoped specifiers resolving to a non-Spa package,
plus Overseer → Selected_Microservice) and never from `prerequisiteEdges`. In particular every
Selected_Microservice precedes `packages/overseer` in both orders (2.8), and every declared
`common → common` edge is honoured within statement 3.

**Validates: Requirements 2.1, 2.3, 2.4, 2.8, 2.13**

### Property 2: Preservation — every prerequisite-forced pair keeps its Pre_Fix_Baseline relative order

*For any* generated layout whose Pre_Fix_Baseline Workspace_Build_Order carries no Ordering_Violation,
*every* pair of packages whose relative order in that baseline order is forced by a
Compile_Time_Prerequisite edge appears in the same relative order in the Build_Sequence order. The
baseline oracle is the retired derivation restated independently — Kahn's algorithm with a ready queue
in `compareCodePoints` order of `packageDir` over all declared scoped specifiers, which is what
`workspace-build-order.property.test.ts`'s `referenceOrder` already is. Pairs the prerequisite relation
leaves unconstrained are excluded from the claim, which is the scope the bugfix document's Preservation
Checking property itself states; this property implements that property directly, and F11 records why an
unconstrained pair cannot be claimed by any fix that replaces the ordering mechanism.

**Validates: Requirements 3.1, 3.2, 3.3, 3.18**

### Property 3: The two paths agree on the relative order of every shared pair

*For any* generated layout and *any* Selector, for every pair of packages appearing in both the
Workspace_Build_Order and the Tsc_Root_Order, the two orders place them in the same relative order,
and `verifyBuildOrder` returns no `[build-order:divergence]` message. The Tsc_Root_Order legitimately
omits `packages/build-tools`, `packages/integration-tests`, every unselected Microservice_Package, and
every Spa_Package, so the claim quantifies over the intersection only.

**Validates: Requirements 2.11, 2.14**

### Property 4: The two paths differ only in membership, never in statement order

*For any* generated layout and *any* Selector, mapping each entry of both produced orders to the
statement number that emitted it yields two non-decreasing sequences over the same statement
numbering, and the Tsc_Root_Order equals the Workspace_Build_Order filtered to the Selector-scoped
membership. Equivalently: replacing the whole-repository membership with the Selector-scoped
membership, and changing nothing else, reproduces the Tsc_Root_Order exactly.

**Validates: Requirements 2.5, 2.7**

### Property 5: Determinism, and independence of presentation order

*For any* generated layout, *any* Selector, and *any* two independent permutations of the layout's
package list, all derivations of both orders are identical element for element: repeated calls agree
with each other, and both permutations agree with the unpermuted derivation. No metadata beyond
category, directory, name, and declared specifiers is consulted, which is asserted by deriving twice
over layouts differing only in fields the primitive must not read.

**Validates: Requirements 2.2, 2.3, 3.3**

### Property 6: Every Spa_Package follows every Tsc_Project, on both paths

*For any* generated layout and *any* Selector, no Tsc_Project appears at a later position than any
Spa_Package in the Workspace_Build_Order, no Spa_Package appears in the Tsc_Root_Order at all, and the
recorded invocation sequence of `executeBuildPlan` places every `npm run build` bundler invocation
strictly after the single `npx tsc --build`. The last clause is the seam
`spa-build-sequencing.property.test.ts` already drives; the first is what statement 7 adds.

**Validates: Requirements 2.4, 2.5, 3.15**

### Property 7: A Spa_Package is never a Compile_Time_Prerequisite

*For any* generated layout containing at least one `microservice → spa` or `overseer → spa` edge,
`prerequisiteEdges` returns no edge whose prerequisite is a Spa_Package, `verifyBuildOrder` reports no
violation for such an edge whichever order the two endpoints appear in, and that Spa_Package is
nonetheless present in the Required_Dependencies, the stage set where its category justifies it, and
`plan.spaBuilds`. The declared edge remains a staging and resolution declaration with no ordering
force.

**Validates: Requirements 2.6, 3.15**

### Property 8: The Verification_Pass verdict equals an independent violation oracle, and an intra-statement prerequisite always fails

*For any* generated layout, *any* Selector, and *any* injected defect drawn from {no defect, a
Microservice_Package declaring a peer, a Common_Package declaring a Microservice_Package, a
Common_Package declaring the Overseer, a prerequisite cycle of length 1 to k},
`verifyBuildOrder` returns a non-empty message list exactly when the oracle finds a violation, names
every offending package directory, and returns nothing for the no-defect case. The peer case fails
**for both orderings of the two directory names**, which is the clause distinguishing the structural
check from the positional one: statement 4 is unordered, so a defect that the position comparison
happens to miss must still be reported.

**Validates: Requirements 2.13**

### Property 9: A produced order over a violation-free layout invokes each package's `build` once, in order, stopping at the first failure

*For any* generated layout and *any* chosen failing package and non-zero status, `runOrderedBuild`
over the Build_Sequence order invokes `npm run build --workspace <name>` exactly once per package up
to and including the failing one, in the produced order, invokes nothing after it, and throws
`[build-order:failed]` naming that package's directory and the observed status with the existing
wording. Driven through the injected `CommandRunner`, so nothing is spawned.

**Validates: Requirements 3.14**

### Property 10: The four preserved diagnostics keep their wording and their participant sets

*For any* generated layout carrying a dangling `@microservices`-scoped specifier, a cycle among
Common_Packages, or a cycle elsewhere in the Prerequisite_Graph, the failure carries
`[shared:unresolved]` or `[build-order:cycle]` with its existing message shape, names every offending
specifier or every cycle participant and **only** the participants (as package directories), computes
no order, and therefore invokes no `build` script. A Common_Package cycle is reported by statement 3
and any other cycle by the Verification_Pass; both use the one message builder, so the two are
indistinguishable in output.

**Validates: Requirements 3.14**

### Property 11: The Tsc_Root_Order is unchanged from the Pre_Fix_Baseline for every directory-ordered Selector

*For any* generated layout and *any* Selector whose identifier list is in ascending directory order —
which includes every spelling of the all-Selector (unset, blank, `*`, padded) and therefore both
shipped Container configurations — the new `tscRoots` equals the Pre_Fix_Baseline `tscRootsOf`
composition element for element, the oracle being that composition restated independently:
`contracts`, the required Common_Packages in dependency order, the Selected_Microservices, the
Overseer. For a Selector *not* in ascending directory order the two differ only by a permutation
within the Selected_Microservices block, with both blocks holding the same identifiers — the residual
change D1 records.

**Validates: Requirements 3.4**

### Property 12: Selector order survives everywhere it is observable

*For any* generated layout and *any* Selector, `plan.selected` equals `resolveSelected(selector,
discoveredIdentifiers)` element for element (duplicates and Selector order preserved), the
`selected-microservice` entries of `plan.stage` appear in that same order, and the generated
Microservice_Registry's import and entry order is that same list. Only `tscRoots` reorders.

**Validates: Requirements 3.5, 3.13, 3.17**

---

## Fix Implementation

### Changes required

**New file: `packages/build-tools/src/build-sequence.ts`**

The primitive and the Verification_Pass of Components §1 and §3. Exports `SequenceMembership`,
`SequencedPackage`, `buildSequence`, `PrerequisiteEdge`, `prerequisiteEdges`, `verifyBuildOrder`, and
the throwing wrapper `assertBuildOrder`. Imports `CONTRACTS`, `BUILD_TOOLS`, `OVERSEER`,
`INTEGRATION_TESTS`, `NAMESPACE_CONTAINER`, and `WORKSPACE_SCOPE` from `framework.ts`, and
`compareCodePoints`, `findCyclePath`, `leastTopologicalOrder` from `topological-order.ts`. No `node:fs`
import, no `process` read.

**`packages/build-tools/src/workspace-build-order.ts`**

1. `workspaceBuildOrder(nodes)` keeps its signature and return type; its body becomes partition →
   `buildSequence` → `assertBuildOrder` → map back to the input `WorkspaceNode` values by
   `packageDir`. `declaredNames` and `dependencyKeysOf` move to `build-sequence.ts` as the
   Prerequisite_Graph's resolver, taking `unresolvedSpecifierError`'s message builder with them
   byte-identically.
2. `cycleError` moves to `build-sequence.ts`, wording unchanged, and is called from statement 3 and
   from the pass.
3. `workspaceNodesFrom`, `runOrderedBuild`, `orderedBuildFailedError`, `CommandRunner`,
   `spawnRunner`, and `runOrderedBuildCli` are unchanged. The module comment's paragraph attributing
   the order to declared dependencies and stating that `contracts` first and `integration-tests` last
   are unhardcoded consequences is replaced: those two positions are now statements 1 and 6.

**`packages/build-tools/src/build-plan.ts`**

1. `tscRootsOf` and its `positioned()` helper are deleted.
2. `buildPlanFrom` derives `tscRoots` from `buildSequence` with the Selector-scoped membership of
   Components §2, and calls `assertBuildOrder` with the repository-wide order as `counterpart`.
3. `spaBuilds`, `stage`, `stageOf`, `ALWAYS_STAGED_SCOPED`, `ALWAYS_STAGED_AT_PACKAGE_DIR`,
   `SCOPE_DIR`, and the `BuildPlan` shape are unchanged. The doc comment on `tscRoots` gains the
   statement numbering; the comment asserting the two filters partition the BUILD set stays, since it
   still does.

**`packages/build-tools/src/framework.ts`**

`FrameworkBuildPosition`, the `buildPosition` field, and `singleton()`'s third parameter are removed;
the four records shorten accordingly. Nothing else in the module changes.

**`packages/build-tools/src/repo-invariants.ts`**

A fourth check, `checkBuildOrderSource(scripts, sources)`, pure over an injected map of script names
to values and an injected list of `(path, source)` pairs, reporting `[workspaces:order-source]` for
each script value or `scripts/*.js` source that invokes a build with `--workspaces`. Wired into
`collectViolations()` after the three existing checks, whose behaviour and message shapes are
untouched (3.10).

**`scripts/start.js`**

The one statement of Components §5, replacing `npm run build --workspaces` with a spawn of
`packages/build-tools/dist/bin/build-workspaces.js`. `runOrExit` becomes unused if nothing else calls
it and is removed with it.

**`scripts/common-startup.js`**

The module comment's topological-`workspaces` rationale is replaced (F8). No code change.

**Documentation (2.16 through 2.20)**

`.kiro/steering/tech.md`: build order comes from the Build_Sequence; the `workspaces` array declares
membership and remains globs because npm reads it statically before any repository code runs, and only
its *sequence* stops being load-bearing; `check:invariants` is described by its four actual checks;
`build`, `pretest`, and `ci` are described by the scripts they actually invoke.
`.kiro/specs/shared-packages/requirements.md` is marked superseded on the term Workspace_Build_Order,
pointing at the current definition. `README.md` and `.kiro/steering/structure.md`'s `spa` section
record that a Microservice_Package serving a Spa_Package must compile and start without that
Spa_Package's bundle present — the compile half licensing statement 7, the runtime half already
specified by `scaffold-demo-samples`.

**Independence from `scaffold-demo-samples` (2.22)**

Nothing above names `packages/spa/demo`, `packages/common/extended-config`, or any edge either
introduces. Statement 7 is empty when no Spa_Package exists and statement 3 has one member instead of
two; the primitive has no branch on either. The only artefact that encodes that feature's presence is
the real-tree oracle, which is data (Data Models above), and _Property 2_ plus the 3.18 example
together demonstrate the pre-feature state produces its own then-committed order with no special case.

---

## Testing Strategy

### Validation approach

There is no exploratory phase. The defect is measured — the position numbers of Data Models, the
TS2307 text of 1.3, the mechanism table of 1.7 — and its root cause is a completed evaluation (D11 of
the sibling spec, re-verified as F1 through F9). Writing a test to watch the bug fail first would
re-measure what 1.2 already states with the position numbers to prove it. What replaces it is the one
thing that measurement did *not* establish: that the Verification_Pass would have caught it. So the
first task after §1 lands is to run the pass over the **pre-fix** derivation on the committed tree and
observe it report `packages/microservices/microservice1` placed after `packages/overseer` — a
one-example confirmation that the check has teeth, discarded once the fix lands because Fix Checking
covers it thereafter.

### Fix Checking

**Goal.** For every input where the Bug_Condition holds, the fixed derivation produces an order free
of Ordering_Violations, and the compile of every package in that order succeeds.

```
FOR ALL X WHERE isBugCondition(X) DO
  order ← orderProducedBy'(X.path, X.state)
  ASSERT NOT hasOrderingViolation(order)
    AND compileOf(order) succeeds for every package in order
END FOR
```

Covered by _Properties 1, 3, 4, 6, 7 and 8_ over generated layouts, and by three concrete executions
for the `compileOf` half, which no property loop can carry:

- the real-tree oracle of Data Models, replacing `EXPECTED_ORDER` in
  `workspace-build-order-real-tree.test.ts` (2.21);
- a clean-tree ordered build — no `dist/`, no `*.tsbuildinfo`, a **real** registry naming all three
  microservices — exiting zero, which is the state 1.3 and 1.4 describe and the one the pre-fix order
  fails in. It runs inside a `pristineWorktree()` copy, per the hard prohibition on a test writing to
  the checked-out tree, and it is the single most valuable test in this fix;
- `npm start` on a pristine copy still reaching the Overseer boot marker after the §5 change, which
  `dev-start-parity.test.ts` already has the harness for.

### Preservation Checking

**Goal.** For every input where the Bug_Condition does not hold, every pair the
Compile_Time_Prerequisite relation forces keeps its relative order in the fixed derivation.

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  FOR ALL a, b IN orderProducedBy(X.path, X.state) WHERE isCompileTimePrerequisite(b, a) DO
    ASSERT positionOf(b, orderProducedBy'(X.path, X.state))
         < positionOf(a, orderProducedBy'(X.path, X.state))
  END FOR
END FOR
```

This is the bugfix document's Preservation Checking property as it now stands, and it is precisely what
the design asserts — a pair the relation leaves unconstrained is not claimed preserved, for the reason
F11 records. What is asserted: _Property 2_ (every prerequisite-forced pair), _Property 11_ (the
Tsc_Root_Order, element for element, for every directory-ordered Selector including both shipped ones),
_Property 12_ (Selector order everywhere it is observable), and the two pinned real-tree oracles — the
post-feature order (2.21) and the
pre-feature order (3.18), the latter as an example test over a `pristineWorktree()` copy with the
Demo_Spa and `extended-config` removed and `microservice1`'s specifier dropped.

For the first three, property-based testing is the right instrument, because the claim is over a domain
too large to enumerate and because the interesting cases — a Common_Package reachable only through a
Spa_Package, a Selector naming a subset that changes which commons are required — are ones a
hand-written example set reaches only by accident.

### Unit and example-based tests

- **`build-sequence.ts` statement scaffold** — one example per statement over a fixed membership:
  statement 2 present when `buildTools` is true and absent when false, ditto statement 6, and
  statement 3's `config`-before-`extended-config` on the real Common_Packages.
- **The two real-tree oracles** — Data Models' ten entries, and the two per-Selector `tscRoots` lists.
  Example tests, not properties: there is one committed repository and one correct order over it.
- **`[workspaces:order-source]`** — one example per shape: a root script with `--workspaces` in a
  build invocation, a `scripts/*.js` source with one, and the clean repository reporting nothing.
- **`framework.ts` after retirement** — a source-level assertion that no file under
  `packages/build-tools/src/` names `buildPosition`, which is 2.2's only mechanical check.
- **`scripts/start.js` wiring** — the ordered bin path appears in the source, `npm run build
  --workspaces` does not, `runCommonStartup` is still called before it, and the Overseer spawn is
  still last. Source-level and cheap, in the style `dev-start-parity.test.ts` already uses.
- **Rewrites and deletions** — the ten suites of F10, in that table's terms. Three are worth calling
  out. Two currently assert the defect and their assertions are deleted: the
  `order[demoIdx + 1] === "packages/microservices/microservice1"` block in the real-tree test, and the
  R12.9 "within the same single pass, with no phase boundary" clause in
  `ordered-build.property.test.ts`. The third is the only *correct* assertion this fix invalidates —
  `dev-project-list.property.test.ts`'s duplicate-bearing Selector block, which asserts a claim about
  the Project_List that D1 relocates to `plan.selected`. It is re-scoped, not dropped: the Selector-order
  claim it protects still needs a test, and _Property 12_ is where it now lives.

### Integration tests

- **Clean-tree ordered build with a real registry** — the Fix Checking execution above, in a
  `pristineWorktree()` copy. Extends the existing `repository-build.test.ts` rather than adding a
  suite, since that file already owns the bootstrap-then-ordered-pass seam.
- **`npm start` end to end** — one spawn in a pristine copy, asserting the step landmarks in order
  (bootstrap, `[boot] registered microservices:`, the Overseer marker) and the one-shot exit status.
  `dev-start-parity.test.ts` already asserts exactly this; the change is that its build step is now the
  ordered bin.
- **`npm ci` then `npm run ci` on a clean clone exits zero** (3.16) — the existing smoke check, run
  once after the fix, with the empty registry template still installed by `prepare`.
- **Both Container configurations still build and serve** (3.5, 3.17) — the existing image tests, run
  unchanged. If either staged set or either mount changes, something in this fix reached further than
  it should have.

### Not tested, by decision

- **The steering and README prose of 2.16 through 2.20** — reviewed, not asserted. Substring tests over
  prose are brittle and this repository polices documentation wording nowhere else. The one exception
  is F8's `/topological/i` assertion, which already exists and must be retargeted rather than dropped,
  because it is what would otherwise leave a false rationale in place.
- **That `tsc --build` honours command-line root order** — a TypeScript guarantee, verified once by
  reading every `tsconfig.json` for `references` (F7). A test here would measure the compiler.
- **The absence of a fourth Ordering_Mechanism (2.10)** — partly structural (there is one primitive and
  two call sites, both asserted by _Property 4_), partly the `[workspaces:order-source]` check, and
  partly code review. No test can assert that no future mechanism appears.

---

## Preservation evidence

**3.4 — the Tsc_Root_Order for `*` and `microservice1,microservice2`, entry for entry.** Preserved
because the Build_Sequence's statements 1, 3, 4, 5 reproduce `tscRootsOf`'s four-part composition in
the same order, and because for both Selectors directory order and Selector order are the same list
(F2). Demonstrated by _Property 11_ against an independent restatement of the pre-fix composition, and
pinned concretely by the two-row table in Data Models as an example test over the committed tree.

**3.5 — the staged path set and the Integrity_Assertion.** Preserved because nothing on the staging
path is touched: `stageOf` builds its four groups from `selected` and `staged`, neither of which this
fix reorders (F9), and `assertImageTreeIntegrity` compares `Set`s of `scopedEntry` values against a
sorted `readdirSync`, so it is order-insensitive in both directions. Demonstrated by _Property 12_ for
the staging order and by the existing image tests, run unchanged, for the staged file set.

**3.15 — Selector-scoped root exclusions, per-Spa `npm run build`, bundler phase after a zero-status
`tsc --build`.** The first becomes an explicit `buildTools: false, testOnly: false` at
`buildPlanFrom`'s call site, which is stronger than the pre-fix arrangement where the exclusion was an
emergent consequence of those packages being neither required nor selected (F4). The second and third
are `executeBuildPlan`, unmodified (F3). That function is not touched because its shape is forced from
outside this fix: the single `tsc --build` is a batch invocation that can only be issued once every
root is known, and the bundler phase must follow it because a Spa_Package's bundler reads a
Common_Package's compiled `dist/` while nothing reads a Spa_Package's output (R6.12/R6.13) — not
because leaving it alone is convenient. D7 carries that argument in full. Demonstrated by
_Properties 6 and 7_.

**3.18 — the pre-`scaffold-demo-samples` order.** That state has one Common_Package, three
Microservice_Packages, and no Spa_Package, so the Build_Sequence yields `contracts`, `build-tools`,
`common/config`, the three microservices in directory order, `overseer`, `integration-tests` — the
then-committed order exactly, with statement 7 empty and no special case anywhere in the primitive.
Demonstrated by an example test deriving the order over a `pristineWorktree()` copy reduced to that
shape, and generally by _Property 2_, whose generated layouts include ones with no Spa_Package and one
Common_Package.

---

## Risks and deviations

### D1 — Statement 4 iterates in directory order on every path, so a hand-written reordered Selector changes the Tsc_Root_Order

**The conflict.** 2.3 mandates deterministic ascending-`packageDir` iteration for every "in any order"
statement, statement 4 included. `tscRootsOf` emits the Selected_Microservices in **Selector** order
(F1). 2.11 and 2.14 then require the Workspace_Build_Order and the Tsc_Root_Order to agree on the
relative order of every shared pair, with the Verification_Pass failing on disagreement. For
`MICROSERVICES=microservice3,microservice1` the three requirements cannot all hold: the Tsc_Root_Order
would hold microservice3 first while the repository-wide order holds microservice1 first, and 2.14
would fail the build over a difference that harms nothing — no ordering edge exists among
Microservice_Packages, a peer dependency being forbidden and enforced.

**The resolution.** Statement 4 iterates in ascending `packageDir` code-point order on **every** path,
`tscRoots` included. The three candidate alternatives were rejected: exempting `tscRoots` from 2.3
reintroduces two orderings from one primitive and contradicts 2.7; narrowing 2.14 to "pairs carrying an
ordering edge" makes the divergence check unable to detect the very class of divergence 1.7 describes,
since no edge exists between the two Overseer-relative positions either; and re-ordering the Selector
itself would change `plan.selected` and the registry, which 3.13 and 3.17 forbid.

**Why 3.4 still holds exactly as written.** 3.4 scopes its byte-identical obligation to two Selectors.
For `*`, `resolveSelected`'s all-branch returns `discovery.byCategory.microservice.map(dirName)`
unchanged, and discovery sorts each category's members by directory name — verified at
`candidatesOf()`'s trailing `.sort(...)` and at `discoverPackagesFrom`'s `filter`-based grouping (F2).
Since a Microservice_Package's `packageDir` is `packages/microservices/${dirName}`, sorting by either
key is the same sort, so for `*` Selector order **already is** directory order. For
`microservice1,microservice2` the two coincide by inspection. 3.4 is therefore satisfied element for
element, not approximately.

**The residual change, stated plainly.** For a Selector whose identifiers are *not* listed in ascending
directory order, `tscRoots` now lists the Selected_Microservices in directory order rather than in the
order written. Blast radius: the order of a subset of arguments to one `npx tsc --build` invocation,
and the order of the same subset in the Dev_Server's `ts.createSolutionBuilderWithWatch` root list. No
ordering edge exists among Microservice_Packages, and no project references exist to make root order
meaningful beyond command-line sequence (F7), so nothing observable changes: the same projects compile,
the same outputs are written, the same diagnostics are reported. What does **not** change is
`plan.selected`, the `selected-microservice` entries of `plan.stage`, and the Microservice_Registry's
import and entry order — all three are built from `resolveSelected`'s return value independently of the
root composition (F9), and _Property 12_ pins all three. Duplicate identifiers in a Selector, which
`resolveSelected` deliberately preserves, still reach `selected` and `stage` as duplicates; statement 4
de-duplicates them in `tscRoots`, where a repeated root was already a no-op for the solution builder.

### D2 — 2.14's divergence check runs on the image and dev paths, which means the repository-wide order is derived on a path that does not use it

`buildPlanFrom` must hold both orders to compare them, so it derives the whole-repository order it
otherwise has no use for. Cost, measured against what those paths already do: `workspaceNodesFrom` over
an existing `Discovery` plus `readDependencySpecifiers` for four Framework_Singleton directories, of
which the Overseer's is already read — three extra `package.json` reads and one in-memory sort, against
a `tsc --build` of the whole workspace. Negligible, and it buys 2.14 on every image build and every
`npm run dev` startup rather than only in a test.

The alternative considered was making the divergence check test-only, over generated layouts and the
committed tree. Rejected because 2.14 states it as a property of the Verification_Pass, and because a
divergence introduced by a future edit to one call site is exactly the regression that a check running
only in a suite someone must remember to extend would miss.

### D3 — `[shared:unresolved]` and `[build-order:cycle]` are raised from a different module than before

3.14 pins the wording, not the raiser, and explicitly leaves "which component reports a given input" to
design. Both messages move into `build-sequence.ts`: `[shared:unresolved]` because the Prerequisite_Graph
is where every specifier is now resolved, and `[build-order:cycle]` because both raisers (statement 3's
common sort and the Verification_Pass) live there. The message builders move byte-identically, and
_Property 10_ pins the wording and the participant sets rather than trusting the move.

One behavioural consequence worth stating: pre-fix, `[shared:unresolved]` was raised during the graph
walk, so a dangling specifier could surface before or after a cycle depending on traversal. Post-fix the
cycle check runs first inside the pass, so an input carrying both a cycle and a dangling specifier now
reports the cycle. No requirement fixes the precedence between the two, and no existing test asserts it
— checked against `workspace-build-order.property.test.ts`, whose cycle block generates no dangling
specifier.

### D4 — 2.15 lands in the Repo_Invariant_Checker while 2.13's pass does not, which looks inconsistent

Requirement 2.15 leaves the choice open and 2.13 forbids a second mechanism for its own claim. The split
is deliberate and rests on what each check needs: 2.15's claim is a static fact about script sources,
needing no order, no Selector, and no discovery — precisely the checker's existing shape, and it
generalises an assertion `ci-wiring.test.ts` already makes (F8). 2.13's claim needs a produced order and
a Selector, neither of which the checker has, and duplicating it there would make the checker a second
authority on the same question. The consequence to accept is that `npm run check:invariants` reports the
order-source violation but not an Ordering_Violation; the latter fails the derivation itself, which
every entry point including `npm run ci` goes through first.

### D5 — `workspaceBuildOrder`'s exported signature is kept for its consumers, so a `SequencedPackage` is mapped back to a `WorkspaceNode`

`runOrderedBuild` needs `node.name` and `node.packageDir`, and three test suites plus
`ci-wiring.test.ts` and `repository-build.test.ts` consume `readonly WorkspaceNode[]`. Rather than
change five call sites and lose the `statement` field's usefulness inside the pass, the primitive
returns `SequencedPackage` values and `workspaceBuildOrder` maps them back to the input nodes by
`packageDir`. The cost is one lookup per package and one type that exists only at the boundary; the
alternative — widening `WorkspaceNode` with a `statement` field — would put an ordering concept into the
type the effects half consumes, which is what `tier`'s "diagnostics only; no rule reads it" comment
warns against.

### D6 — Statement 3's within-statement comparator is `packageDir` while `resolveDependencySets` uses `dirName`

2.3 and 3.3 are stated in `packageDir` terms; `required-dependencies.ts` holds its ready queue in
`dirName` order (R7.2 of the owning spec). The primitive uses `packageDir` throughout. The two agree on
Common_Packages, every one of which has `packageDir === "packages/common/" + dirName` (F5), so no
existing result moves and `resolveDependencySets` needs no change. The divergence would become real only
if a Common_Package lived outside `packages/common/`, which discovery's location-only membership rule
makes impossible.

### D7 — The SPA phase boundary is expressed in two places, and deliberately not deduplicated

Statement 7 of the Build_Sequence and the line order of `executeBuildPlan` both put the bundler builds
after the Tsc_Projects. They are two independent facts that agree, not one rule stated twice
(Components §2), and this deviation records why no attempt is made to reduce them to one expression.

First, `plan.tscRoots` is **not** part of the duplication. It is one derived field with two legitimate
consumers — `executeBuildPlan` on the image path, and `projectListFrom` in `dev-supervisor.ts`, which is
literally `buildPlanFrom(selector, discovery, readDependencies).tscRoots` — so the field exists whatever
the executor does with it. The only thing that restates the phase boundary at all is the two-line
sequence inside a four-line function body.

**The cheap deduplication does not work.** Handing the image path `spa: plan.spaBuilds` instead of
`spa: []`, and then deriving both invocation lists by filtering the produced sequence on each entry's
`statement`, yields exactly the same shape as today with the filter reading a different field. The phase
boundary is still the line order in `executeBuildPlan`, because every Tsc_Project must be collected
before one batch `tsc --build` can be issued at all, and partitioning the sequence into "all
Tsc_Projects" and then "all bundlers" re-creates that boundary wherever statement 7 happens to sit. It
removes nothing.

**The real deduplication adds complexity and breaks a requirement.** Walking the sequence in order and
emitting one `tsc --build` per contiguous run of Tsc_Projects would make statement 7's position
genuinely govern the image path. It also: (a) breaks 3.15, which requires the bundler builds to be
entered only after **the** `tsc --build` pass — singular — exits zero; (b) falsifies three assertions in
`spa-build-sequencing.property.test.ts` that encode exactly one `tsc` invocation at index 0 —
`expect(invocations).toHaveLength(1 + plan.spaBuilds.length)`, `expect(tsc).toHaveLength(1)`, and
`expect(t).toBe(0)`; and (c) regresses build performance, since one `tsc --build` over all roots lets
the solution builder share work across projects, while several passes interact with `composite` and
`tsbuildinfo` in ways that would need measuring before they could be claimed equivalent.

**What it would buy is configurability for a constant** — the ability to place statement 7 somewhere
other than last, a knob whose one correct value is the one it already has.

**The agreement is guarded rather than assumed.** _Property 6_ asserts that both expressions agree: no
Tsc_Project after a Spa_Package in the Workspace_Build_Order, no Spa_Package in the Tsc_Root_Order, and
every recorded bundler invocation strictly after the single `npx tsc --build`. Moving statement 7
therefore fails a test rather than letting the two silently diverge.

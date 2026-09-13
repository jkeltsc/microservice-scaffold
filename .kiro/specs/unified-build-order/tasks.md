# Implementation Plan: unified-build-order

## Overview

This plan turns [bugfix.md](./bugfix.md) and [design.md](./design.md) into an ordered series of coding tasks. It collapses three order-producing mechanisms into one — the Build_Sequence primitive of design.md Components §1 — adds the Verification_Pass of §3, moves `npm start` off the Declared_Array_Sequence, and updates the ten suites F10 lists plus the documentation of 2.16 through 2.20. Nothing about *what* is built, staged, served, or reported changes.

| Step | Parent task | Character |
| --- | --- | --- |
| — | Task 1 | **Exploration** — the Bug_Condition property test, written before the fix and expected to FAIL |
| — | Task 2 | **Preservation baseline** — the three preservation property tests, written before the fix and expected to PASS |
| 1 | Task 3 | **Additive** — `build-sequence.ts`: the primitive and the Verification_Pass; no production path calls it yet |
| 2 | Task 4 | **Atomic** — both derivations switch to the primitive, `buildPosition` retires, the affected suites move together |
| 3 | Task 6 | **Behaviour change** — `scripts/start.js` stops reading the `workspaces` array, and `[workspaces:order-source]` keeps it from returning |
| 4 | Task 8 | **Evidence** — the concrete Fix Checking and Preservation executions a property loop cannot carry |
| 5 | Task 9 | **Documentation** — steering, the superseded spec definition, and the README, last, so they describe what the repo does |

**The hard sequencing constraint of requirement 2.12 governs this order and the plan is invalid without it.** Task 3 (the Build_Sequence primitive and the Verification_Pass) and task 4 (the two derivations calling them) MUST land before task 6.1 (`scripts/start.js`). `npm start` is today saved only by the hand-topological `workspaces` array; removing that mechanism while the order still comes from the incomplete derivation puts every fresh clone's `npm start` on the TS2307 of 1.3. Design.md records this as a task-ordering obligation nothing in the design can express — the two files touch neither each other nor a shared import — so it is enforced here, by task order and by the dependency graph, and nowhere else. A task sequence placing 6.1 before 3.1 is invalid.

**Where the tree builds and the suite passes.** Every top-level task from 4 onward ends on a tree that builds with a green suite. Tasks 1 through 3 do not, and that is deliberate rather than achievable-but-skipped: task 1 commits a property test that FAILS on unfixed code, which is what confirms the defect exists, and task 3 is additive so it cannot make that test pass. The red window opens at task 1 and closes at task 4.9. Task 2's tests are green throughout — they pass on unfixed code by observation and must still pass after the fix. This is the single place the step-by-step-green discipline the sibling specs follow is broken, and it is broken because the exploration test's failure is the evidence.

**Task 4 is atomic and its verification gate applies to the parent, not to each sub-task.** The moment `workspaceBuildOrder()` calls the primitive, the real-tree oracle, the topological-oracle property suite, and the phase-boundary clause of `ordered-build.property.test.ts` all describe a derivation that no longer exists; and `framework.ts` cannot drop `buildPosition` until `build-plan.ts` has stopped reading it. Sub-tasks 4.1 through 4.10 land together on one branch. Do not run the gate between them.

**The verification gate at the end of every step** (the checkpoint tasks below) is:

1. `npm run ci`
2. `MICROSERVICES='*' sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES='*' .`
3. `MICROSERVICES='microservice1,microservice2' sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES='microservice1,microservice2' .`

From step 3 onward the gate additionally includes `MICROSERVICES='*' npm start` and a short `npm run dev` session with one source edit, because step 3 is where the `npm start` build path changes.

Every property test carries the tag comment `// Feature: unified-build-order, Property {number}: {property_text}` and runs at `numRuns: 100` or more — 200 where it joins a suite already at 200 — matching the repository's existing Build_System suites. Each of the design's twelve correctness properties is implemented by exactly one property test, attributed below by a `_Properties:_` line.

## Tasks

- [x] 1. Write the bug condition exploration test
  - **Property 1: Bug Condition** - No produced order contains an Ordering_Violation
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **CRITICAL**: This test MUST FAIL on unfixed code — the failure confirms the Ordering_Violation of 1.2 exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior of 2.8, so it is the test that validates the fix when it passes at task 4.9. It is not rewritten by any later task
  - File: `packages/build-tools/tests/build-order-violation.property.test.ts`
  - Drive the two **public** derivations, never the new module: `workspaceBuildOrder(workspaceNodesFrom(discovery, readDependencies))` for the Workspace_Build_Order and `buildPlanFrom(selector, discovery, readDependencies).tscRoots` for the Tsc_Root_Order. Both entry points keep their signatures across the fix (D5), so the test flips from red to green with no edit
  - Write the prerequisite relation as an oracle straight from `isCompileTimePrerequisite` in the Bug Condition: a declared `@microservices`-scoped specifier resolving to a **non-Spa** package, plus `Overseer → each Selected_Microservice`; a Spa_Package is excluded unconditionally (2.6). The oracle must not call `prerequisiteEdges`, which does not exist yet and which the property is meant to check independently
  - Assert over generated layouts: no pair `(a, b)` where `b` is a prerequisite of `a` and `a` sits at an earlier position, in **either** order; and in particular every Selected_Microservice precedes `packages/overseer` in both
  - **Scoped PBT Approach**: the defect is deterministic, so scope the generator to the concrete failing shape as well as sampling freely — a layout in which a Microservice_Package declares a Spa_Package whose `packageDir` sorts after `packages/overseer`, which is exactly the committed tree's `microservice1 → @microservices/demo` at `packages/spa/demo` (`s` > `o`). Add one non-generated example over the committed tree so the counterexample is reproducible without a seed
  - Run on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS. Document the counterexamples: over the committed tree at `35156ce` the derived order is `packages/overseer` at 7, `packages/spa/demo` at 8, `packages/microservices/microservice1` at 9, and `microservice1` is a Compile_Time_Prerequisite of the Overseer through the generated registry (1.2); the generated shapes reproduce the same violation with no Spa_Package name in them
  - Record that the violation is what 1.3 turns into `error TS2307: Cannot find module '@microservices/microservice1'` and that 1.10 explains why nothing downstream repairs it
  - Mark complete when the test is written, run, and the failure documented
  - _Properties: 1_
  - _Requirements: 1.1, 1.2, 1.3, 1.10, 1.14, 2.8, 2.13_

- [x] 2. Write the preservation property tests (BEFORE implementing the fix)
  - **Property 2: Preservation** - Every prerequisite-forced pair keeps its Pre_Fix_Baseline relative order
  - **IMPORTANT**: Follow observation-first methodology — observe the UNFIXED derivation's behaviour for inputs where the Bug_Condition does NOT hold, then assert the observed pattern
  - File: `packages/build-tools/tests/build-order-preservation.property.test.ts`, holding three tagged property blocks
  - Observe on unfixed code and record as the baseline oracle: the Pre_Fix_Baseline Workspace_Build_Order is Kahn's algorithm with a ready queue in `compareCodePoints` order of `packageDir` over all declared scoped specifiers — restate it independently in the test, in the shape `workspace-build-order.property.test.ts`'s `referenceOrder` already has, rather than calling `workspaceBuildOrder`
  - First block, _Property 2_: for any generated layout whose baseline order carries no Ordering_Violation, every pair the Compile_Time_Prerequisite relation **forces** in that baseline appears in the same relative order in the derived order. Pairs the relation leaves unconstrained are excluded from the claim, and the test says so in a comment citing F11's two counterexamples — the legal `overseer → spa` edge and the specifier-free Common_Package. Include layouts with no Spa_Package and one Common_Package, which is the 3.18 shape
  - Second block, _Property 11_: for any generated layout and any Selector whose identifier list is in ascending directory order — every spelling of the all-Selector (unset, blank, `*`, padded) and both shipped Container configurations included — `buildPlanFrom(...).tscRoots` equals an independent restatement of the pre-fix `tscRootsOf` composition element for element: `contracts`, the required Common_Packages in dependency order, the Selected_Microservices, the Overseer
  - Third block, _Property 12_: `plan.selected` equals `resolveSelected(selector, discoveredIdentifiers)` element for element with duplicates and Selector order preserved, the `selected-microservice` entries of `plan.stage` appear in that same order, and the generated Microservice_Registry's import and entry order is that same list
  - Run on UNFIXED code
  - **EXPECTED OUTCOME**: All three blocks PASS — this is the baseline behaviour the fix must preserve. _Property 2_ passes trivially pre-fix because the derivation *is* the baseline oracle; that is the point of writing it now, since it becomes a real claim the moment task 4 replaces the mechanism
  - Mark complete when the three blocks are written, run, and passing on unfixed code
  - _Properties: 2, 11, 12_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.13, 3.17, 3.18_

- [x] 3. Step 1 — The Build_Sequence primitive and the Verification_Pass (additive, inert)

  - [x] 3.1 Create `packages/build-tools/src/build-sequence.ts` with the ordering primitive
    - Export `SequenceMembership` (`common`, `microservices`, `spa`, `buildTools`, `testOnly`) and `SequencedPackage` (`packageDir`, `name`, `statement: 1 | 2 | 3 | 4 | 5 | 6 | 7`), exactly as Components §1 declares them
    - Implement `buildSequence(membership)` as the seven ordered statements of 2.1, literally and in this order: `CONTRACTS`; `BUILD_TOOLS` when `membership.buildTools`; `commonOrder(membership.common)`; `membership.microservices` sorted by `compareCodePoints` on `packageDir`; `OVERSEER`; `INTEGRATION_TESTS` when `membership.testOnly`; `membership.spa` sorted by `compareCodePoints` on `packageDir`
    - `commonOrder` is `findCyclePath` then `leastTopologicalOrder`, keyed by declared name, its edges being each member's Dependency_Specifiers that resolve to **another member of `membership.common`**, its ready queue held in `compareCodePoints` order of `packageDir`. `config` before `extended-config` must follow from the one declared edge, not from a rule
    - Move `cycleError` from `workspace-build-order.ts` with its `[build-order:cycle]` wording **byte-identical**, and call it from `commonOrder` (3.14)
    - Import `CONTRACTS`, `BUILD_TOOLS`, `OVERSEER`, `INTEGRATION_TESTS`, `NAMESPACE_CONTAINER`, and `WORKSPACE_SCOPE` from `framework.js`; `compareCodePoints`, `findCyclePath`, `leastTopologicalOrder` from `topological-order.js`. Do **not** reuse `resolveDependencySets`: it walks out from roots so it cannot enumerate every Common_Package, and its direction rules are wrong repository-wide (F5)
    - No `node:fs` import and no `process` read anywhere in the module — that purity is what lets every property below run over generated layouts (2.13)
    - Consult no per-package position metadata: statements 1, 2, 5, and 6 name their members through `framework.ts`'s exported records (2.2)
    - Nothing imports this file yet — it is purely additive
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 3.14_

  - [x] 3.2 Add the Verification_Pass to `build-sequence.ts`
    - Export `PrerequisiteEdge` (`prerequisite`, `dependent`, both repo-relative package directories) and `prerequisiteEdges(nodes, selectedMicroservices)`, building the Prerequisite_Graph: every declared `@microservices`-scoped specifier resolving to a **non-Spa** package, plus the `Overseer → Selected_Microservice` edges the Microservice_Registry creates and no manifest may declare
    - Move `declaredNames`, `dependencyKeysOf`, and `unresolvedSpecifierError` out of `workspace-build-order.ts` into this module, the `[shared:unresolved]` wording byte-identical, so every specifier is resolved once and the message is raised once per offending consumer (3.14, D3)
    - Export `verifyBuildOrder(order, edges, counterpart?)` returning every violation message of one run — empty when the order is sound — and the throwing wrapper `assertBuildOrder(...)` the two derivations call
    - Run all four checks on every invocation so one call reports everything, in this order: **cycle** (`findCyclePath` over the Prerequisite_Graph, reported with the existing `[build-order:cycle]` wording, directories not declared names); **positional** (each edge's prerequisite strictly earlier than its dependent — the Ordering_Violation of the Bug_Condition verbatim); **structural** (an edge whose endpoints sit in the same Unordered_Statement — 4, 6, or 7 — reported whichever way the two sort, which is how a Microservice_Package declaring a peer is caught; statement 3 is an Ordered_Statement and is deliberately exempt); **divergence** (`counterpart` and `order` must agree on the relative order of every package both contain, reported as `[build-order:divergence]`)
    - The positional and structural findings share the new tag `[build-order:prerequisite]` with two clause shapes; no new tag replaces or narrows `[shared:unresolved]` or `[build-order:cycle]`
    - Record in a comment why the cycle check runs first and what that changes: an input carrying both a cycle and a dangling specifier now reports the cycle, a precedence no requirement fixes and no existing test asserts (D3)
    - Record why the `Overseer → Selected_Microservice` edges are synthesised here rather than declared: `peerDependencyError` rejects any manifest naming a Microservice_Package with `[deps:peer]` and grants the Overseer no exemption, and the set of microservices is Selector-dependent anyway (1.8, 1.9). No manifest gains such a dependency as part of this fix and the resolver keeps rejecting one (3.12)
    - _Requirements: 1.8, 1.9, 2.6, 2.13, 2.14, 3.12, 3.14_

  - [x] 3.3 Write the statement-scaffold example tests
    - File: `packages/build-tools/tests/build-sequence.test.ts`
    - One example per statement over a fixed membership: statement 2 present when `buildTools` is true and absent when false; the same for statement 6 and `testOnly`; statement 7 empty when `membership.spa` is empty
    - Statement 3's `config`-before-`extended-config` over the two real Common_Packages, asserted as a consequence of `extended-config`'s single declared specifier
    - Assert each returned `SequencedPackage.statement` value matches the statement that should have emitted it, so the numbering the properties quantify over is pinned by example too
    - _Requirements: 2.1, 2.3_

  - [x] 3.4 Write the Verification_Pass property tests
    - File: `packages/build-tools/tests/build-sequence-verification.property.test.ts`
    - _Property 8_: for any generated layout, any Selector, and any injected defect from {no defect, a Microservice_Package declaring a peer, a Common_Package declaring a Microservice_Package, a Common_Package declaring the Overseer, a prerequisite cycle of length 1 to k}, `verifyBuildOrder` returns a non-empty message list exactly when an independently written violation oracle finds a violation, names every offending package directory, and returns nothing for the no-defect case. The peer case must fail **for both orderings of the two directory names** — that clause is what distinguishes the structural check from the positional one
    - _Property 10_: for any generated layout carrying a dangling `@microservices`-scoped specifier, a cycle among Common_Packages, or a cycle elsewhere in the Prerequisite_Graph, the failure carries `[shared:unresolved]` or `[build-order:cycle]` with its existing message shape, names every offending specifier or every cycle participant and **only** the participants as package directories, computes no order, and therefore invokes no `build` script. A Common_Package cycle reported by statement 3 and any other cycle reported by the pass must be indistinguishable in output
    - _Properties: 8, 10_
    - _Requirements: 2.13, 3.14_

  - [x] 3.5 Confirm the Verification_Pass would have caught the committed defect, and record the observation
    - This is what replaces an exploratory phase per the design's Testing Strategy: the defect is already measured, but that the *pass* has teeth is not
    - Run `prerequisiteEdges` plus `verifyBuildOrder` over the **pre-fix** `workspaceBuildOrder()` output on the committed tree, in a scratch script or a temporarily-added `it` — and observe it report `packages/microservices/microservice1` placed after `packages/overseer` under `[build-order:prerequisite]`
    - Record the observed message text in the commit message
    - **Commit no test file for this**: it is a one-example confirmation, superseded by task 1's property the moment task 4 lands, and keeping it would assert the pre-fix derivation the fix deletes. Delete the scratch code before committing
    - _Requirements: 1.2, 1.14, 2.13_

- [x] 4. Step 2 — Both derivations call the primitive; `buildPosition` retires (atomic)

  > **This parent task cannot be split into independently-shippable pieces, and the verification gate applies to the parent.** `framework.ts` cannot drop `buildPosition` until `build-plan.ts` has stopped reading it (`tscRootsOf`'s `positioned()` is its only production reader, F4), and the real-tree oracle, the topological-oracle property suite, and `ordered-build.property.test.ts`'s phase-boundary clause all describe a derivation that stops existing at 4.1. **Sub-tasks 4.1 through 4.10 must all complete before the suite is green.** If further de-risking is needed the only clean seam is 4.1–4.3 (the sources) and 4.4–4.8 (the suites) as two commits on one branch, merged as a unit.

  - [x] 4.1 Rewrite `workspaceBuildOrder()` in `packages/build-tools/src/workspace-build-order.ts` over the primitive
    - Keep the exported signature and the `readonly WorkspaceNode[]` return type — `runOrderedBuild`, three build-tools suites, `ci-wiring.test.ts`, and `repository-build.test.ts` all consume `WorkspaceNode` values (D5)
    - Body becomes: partition `nodes` by `tier` and category → `buildSequence({ common, microservices: dirNames, spa, buildTools: true, testOnly: true })` → `assertBuildOrder(order, prerequisiteEdges(nodes, allIdentifiers))` → map each `SequencedPackage` back to its input node by `packageDir`
    - Delete the local `declaredNames`, `dependencyKeysOf`, `unresolvedSpecifierError`, and `cycleError` — they now live in `build-sequence.ts` (3.2) — and remove the now-unused `topological-order.js` imports
    - Leave `workspaceNodesFrom`, `runOrderedBuild`, `orderedBuildFailedError`, `CommandRunner`, `spawnRunner`, and `runOrderedBuildCli` untouched. `workspaceNodesFrom` stays because it is the only place a Framework_Singleton's own specifiers are read and the Verification_Pass needs them
    - Replace the stale module-comment paragraph — the one attributing the order to declared dependencies and calling `contracts` first and `integration-tests` last unhardcoded consequences — with the actual reason: those two positions are now statements 1 and 6 of the Build_Sequence, and the pass, not the sort, is what honours a declared edge
    - The assertion runs before any `build` script is spawned, so `runOrderedBuildCli` cannot build over an unsound order and `[build-order:failed]` is unreachable for an ordering reason
    - This is where the derivation mechanism of 1.7's three-mechanism table collapses into one: after this sub-task and 4.2, the only remaining Ordering_Mechanism is the Build_Sequence
    - _Requirements: 1.7, 2.1, 2.7, 2.8, 2.10, 3.1, 3.2, 3.14_

  - [x] 4.2 Rewrite `tscRoots` derivation in `packages/build-tools/src/build-plan.ts`
    - Delete `tscRootsOf` and its `positioned()` helper outright
    - `buildPlanFrom` calls `buildSequence({ common: required.filter((pkg) => pkg.category === "common"), microservices: selected, spa: [], buildTools: false, testOnly: false })` and `tscRoots` becomes that sequence's `packageDir` list. Comment both `false` values with 3.15: the exclusion is now a stated decision rather than the emergent consequence F4 describes
    - Comment `spa: []` as the *image path* handing statement 7 no members, `plan.spaBuilds` being where its Spa_Packages live — statement 7's placement and `spaBuilds`' phase are two independent facts that agree, not one claim expressed twice; take the comment's substance from design.md's `### D7` (2.4, 2.5)
    - Derive the repository-wide order from the `discovery` and `readDependencies` the function already holds — `workspaceNodesFrom(discovery, readDependencies)` needs nothing more — and call `assertBuildOrder(tscSequence, edges, workspaceOrder)` so the divergence check of 2.14 runs on the image path and the dev path over the real Selector, with three extra manifest reads and no spawned process (D2)
    - Leave `spaBuilds`, `stage`, `stageOf`, `ALWAYS_STAGED_SCOPED`, `ALWAYS_STAGED_AT_PACKAGE_DIR`, `SCOPE_DIR`, and the `BuildPlan` shape unchanged; keep the comment recording that the two `buildKind` filters partition the BUILD set, since they still do. Add the statement numbering to `tscRoots`' doc comment
    - Make no change to `projectListFrom` or `devProjectList` in `dev-supervisor.ts`: the Project_List is literally `buildPlanFrom(...).tscRoots`, so it inherits the primitive and 2.11 holds by identity, and every Dev_Server restart decision, diagnostic, and failure message stays as it is (3.6)
    - _Requirements: 2.5, 2.7, 2.11, 2.14, 3.4, 3.6, 3.15_

  - [x] 4.3 Retire `buildPosition` from `packages/build-tools/src/framework.ts` and its three test readers
    - Remove `FrameworkBuildPosition`, the `buildPosition` field, and `singleton()`'s third parameter; the four records shorten to `singleton(dirName, staging)`. Nothing else in the module changes — `FrameworkStaging`, `staging`, `ALWAYS_STAGED_SCOPED_ENTRIES`, and `OVERSEER_ENTRYPOINT` are a different axis and stay (F4, 3.5)
    - `packages/build-tools/tests/framework.test.ts`: drop the four `buildPosition` field pins
    - `packages/build-tools/tests/required-dependencies.property.test.ts`: drop `expect(CONTRACTS.buildPosition).toBe("first")`
    - `packages/build-tools/tests/build-plan.property.test.ts`: rewrite the `singleton.buildPosition !== "excluded"` root-membership oracle as an explicit `BUILD_TOOLS`/`INTEGRATION_TESTS` exclusion, and restate `referenceTscRoots` in Build_Sequence terms — statements 1, 3, 4, 5 — while keeping it an independent restatement rather than a call into the primitive
    - Keeping the field declared but unread was rejected: an unread field describing build order is exactly the "position knowledge in one place, not read in another" shape root cause 2 identifies
    - _Requirements: 1.11, 2.2_

  - [x] 4.4 Update the real-tree oracle to the Build_Sequence order
    - File: `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`
    - Replace `EXPECTED_ORDER` with the ten entries of design.md's Data Models table: `contracts`, `build-tools`, `common/config`, `common/extended-config`, the three microservices in `packageDir` order, `overseer`, `integration-tests`, `spa/demo`
    - **Delete** the `it` block asserting `order[demoIdx + 1] === "packages/microservices/microservice1"`: it is an assertion *of the defect* and there is nothing to re-scope it to
    - Rewrite the header comment's per-entry rationale so each position cites the statement that emitted it rather than a graph consequence; the contracts-first and integration-tests-last blocks survive, retargeted onto statements 1 and 6, with `spa/demo` now the sole entry following `integration-tests` (3.1)
    - _Requirements: 2.21, 3.1, 3.2_

  - [x] 4.5 Rewrite `workspace-build-order.property.test.ts` against a Build_Sequence oracle
    - Its current oracle *is* the lexicographically-least topological order over declared dependencies, which is no longer the derivation. Replace `referenceOrder` with an independent restatement of the seven statements of 2.1, written from the requirement rather than by calling `buildSequence`
    - The determinism block and the cycle block survive, retargeted: determinism onto 2.3's within-statement `compareCodePoints` tiebreak, and the cycle block onto the moved `[build-order:cycle]` message builder
    - Delete the block asserting that two packages with no dependency relation are ordered by `packageDir` **across** the whole order, and restate it as 3.3 now stands: the tiebreak governs pairs within one statement only, so a Common_Package declaring no specifier no longer leads the order ahead of `packages/contracts`
    - Keep `numRuns: 200`, matching the suite as it stands
    - _Requirements: 2.1, 2.3, 3.3, 3.14_

  - [x] 4.6 Invert the phase-boundary clause in `ordered-build.property.test.ts` and attribute _Property 9_ there
    - The R12.9 assertion that a Spa build sits "within the same single pass, with no phase boundary" is now false: statement 7 makes the bundlers a trailing phase. Invert it to "every Spa_Package's `npm run build` invocation follows every Tsc_Project invocation"
    - Keep every effects claim as it stands and tag it as _Property 9_: over any generated layout, any chosen failing package, and any non-zero status, `runOrderedBuild` invokes `npm run build --workspace <name>` exactly once per package up to and including the failing one, in the produced order, invokes nothing after it, and throws `[build-order:failed]` naming that package's directory and the observed status with the existing wording — all through the injected `CommandRunner`, so nothing is spawned
    - Keep `numRuns: 200`
    - _Properties: 9_
    - _Requirements: 2.4, 3.14, 3.15_

  - [x] 4.7 Re-scope the duplicate-bearing Selector block in `dev-project-list.property.test.ts`
    - The block "matches resolveSelected for whitespace-padded and duplicated identifiers" asserts the Project_List's microservice members equal `resolveSelected`'s output element for element **including duplicates**. D1 relocates that claim: statement 4 iterates in `packageDir` order and de-duplicates, where a repeated root was already a no-op for the solution builder
    - **Re-scope, do not drop.** Move the Selector-order-and-duplicates claim onto `plan.selected`, where Selector order and duplicates do survive, and cross-reference _Property 12_ as its home; leave in place, over the Project_List, only the claim that its microservice members are the same *set* as `resolveSelected`'s
    - Every other block survives unchanged: contracts first, Overseer last, no Spa_Package, no `packages/build-tools` or `packages/integration-tests`, every dependency before its dependent
    - Correct the header comment's stale `buildPosition` explanation, which now describes a field that no longer exists
    - Keep `numRuns: 200`
    - _Requirements: 2.11, 3.5, 3.13_

  - [x] 4.8 Write the remaining Build_Sequence property tests
    - Files: `packages/build-tools/tests/build-sequence.property.test.ts` for _Properties 3, 4, 5_ and `packages/build-tools/tests/build-sequence-spa-phase.property.test.ts` for _Properties 6, 7_
    - Widen the shared in-memory layout model `build-plan.property.test.ts` and `dev-project-list.property.test.ts` already use in three ways: generate every Consumer_Category rather than the library categories only, let the four Framework_Singletons participate as nodes with their own specifiers, and add a generator variant that plants an intra-statement edge on purpose so the structural check has something to catch. Touch no filesystem — both derivations are pure over an injected `Discovery` and `ReadDependencies`
    - _Property 3_: for every pair of packages appearing in both the Workspace_Build_Order and the Tsc_Root_Order the two agree on relative order, and `verifyBuildOrder` returns no `[build-order:divergence]` message; quantified over the intersection only, since the Tsc_Root_Order legitimately omits `build-tools`, `integration-tests`, every unselected Microservice_Package, and every Spa_Package
    - _Property 4_: mapping each entry of both orders to its emitting statement number yields two non-decreasing sequences over the same numbering, and the Tsc_Root_Order equals the Workspace_Build_Order filtered to the Selector-scoped membership — the two paths differ only in membership, never in statement order
    - _Property 5_: repeated derivations agree element for element, and two independent permutations of the layout's package list both reproduce the unpermuted derivation; assert the "no metadata beyond category, directory, name, and declared specifiers" half by deriving twice over layouts differing only in fields the primitive must not read
    - _Property 6_: no Tsc_Project appears later than any Spa_Package in the Workspace_Build_Order, no Spa_Package appears in the Tsc_Root_Order at all, and `executeBuildPlan`'s recorded invocation sequence places every bundler `npm run build` strictly after the single `npx tsc --build`
    - _Property 7_: for a layout carrying a `microservice → spa` or `overseer → spa` edge, `prerequisiteEdges` returns no edge whose prerequisite is a Spa_Package, `verifyBuildOrder` reports no violation for such an edge whichever order the endpoints appear in, and that Spa_Package is nonetheless in the Required_Dependencies, in the stage set where its category justifies it, and in `plan.spaBuilds`
    - Leave `spa-build-sequencing.property.test.ts` untouched: it already asserts `tsc --build` first and bundlers after, which is the phase boundary _Property 6_ also guards (D7)
    - _Properties: 3, 4, 5, 6, 7_
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.11, 2.14, 3.15_

  - [x] 4.9 Verify the bug condition exploration test now passes
    - **Property 1: Expected Behavior** - No produced order contains an Ordering_Violation
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test and do not edit its oracle
    - Run `packages/build-tools/tests/build-order-violation.property.test.ts`
    - **EXPECTED OUTCOME**: Test PASSES, confirming the Ordering_Violation is gone: every Selected_Microservice now precedes `packages/overseer` on both paths, and the committed-tree example yields the ten-entry order of 2.21
    - _Bug_Condition: isBugCondition(X) from design.md Bug Details — an order holding a package ahead of one of its Compile_Time_Prerequisites_
    - _Expected_Behavior: the Build_Sequence of 2.1 with the Verification_Pass of 2.13 asserting the produced order_
    - _Requirements: 2.1, 2.8, 2.13, 2.14_

  - [x] 4.10 Verify the preservation tests still pass
    - **Property 2: Preservation** - Every prerequisite-forced pair keeps its Pre_Fix_Baseline relative order
    - **IMPORTANT**: Re-run the SAME three blocks from task 2 — do NOT write new tests and do not relax an assertion to make one pass
    - Run `packages/build-tools/tests/build-order-preservation.property.test.ts`, then the whole build-tools and integration suites
    - **EXPECTED OUTCOME**: Tests PASS with no regressions. _Property 2_ is now a real claim rather than a tautology, since the derivation and the baseline oracle are two different mechanisms
    - If a failure names a pair the prerequisite relation leaves **unconstrained**, the test is over-claiming and must be narrowed to the forced pairs — that is F11's argument, not a defect in the fix. A failure naming a forced pair is a real regression
    - _Preservation: the Preservation Requirements of design.md — 3.1 through 3.18, with 3.4, 3.5, 3.13, and 3.17 carried by Properties 11 and 12_
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.13, 3.17, 3.18_

- [x] 5. Checkpoint — step 2 verification gate
  - Run `npm run ci` and both documented two-command container builds. Confirm the ten-entry real-tree order, a green `build-order-violation.property.test.ts`, and no `buildPosition` reader left anywhere under `packages/build-tools/src/`
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 2.21, 3.14, 3.16_

- [x] 6. Step 3 — `npm start` off the Declared_Array_Sequence, and the order-source invariant

  > **Requirement 2.12 gates this whole parent on tasks 3 and 4 being complete.** Do not start 6.1 before 4.9 is green.

  - [x] 6.1 Replace the `--workspaces` build in `scripts/start.js` with a spawn of the ordered bin
    - This is the last Declared_Array_Sequence consumer in the repository (1.5, 1.6): replace `runOrExit("npm", ["run", "build", "--workspaces"])` with a `spawnSync(process.execPath, ["packages/build-tools/dist/bin/build-workspaces.js"], { stdio: "inherit" })` — the same bin `scripts/build.js` spawns — and keep the existing `[start] … refusing to start the Overseer` framing and `process.exit` on a non-zero status
    - Remove `runOrExit` if nothing else calls it
    - Preserve exactly, and verify by reading the file afterwards: `runCommonStartup({ tag: "start" })` still runs **first**, so the Bootstrap_Build and registry regeneration still happen in that order and a selector error or failed step still aborts before the Overseer (3.7); the trailing one-shot `spawnSync` of `packages/overseer/dist/index.js` with `process.exit(server.status)` is untouched (3.7); no Selector is parsed here and every workspace package is still built (3.8); the `dotenvx run --` wrapper is untouched (3.9)
    - Record in a comment why the bin exists by the time it is spawned: `runCommonStartup`'s first step is the Bootstrap_Build that compiles `build-tools`, the same guarantee `scripts/build.js` relies on, reached one call earlier
    - _Requirements: 1.5, 2.9, 2.10, 2.12, 3.7, 3.8, 3.9_

  - [x] 6.2 Correct the module comment in `scripts/common-startup.js`
    - Delete the sentence attributing the soundness of generating the registry before the full build to the root `workspaces` array being in topological order, and state the actual reason: the registry is generated before the build so the Overseer compiles against a fresh one, and the build order comes from the Build_Sequence
    - Comment only — no code change in this file
    - _Requirements: 1.6, 2.9, 2.16_

  - [x] 6.3 Retarget the three `/topological/i` assertions in `dev-start-parity.test.ts`
    - The suite pins `expect(/topological/i.test(commonStartupSrc)).toBe(true)` together with `false` for both entry points, which after 6.2 pins a rationale that is gone
    - Retarget all three onto the replacement wording rather than deleting them: they are what would otherwise leave a false rationale in place, and the design's "reviewed, not asserted" exemption for prose explicitly excludes them
    - Leave the suite's ordering, one-shot, and refusal-line assertions untouched
    - _Requirements: 2.9, 3.7_

  - [x] 6.4 Add the fourth check `checkBuildOrderSource` to `packages/build-tools/src/repo-invariants.ts`
    - Pure over an injected map of script names to values and an injected list of `(path, source)` pairs, returning one `[workspaces:order-source]` message per script value or `scripts/*.js` source that invokes a build with `--workspaces`
    - Wire it into `collectViolations()` **after** the three existing checks, and extend the real-filesystem effect shell to read the root `scripts` object and every `scripts/*.js` source
    - Leave `checkWorkspaceCoverage`, `checkImportDiscipline`, and `checkDependencyDirection` and their message shapes untouched, including the coverage check's documented indifference to `workspaces` entry order (3.10) and its treatment of the array as globs matching every workspace package (3.11) — update only the "three checks" wording in the module comment and section numbering
    - Record why this claim lands here while the Verification_Pass does not (D4): it is a static fact about script sources needing no order, no Selector, and no discovery, and it generalises the assertion `ci-wiring.test.ts` already makes over root scripts
    - _Requirements: 2.10, 2.15, 3.10, 3.11_

  - [x] 6.5 Write the `[workspaces:order-source]` example tests
    - Extend `packages/build-tools/tests/check-repo-invariants.test.ts` and `packages/build-tools/tests/repo-invariants.property.test.ts` rather than adding a suite
    - One example per shape: a root script containing `--workspaces` in a build invocation, a `scripts/*.js` source containing one, and the clean repository reporting nothing
    - Assert the bin still exits 0 on a clean generated tree and 1 with every message present when one violation of each of the now-four checks is seeded
    - _Requirements: 2.15, 3.10_

  - [x] 6.6 Extend the `ci-wiring.test.ts` no-`--workspaces` assertion to `scripts/*.js`
    - The suite asserts no **root script** contains `npm run build --workspaces`; the last occurrence lived in `scripts/build.js`'s sibling `scripts/start.js`, which the assertion never ranged over (F8)
    - Extend its range to every `scripts/*.js` source, keeping the existing root-script cases and the `check:invariants` ordering assertions as they are
    - _Requirements: 2.10, 2.15_

  - [x] 6.7 Write the `scripts/start.js` wiring assertions
    - Source-level and cheap, in the style `dev-start-parity.test.ts` already uses, in that suite: `packages/build-tools/dist/bin/build-workspaces.js` appears in the source, `npm run build --workspaces` does not, `runCommonStartup` is still called before it, and the Overseer entrypoint spawn is still the last statement
    - _Requirements: 2.9, 3.7, 3.8_

- [x] 7. Checkpoint — step 3 verification gate
  - Run `npm run ci`, both documented two-command container builds, `MICROSERVICES='*' npm start`, and a short `npm run dev` session with one source edit. Confirm `check:invariants` reports zero `[workspaces:order-source]` violations and that `npm start` reaches the Overseer boot marker and exits with the Overseer's status
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 3.7, 3.9, 3.16_

- [x] 8. Step 4 — The concrete Fix Checking and Preservation executions

  - [x] 8.1 Add the clean-tree ordered build with a real registry to `repository-build.test.ts`
    - **This is the single highest-value test in this fix**: it is exactly the state 1.3 and 1.4 describe — no `dist/`, no `*.tsbuildinfo`, and a **real** Microservice_Registry naming all three microservices — in which the pre-fix order fails at the Overseer with TS2307 and a re-run fails identically
    - It MUST run inside a `pristineWorktree()` copy and never against the checked-out tree: materialise one copy in `beforeAll`, skip with the returned `reason` when `available === false`, re-root every path it writes at the returned `dir`, pass `cwd: dir` to everything it spawns, and tear down with `cleanup()`. Use no git command to undo anything
    - In that copy: generate the real registry for `MICROSERVICES='*'`, remove every `dist/` and `*.tsbuildinfo`, run the bootstrap build then the ordered bin, and assert exit status 0 with the Overseer compiled
    - Extend `repository-build.test.ts` rather than adding a suite — it already owns the bootstrap-then-ordered-pass seam
    - _Requirements: 1.3, 1.4, 2.8, 2.21_

  - [x] 8.2 Assert `npm start` end to end on a pristine copy after the step-3 change
    - One spawn in a `pristineWorktree()` copy, asserting the step landmarks in order — the bootstrap, `[boot] registered microservices:`, the Overseer marker — and the one-shot exit status
    - `dev-start-parity.test.ts` already asserts exactly this and already owns the harness; the change is that the build step it observes is now the ordered bin, so extend its existing execution block rather than adding a suite
    - _Requirements: 2.9, 3.7, 3.9_

  - [x] 8.3 Add the pre-`scaffold-demo-samples` expected-order example test
    - New example test deriving the Workspace_Build_Order over a `pristineWorktree()` copy reduced to that feature's predecessor shape: the Demo_Spa and `extended-config` removed and `microservice1`'s `@microservices/demo` specifier dropped
    - Assert exactly that state's then-committed order — `contracts`, `build-tools`, `common/config`, the three microservices in directory order, `overseer`, `integration-tests` — with statement 7 empty and no special case anywhere in the primitive
    - This is 2.22's evidence as well as 3.18's: the fix is correct whether that feature's changes are present or absent
    - Capture original file contents by reading them **from the copy** and restore by writing captured bytes, never through git; tear down with `cleanup()`
    - _Requirements: 2.22, 3.18_

  - [x] 8.4 Add the source-level assertion that no `buildPosition` reader survives
    - Assert that no file under `packages/build-tools/src/` names `buildPosition`, which is 2.2's only mechanical check — the requirement is about what the derivation may consult, and the absence of the metadata is what makes it checkable by inspection
    - Put it beside the existing framework surface assertions in `packages/build-tools/tests/framework.test.ts`
    - _Requirements: 2.2_

- [x] 9. Step 5 — Documentation

  - [x] 9.1 Correct `.kiro/steering/tech.md`
    - State that build order comes from the Build_Sequence; remove the assertion that the `workspaces` array order IS the build order and must stay topological; remove the attribution of build-order enforcement to `check:invariants` (2.16)
    - State that the `workspaces` field remains declared and remains expressed as globs, because npm reads it statically to discover the workspaces and create the `node_modules/@microservices/*` symlinks before any repository code runs — it declares **membership**, not a package list and not an order, and only its *sequence* stops being load-bearing (2.17)
    - Describe `check:invariants` by its **four** actual enforcement areas — Workspace_Coverage, import discipline, Common_Package dependency direction, and the order-source check — and describe `build`, `pretest`, and `ci` as the scripts they actually invoke, so no command listing implies a `--workspaces` traversal decides build order (2.18)
    - Leave the `npm start` and `npm run dev` descriptions otherwise intact, updating only the build step `npm start` takes
    - _Requirements: 1.12, 2.16, 2.17, 2.18_

  - [x] 9.2 Mark the superseded definition in `.kiro/specs/shared-packages/requirements.md`
    - Mark that document as superseded on the term Workspace_Build_Order — where it defines it as "the order of the `workspaces` array in the root `package.json`" — and point at the current definition, so one term no longer carries two incompatible definitions across live specs
    - Change nothing else in that document: it is a completed spec's requirements, and the marking is a retraction of one definition, not a rewrite
    - _Requirements: 1.13, 2.19_

  - [x] 9.3 Update `README.md`
    - In `### How a build order is produced`, change the `npm start` row's third and fourth cells from `*none — traverses the `workspaces` array*` and `*(none)*` to `dist/bin/build-workspaces.js` and `workspaceBuildOrder()`, making its row identical to the `npm run build` row except for the repo script
    - Replace the paragraph beginning "`npm start` is the odd row" — which describes this fix as pending — with a statement that no path reads the `workspaces` array for ordering, that the array declares membership only, and that all four entry points reach their order through the Build_Sequence with two memberships between them
    - Rewrite `### Workspace ordering matters` now that array order is load-bearing for nothing: keep the obligation that a new common package is **added** to `workspaces` (Workspace_Coverage), drop the obligation that it be positioned before every package that depends on it, and drop the attribution of array-order sensitivity to `npm start`. Retitle the section if the new content no longer matches the title
    - Record that a Microservice_Package serving a Spa_Package must **compile and start** without that Spa_Package's bundle present: the compile half is what licenses the trailing bundler phase of statement 7, and the runtime half is the `503` at the Mount_Root while the Spa_Root is absent, recovering on the next request with no restart (2.20)
    - _Requirements: 2.9, 2.10, 2.20_

  - [x] 9.4 Update the `spa` category section of `.kiro/steering/structure.md`
    - Record the same compile-and-start fact as 9.3: a Microservice_Package serving a Spa_Package compiles with no Spa_Root present, which is why a Spa_Package is never a `tsc --build` root and why its bundler build is a trailing phase; the runtime half is already specified by `scaffold-demo-samples`
    - Change nothing about the Spa_Resolution_Pairs convention or the category contract — a non-empty `scripts.build` remains the whole of it
    - _Requirements: 2.20_

- [x] 10. Checkpoint — final verification gate
  - Run `npm run ci` on a warm tree and again on a genuinely cold one (`git ls-files --cached --others --exclude-standard` piped into `tar` in a temp directory, then `npm ci`), both documented two-command container builds, `MICROSERVICES='*' npm start`, and a short `npm run dev` session with one source edit
  - Run the two existing Container tests **unchanged** and confirm neither staged set nor either mount changed: if either did, something in this fix reached further than it should have
  - Confirm `npm ci` followed by `npm run ci` exits zero on a clean clone with the empty registry template still installed by `prepare`
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 2.21, 3.5, 3.16, 3.17_

## Notes

- **Requirement 2.12 is the plan's one non-negotiable ordering constraint.** Tasks 3 and 4 — the Build_Sequence primitive, the Verification_Pass, and both derivations calling them — MUST land before task 6.1 changes `scripts/start.js`. `npm start` is today saved only by the hand-topological `workspaces` array; a change set that removes that mechanism while the order still comes from the incomplete derivation leaves every fresh clone running `npm start` on the TS2307 of 1.3. Nothing in the design can express the constraint, because §1 and §5 touch different files and neither imports the other, so it is carried here and in the dependency graph's wave numbering. A sequence placing 6.1 before 3.1 is invalid.
- **The suite is red from task 1 until 4.9, and that is the design.** Task 1 commits a property test that fails on unfixed code, which is the confirmation the Ordering_Violation exists; task 3 is additive and cannot make it pass. This is the only place the sibling specs' "every step ends on a tree that builds with a green suite" discipline is broken. Every top-level task from 4 onward restores it. Task 2's three blocks are green throughout, before and after.
- **No task edits `design.md`, and no task reconciles or re-litigates the Preservation Checking property.** bugfix.md already states it in the narrowed, satisfiable form — prerequisite-forced pairs preserved, unconstrained pairs not claimed — and that is the authoritative statement this plan implements, at task 2's first block and again at 4.10. design.md's `### F11` records why the general form was abandoned: the unsatisfiability argument, both counterexamples (the legal `overseer → spa` edge, and the specifier-free Common_Package sorting ahead of `contracts`), and the list of what is asserted instead. The two documents agree, so there is nothing left to realign.
- **`executeBuildPlan` is deliberately unmodified (3.15), and no task collapses the SPA phase boundary into one expression.** Statement 7 of the Build_Sequence and `executeBuildPlan`'s line order are two independent facts that agree, not one rule stated twice: statement 7 governs the whole-repository build order, where each package runs its own `build` script in sequence and so position is the only lever, while the line order is forced independently by `tsc --build` being a **batch** invocation over all roots at once and by a Spa_Package's bundler reading a Common_Package's compiled `dist/` while nothing reads a Spa_Package's output. `plan.tscRoots` is no part of it — one derived field with two legitimate consumers, `executeBuildPlan` and `projectListFrom`. The cheap deduplication (filtering the produced sequence on `statement`) removes nothing, because a batch `tsc --build` must collect every root first and so re-creates the boundary wherever statement 7 sits; the real one breaks 3.15's singular pass, falsifies three assertions in `spa-build-sequencing.property.test.ts`, and splits the compile pass at a performance cost — to buy configurability for a constant. design.md's `### D7` carries the full argument; _Property 6_ guards the agreement rather than letting it be assumed.
- **The README's `### How a build order is produced` section is a coverage gap this plan closes without a requirement number.** Requirements 2.16 through 2.20 name `tech.md`, `structure.md`, `shared-packages/requirements.md`, and the README's compile-and-start fact — but not that section or `### Workspace ordering matters`, because neither existed when the requirements were written. Task 9.3 covers them anyway: the section's `npm start` row currently reads *none — traverses the `workspaces` array*, and it carries a paragraph describing this fix as pending, so leaving it alone would ship a README that documents the defect as current. No requirement number is invented for it.
- **Files written by more than one sub-task.** Exactly one: `packages/build-tools/src/build-sequence.ts`, written by 3.1 (the primitive) and 3.2 (the Verification_Pass), which sit in different waves. `packages/build-tools/tests/framework.test.ts` is written by 4.3 (dropping the field pins) and 8.4 (adding the source-level absence assertion), also in different waves. Every other file in the plan has exactly one writing sub-task.
- **Three test suites lose assertions, and only two of the three deserve to.** The real-tree test's `order[demoIdx + 1] === "packages/microservices/microservice1"` block (4.4) and `ordered-build.property.test.ts`'s "within the same single pass, with no phase boundary" clause (4.6) assert the defect, so they go. `dev-project-list.property.test.ts`'s duplicate-bearing Selector block (4.7) is the only **correct** assertion this fix invalidates, and it is re-scoped rather than dropped: the Selector-order claim it protects still needs a test, and _Property 12_ is where it now lives.
- **No task changes the effects half of the image or dev paths.** `executeBuildPlan`, `stageOf`, `assertImageTreeIntegrity`, `resolveDependencySets`, `resolveSelected`, `generateRegistry`, and `dev-supervisor.ts`'s `decide` / `reduceDevEvents` / `runDevSupervisor` are untouched. `projectListFrom` needs no edit at all: it is literally `buildPlanFrom(...).tscRoots`, so 2.11 holds by identity rather than by a second derivation.
- **The root `workspaces` array is neither reordered nor edited by any task** (3.11), and no manifest gains a dependency on a Microservice_Package (3.12). The array keeps exactly one obligation, Workspace_Coverage, and `checkWorkspaceCoverage`'s documented indifference to entry order stays as it is (3.10). What changes is that nothing reads its *sequence* any more.
- **Reviewed, not asserted.** The steering and README prose of 2.16 through 2.20 is reviewed at task 10's gate rather than pinned by substring tests: such tests are brittle and this repository polices documentation wording nowhere else. The one exception is the `/topological/i` assertion of F8, which already exists and is retargeted at 6.3 rather than dropped, because it is what would otherwise leave a false rationale in `scripts/common-startup.js`.
- **Not tested, by decision.** That `tsc --build` honours command-line root order is a TypeScript guarantee, verified once by reading every `tsconfig.json` for `references` (F7); a test here would measure the compiler. The absence of a fourth Ordering_Mechanism (2.10) is partly structural — one primitive, two call sites, both pinned by _Property 4_ — partly the `[workspaces:order-source]` check of 6.4, and partly code review; no test can assert that no future mechanism appears.
- **No test writes to the checked-out tree.** Tasks 8.1, 8.2, and 8.3 each mutate sources, and each does so inside its own `pristineWorktree()` copy: one copy materialised in `beforeAll`, every written path re-rooted at the returned `dir`, `cwd: dir` passed to everything spawned, original contents captured by reading them from that copy and restored by writing captured bytes, and `cleanup()` in teardown. No destructive git command appears in any task. `dev-error-recovery.test.ts` and `dev-session-scope.test.ts` are the worked examples to follow.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["3.2"] },
    { "id": 3, "tasks": ["3.3", "3.4", "3.5"] },
    { "id": 4, "tasks": ["4.1", "4.2"] },
    { "id": 5, "tasks": ["4.3"] },
    { "id": 6, "tasks": ["4.4", "4.5", "4.6", "4.7", "4.8"] },
    { "id": 7, "tasks": ["4.9", "4.10"] },
    { "id": 8, "tasks": ["6.1", "6.2"] },
    { "id": 9, "tasks": ["6.3", "6.4", "6.7"] },
    { "id": 10, "tasks": ["6.5", "6.6"] },
    { "id": 11, "tasks": ["8.1", "8.2", "8.3", "8.4"] },
    { "id": 12, "tasks": ["9.1", "9.2", "9.3", "9.4"] }
  ]
}
```

The checkpoint tasks (5, 7, 10) are gates rather than work and carry no wave; each runs after the last wave of the step it closes.

The waves obey three constraints. **No two sub-tasks in one wave write the same file** — the two files written twice are `build-sequence.ts` (3.1 in wave 1, 3.2 in wave 2) and `framework.test.ts` (4.3 in wave 5, 8.4 in wave 11), and each pair sits in a different wave.

**Every source sub-task precedes the tests that assert against it, and every dependency precedes its consumer.** Tasks 1 and 2 come first because both must be written and run against unfixed code; 3.1 before 3.2, which builds the Prerequisite_Graph from the message builders 3.1 moved; 3.2 before 3.3, 3.4, and 3.5, all of which drive the pass; 4.1 and 4.2 before 4.3, because `framework.ts` cannot drop `buildPosition` until `build-plan.ts`'s `tscRootsOf` — its only production reader — is gone; 4.3 before wave 6, whose suites assert against the retired field and the new derivations; wave 6 before 4.9 and 4.10, which re-run the two pre-fix test sets over a complete fix; 6.1 before 6.4, so the order-source check is added to a repository it already passes rather than one it fails; 6.1 and 6.2 before 6.3 and 6.7, which assert over their edited sources.

**Wave 8 is where requirement 2.12 lives.** It is the first wave after 4.9 and 4.10 have confirmed the fix, and 6.1 is its first sub-task. Every earlier wave belongs to the primitive, the derivations, or the tests; nothing in waves 0 through 7 touches `scripts/start.js`.

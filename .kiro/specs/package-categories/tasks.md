# Implementation Plan: package-categories

## Overview

This plan follows the design's **Migration and Sequencing** section step for step. Its eight steps — the design's original six, plus step 7's correction to shipped code and step 8's platform-derived build order — are ordered so that every step ends on a tree that builds, with exactly one deliberate exception (step 4, the atomic core swap). The order is not negotiable and is not re-derived here. Plan step numbers and design migration step numbers do not line up from step 8 on; see the note below the table.

| Step | Parent task | Character |
| --- | --- | --- |
| 1 | Task 1 | Additive — `framework.ts`, nothing imports it |
| 2 | Task 3 | Backward-compatible — Emit_Script + empty `spa` category, both no-ops on the current tree |
| 3 | Task 5 | Additive — new Build_System modules, no production path imports them |
| 4 | Task 7 | **Atomic** — one parent, one verification gate, sub-tasks land together |
| 5 | Task 9 | Wire the repo-invariant checks into `npm run ci`, then fix what they name |
| 6 | Task 11 | Steering documents, last, so they describe what the repo does |
| 7 | Task 13 | **Correction to shipped code** — the build-phase order, the SPA dependency rules, and the build/stage separation, after steps 1–6 landed |
| 7 (cont.) | Tasks 13.10–13.11 | **Correction to shipped code** — the declared-name mirroring rule extends to every Consumer_Category |
| 8 | Task 15 | **Additive then a swap** — the platform-derived Workspace_Build_Order replaces a hand-maintained invariant |

Step 7 is not part of the design's original six-step migration. It was added after the spec was revised, and it carries two corrections at once. First, the Bundler_Build_Phase must run **after** the Tsc_Build_Pass, not before, and three dependency/import edges the shipped code does not reject are now failures. Second, the Dependency_Resolver must return **two** sets rather than one: the Required_Dependencies as the build set and the new Staged_Dependencies as the stage set. Both corrections touch `required-dependencies.ts` and `build-plan.ts`, so they land as a single pass whose sub-tasks are grouped by file — one set of edits per file, one gate — rather than as two sequential steps that would rewrite the same doc comments twice. It is a correction applied on top of a tree that already builds, so its sub-tasks are independently shippable and its gate is the ordinary one.

Step 7 also carries a third, much smaller correction, folded in as tasks 13.10–13.11 rather than given a step of its own: R3.6 and R4.5 now apply the declared-name mirroring rule to **every** Consumer_Category, Microservice_Packages included, where the shipped code checks Common and Spa only. It is one predicate in `discovery.ts` plus the restated Property 8, it touches a file no other step-7 sub-task touches, and it is vacuous on the current tree, so it rides along under step 7's ordinary gate.

**Plan step 8 (task 15) implements the design's *migration step 5*, and the numbering deliberately does not line up.** design.md's Migration and Sequencing section now has seven steps, because a new step 5 — "Re-point the root scripts at the derived Workspace_Build_Order" — was inserted ahead of the former steps 5 and 6, which became 6 and 7. This plan cannot renumber to match: its tasks 1–12 are already executed and its task 13 already occupies the last position, so inserting a parent task in the middle would renumber executed work and misrepresent what was done. Plan step 8 is therefore the *last* step here and the *fifth* step there. Nothing about the ordering constraint is lost by the mismatch: design migration step 5 only has to land after the core swap (plan step 4 / task 7) and after the invariant checks are wired (plan step 5 / task 9), and as the final step it does.

**What step 8 is, in one sentence: it deletes an invariant instead of adding one.** Every other step in this plan makes a previously-silent mistake loud. Step 8 removes a hand-maintained obligation — the root `workspaces` array's topological entry order — by deriving the build order from the `@microservices`-scoped `dependencies` each package already declares. The array keeps one obligation only, Workspace_Coverage (R12.15, R12.16), and the ordering check written in task 5.11 is narrowed to a coverage check accordingly. A package author's whole obligation becomes one `dependencies` entry: no `tsconfig.json` `references`, no `tsc -b` in a consumer, no registration list, no array position (R12.4, R12.14).

**The verification gate at the end of every step** (the checkpoint tasks below) is:

1. `npm run ci`
2. `MICROSERVICES='*' sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES='*' .`
3. `MICROSERVICES='microservice1,microservice2' sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES='microservice1,microservice2' .`

From step 4 onward the gate additionally includes `npm start` and a short `npm run dev` session with one source edit (R14.11, R14.12).

Every property test carries the tag comment `// Feature: package-categories, Property {number}: {property_text}` and runs at `numRuns: 200`, matching the existing Build_System suites.

## Tasks

- [x] 1. Step 1 — Introduce the Framework_Constants_Module (inert)

  - [x] 1.1 Create `packages/build-tools/src/framework.ts`
    - Declare `WORKSPACE_SCOPE`, `PACKAGES_DIR`, the `FrameworkStaging` / `FrameworkBuildPosition` / `FrameworkSingleton` types, the four singleton records `CONTRACTS` (scoped-node-modules, first), `OVERSEER` (package-dir, last), `BUILD_TOOLS` (none, excluded), `INTEGRATION_TESTS` (none, excluded)
    - Export `FRAMEWORK_SINGLETONS` as one ordered collection of exactly those four, `frameworkSingletonByName`, `ALWAYS_STAGED_SCOPED_ENTRIES`, and `OVERSEER_ENTRYPOINT` **composed** from `OVERSEER.packageDir`
    - Export `ConsumerCategory`, `CONSUMER_CATEGORIES`, and `NAMESPACE_CONTAINER` for the three container directories
    - Implement `assertFrameworkDirectoriesPresent(exists)` raising `[framework:missing]` and naming every absent singleton with its declared directory
    - Add the cross-reference comment pointing at `scripts/emit-effective-dockerfile.sh`, which cannot import this module
    - Nothing imports this file yet — it is purely additive
    - _Requirements: 1.2, 5.1, 10.1, 10.6, 10.7_

  - [x] 1.2 Write the `framework.ts` surface unit test
    - File: `packages/build-tools/tests/framework.test.ts`
    - Assert `FRAMEWORK_SINGLETONS` enumerates exactly the four expected names in a fixed, repeatable order and yields no other value
    - Assert `OVERSEER_ENTRYPOINT` equals `packages/overseer/dist/index.js` and that `ALWAYS_STAGED_SCOPED_ENTRIES` holds exactly the singletons whose `staging` is `scoped-node-modules`
    - Assert `NAMESPACE_CONTAINER` covers all three Consumer_Categories
    - _Requirements: 10.1, 10.6_

  - [x] 1.3 Write the property test for framework-directory presence
    - File: `packages/build-tools/tests/framework.property.test.ts` (the Testing Strategy table assigns Property 27 no file; this is its home)
    - **Property 27: An absent Framework_Singleton directory fails, naming it**
    - Generate arbitrary subsets of the four declared directories as "present"; assert success exactly when all four are present, and otherwise a `[framework:missing]` failure naming every absent singleton and its declared directory
    - _Requirements: 10.7_

- [x] 2. Checkpoint — step 1 verification gate
  - Run `npm run ci` and both documented two-command container builds. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 14.6, 14.8_

- [x] 3. Step 2 — Emit_Script and the `spa` category (backward-compatible)

  - [x] 3.1 Update `scripts/emit-effective-dockerfile.sh`
    - Add `LC_ALL=C; export LC_ALL` near the top so glob expansion sorts by byte value
    - Replace `name=$(basename "$dir")` with pure parameter expansion (`name=${dir%/}; name=${name##*/}`)
    - Add `COMMON_DIRS` (`for dir in packages/common/*/`) and `SPA_DIRS` (`for dir in packages/spa/*/`) loops, each with the existing `[ -f "$dir/package.json" ] || continue` guard, and export both alongside `PKG_DIRS` and `MS_DIRS`
    - Extend the awk top-level exclusion condition to the four entries `integration-tests`, `microservices`, `common`, `spa`, applied **only** to the top-level `pkg[]` loop
    - Order the Manifest_Copy_Block: root manifest, non-excluded top-level packages, then one group per container in the fixed order microservices, common, spa
    - Keep the single `awk` pass, the temp-file-then-`mv` discipline, the anchor validation, the selector resolution, and the toggle-default `ENV` block untouched
    - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6, 11.7, 11.10_

  - [x] 3.2 Verify the emitted `Dockerfile` is byte-identical before and after
    - This is the acceptance check of step 2: on the current tree (`packages/common/` absent, `packages/spa/` empty) the new script must produce byte-identical output to the old one
    - Emit with the pre-change script for `MICROSERVICES='*'` and for `MICROSERVICES='microservice1,microservice2'`, save each output outside the working tree, emit again with the updated script, and `diff` each pair — both diffs must be empty
    - Confirm the blocks at the `# --- MANIFEST_COPY_BUILD ---` and `# --- MANIFEST_COPY_PRODDEPS ---` anchors remain character-identical to each other
    - _Requirements: 11.2, 11.6, 11.9, 14.6_

  - [x] 3.3 Create the empty `spa` Namespace_Container and register it
    - Create `packages/spa/.gitkeep` (git cannot track an empty directory; discovery ignores it twice over — not a directory, and dot-prefixed) and add no `package.json` at `packages/spa/`
    - Add `"packages/spa/*"` to the root `package.json` `workspaces` array in topological position, ahead of `packages/microservices/*` and `packages/overseer`
    - Run `npm install` and confirm exit status 0 with the glob matching zero directories
    - _Requirements: 9.2, 9.4, 12.3_

  - [x] 3.4 Write the `packages/spa/` structural example test
    - File: `packages/integration-tests/tests/package-categories-layout.test.ts`
    - Assert `packages/spa/` exists, holds zero qualifying subdirectories, and has no `package.json`
    - _Requirements: 9.2_

  - [x] 3.5 Write the Emit_Script property test
    - File: `packages/integration-tests/tests/emit-dockerfile.property.test.ts` (integration-shaped: it drives the real shell script against generated temp repository skeletons)
    - **Property 24: The Emit_Script emits one `COPY` per discovered non-excluded manifest at both anchors**
    - Vary: containers present / absent / empty, arbitrary member directories, members holding no `package.json`, members named after an excluded top-level entry; assert exactly one `COPY` line per directory directly holding a readable `package.json` that is not an excluded top-level entry, character-identical blocks at both anchors, the fixed group order with ascending byte order within each group, and byte-identical output across two consecutive runs
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.10_

  - [x] 3.6 Extend `packages/integration-tests/tests/effective-dockerfile.test.ts` for the new exclusions
    - Add a case asserting the four-entry Exclusion_List contributes no `COPY` line for `integration-tests`, `microservices`, `common`, or `spa` as top-level entries
    - Add a case asserting an empty `packages/spa/` contributes no `COPY` line and the script still exits zero
    - Leave the existing anchor-failure cases untouched — they are the R11.9 evidence
    - _Requirements: 11.3, 11.5, 11.9_

- [x] 4. Checkpoint — step 2 verification gate
  - Run `npm run ci` and both documented two-command container builds; confirm the step 3.2 diffs were empty. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 9.3, 9.4, 14.6, 14.8_

- [x] 5. Step 3 — Add the new Build_System modules (inert)

  - [x] 5.1 Create `packages/build-tools/src/discovery.ts`
    - Implement `discoverPackagesFrom(listContainer, readManifest)` — pure core — plus the `discoverPackages()` effect shell supplying `readdirSync(withFileTypes)` / `readFileSync`
    - Location-based membership: direct entries of each `NAMESPACE_CONTAINER` that resolve to a directory and whose name does not begin with `.`, sorted by ascending code point; nothing two or more levels deep; no manifest field participates
    - Build the `Discovery` shape: `byCategory`, `nameByDir` (byte-exact declared names), `byName` (injective resolution index)
    - Implement the five-stage validation pipeline, each stage collecting **every** offender before failing: `[discovery:manifest]` (the `ManifestRead` union distinguishes absent / unreadable / unparsable), `[discovery:name]`, `[discovery:mirror]` (Common and Spa only), `[discovery:duplicate]`, `[barrel:invalid]` (Common `main`/`types` and Spa `scripts.build` in one failure, sorted by `dirName` then `packageDir`)
    - Raise `[discovery:container-missing]` for an absent `packages/microservices/`; tolerate absent or empty `common` and `spa` silently
    - Implement `buildKindOf(category)` (total, category alone) and `readDependencySpecifiers(packageDir)` as the single `@microservices`-scope dependency reader
    - Import every framework name and container directory from `framework.ts`; declare none of those literals here
    - No production path imports this file yet
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.9, 1.10, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 3.1, 3.4, 3.5, 3.6, 3.9, 3.10, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.2, 6.1, 6.2, 9.1, 9.6, 9.8, 10.4_

  - [x] 5.2 Write the discovery category property tests
    - File: `packages/build-tools/tests/discovery.categories.property.test.ts`
    - **Property 1: Location determines Package_Category, exactly once**
    - **Property 2: Manifest fields cannot change a category or a staged set**
    - Vary container membership, entries named after a Framework_Singleton, and mutations of `main` / `types` / `bin` / `dependencies` shape
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 2.8, 2.9, 2.10, 5.1, 5.2_

  - [x] 5.3 Write the container-entry enumeration property test
    - File: `packages/build-tools/tests/discovery.entries.property.test.ts`
    - **Property 3: Discovery enumerates exactly the qualifying direct entries, in code-point order**
    - Vary entry kinds (directories, regular files), dot-prefixed names, nesting depth two or more, and shuffled listing order; assert deeper directories are excluded and treated as private content of their nearest depth-1 ancestor
    - _Requirements: 1.4, 1.10, 2.1, 2.2, 2.3, 2.4, 2.5, 9.1, 9.6, 9.8_

  - [x] 5.4 Write the container-presence property test
    - File: `packages/build-tools/tests/discovery.containers.property.test.ts`
    - **Property 4: An absent or empty consumer container is tolerated; an absent microservices container is not**
    - Vary each container across present / empty / absent; assert zero members with no diagnostic for `common` and `spa`, other categories unaffected, and a failure naming the directory when `microservices` is absent
    - _Requirements: 1.9, 2.6, 2.7, 9.3_

  - [x] 5.5 Write the Package_Name_Lookup property tests
    - File: `packages/build-tools/tests/discovery.names.property.test.ts`
    - **Property 5: The Package_Name_Lookup records exactly and resolves only on exact equality**
    - **Property 6: Duplicate declared names fail, naming every declaring directory**
    - **Property 7: An unusable or nameless manifest fails, naming the directory and the condition**
    - **Property 8: A Common or Spa package's declared name must mirror its directory**
    - Vary declared name values, case-flipped / prefixed / suffixed / whitespace-padded near-miss specifiers, cross-container collisions, and the three manifest-read outcomes
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.9_

  - [x] 5.6 Write the category-contract validation property test
    - File: `packages/build-tools/tests/discovery.validation.property.test.ts`
    - **Property 9: Category-contract validation is exact, total, and reported once**
    - Vary the `main` / `types` / `scripts.build` state matrix across all three categories; assert Microservice_Packages and Spa barrel state are never reported, no offender is skipped, and every offender appears in one sorted, run-stable failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7_

  - [x] 5.7 Create `packages/build-tools/src/required-dependencies.ts` — the Dependency_Resolver
    - Implement `requiredDependencies(selected, discovery, readDependencies)`
    - Resolution order per specifier: Framework_Singleton name (resolved, not followed, not a member) → recorded declared name → otherwise `[shared:unresolved]`, **byte-identical to the current message**, with the retained `[shared:` prefix and the comment recording why it is not renamed
    - Phase 1: three-colour DFS with a live stack collecting the reachable subgraph, raising `[deps:cycle]` on a grey re-entry and naming every participant in cycle order
    - Phase 2: Kahn's algorithm over the induced subgraph with a lexicographically-ordered ready queue, yielding the unique lexicographically-least topological order
    - Exclude the Selected_Microservices, the Overseer, and every Framework_Singleton from the result; raise `[deps:peer]` for a specifier resolving to a Microservice_Package
    - Ignore every non-`@microservices` `dependencies` key without attempting resolution
    - _Requirements: 3.2, 3.3, 3.7, 3.8, 3.10, 5.3, 5.7, 7.1, 7.2, 7.10, 13.11, 14.5_

  - [x] 5.8 Write the Required_Dependencies property tests
    - File: `packages/build-tools/tests/required-dependencies.property.test.ts`
    - Carry over the in-memory graph generator and reference reachability oracle from the retired `shared-packages` dependency-walk suite, re-modelled from `Map<name, SharedPackage>` onto a `Discovery`; preserve the dangling-dependency block as-is because its `[shared:unresolved]` assertion is a pinned contract
    - **Property 10: A Framework_Singleton specifier resolves and never becomes a required dependency**
    - **Property 11: An unresolvable specifier fails with the preserved message; unscoped keys are ignored**
    - **Property 12: The Required_Dependencies equal the reachability oracle**
    - **Property 13: The Required_Dependencies are in the lexicographically-least topological order** — strengthen the inherited ordering block with a Kahn-with-sorted-ready-queue oracle, not only "every dependency precedes its dependents"
    - **Property 14: A dependency cycle fails, naming every participant** — inject cycles of length 1 through k
    - Add a block for `[deps:peer]`
    - _Requirements: 3.7, 3.8, 3.10, 5.3, 5.4, 5.7, 7.1, 7.2, 7.10, 8.12, 13.11, 14.5_

  - [x] 5.9 Create `packages/build-tools/src/build-plan.ts` — the one shared derivation
    - Implement `buildPlanFrom(selector, discovery, readDependencies)` composing `resolveSelected` and `requiredDependencies` and reimplementing neither, plus the `buildPlan(selector?)` real-filesystem wrapper
    - Produce `selected`, `requiredDependencies`, `spaBuilds` (required dependencies whose Build_Kind is Bundler_Project), `tscRoots` (`packages/contracts` first, then the Required_Dependencies filtered to `tsc-project`, then the Selected_Microservices in Selector order, then the Overseer last), and `stage` (always-staged Framework_Singletons, then the Required_Dependencies in required-dependency order, then the Selected_Microservices, then the Overseer at its package directory) with `StagedPackage.justification` recording why each entry is there
    - Root uniqueness falls out of the exclusions rather than being enforced; no Spa_Package can reach `tscRoots`
    - _Requirements: 5.4, 5.5, 5.6, 6.3, 6.4, 6.6, 6.7, 7.3, 7.4, 7.5, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9_

  - [x] 5.10 Write the BuildPlan property tests
    - File: `packages/build-tools/tests/build-plan.property.test.ts`
    - **Property 15: Build_Kind is total and determined by category alone**
    - **Property 16: The `tsc --build` roots are exactly the Selector-justified Tsc_Projects, correctly ordered**
    - **Property 18: The Spa build set equals the required Spa_Packages, each built once in its own directory**
    - Vary Selectors and layouts with and without Spa members; assert no `packages/build-tools` or `packages/integration-tests` root and determinism across repeated derivations
    - _Requirements: 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 9.7, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9_

  - [x] 5.11 Create `packages/build-tools/src/repo-invariants.ts`
    - Implement `checkWorkspaceOrder(entries, packages)` returning one `[workspaces:order]` message per violation and mutating nothing: `packages/contracts` at index 0, `packages/integration-tests` last, `common/*` and `spa/*` before `microservices/*` and `overseer`, `microservices/*` before `overseer`, exactly one matching entry per package directory, `entryIndex(Q) < entryIndex(P)` for every resolved `P → Q`, and the shared-entry violation naming both packages and the shared entry; every rule involving a zero-match glob is treated as satisfied
    - Implement `checkImportDiscipline(discovery, files, readSource)` returning `[imports:escape]` for relative specifiers escaping the importing package's directory and `[imports:peer]` for a Microservice_Package naming a peer or the Overseer
    - Implement `checkDependencyDirection(discovery)` returning `[deps:direction]` for a Common_Package depending on a Microservice_Package or the Overseer
    - All three pure over injected inputs
    - _Requirements: 8.9, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.11, 14.4, 14.5, 14.10_

  - [x] 5.12 Write the Workspace_Build_Order property test
    - File: `packages/build-tools/tests/workspace-order.property.test.ts`
    - **Property 23: The Workspace_Build_Order check verdict equals the rule oracle**
    - Vary `workspaces` arrays × dependency graphs, zero-match globs, and shared-entry edges; assert the verdict matches an independently written rule oracle and each message names the depending package, the depended-on package, and the two entries (or the shared entry)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.11_

  - [x] 5.13 Write the import-discipline and dependency-direction property tests
    - File: `packages/build-tools/tests/repo-invariants.property.test.ts`
    - **Property 25: Import discipline is enforced over every Consumer_Package source**
    - **Property 26: A Common_Package's declared dependencies point downward only**
    - Vary generated file / specifier sets and manifests; assert nothing is reported for a legal by-name import from a package permitted to depend on the target
    - _Requirements: 8.9, 14.4, 14.5, 14.10_

  - [x] 5.14 Create `packages/build-tools/src/bin/check-repo-invariants.ts`
    - Run all three checks over the real tree (root `workspaces` array, a filesystem walk of each discovered package's `src/` and tests, `discoverPackages()`), write every message from every check to stderr, and exit 1 when any list is non-empty
    - Register the bin in `packages/build-tools/package.json` alongside the existing entry points; do **not** wire it into `npm run ci` yet — that is step 5
    - _Requirements: 8.9, 12.8, 12.9, 14.10_

  - [x] 5.15 Write the bin exit-behavior example test
    - File: `packages/build-tools/tests/check-repo-invariants.test.ts`
    - Assert exit 0 on a clean generated tree and exit 1 with every message present on a tree seeded with one violation of each of the three checks
    - _Requirements: 12.8_

  - [x] 5.16 Write the absent-microservices-container example test
    - File: `packages/build-tools/tests/discovery-container-missing.test.ts`
    - Assert `[discovery:container-missing]` naming `packages/microservices` and that no discovery result is returned for any category
    - _Requirements: 2.7_

- [x] 6. Checkpoint — step 3 verification gate
  - Run `npm run ci` and both documented two-command container builds. The new modules are inert; also run `discoverPackages()` against the real tree and confirm it finds zero Common_Packages and zero Spa_Packages, which checks Property 4 against reality before anything moves. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 2.6, 9.3, 14.6, 14.8_

- [x] 7. Step 4 — The atomic core swap

  > **This parent task cannot be split into independently-shippable pieces, and the verification gate applies to the parent, not to each sub-task.** The moment location-based discovery becomes authoritative, `contracts` and `config` change status simultaneously: `contracts` leaves the discovered set and `config` is only discoverable from `packages/common/config/`. Wiring the new discovery without moving `config` loses `config` from the Required_Dependencies, the build order, and the image; moving `config` without wiring the new discovery loses it from `classify()`'s `packages/*` scan. Either half alone leaves `microservice2` and `microservice3` with no compiled `@microservices/config` to link against. **Sub-tasks 7.1 through 7.18 must all complete before the tree builds again.** Do not run the gate between them and do not ask CI to prove an intermediate state. If further de-risking is needed, the only clean seam is 7.1–7.3 (the move) and 7.4–7.18 (the rewiring) as two commits on one branch merged as a unit.

  - [x] 7.1 Relocate `packages/config/` to `packages/common/config/`
    - `git mv packages/config packages/common/config`, moving `package.json`, `tsconfig.json`, `src/index.ts`, and `tests/build-config-payload.property.test.ts` byte-unchanged
    - Then **`rm -rf packages/config`**: `git mv` moves only tracked files, so the untracked `packages/config/dist/` and `packages/config/tsconfig.tsbuildinfo` are left behind as an orphan directory. **Neither artifact may be carried to the new location** — `*.tsbuildinfo` must stay untracked (a committed buildinfo makes `tsc` trust it over the gitignored, therefore absent, `dist/` on a fresh clone and skip emitting), and a stale buildinfo whose recorded `rootDir` is `packages/config/src` would suppress the first emit at the new path. The new location must build from nothing.
    - Confirm `packages/config` no longer exists and that no `dist/` or `tsbuildinfo` was committed at the new path
    - Make no edit to the relocated `package.json` (same `name`, `type`, `main`, `types`, four scripts) and no edit to `microservice2` or `microservice3`
    - _Requirements: 8.1, 8.2, 8.6, 8.7, 8.10, 14.4_

  - [x] 7.2 Deepen `packages/common/config/tsconfig.json`
    - Change `extends` to `../../../tsconfig.base.json` — one extra level for the extra directory depth — leaving `outDir`, `rootDir`, and `include` unchanged
    - _Requirements: 8.3_

  - [x] 7.3 Update the root `workspaces` array and reinstall
    - Remove `packages/config`; add `packages/common/*` in topological position, giving the final order `packages/contracts`, `packages/build-tools`, `packages/common/*`, `packages/spa/*`, `packages/microservices/*`, `packages/overseer`, `packages/integration-tests`
    - Run `npm install` so the `@microservices/config` workspace link retargets to `packages/common/config`
    - _Requirements: 8.4, 12.1, 12.2, 12.3, 12.4, 12.5, 12.7_

  - [x] 7.4 Rewire `packages/build-tools/src/image-tree.ts`
    - `buildImageTree` becomes a plan executor in this fixed order: `assertFrameworkDirectoriesPresent(existsSync)` → `discoverPackages()` → `generateRegistry(selector, discovery)` → `buildPlanFrom(...)` → one `npm run build` per `plan.spaBuilds` in that package's own directory → a single `npx tsc --build ...plan.tscRoots` → `assertBuildOutputsPresent` → `rmSync(outDir)` → `copyPackage` per `plan.stage` → `assertImageTreeIntegrity`
    - Add `assertBuildOutputsPresent(plan, exists, isNonEmptyDir)` raising `[image-tree:framework-output]` for a framework member and `[image-tree:no-dist]` otherwise, naming every offender, **before the first copy**
    - Add `assertImageTreeIntegrity(outDir, plan, listScopedEntries)` that **enumerates** the real direct entries under `<outDir>/node_modules/@microservices/` and checks them against the justified union in both directions: `[image-tree:unjustified]` first, then `[image-tree:missing]`, each naming every offender, sorted
    - Delete `assertNoUnselectedMicroservice`, `assertNoNonRequiredSharedPackage`, `readSharedDeps`, and the local `WORKSPACE_SCOPE`; take the Overseer package directory, the container directories, and the scope from `framework.ts`
    - Leave `copyPackage` unchanged — that is what keeps the staged `contracts` file set byte-identical including `dist/testing/`
    - _Requirements: 5.6, 5.8, 5.9, 5.10, 6.5, 6.8, 6.9, 6.10, 6.11, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.11, 10.2_

  - [x] 7.5 Rewire `packages/build-tools/src/dev-supervisor.ts`
    - `projectListFrom(selector, discovery, readDependencies)` returns `buildPlanFrom(...).tscRoots` — the same array, not a parallel derivation; `devProjectList` supplies `discoverPackages()` and `readDependencySpecifiers`
    - Delete `readSharedDependencies`, `OVERSEER_PACKAGE_DIR`, `WORKSPACE_SCOPE`, and `OVERSEER_ENTRYPOINT`, sourcing the first three from `framework.ts` and the reader from `discovery.ts`
    - Leave `decide`, `reduceDevEvents`, and `runDevSupervisor` untouched; keep `discoverPackages()` called exactly once per Dev_Session at startup, so nothing re-lists in the steady state
    - Keep Selector and resolution failures written to stderr verbatim with no `[dev]` framing
    - _Requirements: 10.3, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 13.10, 13.11, 14.12_

  - [x] 7.6 Rewire `packages/build-tools/src/generate-registry.ts`
    - `generateRegistry(selector, discovery = discoverPackages())` takes the `Discovery`; delete `listMicroserviceDirectories` and use `discovery.byCategory.microservice.map((p) => p.dirName)`, already sorted exactly as the old `.sort()` produced
    - Compose `OUTPUT_PATH` from `OVERSEER.packageDir` so `packages/overseer` appears once
    - Keep the emitted text unchanged: one `import * as mN from "@microservices/<dirName>"` per Selected_Microservice and one entry with the same three fields — the specifier stays directory-derived
    - Registry generation now sits downstream of discovery validation so an unusable manifest produces no registry
    - _Requirements: 3.4, 10.4, 14.2_

  - [x] 7.7 Delete `packages/build-tools/src/shared-packages.ts`
    - The whole module goes, `classify()` included. No manifest-shape membership predicate remains anywhere in the Build_System
    - _Requirements: 2.8, 2.9, 2.10_

  - [x] 7.8 Retire the three `shared-packages.*` test suites
    - Delete `packages/build-tools/tests/shared-packages.discovery.property.test.ts` — it is a property test *of* `classify()`, its oracle re-implementing the removed manifest-shape rule; coverage now lives in `discovery.categories.property.test.ts` and `discovery.entries.property.test.ts`
    - Delete the retired `shared-packages` dependency-walk property suite, confirming its generator, its reference oracle, and its pinned `[shared:unresolved]` block were carried into `required-dependencies.property.test.ts` in task 5.8
    - Delete `packages/build-tools/tests/shared-packages.order.property.test.ts`, confirming its DAG-ordering block is now the strengthened Property 13 block of `required-dependencies.property.test.ts` and its concrete `workspaces` block is superseded by `workspace-order.property.test.ts` plus the committed-manifest example, with its `packages/config` literals retargeted to `packages/common/config`
    - _Requirements: 3.8, 7.2, 13.11_

  - [x] 7.9 Rewrite `packages/build-tools/tests/image-tree-minimality.test.ts`
    - Retarget from the deleted `assertNoNonRequiredSharedPackage` to `assertImageTreeIntegrity`, keeping the real temp-`outDir` approach
    - Add the completeness case the old two-guard design could not express: a required entry absent → `[image-tree:missing]`
    - Update the pinned message expectations to the new `[image-tree:unjustified]` / `[image-tree:missing]` shapes (this diagnostic is Build_System-internal and is not one of the two preserved contracts)
    - _Requirements: 7.7, 7.8, 7.9, 7.11_

  - [x] 7.10 Write the Image_Tree integrity property tests
    - File: `packages/build-tools/tests/image-tree.integrity.property.test.ts`
    - **Property 19: A package is staged if and only if the Selector justifies it**
    - **Property 21: A planned package with no build output fails before anything is staged**
    - **Property 22: The Integrity_Assertion is sound and complete over the enumerated entries**
    - Vary plans × actual-entry sets with injected strays (including entries belonging to no discovered category) and omissions
    - _Requirements: 5.6, 5.9, 5.10, 6.11, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9, 7.11, 8.11, 8.12, 9.7_

  - [x] 7.11 Write the staging file-set property test
    - File: `packages/build-tools/tests/image-tree.staging.property.test.ts`
    - **Property 20: A staged package contributes exactly its manifest plus its `dist/` contents**
    - Generate synthetic package source trees in a real temp directory with arbitrary extra files and directories alongside `package.json` and `dist/`; assert the staged path set equals `package.json` plus every file under `dist/`, for every category
    - _Requirements: 6.8_

  - [x] 7.12 Write the dev/image parity property test
    - File: `packages/build-tools/tests/dev-image-parity.property.test.ts`
    - **Property 17: The dev Project_List equals the image `tsc --build` roots**
    - Vary Selectors × layouts; invoke **both** derivations and assert deep array equality element for element and in the same order
    - _Requirements: 13.1, 13.2, 13.8_

  - [x] 7.13 Update `packages/build-tools/tests/dev-project-list.property.test.ts`
    - Adapt to the new `projectListFrom(selector, discovery, readDependencies)` signature, replacing the old `(selector, directories, shared, readDependencies)` call shape
    - Keep the membership/order oracle and the selector-equivalence block, and keep the `packages/build-tools` / `packages/integration-tests` exclusion assertions
    - _Requirements: 13.3, 13.4, 13.5, 13.6, 13.7_

  - [x] 7.14 Update the two registry-generator property tests
    - Files: `packages/build-tools/tests/registry-generator.property.test.ts` and `packages/build-tools/tests/registry-generator.unmatched.property.test.ts`
    - Adapt to the generator's new `discovery` parameter while asserting the emitted text is unchanged
    - Extend the generators so layouts include Common and Spa members, asserting the registry's identifier set stays exactly the microservice directory names and is disjoint from every other category
    - _Requirements: 14.2_

  - [x] 7.15 Retarget `packages/integration-tests/tests/shared-package-conventions.test.ts`
    - Rename the file to `common-package-conventions.test.ts` and retarget every assertion from `packages/config` to `packages/common/config`, restating the conventions in Common_Package terms
    - Keep the `workspaces`-order block as a committed-manifest example asserting the final array order, now that the automated check supersedes it as the general rule
    - _Requirements: 8.8, 8.9, 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 7.16 Retarget `packages/integration-tests/tests/shared-package-staging.test.ts`
    - Retarget the staged `config` assertions to the relocated package and update the `contracts` comments to say it is justified as a Framework_Singleton rather than as a required dependency, even where the assertions themselves do not change
    - Keep the real-directory (not symlink) assertions and the "staged when `microservice2`/`microservice3` is selected, absent otherwise" cases
    - _Requirements: 5.6, 5.10, 8.8, 8.11, 8.12_

  - [x] 7.17 Update `packages/integration-tests/tests/dev-cold-start.test.ts`
    - Replace `packages/config` with `packages/common/config` in the pinned `PROJECT_LIST_PACKAGES` array, leaving the rest of the pinned six-entry order intact
    - _Requirements: 8.8, 13.5, 13.8_

  - [x] 7.18 Retarget the `packages/common/config` COPY expectation in `effective-dockerfile.test.ts`
    - Change the `COPY packages/config/package.json packages/config/` expectation to `COPY packages/common/config/package.json packages/common/config/` and assert it appears at both anchor positions
    - _Requirements: 8.8, 11.8_

  - [x] 7.19 Write the real-tree discovery and migration-facts example tests
    - Files: `packages/build-tools/tests/discovery-real-tree.test.ts` and `packages/integration-tests/tests/migration-facts.test.ts`
    - Real-tree discovery: `discoverPackages()` over the committed repository yields exactly the four rows of the design's Data Models table, no framework directory among them, and no `build-tools` entry despite its `main`/`types`
    - Migration facts: `packages/common/config/` holds `package.json`, `tsconfig.json`, `src/`, `tests/`; its `extends` is `../../../tsconfig.base.json`; the relocated manifest declares the same `name`, `type`, `main`, `types`, and four scripts; both consumers still declare `@microservices/config`
    - No stale path references: scan `packages/build-tools/src/`, `scripts/`, `Dockerfile.template`, the root manifest, and every test source for zero occurrences of the string `packages/config`, and assert the directory is absent
    - _Requirements: 2.10, 4.6, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 8.10_

  - [x] 7.20 Write the relocated barrel export-equality tests
    - Files: `packages/common/config/tests/barrel-surface.test.ts` and `packages/common/config/tests/barrel-surface.test-d.ts`
    - Assert the barrel exports exactly `sampleConfig`, `buildConfigPayload`, `SampleConfig`, `ConfigPayload` and nothing else, with the type signatures pinned by `*.test-d.ts` assertions run under `npm run test:types` (adding the typecheck-only project config that `packages/contracts/` already models, if the relocated package has none)
    - _Requirements: 8.7_

  - [x] 7.21 Write the Spa build sequencing and build-failure example tests
    - File: `packages/build-tools/tests/spa-build-sequencing.test.ts`
    - With an injected command runner recording the invocation sequence: every Spa build precedes the single `tsc --build`; a non-zero Spa build prevents `tsc --build` entirely and stages nothing; a non-zero `tsc --build` stages nothing
    - _Requirements: 6.5, 6.9, 6.10_

  - [x] 7.22 Write the baseline-equivalence integration tests
    - File: `packages/integration-tests/tests/baseline-equivalence.test.ts`
    - Registry equivalence: generate for `*` and for `microservice1,microservice2` and compare against the expected text — same specifier set, same per-entry field set as the Pre_Change_Baseline
    - Image_Tree equivalence: assemble for both shipped Selectors and assert the scoped entry set equals the baseline set plus `config` where it is a required dependency, each entry is a real directory rather than a symlink, and the Overseer sits at `packages/overseer/`
    - `contracts` staged file set: for both Selectors the sorted tree-relative path set under `node_modules/@microservices/contracts` equals `package.json` plus every file of `dist/`, `dist/testing/` included
    - _Requirements: 5.6, 5.8, 7.6, 14.2, 14.7_

- [x] 8. Checkpoint — step 4 verification gate (the atomic step's single gate)
  - Run `npm run ci` and both documented two-command container builds; from this step onward also run `npm start` and a short `npm run dev` session with one source edit
  - Additionally confirm: the generated registry text for both shipped Selectors is unchanged from the baseline; the scoped entry sets of both Image_Trees match the baseline plus `config`; the staged `contracts` file set matches the baseline list including `dist/testing/`; and every unmodified `integration-tests` suite (endpoint contracts, routing, toggles, collision abort, dev lifecycle, specific-container 404) still passes untouched — any edit one of them needs is a signal that runtime behavior moved
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 14.1, 14.2, 14.3, 14.6, 14.7, 14.8, 14.11, 14.12_

- [x] 9. Step 5 — Wire the repository-invariant checks into `npm run ci`

  - [x] 9.1 Add `check:invariants` to the root scripts and insert it into `ci`
    - Add `"check:invariants": "node packages/build-tools/dist/bin/check-repo-invariants.js"` to the root `package.json`
    - Make `ci` read `npm run build --workspaces && npm run check:invariants && npm run typecheck --workspaces && npm run lint --workspaces && npm test && npm run test:types` — after the build, because the bin is compiled output, and before the slower gates so an ordering mistake fails fast
    - _Requirements: 12.8, 14.8, 14.10_

  - [x] 9.2 Fix every violation the check reports
    - **Expect this to surface existing violations rather than pass immediately.** The workspaces-order check is the first automated statement of rules the repository has only ever upheld by convention, and the import-discipline check is the first automated statement of R14.4/R14.5
    - Run `npm run check:invariants`, then fix what each message names: `[workspaces:order]` by reordering the root `workspaces` array, `[imports:escape]` and `[imports:peer]` by rewriting the offending import specifiers to by-name imports, `[deps:direction]` by removing an upward dependency from a Common_Package manifest
    - Re-run until the bin exits 0, then re-run the full gate
    - _Requirements: 8.9, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 14.4, 14.5, 14.10_

  - [x] 9.3 Write the CI-wiring example test
    - File: `packages/integration-tests/tests/ci-wiring.test.ts`
    - Assert the root `ci` script contains `check:invariants`, that it is positioned after `build --workspaces` and before `typecheck --workspaces`, and that `check:invariants` points at the compiled bin
    - _Requirements: 12.8, 14.10_

- [x] 10. Checkpoint — step 5 verification gate
  - Run `npm run ci` (now including the repository-invariant checks) and both documented two-command container builds, plus `npm start` and a short `npm run dev` session with one source edit. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 12.8, 14.6, 14.8, 14.10, 14.11, 14.12_

- [x] 11. Step 6 — Steering documents

  - [x] 11.1 Rewrite `.kiro/steering/structure.md` for the taxonomy
    - Name the framework/consumer taxonomy, list all four Framework_Singleton directories, list all three Consumer_Categories each paired with its Namespace_Container directory, and state the rule that the framework knows its own parts by name and discovers the consumer's parts by location
    - Update the layout listing to contain `packages/common/`, `packages/spa/`, and `packages/common/config/`, and no `packages/config/`
    - Give each of the three Consumer_Categories its path pattern, directory naming rule, whether a Barrel is required, the permitted dependency direction, whether and when the category ships into an image, and a "Where things go" entry
    - Replace the whole "Shared packages" section with the Common_Package guidance; remove any guidance placing a consumer library directly under `packages/` and any guidance tying a category to `main`/`types`
    - State the Exclusion_List in terms of the four excluded top-level entries `integration-tests`, `microservices`, `common`, `spa`, with the note that a Common_Package and a Spa_Package are never added because they ship
    - Record `contracts` as a Framework_Singleton known by name, excluded from every Consumer_Category, built and staged for every Selector, and record as an explicitly open question whether a types-only Framework_Singleton needs to ship, noting that its staging behavior is unchanged by this feature
    - Record the review-upheld convention that only the four Framework_Singleton directories and the three Namespace_Containers sit directly under `packages/`, and that no Build_System check validates it
    - _Requirements: 1.7, 15.1, 15.2, 15.3, 15.4, 15.7, 15.8, 15.9, 15.10_

  - [x] 11.2 Update `.kiro/steering/tech.md` for Build_Kind and build order
    - State the Build_Kind rule: every Framework_Singleton, Microservice_Package, and Common_Package is a Tsc_Project built through `tsc`; a Spa_Package is built through its own `npm run build` and is never a root of `tsc --build`
    - State the Workspace_Build_Order as an ordered list containing `packages/contracts`, `packages/common/*`, `packages/spa/*`, `packages/microservices/*`, `packages/overseer`, `packages/integration-tests` in the relative order the root manifest declares, with the reason a consumer listed before its dependency breaks a fresh-clone build
    - Repeat the `contracts` Framework_Singleton note and the open question about shipping a types-only package
    - Add `check:invariants` to the `npm run ci` command description
    - _Requirements: 15.5, 15.6, 15.7, 15.8_

- [x] 12. Final checkpoint — full verification gate
  - Run `npm run ci` and both documented two-command container builds, plus `npm start` and a short `npm run dev` session with one source edit. Read each Requirement 15 criterion against the edited steering documents, and review R10.2–R10.5 by eye: each framework literal should appear exactly once, in `framework.ts`. Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 14.6, 14.8, 14.9, 14.11, 14.12, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10_

- [x] 13. Step 7 — Correct the build-phase order, the SPA dependency rules, and the build/stage separation

  > **This step corrects shipped code, not pending work, and it lands two spec revisions in one pass.** Task 7.4 implemented `executeBuildPlan` with the Bundler_Build_Phase **before** the Tsc_Build_Pass, and task 7.21 wrote `spa-build-sequencing.test.ts` to pin that order; R6.5 has since been inverted, so bundlers run only after `tsc --build` exits zero and a Common_Package a Spa_Package imports is already compiled when the bundler reads it (R6.12, R6.13). Separately, task 5.7's resolver returns **one** dependency set where the spec now calls for **two**: the Required_Dependencies are the build set, and the new Staged_Dependencies are the stage set, reached by a traversal that *arrives at* a Spa_Package without expanding it — so a Common_Package reachable only by way of a Spa_Package is compiled and never shipped (R6.14, R7.13, R7.14). Alongside both: R7.12 rewords `[deps:peer]` to attribute no Package_Category to the declarer, R8.13 and R9.11 add two forbidden inbound-SPA edges, R9.9 fixes `microservice → spa` as staging-only, and R14.13/R14.14 add a fourth import-discipline rule.
  >
  > **The sub-tasks are grouped by file, and each source file is touched exactly once.** Both corrections land in `required-dependencies.ts` and `build-plan.ts`; sequencing them as two steps would mean editing the same doc comments twice and running two gates for one coherent change. One pass, one gate at task 14, one set of edits per file. They land on a tree that already builds, so the ordinary gate applies.
  >
  > Every property below carries the tag comment `// Feature: package-categories, Property {n}: {property_text}`, with the property text matching design.md's title **verbatim**, and runs at `numRuns: 200`.

  - [x] 13.1 Rework `packages/build-tools/src/required-dependencies.ts` in one pass
    - **The two forbidden inbound-SPA edges, in `resolveSpecifiers`.** A specifier declared by a Common_Package that resolves to a Spa_Package fails with `[deps:common-to-spa]`, naming the declaring Common_Package's repo-relative directory and the offending specifier, and stating that a Common_Package must point downward only and a Spa_Package exposes no importable API. A specifier declared by a Spa_Package that resolves to another Spa_Package fails with `[deps:spa-to-spa]`, naming **both** Spa_Package repo-relative directories and stating that code shared between two Spa_Packages belongs in a Common_Package each of them declares a dependency on — the remedy is the point of the message. Collect offenders the way the module already does for the peer rule (accumulate, sort, then throw on the first sorted offender) so the failure is run-stable; either failure returns no Required_Dependencies, so no Project_List and no Image_Tree follow. The exact target wording for both is in design.md's Error Handling catalog
    - **Reword `[deps:peer]` in `peerDependencyError`.** Replace the trailing `; microservices may not depend on each other` clause — it is false whenever the declarer is a Spa_Package, a Common_Package, or the Overseer. The replacement names only the declaring package's repo-relative directory and the offending specifier and attributes **no** Package_Category to the declarer; take the exact byte-level text from design.md's Error Handling catalog. Update the `@param`/doc comment to say the message covers every declarer kind, which is why one error suffices for all four
    - **Correct the cycle-scope comment.** It currently reads that cycles "can therefore only form among Common and Spa packages". With `common → spa` and `spa → spa` both rejected, a Spa_Package has no outbound edge the walk follows and is a traversal **leaf**, so a cycle can only form **among Common_Packages**. Restate the enumeration of why each other edge cannot close a cycle (microservice target → peer failure; Overseer or `contracts` → resolves as a Framework_Singleton and is not followed; `common → spa` and `spa → spa` → rejected outright) and keep the note that the colour walk is written generally anyway, with its property test injecting cycles of length 1 through k
    - **New: phase 3, the Staged_Dependencies.** `Subgraph` gains `rootReached`, the member `packageDir`s a Selected_Microservice or the Overseer names directly — phase 1 already resolves the roots' specifiers before it recurses and currently discards them, so it records them instead of re-reading a manifest. Add `stagedSubset(subgraph, required)`, a second walk over the already-collected subgraph seeded from `rootReached` that expands a member's `edges` only when that member's `category !== "spa"`, so a Spa_Package is **arrived at and included** and not expanded; the result preserves `required`'s relative order, so it is a subsequence of it and inherits the lexicographically-least topological order with no second sort. Add the `DependencySets { required, staged }` type and `resolveDependencySets(...)` running all three phases. Keep `requiredDependencies(...)` as a thin wrapper returning `.required` so every shipped caller and every existing property test keeps working
    - Phase 3 performs **no new manifest read, no new filesystem access, no re-resolution, and adds no new failure mode** — every specifier was already resolved or rejected in phase 1. Extend the `@throws` list on `requiredDependencies` and the resolution-order comment block to name `[deps:common-to-spa]` and `[deps:spa-to-spa]`, and record on `stagedSubset` why this is a second restricted-reachability walk rather than a flag threaded through one walk (a node reachable both ways would otherwise record an accident of visit order)
    - _Requirements: R6.14, R7.10, R7.12, R7.13, R7.14, R8.13, R9.11_

  - [x] 13.2 Split the build set from the stage set in `packages/build-tools/src/build-plan.ts`
    - `BuildPlan` gains `stagedDependencies`, the Staged_Dependencies and a subsequence of `requiredDependencies`; `buildPlanFrom` calls `resolveDependencySets` once and populates both fields from the one call, composing rather than reimplementing so `[selector:unmatched]`, `[selector:empty]`, and `[shared:unresolved]` still surface unchanged
    - `stageOf` derives its Consumer_Package group from the **stage** set (`stagedDependencies`, Common *and* Spa, in that set's order); the Framework_Singleton and Selected_Microservice groups are untouched by the split. `tscRootsOf` and `spaBuilds` keep deriving from the **build** set (`requiredDependencies`) and from nothing else
    - State the asymmetry in the module prose as the one thing to remember about the module: **root membership comes from the build set, staging comes from the stage set.** Root membership is by Build_Kind alone and asks nothing about *who* reached a required dependency, so a Common_Package reachable only through a Spa_Package is a `tsc --build` root exactly as one reached from a microservice is, and is staged nowhere. Both fields sit on the plan so neither consumer re-derives anything and a reader can diff the two lists to see precisely which packages are compiled without shipping. On a layout with no Spa_Package the two lists are equal and the asymmetry is invisible — which is why it is written down rather than left to be inferred from the current tree
    - _Requirements: R6.14, R7.3, R7.4, R7.13_

  - [x] 13.3 Invert the two build phases in `packages/build-tools/src/image-tree.ts`
    - In `executeBuildPlan`, move the single `runner("npx", ["tsc", "--build", ...plan.tscRoots])` **ahead** of the `for (const spa of plan.spaBuilds)` loop, so the recorded invocation order is one `tsc --build` followed by one `npm run build` per `plan.spaBuilds` member, each still with that package's own directory as its working directory
    - Rewrite the doc comment that currently numbers the phases as "1. every `plan.spaBuilds` member … 2. the single `npx tsc --build …` runs only after all of them" — it states the old order and calls it "not negotiable"; renumber it as Tsc_Build_Pass first, Bundler_Build_Phase second, and record *why* (a Spa_Package is a sink in the import graph, so it can never be a prerequisite of `tsc --build`, while a Common_Package a Spa_Package imports must be compiled before the bundler runs)
    - Update the failure-ordering prose in the same comment: a non-zero `tsc --build` now yields **zero** bundler invocations and no staging (R6.10), and a non-zero Spa build still stages nothing (R6.9). Both phases must still precede `assertBuildOutputsPresent` / `rmSync(outDir)` / `copyPackage`, so "a failed build stages no package" continues to hold with no cleanup path
    - **Note explicitly, in the module prose, that this file needs no change for the build/stage separation** — the one place a reader would expect an edit and will not find one. `stageImageTree` copies `plan.stage`, and `assertImageTreeIntegrity` derives its justified set from the `scopedEntry` values of that *same* `plan.stage`, so narrowing `plan.stage` narrows the copying and the assertion in step: a Common_Package that leaves the stage set stops being copied *and* stops being expected, and the completeness half cannot go stale against the soundness half because there is only one list. Had the assertion recomputed its own justified set from the Required_Dependencies, this step would have had to edit it too and a mismatch would have been a silent `[image-tree:missing]` on every build with a Spa_Package
    - `plan.tscRoots` and `plan.spaBuilds` are unaffected by the reordering — it is an ordering fix in the executor only, with task 13.2 owning every plan-shape change
    - _Requirements: R6.4, R6.5, R6.9, R6.10, R6.13, R7.7, R7.9, R7.11_

  - [x] 13.4 Extend `checkImportDiscipline` in `packages/build-tools/src/repo-invariants.ts` with the fourth rule
    - Add rule 4: no source of a **Tsc_Project** — Framework_Singleton, Microservice_Package, or Common_Package alike — may declare an `import` specifier naming a discovered Spa_Package, reported as `[imports:spa]` naming the importing file and the offending specifier, in the wording design.md's Error Handling catalog gives
    - Scope the rule by Build_Kind rather than by Package_Category: it is the only one of the four that does, so the file-attribution step must be able to attribute a file to a Framework_Singleton as well as to a Consumer_Package. Widen the pure check's package list accordingly and widen the effect shell's walk (`consumerSourceFiles`) to include each Framework_Singleton's `src/` and tests, keeping the existing skip of a file belonging to no known package
    - Do not report a specifier passed to `import.meta.resolve` — it is not an `import` specifier, and that distinction is exactly what keeps the staging-only `microservice → spa` edge (R9.9, R9.10) expressible. Do not report a Spa_Package name that merely appears as a substring of a longer specifier
    - Update the four-rule doc comment and the return-type comment to list `[imports:spa]`; the rule is vacuous on the shipped tree because `packages/spa/` is empty
    - _Requirements: R14.13, R14.14_

  - [x] 13.5 Replace the Spa sequencing example test with a property test
    - Delete `packages/build-tools/tests/spa-build-sequencing.test.ts` — it pins the pre-correction order, so it now asserts the bug and cannot be amended into correctness
    - Create `packages/build-tools/tests/spa-build-sequencing.property.test.ts` driving `executeBuildPlan` with a recording `CommandRunner` and an injected `stage` step, over Selectors × Spa member counts
    - **Property 18: The Bundler_Build_Phase is exactly the required Spa_Packages, each built once in its own directory, entirely after the Tsc_Build_Pass**
    - **Validates: Requirements R6.5, R6.9, R6.10**
    - Assert exactly one `npx tsc --build` over `plan.tscRoots`; every `npm run build` invocation strictly after it; one invocation per required Spa_Package with that package's own directory as `cwd`; no non-required Spa_Package built; **no ordering required among the Spa builds** (`spa → spa` is rejected before a plan exists, so the invocation multiset is what is stable); a non-zero `tsc --build` exit yielding zero bundler invocations and no staging; and a non-zero Spa build staging nothing
    - Tag the property `// Feature: package-categories, Property 18: The Bundler_Build_Phase is exactly the required Spa_Packages, each built once in its own directory, entirely after the Tsc_Build_Pass` and run at `numRuns: 200`
    - _Requirements: R6.5, R6.9, R6.10_

  - [x] 13.6 Extend `packages/build-tools/tests/required-dependencies.property.test.ts`
    - **Property 28: A forbidden inbound edge into a Spa_Package fails, naming the declarer and the remedy**
    - **Validates: Requirements R8.13, R9.11**
    - Over dependency graphs with injected `common → spa` and `spa → spa` edges: resolution fails exactly when at least one such edge exists; `[deps:common-to-spa]` names the declaring Common_Package's directory and the offending specifier; `[deps:spa-to-spa]` names both Spa_Package directories and states the Common_Package remedy; neither case returns Required_Dependencies; a graph whose Common and Spa packages name only third-party packages, Framework_Singletons, and Common_Packages resolves cleanly
    - **Property 29: A Microservice_Package is never a dependency target, whatever the declarer**
    - **Validates: Requirements R7.12, R14.5**
    - Varying the declarer's category: for a declaring Microservice_Package, Common_Package, Spa_Package, or the Overseer, resolution fails with `[deps:peer]` naming that declarer's repo-relative directory and the offending specifier, returns no Required_Dependencies, and produces a message naming **no** Package_Category for the declarer — so one wording is correct for all four declarer kinds
    - **Property 31: The Staged_Dependencies equal the SPA-cut reachability oracle**
    - **Validates: Requirements R7.14, R9.12**
    - Over layouts × Selectors, against an independently written restricted-reachability oracle that follows every specifier of a root and of every reached non-Spa_Package and follows no specifier a Spa_Package declares: a Common_Package reachable **only** via a Spa_Package is excluded; one reachable both via a Spa_Package and by a path expanding none is included; a required Spa_Package is included because the walk arrives at it before stopping; the result is identical across repeated runs and independent of the order in which the roots and their specifiers are visited
    - Update the exact-match assertion that pins the old `[deps:peer]` sentence; it must pin the new text just as exactly, since R7.12 constrains the wording. Leave every existing block untouched otherwise — `requiredDependencies` stays a thin wrapper over `resolveDependencySets(...).required`, so Properties 10–14 keep passing unchanged
    - _Requirements: R7.12, R7.14, R8.13, R9.11, R9.12_

  - [x] 13.7 Extend `packages/build-tools/tests/build-plan.property.test.ts`
    - Strengthen the layout generator for the revised **Properties 15 and 16** so it produces a Common_Package reachable **only** through a Spa_Package (no Selected_Microservice, no other Tsc_Project, and not the Overseer declaring a specifier resolving to it) and a `microservice → spa` edge
    - Property 16 must now assert that such a Common_Package **is** a `tsc --build` root, present exactly once, so its compiled output exists before the Bundler_Build_Phase begins (R6.12); that root membership is decided by Build_Kind alone, never by which root reached the required dependency; and that the `microservice → spa` edge adds the Spa_Package to the Required_Dependencies for staging and linking while imposing **no** ordering constraint on `plan.tscRoots` and contributing no root (R9.9, R6.13)
    - Keep the existing Property 15 totality assertions and the `packages/build-tools` / `packages/integration-tests` exclusion and determinism assertions; update the two property tag comments if design.md's titles changed
    - **Property 32: Staged ⊆ Required, and the difference is built but never shipped**
    - **Validates: Requirements R6.14, R7.13**
    - Every member of `stagedDependencies` is a member of `requiredDependencies` and appears in the same relative order; every member of `requiredDependencies` is a build target, appearing in `tscRoots` when its Build_Kind is Tsc_Project and in `spaBuilds` when it is Bundler_Project; and every member of `requiredDependencies` absent from `stagedDependencies` appears in `tscRoots` when it is a Tsc_Project and in **no** `stage` entry, so its compiled output is produced and copied nowhere
    - _Requirements: R6.12, R6.13, R6.14, R7.13, R9.9_

  - [x] 13.8 Extend `packages/build-tools/tests/repo-invariants.property.test.ts`
    - **Property 30: No Tsc_Project source imports a Spa_Package**
    - **Validates: Requirements R14.13, R14.14**
    - Over importing packages spanning every Tsc_Project kind — Framework_Singleton, Microservice_Package, and Common_Package — generate specifier sets over Spa_Package names, Common_Package names, Framework_Singleton names, third-party names, and near-misses of each; assert exactly the specifiers naming a discovered Spa_Package are reported, with the importing file and the specifier, and nothing else is — including a Spa_Package name appearing only as a substring of a longer specifier and a Spa_Package name passed to `import.meta.resolve`
    - _Requirements: R14.13, R14.14_

  - [x] 13.9 Restate `packages/build-tools/tests/image-tree.integrity.property.test.ts` over the Staged_Dependencies
    - Restate **Property 19: A package is staged if and only if the Selector justifies it** so the staged entry set is the always-staged Framework_Singletons, the **Staged_Dependencies**, and the Selected_Microservices — a discovered Common_Package or Spa_Package staged iff it is a member of the Staged_Dependencies, not of the Required_Dependencies
    - Restate **Property 22: The Integrity_Assertion is sound and complete over the enumerated entries** so the justified union is that same Staged_Dependencies-based union, and extend the plan generator to produce plans whose `stagedDependencies` is sometimes a **strict** subset of `requiredDependencies` — a built-but-unstaged package present in the tree must register as `[image-tree:unjustified]` alongside the existing strays that belong to no discovered category, and every absent member of the union must still be named by `[image-tree:missing]`
    - Leave Property 21 as it stands: it asserts over the plan's build members and is unaffected by which of them ship
    - _Requirements: R7.3, R7.4, R7.7, R7.9, R7.11_

  - [x] 13.10 Make discovery's mirroring stage category-blind in `packages/build-tools/src/discovery.ts`
    - Validation **stage 3** — the `[discovery:mirror]` stage — currently restricts itself to Common_Packages and Spa_Packages. Drop the category restriction so every discovered Consumer_Package is checked, Microservice_Packages included: the declared `name` must equal `@microservices/` followed by the directory name, character for character and case-sensitively (R3.6). One predicate change; the stage's offender accumulation, its `packageDir` sort, and its position between stage 2 and stage 4 are unchanged
    - **Stage 5 keeps its category scoping.** A Microservice_Package remains exempt from the `[barrel:invalid]` contract stage **alone** (R4.5), and a Framework_Singleton remains exempt from both stages by never being a container member (R4.6). The narrowing that R4.5 now states is exactly this: mirroring is not a category-scoped check, the manifest contract is
    - Message shape is in design.md's Error Handling catalog: one line per offender, each naming the repo-relative directory, the declared name, and the expected name, every offender in one sorted failure
    - **The check is vacuous on the current tree** — all three shipped microservices already declare a name matching their directory — and the generated registry text is unchanged, because the registry's import specifier was always directory-derived (R14.2) and stays so. The only observable effect is that an already-broken configuration now fails loudly at discovery, naming the manifest, instead of surfacing later as an unresolved-module `tsc` error pointing at generated code
    - Update the `@throws` line and the stage-list comment: `[discovery:mirror]` no longer reads "(Common and Spa only)". design.md's component-7 "known asymmetry" subsection, which explained why Microservice_Packages were exempt, has been **deleted** from the design, so no comment in this file may still claim such an exemption exists
    - _Requirements: R3.6, R4.5_

  - [x] 13.11 Restate Property 8 in `packages/build-tools/tests/discovery.names.property.test.ts`
    - **Property 8: Every discovered Consumer_Package's declared name must mirror its directory**
    - **Validates: Requirements R3.6, R4.5**
    - The property has been restated in design.md and its closing clause is **inverted**: the block written in task 5.5 under the old title ("A Common or Spa package's declared name must mirror its directory") asserts that a Microservice_Package's declared name is *not* checked, which is now the opposite of the rule. Replace that assertion rather than adding beside it, and take the property title verbatim from design.md
    - Over generated layouts spanning all three Consumer_Categories: a non-mirroring declared name fails with `[discovery:mirror]` naming the directory, the declared name, and the expected name, for **every** category; a mirroring name passes, for every category; the case-flipped, prefixed, suffixed, and whitespace-padded near-misses already generated in this file fail for a Microservice_Package exactly as they do for a Common_Package; and every offender of a multi-offender layout appears in one sorted, run-stable failure
    - Tag the property `// Feature: package-categories, Property 8: Every discovered Consumer_Package's declared name must mirror its directory` and run at `numRuns: 200`
    - Leave Properties 5, 6, and 7 in this file untouched — none of them reasons about mirroring
    - _Requirements: R3.6, R4.5_

- [x] 14. Checkpoint — step 7 verification gate
  - Run `npm run ci` and both documented two-command container builds, plus `npm start` and a short `npm run dev` session with one source edit
  - Additionally confirm **both** changes are observably behavior-neutral on the shipped tree, for the same underlying reason — `packages/spa/` holds zero Spa_Packages:
    - The phase inversion: `plan.spaBuilds` is empty for every Selector, so the Bundler_Build_Phase is a no-op and the reordering moves nothing
    - The build/stage separation: no traversal ever arrives at a Spa_Package, so `stagedDependencies` equals `requiredDependencies` for every Selector and `plan.stage` is unchanged
    - Both Image_Trees must therefore be **byte-for-byte** what step 4's gate produced
  - The new rules are vacuous here too — `[deps:common-to-spa]`, `[deps:spa-to-spa]`, and `[imports:spa]` have nothing to fire on — so the evidence for every new rule, and for the two behavior-neutral changes above, is the property tests over synthetic layouts rather than the committed repository. The gate confirms only that nothing moved and nothing fires
  - The mirroring extension of tasks 13.10–13.11 is vacuous for a different reason: `[discovery:mirror]` has something to check on every one of the four discovered packages and passes on all four, because each already declares a name mirroring its directory. Confirm the generated registry text for both shipped Selectors is still byte-identical to the baseline, which is what proves the extension changed no specifier
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: R3.6, R4.5, R6.5, R6.14, R7.13, R9.3, R14.2, R14.6, R14.8_

- [x] 15. Step 8 — Derive the Workspace_Build_Order from declared dependencies

  > **This step implements design.md's migration step 5 and lands last, and the numbering mismatch is deliberate** — see the Overview. It also runs against the grain of every other step: instead of making a silent mistake loud, it **removes a hand-maintained invariant**. The root `workspaces` array's topological entry order stops meaning anything (R12.16); the Build_System derives the order over *every* workspace package from the `@microservices`-scoped `dependencies` each one already declares (R12.1–R12.5), and the repository-wide build invokes each package's own `build` script in that order (R12.7). A package author declares a dependency once, in `package.json`, and gets its build position for free: no `tsconfig.json` `references`, no `tsc -b` in a consumer, no registration list, no array position (R12.4, R12.13, R12.14).
  >
  > **This is not `plan.tscRoots`, and conflating the two is the easy mistake.** The Workspace_Build_Order consults no Selector, covers `build-tools` and `integration-tests` and every unselected microservice and every Spa_Package (R12.1), invokes one `npm run build` per package rather than one `tsc --build` over roots (R12.7), and sorts by repo-relative `packageDir` where the resolver sorts by `dirName` (R12.5 versus R7.2). The two derivations share graph *machinery* and nothing else, which is why task 15.1 extracts that machinery into a leaf both consume. The Image_Assembler keeps its Tsc_Build_Pass / Bundler_Build_Phase structure unchanged — the two paths deliberately do not converge (R12.10).
  >
  > **The step lands on a tree that already builds, so its gate is the ordinary one** and its sub-tasks are independently shippable. Sub-tasks are grouped by file and each source file is touched exactly once within the step. `repo-invariants.ts` is touched here as well as in task 13.4, which is fine — different steps, different waves.
  >
  > Every property below carries the tag comment `// Feature: package-categories, Property {n}: {property_text}`, with the property text matching design.md's title **verbatim**, and runs at `numRuns: 200`.

  - [x] 15.1 Create `packages/build-tools/src/topological-order.ts` — the shared graph machinery
    - Export `compareCodePoints(a, b)`, `leastTopologicalOrder(nodes, keyOf, dependenciesOf, compareNodes)` — Kahn's algorithm with the ready queue held in `compareNodes` order — and `findCyclePath(nodes, keyOf, dependenciesOf)`, a three-colour walk with a live stack returning a closed cycle path in `keyOf` terms or `undefined`
    - `keyOf` (identity) and `compareNodes` (ready-queue order) are **separate parameters** precisely because the two callers differ on the second: the Dependency_Resolver orders by `dirName` (R7.2) and `workspace-build-order.ts` orders by `packageDir` (R12.5)
    - `leastTopologicalOrder` assumes an acyclic graph and every caller runs `findCyclePath` first, because Kahn's residual set includes nodes merely *downstream* of a cycle and naming those as participants would over-report
    - No domain knowledge in this module: no package, no category, no specifier, no error prefix. Each caller keeps its own error formatting, because the prefixes differ (`[deps:cycle]` versus `[build-order:cycle]`)
    - _Requirements: R7.2, R12.5, R12.6_

  - [x] 15.2 Re-point `packages/build-tools/src/required-dependencies.ts` at the shared machinery
    - Replace the module's private `topologicalOrder`, its `compare`, and its ready-queue sort with a call into `leastTopologicalOrder`, and extract the cycle-*shape* detection through `findCyclePath` while keeping the `[deps:cycle]` message and its cycle-order formatting here
    - Keep the three-colour resolver walk itself in this module: it is a *resolver*, raising `[shared:unresolved]`, `[deps:peer]`, `[deps:common-to-spa]`, and `[deps:spa-to-spa]` as it descends, and only the cycle shape is common
    - **Behavior-preserving, and the acceptance condition is that nothing else moves:** the module's public surface (`requiredDependencies`, `resolveDependencySets`, `stagedSubset`, `Subgraph`, `DependencySets`) is unchanged, and `packages/build-tools/tests/required-dependencies.property.test.ts` — Properties 10, 11, 12, 13, 14, 28, 29, and 31 — must pass **unedited**. An edit needed there means the extraction changed behavior
    - _Requirements: R7.2, R7.10_

  - [x] 15.3 Create `packages/build-tools/src/workspace-build-order.ts` (design component 9)
    - Declare `WorkspaceNode` — `packageDir` (identity and the R12.5 sort key), `name`, `dependencySpecifiers`, and a `tier` used for diagnostics only, which no rule reads. One node type spans both tiers deliberately, so the derivation needs no framework special case
    - Implement `workspaceNodesFrom(discovery, readDependencies)`: the four `FRAMEWORK_SINGLETONS` plus every discovered Consumer_Package of all three categories, exactly once each and nothing else (R12.1). A Framework_Singleton's specifiers come from the injected reader because no `Discovery` records them; a Consumer_Package's come from its recorded `dependencySpecifiers`
    - Implement `workspaceBuildOrder(nodes)` over `findCyclePath` then `leastTopologicalOrder`, sorting the ready queue by `packageDir` code point (R12.5). Resolve each specifier against the union of declared Consumer_Package names and Framework_Singleton names, and treat a **framework match as an ordering edge** rather than skipping it (R12.3) — that is the whole reason `packages/contracts` lands first and `packages/integration-tests` lands last, with neither position asserted anywhere
    - Record in the module prose that R12.3 diverges from R3.7 and R5.3 on purpose: those exclude a Framework_Singleton from the Required_Dependencies, a question about what is *built and staged for a Selector*; this asks only what must be compiled before what, and a package excluded from a set can still constrain an order
    - Apply **no** dependency-direction rule. `packages/integration-tests` legitimately declares specifiers resolving to every Microservice_Package and to the Overseer, so raising `[deps:peer]` here would fail every build. Direction is `checkDependencyDirection`'s and the resolver's concern; this function only orders
    - An `@microservices`-scoped specifier matching neither a declared consumer name nor a Framework_Singleton name **fails**, reusing the `[shared:unresolved]` message verbatim — dropping the edge would silently produce an order that looks fine and builds a package before its real dependency
    - Raise `[build-order:cycle]` naming every participating package in cycle order, computing no order so the caller invokes no `build` script (R12.6). The prefix is `[build-order:` and not `[deps:` because the scopes differ: `[deps:cycle]` is Selector- and reachability-scoped, this one covers every workspace package
    - Implement `CommandRunner`, `runOrderedBuild(order, runner?)` — one `npm run build --workspace <declared name>` per package, exactly once, in order (R12.7), stopping at the first non-zero exit with `[build-order:failed]` naming the offending package's repo-relative directory and the observed status and invoking nothing that follows it (R12.8) — and `runOrderedBuildCli()` holding **all** CLI policy: framing, stderr, exit status
    - Record why a Spa_Package needs no phase logic on this path: invoking each package's own `build` script builds it with its own bundler, and R12.2 has already positioned it after every Tsc_Project it declares a specifier resolving to, so there is one ordered pass and no phase boundary anywhere (R12.9)
    - _Requirements: R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R12.7, R12.8, R12.9, R12.10, R12.13_

  - [x] 15.4 Create the thin-wrapper bin `packages/build-tools/src/bin/build-workspaces.ts`
    - Shebang, one import of `runOrderedBuildCli` from `../workspace-build-order.js`, one call to it, and nothing else — no constants, no helpers, no filesystem access, no argument parsing, no exit-code logic. This is the "Bins are thin wrappers" convention now recorded in `.kiro/steering/structure.md`, of which `runDevSupervisorCli()` and `runRepoInvariantsCli()` are the references
    - Register the bin in `packages/build-tools/package.json` alongside the existing entry points
    - _Requirements: R12.7, R12.8_

  - [x] 15.5 Extract `runBootstrapBuild(env)` from `runCommonStartup` in `scripts/common-startup.js`
    - Lift the existing Bootstrap_Build step body out as a named export, verbatim, so both callers share one implementation: `runCommonStartup` (`npm start` / `npm run dev`) and the new `scripts/build.js`. Keep the step body, the step name, its position, and the returned `steps` array byte-identical, and leave the comments recording the clean-checkout rationale in place
    - **The acceptance condition is that `packages/build-tools/tests/dev-common-startup.property.test.ts` passes unedited.** If that suite needs an edit, the extraction was not behavior-preserving and must be redone — that suite is the only evidence R12.22 and R14.11 have that `npm start` and `npm run dev` were not disturbed
    - This file stays plain uncompiled ESM under `scripts/`: a module that *performs* the Bootstrap_Build cannot itself require compilation
    - _Requirements: R12.11, R12.22, R14.11_

  - [x] 15.6 Create `scripts/build.js` — the repository-wide build entry point
    - Two things only: call `runBootstrapBuild()`, then spawn `packages/build-tools/dist/bin/build-workspaces.js` and exit with its status
    - Plain uncompiled ESM under `scripts/`, and it must be: the module that derives the order is compiled output absent from a fresh clone, so the Bootstrap_Build of `packages/contracts` and `packages/build-tools` has to precede it (R12.11). A compiled module under `packages/` could not have imported `scripts/common-startup.js` anyway — a relative specifier escaping its own package directory is exactly what `[imports:escape]` forbids (R14.4)
    - Record that `contracts` and `build-tools` are built a **second** time when the ordered pass reaches them and that this is intended (R12.12): each is an incremental `tsc` over output the bootstrap just produced, so the repeat is a near no-op that exits zero and prints nothing. Having the executor skip whatever the bootstrap covered would couple the ordered pass to the bootstrap's contents, so changing the bootstrap pair would silently change which packages the ordered build skips
    - _Requirements: R12.11, R12.12_

  - [x] 15.7 Rewire the root `package.json` scripts
    - `build` and `pretest` each become `node scripts/build.js`; the `ci` script's leading build step becomes `npm run build`, giving `npm run build && npm run check:invariants && npm run typecheck --workspaces && npm run lint --workspaces && npm test && npm run test:types`
    - After this edit **`npm run build --workspaces` appears in no root script** (R12.21). Leave `test`, `test:workspaces`, `test:types`, `lint`, `typecheck`, `start`, `dev`, `prepare`, and the `docker:build:*` scripts alone — `--workspaces` stays correct for those, none of which depends on visiting order
    - Make no change to the `workspaces` array itself: its entries and their sequence stay as task 7.3 left them, and that sequence is now cosmetic (R12.16). Do not reintroduce a rule about it
    - _Requirements: R12.21, R14.8_

  - [x] 15.8 Narrow the workspaces check in `packages/build-tools/src/repo-invariants.ts` from order to coverage
    - Rename `checkWorkspaceOrder` to `checkWorkspaceCoverage` and change its message prefix from `[workspaces:order]` to `[workspaces:coverage]`. Neither is a pinned contract — only `[selector:unmatched]` and `[shared:unresolved]` are (R13.10, R13.11) — and the rename is not cosmetic: the function verifies a *set* property now and would be misnamed if it kept a name promising an order, while the prefix names the concern an operator is being pointed at
    - **Delete all five ordering rules** written in task 5.11: `packages/contracts` at index 0, `packages/integration-tests` last, `common/*` and `spa/*` before `microservices/*` and `overseer`, `microservices/*` before `overseer`, and the per-edge `entryIndex(Q) < entryIndex(P)` rule with its shared-entry variant. Each states a rule R12.16 removes
    - **Keep one rule, in both directions:** a workspace package directory matched by zero entries is a violation (npm would not discover it), and one matched by two or more is a violation (the declaration is ambiguous). The message names the package's repo-relative directory and **every** entry matching it with its index, so a duplicate names both and a zero-match names none (R12.18). Mutate nothing, and in particular leave the Root_Manifest untouched
    - Three things the function must deliberately not do: read the relative order of any two entries (R12.16), report anything about a dependency edge between two packages the same single entry matches (R12.19), or treat a glob entry matching zero directories as a violation (R12.20) — the last is what lets the committed `packages/spa/*` entry coexist with an empty `packages/spa/`
    - Update the module doc comment's invariant count: three checks, **six** invariants — coverage contributes one where the ordering check contributed five, `checkImportDiscipline` contributes four including `[imports:spa]` from task 13.4, and `checkDependencyDirection` contributes one. `runRepoInvariantsCli` keeps its name, so the bin and the `check:invariants` script need no edit
    - _Requirements: R12.15, R12.16, R12.17, R12.18, R12.19, R12.20_

  - [x] 15.9 Rewrite `workspace-order.property.test.ts` as `packages/build-tools/tests/workspace-coverage.property.test.ts`
    - **Property 23: The Workspace_Coverage check verdict equals the coverage oracle**
    - **Validates: Requirements R12.15, R12.16, R12.17, R12.18, R12.19, R12.20**
    - Carry over the entry-matching helper and the generated-`workspaces`-array generator; delete every ordering assertion — fixed positions, tier precedence, per-edge entry precedence, and the shared-entry rule — because each states a rule R12.16 removes. Retire the old Property 23 title and take the restated one verbatim
    - Assert the verdict equals an independently written coverage oracle (a per-package match count): exactly those packages matched by a number of entries other than one are reported, each message names the package directory and every matching entry, nothing else is reported, and the Root_Manifest is unmodified in every case
    - Add the three invariance blocks: permuting the entries while holding the matched directory set fixed changes neither the verdict nor the message set (R12.16); adding a dependency edge between two packages the same single entry matches changes the verdict not at all and reports no violation (R12.19); a glob entry matching zero directories contributes zero matches and is itself no violation (R12.20)
    - Tag `// Feature: package-categories, Property 23: The Workspace_Coverage check verdict equals the coverage oracle` and run at `numRuns: 200`
    - _Requirements: R12.15, R12.16, R12.17, R12.18, R12.19, R12.20_

  - [x] 15.10 Write `packages/build-tools/tests/workspace-build-order.property.test.ts`
    - **Property 33: The Workspace_Build_Order equals the topological oracle**
    - **Validates: Requirements R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R12.13**
    - Pure over synthetic workspace sets spanning both tiers and all three Consumer_Categories × dependency assignments, against an independently written Kahn-with-sorted-ready-queue oracle: every workspace package present exactly once and nothing else; each package after every package it declares a specifier resolving to, with a framework specifier counting as an ordering edge exactly as a consumer specifier does; packages with no dependency relation in ascending code-point order of `packageDir`; and identical element for element across repeated derivations and **independent of the order the packages are presented in**
    - Include the two consequence blocks R12.3 and R12.13 name: every package declaring `@microservices/contracts` follows `packages/contracts`, and a Common_Package declaring a specifier resolving to another Common_Package follows it — with no input other than the declaring package's own `dependencies` (R12.4)
    - Vary `packageDir` values so the code-point tiebreak is observable, include diamonds, and inject cycles of length 1 through k: a cyclic input fails naming exactly the participants, computes no order, and causes no `build` script to be invoked (R12.6)
    - Tag `// Feature: package-categories, Property 33: The Workspace_Build_Order equals the topological oracle` and run at `numRuns: 200`
    - _Requirements: R12.1, R12.2, R12.3, R12.4, R12.5, R12.6, R12.13_

  - [x] 15.11 Write `packages/build-tools/tests/ordered-build.property.test.ts`
    - **Property 34: The ordered build invokes each package's own `build` once, in order, and stops at the first failure**
    - **Validates: Requirements R12.7, R12.8, R12.9**
    - Drive `runOrderedBuild` with a recording `CommandRunner` returning a caller-chosen exit status — nothing is spawned, so the suite stays fast enough for `numRuns: 200`. Over the same synthetic workspace sets × which package (if any) exits non-zero: the recorded invocations are exactly one per package in the Workspace_Build_Order up to and including the first failing package, none for any package after it, and none twice; an all-zero run invokes every package exactly once in that order; a failing run reports the offending package's repo-relative directory and the observed status
    - Include Spa members so the invocation sequence can be checked against their Tsc_Project dependencies: a Spa_Package's invocation occurs after the invocation of every Tsc_Project it declares a specifier resolving to, **within the same single pass and with no phase boundary anywhere in the sequence** (R12.9)
    - Tag the property with `// Feature: package-categories, Property 34: ` followed by the title exactly as design.md states it, backticks around `build` included, and run at `numRuns: 200`
    - _Requirements: R12.7, R12.8, R12.9_

  - [x] 15.12 Write the real-tree Workspace_Build_Order example test
    - File: `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`
    - Assert the derivation over the committed repository yields exactly the eight entries of design.md's Data Models table, in that order: `packages/contracts`, `packages/build-tools`, `packages/common/config`, `packages/microservices/microservice1`, `packages/microservices/microservice2`, `packages/microservices/microservice3`, `packages/overseer`, `packages/integration-tests`
    - Assert `packages/contracts` is first and `packages/integration-tests` last **without asserting them as rules** — they are graph consequences here, and the test's job is to record that the graph produces them (R12.3). One case, because the tree is one input; the general claim is Property 33
    - _Requirements: R12.1, R12.2, R12.3, R12.4, R12.5_

  - [x] 15.13 Write the bin thin-wrapper shape example test
    - File: `packages/build-tools/tests/build-workspaces-bin.test.ts`
    - Assert `src/bin/build-workspaces.ts` contains a shebang, exactly one import, and exactly one call, and no CLI policy of its own — no constant, no helper, no filesystem access, no argument parsing, no exit-code logic
    - Assert the bin is registered in `packages/build-tools/package.json` and that its compiled path is the one `scripts/build.js` spawns
    - _Requirements: R12.7_

  - [x] 15.14 Write the bootstrap-then-ordered-pass example test
    - File: `packages/integration-tests/tests/repository-build.test.ts`
    - With an injected recording runner rather than by spawning: `scripts/build.js` runs `runBootstrapBuild` — building exactly `@microservices/contracts` and `@microservices/build-tools`, by workspace name — **before** it invokes the compiled ordered-build bin (R12.11)
    - Assert the ordered pass then invokes `contracts` and `build-tools` a second time, each exiting zero with no error and no warning about the repeat (R12.12), so the pass is total over its input rather than coupled to the bootstrap's contents
    - _Requirements: R12.11, R12.12_

  - [x] 15.15 Extend `packages/integration-tests/tests/ci-wiring.test.ts` for the new root-script wiring
    - Assert `build` and `pretest` each invoke `node scripts/build.js`, that the `ci` script's build step is `npm run build`, and that **no** root script contains `npm run build --workspaces` (R12.21)
    - Keep the existing assertions from task 9.3 — `check:invariants` present in `ci`, positioned after the build step and before `typecheck --workspaces`, and pointing at the compiled bin — adapting only the build-step expectation to its new spelling
    - _Requirements: R12.21, R14.8, R14.10_

  - [x] 15.16 Replace the pinned `workspaces`-order assertion in `packages/integration-tests/tests/common-package-conventions.test.ts` with a coverage assertion
    - **The outcome, stated rather than guessed:** R12.16 removes the ordering constraint on the `workspaces` array entirely, and R12.15 leaves it exactly one obligation, Workspace_Coverage. Nothing in the requirements or the design constrains the array's entry order after this step — design.md's component 14 records the committed sequence as cosmetic and asks a reviewer not to reintroduce a rule about it. So the committed-manifest block written in task 7.15, which pins the seven entries in a fixed order, now asserts a rule the platform no longer has and must not be retargeted
    - Replace it with a coverage assertion: every Framework_Singleton directory and every Consumer_Package directory present in the repository is matched by exactly one `workspaces` entry, and no `packages/config` entry remains (R12.15, R8.4). A `packages/spa/*` entry matching zero directories is not a violation (R12.20)
    - Leave every other assertion in the file untouched — the Common_Package conventions it states about `packages/common/config` are unaffected
    - _Requirements: R8.4, R12.15, R12.16, R12.20_

- [x] 16. Checkpoint — step 8 verification gate
  - The ordinary gate: `npm run ci`, both documented two-command container builds, plus `npm start` and a short `npm run dev` session with one source edit
  - **Run the gate once on a genuinely cold tree** — no `dist/`, no `*.tsbuildinfo`, no `node_modules/`. A warm tree hides exactly the defect this step could introduce, because prior output lets a package compile even when it was built too early
  - **The behavior-neutrality evidence for the whole step is one equality: the derived order over the real committed tree must equal, element for element, the order the retired hand-maintained `workspaces` array produced** — the eight entries of design.md's Data Models table, with `packages/common/*` expanded to its single member. Confirm it by eye as well as through task 15.12
  - Additionally confirm: `packages/build-tools/tests/dev-common-startup.property.test.ts` passed **unedited** (the evidence that extracting `runBootstrapBuild` disturbed neither `npm start` nor `npm run dev`, R12.22, R14.11); `packages/build-tools/tests/required-dependencies.property.test.ts` passed **unedited** (the evidence that extracting the graph machinery was behavior-preserving); and both Image_Trees are byte-for-byte what step 7's gate produced, since this step changes no Selector-scoped derivation (R12.10)
  - Expect `check:invariants` to keep exiting 0: the narrowed coverage check is satisfied by the array as task 7.3 left it, and reordering that array would now change nothing (R12.16)
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: R12.10, R12.14, R12.17, R12.21, R12.22, R14.6, R14.8, R14.11, R14.12_

## Notes

- **The eight-step order is fixed.** Each step is a parent task followed by a checkpoint carrying that step's verification gate. Step 4 is the one exception: its sub-tasks share a single gate at task 8 and must all complete before the tree builds again.
- **No sub-task is marked optional.** The design designates the 34 correctness properties as the requirement evidence, and every test-updating sub-task in step 4 is needed for the tree to typecheck and for `npm run ci` to pass. Marking any of them skippable would drop requirement coverage rather than trade speed for scope.
- **Review-only obligations, deliberately with no task.** R1.7 (only the seven directories directly under `packages/`) and R10.5 (exactly one textual declaration of each framework literal) state that no Build_System check validates them, so no scanner is built for either. R10.2–R10.4 are source-level facts with no behavioral observable. R1.7's convention is recorded in `structure.md` by task 11.1; the rest are checked by code review at task 12's gate.
- **Deferred open question, no task.** Whether types-only `contracts` should ship into a runtime image is out of scope; this plan keeps the current staging behavior and only records the question in the steering documents.
- **Known, requirement-sanctioned duplication.** `scripts/emit-effective-dockerfile.sh` cannot import `framework.ts` because it must run on a fresh clone before anything is installed, so the container directories and the four exclusion names appear there as literals too. Task 1.1 and task 3.1 each add a comment cross-referencing the other.
- **Two error messages are preserved byte-identically** — `[selector:unmatched]` and `[shared:unresolved]` — and `selector.ts` is not touched in any task.
- **`dist/` and `*.tsbuildinfo` stay untracked and are never moved.** Task 7.1 states the hazard explicitly; every relocated package must rebuild at its new path from nothing.
- **`Dockerfile.template` is edited by no task**, and `packages/overseer/src/generated/microservice-registry.ts` stays generated with the `prepare` template copy untouched.
- **Step 7 is a correction, not new scope, and existing task text is history.** Tasks 1.x–12 record what was executed against the pre-revision spec; their wording is deliberately left as-is even where the spec has since moved, because rewriting it would misrepresent what was done. Task 13 carries the delta.
- **Everything step 7 adds is vacuous on the current tree, for one reason: `packages/spa/` holds zero Spa_Packages.** `[deps:common-to-spa]`, `[deps:spa-to-spa]`, and `[imports:spa]` can never fire — there is no Spa_Package to depend on or to import. The build-phase inversion moves nothing, because `plan.spaBuilds` is empty for every Selector. And the build/stage separation changes nothing, because no traversal reaches a Spa_Package to stop at, so `stagedDependencies` equals `requiredDependencies` for every Selector and `plan.stage` is identical. The evidence for all of it is therefore Properties 18, 28, 29, 30, 31, and 32 over synthetic generated layouts, not the committed repository; the step 7 gate confirms only that nothing moved and nothing fires.
- **The mirroring extension is vacuous on the current tree, and that is the point of folding it in rather than staging it.** All three shipped microservices already declare a name mirroring their directory, so making `[discovery:mirror]` category-blind (task 13.10) reports nothing today. The generated registry text is unchanged too, because the registry's import specifier was always directory-derived (R14.2) — what the check adds is that a manifest can no longer declare a name that diverges from it. A divergence had no valid outcome before either: npm links a microservice under its declared name while the registry imports the directory-derived one and the assembler stages it at the directory-derived path, so the build failed, just later and pointing at generated code instead of at the manifest. design.md's component-7 "known asymmetry" subsection, which justified the old exemption, has been deleted.
- **Step 8 removes an invariant rather than adding a check, and package authors do nothing.** Every other step in this plan makes a previously-silent mistake loud. Step 8 deletes a hand-maintained obligation: the root `workspaces` array's topological entry order stops carrying build-order meaning (R12.16), so there is nothing left to check about it and the ordering check written in task 5.11 is narrowed to Workspace_Coverage (task 15.8). The build order is derived from the `@microservices`-scoped `dependencies` each package already declares, which means an author's whole obligation is one `dependencies` entry — no `tsconfig.json` `references`, no `tsc -b` in a consumer, no registration list, no array position (R12.4, R12.13, R12.14). The `references` alternative was considered and rejected in the design because it makes the same dependency be declared twice, with a silent failure mode on a cold tree; that is the same defect as a hand-maintained array order and as `classify()`'s manifest-shape gate.
- **Plan step numbering does not match design migration step numbering, deliberately.** design.md now has seven migration steps; this plan has eight. Plan step 8 (task 15) is design migration step 5, landed last because tasks 1–12 are executed and renumbering them would misrepresent what was done. No ordering constraint is violated: design step 5 only has to follow the core swap and the invariant wiring, and as the final step it does.
- **One residual imprecision, recorded and not fixed.** R9.12 obliges a Spa_Package to produce a self-contained build output — every module its bundled assets need resolving from within that output — and the Build_System takes that obligation on trust: no task builds a mechanical check for it. Scanning a Spa_Package's `dist/` for surviving `@microservices/` specifiers was considered and rejected, because such a specifier can appear in a source map or in a string literal in the SPA's own source, where it is harmless, so the scan produces false positives — and on a build gate a false positive is worse than the risk the gate guards against, since it fails correct builds and the only way past it is to disable the gate. The consequence, stated plainly: a Spa_Package whose bundler externalizes a workspace dependency fails at **runtime**, not at build time, because the stage set deliberately does not ship what that bundler chose not to inline. Keeping the bundler configured to inline its workspace dependencies is the Spa_Package author's responsibility.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "3.1", "3.3"] },
    { "id": 2, "tasks": ["3.2", "3.4", "3.5", "3.6", "5.1"] },
    { "id": 3, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6", "5.16", "5.7"] },
    { "id": 4, "tasks": ["5.8", "5.9"] },
    { "id": 5, "tasks": ["5.10", "5.11"] },
    { "id": 6, "tasks": ["5.12", "5.13", "5.14"] },
    { "id": 7, "tasks": ["5.15"] },
    { "id": 8, "tasks": ["7.1"] },
    { "id": 9, "tasks": ["7.2", "7.3"] },
    { "id": 10, "tasks": ["7.4", "7.5", "7.6", "7.7"] },
    { "id": 11, "tasks": ["7.8", "7.9", "7.13", "7.14", "7.15", "7.16", "7.17", "7.18"] },
    { "id": 12, "tasks": ["7.10", "7.11", "7.12", "7.19", "7.20", "7.21", "7.22"] },
    { "id": 13, "tasks": ["9.1"] },
    { "id": 14, "tasks": ["9.2"] },
    { "id": 15, "tasks": ["9.3"] },
    { "id": 16, "tasks": ["11.1", "11.2"] },
    { "id": 17, "tasks": ["13.1", "13.4", "13.10"] },
    { "id": 18, "tasks": ["13.2", "13.3", "13.11"] },
    { "id": 19, "tasks": ["13.5", "13.6", "13.8"] },
    { "id": 20, "tasks": ["13.7", "13.9"] },
    { "id": 21, "tasks": ["15.1", "15.5", "15.8"] },
    { "id": 22, "tasks": ["15.2", "15.3", "15.9"] },
    { "id": 23, "tasks": ["15.4", "15.10", "15.11"] },
    { "id": 24, "tasks": ["15.6", "15.12", "15.13"] },
    { "id": 25, "tasks": ["15.7", "15.14", "15.16"] },
    { "id": 26, "tasks": ["15.15"] }
  ]
}
```

Waves 17–20 are step 7, and they follow two constraints. **No two sub-tasks in one wave write the same file** — each of the eleven touches exactly one file, and the pairings above keep those files distinct. **Every source sub-task precedes the test sub-tasks that assert against it**: 13.1 (`required-dependencies.ts`) before 13.2 (`build-plan.ts`, which calls `resolveDependencySets`) and before 13.6; 13.2 before 13.5, 13.7, and 13.9, all of which read the two dependency sets off the plan; 13.3 (`image-tree.ts`) before 13.5; 13.4 (`repo-invariants.ts`) before 13.8; and 13.10 (`discovery.ts`) before 13.11, which asserts the restated Property 8 against it. 13.10 sits in wave 17 because `discovery.ts` is written by no other step-7 sub-task, and 13.11 sits in wave 18 because `discovery.names.property.test.ts` is written by no other sub-task at all.

Waves 21–26 are step 8, under the same two constraints. **File distinctness:** each of the sixteen sub-tasks writes exactly one file (15.4 additionally registers its bin in `packages/build-tools/package.json`, which no other sub-task in the step touches), and no wave pairs two writers of the same file. `repo-invariants.ts` is written by 13.4 in wave 17 and by 15.8 in wave 21, six waves apart. **Source before its tests:** 15.1 (`topological-order.ts`) precedes both of its consumers, 15.2 (`required-dependencies.ts`) and 15.3 (`workspace-build-order.ts`); 15.3 precedes its bin (15.4), its two property tests (15.10, 15.11), and the real-tree example (15.12); 15.8 (`repo-invariants.ts`) precedes the coverage-test rewrite (15.9) and the coverage assertion in 15.16; 15.5 (`runBootstrapBuild` extraction) and 15.4 (the bin `scripts/build.js` spawns) both precede 15.6, which in turn precedes the root-script rewiring (15.7) and the bootstrap-sequencing example (15.14); and 15.7 precedes 15.15, which asserts the rewired scripts. 15.15 gets a wave of its own because it is the only sub-task that reads the finished root manifest.

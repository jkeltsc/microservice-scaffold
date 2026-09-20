# Implementation Plan: registry-inversion

## Overview

The plan follows the design's **Migration Order and Baseline Comparison** exactly: six steps, in the design's order, each ending in a checkpoint whose gate is `npm ci` followed by `npm run ci` at exit status zero plus `git diff --exit-code packages/integration-tests/baseline/` reporting exactly the recordings that step is allowed to have changed — an empty diff at every step but Step 4.

Step 0 comes first and cannot be reordered: `scripts/record-baseline.js` as committed cannot re-record the `build-order.<slug>.json` fixtures, so until it is repaired and proven to reproduce the Pre_Change_Baseline byte for byte, every later re-recording would be a statement about the recorder rather than about the code. Step 4 is the inversion and is decomposed into one sub-task per seam, in the design's own within-step order, so that a failure names one seam.

This repository adds **no `scaffold.config.json`**. It stays unconfigured and takes the Entry_Root_Default `app`; that is what the fresh-clone claims rest on. Any task needing a non-default `entry` declares it inside a `pristineWorktree()` copy or a Synthesized_Tree in an OS temporary directory, never in the checked-out tree.

## Tasks

- [x] 1. Step 0 — repair the baseline recorder before any fixture is trusted
  - [x] 1.1 Repair `recordBuildOrders`' `devProjectList` call in `scripts/record-baseline.js`
    - The recorder calls `withContext(devProjectList, context, value)`, resolving to `devProjectList(context, selectorString)`; the function's signature is `devProjectList(context, plan)`. Derive the plan and pass it: import `buildPlan` from the compiled `build-plan.js`, compute `const plan = withContext(buildPlan, context, value)`, then `const projectList = [...withContext(devProjectList, context, plan)]`.
    - This repairs the call, not the observable: the recorded value stays the Project_List `devProjectList` returns, recorded through the same entry point and the same public function.
    - Leave `REGISTRY_PATH` a module-level literal resolving `packages/overseer/src/generated/microservice-registry.ts` — `generatedRegistryPath` does not exist yet; it moves in task 9.11.
    - `scripts/record-baseline.js` is a one-shot developer script that writes committed fixtures. It is not a test and is not run by `npm test`.
    - _Requirements: 14.10, 14.15_

- [x] 2. Checkpoint — Step 0 gate
  - Run `npm ci && npm run build && node scripts/record-baseline.js`, then `git diff --exit-code packages/integration-tests/baseline/`. The diff MUST be empty over all thirteen fixtures: that empty diff is the proof the repaired recorder reproduces the Pre_Change_Baseline. A non-empty diff here is a defect in Step 0 and never a licence to commit the new bytes.
  - Then `npm ci && npm run ci` at exit status zero. Ensure all tests pass, ask the user if questions arise.

- [x] 3. Step 1 — relocate the shared test-support arbitraries
  - [x] 3.1 Move the Arbitraries_Module into `packages/build-tools/src/testing/`
    - Move `packages/contracts/testing/arbitraries.ts` → `packages/build-tools/src/testing/arbitraries.ts` and `packages/contracts/testing/index.ts` → `packages/build-tools/src/testing/index.ts`, so the compiled form lands at `packages/build-tools/dist/testing/`.
    - The moved source is byte-identical to its Pre_Change_Baseline apart from the module specifiers it declares and the header comment naming its own location; the exported symbol set is unchanged, none added and none removed.
    - Add `fast-check`, `express`, and `@types/express` to `packages/build-tools/package.json` `devDependencies`. Add no `exports` map to `build-tools` — that would close the compiled deep paths existing suites already import.
    - _Requirements: 11.1, 11.3, 11.4, 11.5_
  - [x] 3.2 Retarget every importer of the Retired_Testing_Specifier and add the dev dependency
    - The obligation stands over the set the build finds, not over this list; as the tree stands it is: `packages/overseer/tests/boot.test.ts`, `toggles.test.ts`, `router.property.test.ts`, `toggle-validation.property.test.ts`; `packages/microservices/microservice1/tests/handler.property.test.ts`, `spa-root-absent.test.ts`; `packages/microservices/microservice2/tests/handler.property.test.ts`; `packages/microservices/microservice3/tests/handler.property.test.ts`; `packages/integration-tests/tests/collision-abort.test.ts` — each to `@microservices/build-tools/dist/testing/index.js`; and `packages/build-tools/tests/registry-generator.unmatched.property.test.ts` to a relative `../src/testing/` path, being inside the owning package.
    - Each importing package's `package.json` gains `build-tools` as a **development** dependency, so no import adds a runtime dependency. Change nothing in these files beyond the specifier.
    - _Requirements: 11.6, 11.8_
  - [x] 3.3 Strip the testing surface from `packages/contracts/`
    - Delete the `./testing` entry from `packages/contracts/package.json` `exports`; ensure `fast-check` appears in neither its `dependencies` nor its `devDependencies`; delete `packages/contracts/tsconfig.testing.json`; collapse its `build` and `typecheck` scripts to exactly one compiler invocation each over its own `tsconfig.json`.
    - Leave `contracts`' type surface untouched: no type added, removed, or renamed.
    - _Requirements: 11.2, 11.4, 11.9_
  - [x] 3.4 Add `packages/integration-tests/tests/retired-testing-specifier.test.ts`
    - Scans every tracked `.ts`, `.js`, and `.json` file of every workspace package, of the Entry_Package, and of `scripts/`, excluding `.kiro/specs/` and its own source, and fails naming the offending file and line when a file names the Retired_Testing_Specifier.
    - One of Property 13's input-invariant observables.
    - _Requirements: 11.7, 13.13_
  - [x] 3.5 Add `packages/integration-tests/tests/shipped-import-reachability.test.ts`
    - Walks import declarations outward from each shipped barrel — `contracts`', the Overseer's, each Common_Package's, each microservice's `src/index.ts` — and fails if any reachable module imports the relocated Arbitraries_Module or `fast-check`, naming the reachable module and the import declaration that reached it.
    - The Entry_Module joins the root set in task 9.16, when it exists.
    - _Requirements: 11.10_

- [x] 4. Checkpoint — Step 1 gate
  - `npm ci && npm run ci` at zero, and `git diff --exit-code packages/integration-tests/baseline/` empty over all thirteen fixtures. `discovery.json` staying byte-unchanged is the specific check that this step added only *development* dependencies: that recording carries `dependencies` keys only, so a moved recording here means a runtime dependency was added. Ensure all tests pass, ask the user if questions arise.

- [x] 5. Step 2 — the `entry` configuration key and the two ProjectContext fields
  - [x] 5.1 Add the `entry` key to `packages/build-tools/src/project-config.ts`
    - Declare `ENTRY_ROOT_DEFAULT` as the literal `app` in this module — the same module that declares the Scope_Default and the three Root_Defaults, and the only module that may spell it. Add `EffectiveConfig.entry`, the two new `ConfigTag` members (`[config:entry-path]`, `[config:entry-overlap]`), the `EntryOverlapRelation` type, the parser's fourth per-value block, the overlap check against the eight reserved paths, and `entry` in the widened `RECOGNISED_TOP_LEVEL_KEYS` so `[config:unknown-key]` lists `entry`, `roots`, `scope` in ascending code-point order.
    - Take a declared value exactly as it appears in the JSON string: no trimming, no separator normalisation, no case normalisation. Decide every validation from the input string and the other declared values alone — no filesystem access for `entry`, no diagnostic about the Entry_Root's existence.
    - A non-string `entry` yields exactly one `[config:shape]` diagnostic and no `[config:entry-path]`, and is excluded from the overlap comparisons with no default substituted. Overlap diagnostics are one per offending pair, at most eight, ordered by ascending code point of colliding path, and name no value already rejected by the path check, the shape check, or `[config:root-path]`.
    - Nothing reads the new value yet, so no Baseline_Recording can move.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.16, 1.17_
  - [x] 5.2 Add `entryRoot` and `entryPointPath` to `packages/build-tools/src/project-context.ts`
    - Two readonly fields on `ProjectContext`, derived once in `projectContext(config)`, which stays pure and total over any `EffectiveConfig`. `entryPointPath` is the Entry_Root joined to `dist/index.js` by a single `/`, with `/` as its only separator and no normalisation of either part — derived in this one module and supplied to every consumer through the context.
    - Do **not** delete `OVERSEER_ENTRYPOINT` here; it still has readers, and removing it now breaks them. It goes in task 9.4.
    - _Requirements: 1.3, 7.1_
  - [x] 5.3 Add the three entry arbitraries to `packages/build-tools/tests/arbitraries/config.ts`
    - `arbAcceptedEntryRoot` — a Valid_Root_Path colliding with none of the eight reserved paths. `arbRejectedEntryRoot` — the three rejection shapes: invalid character or segment, and each of the three collision relations against each reserved path. `arbEntryConfigText` — Project_Config texts declaring `entry` across accepted, rejected, and wrong-typed spellings.
    - _Requirements: 13.10, 13.12_
  - [x] 5.4 Write `packages/build-tools/tests/project-config.entry.property.test.ts`
    - **Property 10: The Config_Parser accepts exactly the Entry_Roots satisfying the shape and overlap conditions**
    - **Validates: Requirements 1.4, 1.6, 13.10**
    - `fast-check`, at least 100 generated inputs per run declared in the file, and the header comment `Feature: registry-inversion, Property 10: …`. Assert acceptance iff Valid_Root_Path with no collision; exactly one `[config:entry-path]` per rejected value; one `[config:entry-overlap]` per offending pair up to eight, in ascending code-point order of colliding path; byte-identical diagnostic text and order across two runs over one input; and an identical diagnostic list whether or not a directory exists at the declared Entry_Root.
  - [x] 5.5 Update the existing config and context suites
    - `project-config.defaults.property.test.ts`, `.roundtrip.property.test.ts`, `.totality.property.test.ts`, `.determinism.property.test.ts`, `.shape.test.ts`: a fourth value participates in the defaults, the round trip, totality, determinism, and the unknown-key key list.
    - `project-context.property.test.ts`: `entryRoot` and `entryPointPath` join the derivations asserted pure and total.
    - _Requirements: 1.2, 1.3, 1.5, 1.7, 7.1_

- [x] 6. Checkpoint — Step 2 gate
  - `npm ci && npm run ci` at zero, and an empty baseline diff over all thirteen fixtures: nothing consumes the new values yet, so no recording can move. A project declaring `entry` gets a diagnostic at this step and nothing else. Ensure all tests pass, ask the user if questions arise.

- [x] 7. Step 3 — retire the Scope_Template_Check
  - [x] 7.1 Remove the `[scope:template]` check from `packages/build-tools/src/repo-invariants.ts`
    - Delete the check and its Registry_Template read; emit no `[scope:template]` diagnostic for any repository state. Keep every other check — Workspace_Coverage, import discipline, Common_Package dependency direction, the build-order-source check, the Load_Bearing_Setting check, `[scope:literal]` — with its existing tag, wording, and reporting order, and keep the clean-run report's printed text exactly as it is, since `check-invariants.txt` is held byte-fixed.
    - The Registry_Template itself still exists at this step and the root `prepare` script still copies it; only the check goes. The template is deleted in task 9.3 and `prepare` in task 9.9.
    - _Requirements: 6.1, 6.2, 6.3_
  - [x] 7.2 Delete the check's test and its expectations
    - Delete `packages/build-tools/tests/scope-template.test.ts` outright — its entire subject ceases to exist, and narrowing it would leave an assertion with no subject. Remove the `[scope:template]` expectations from `packages/build-tools/tests/check-repo-invariants.test.ts`, keeping every other tag, wording, and ordering assertion.
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 8. Checkpoint — Step 3 gate
  - `npm ci && npm run ci` at zero, and an empty baseline diff. `check-invariants.txt` byte-unchanged is the whole verification of this step: the retired check reported nothing in the Pre_Change_Baseline, so removing it must leave the printed text alone. Ensure all tests pass, ask the user if questions arise.

- [x] 9. Step 4 — the inversion
  - Work the sub-tasks in this order. By design the tree is red between 9.1 and 9.16: the Entry_Module's import of the Generated_Registry and the Overseer's import of it cannot both be satisfied, since exactly one location holds the file. The green gate for this step is task 10, not each sub-task. The alternative — generating into both locations for one commit — was rejected in the design: it writes under a Framework_Singleton in the interim, which R4.1 forbids.
  - [x] 9.1 Seam 1 — the Registry_Generator writes into the consumer's tree
    - In `packages/build-tools/src/generate-registry.ts`: replace the `OUTPUT_PATH` literal with `generatedRegistryPath(context)` returning `<Entry_Root>/src/generated/microservice-registry.ts` — the single derivation every writer, every presence guard, and every test reads from; split out the pure composer `registryText(context, selected): string` that `generateRegistry` writes through; make the write temporary-file-plus-rename so no partial registry is ever observable and a failed write leaves the previous complete bytes; create every absent directory of the path; remove the Registry_Template coupling note from the emitted header, keeping the generator-and-Selector header lines and emitting no timestamp, absolute path, host name, or user name; keep UTF-8, no BOM, `\n` only, exactly one trailing `\n`; write no file under any Framework_Singleton's directory; keep the `[selector:empty]` and `[selector:unmatched]` failures creating no directory and leaving an existing registry's bytes alone.
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 4.7, 4.8, 4.10, 5.8_
  - [x] 9.2 Seam 2 — create the Entry_Package
    - `app/package.json`: `name` composed as the Configured_Scope followed by `/` and the last path segment of the Entry_Root, `type: "module"`, the four standard scripts, `dependencies` naming the scoped `overseer` and scoped `contracts` packages, no Microservice_Package dependency, and no `main`/`types`. `build` and `typecheck` each perform a Registry_Generation_Step before invoking the compiler, via `app/scripts/generate-registry.mjs`.
    - `app/tsconfig.json`: `composite` and `declaration` true, `outDir` its own `./dist`, `rootDir` its own `./src`.
    - `app/scripts/generate-registry.mjs`: a dependency-free ESM shim importing nothing beyond `node:fs` and `node:child_process`. It verifies the Build_System's compiled entry point exists and, when absent, writes exactly one stderr diagnostic naming that absent path and the repository-root command that produces it, invokes no compiler, writes no registry, and exits non-zero; otherwise it spawns the generator.
    - `app/src/index.ts`: the verbatim move of `packages/overseer/src/index.ts`'s entrypoint with its two specifier edits — the Generated_Registry by a relative specifier inside the Entry_Package, and `boot`/`startServer` from the scoped `overseer` package by package name. Byte-identical stdout and stderr text to the Pre_Change_Baseline's module for the same registry, environment, and failure, including every bracketed prefix, every leading space of a table line, the line order, and the single `\n` per line.
    - Add `app` to the root `package.json` `workspaces` array (membership; position is load-bearing for nothing).
    - _Requirements: 1.8, 1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 5.4, 5.9, 14.14_
  - [x] 9.3 Seam 3 — the Overseer becomes a library
    - Rewrite `packages/overseer/src/index.ts` as a re-export barrel exporting `boot`, `startServer`, and every type either names in its signature — no `void main()`, no stderr write, no `process.exit`, no `startServer` call, no import of a generated file. Keep `main` as `./dist/index.js` and `types` as `./dist/index.d.ts`.
    - Delete `packages/overseer/src/generated/` and the Registry_Template it contains. Rewrite `boot.ts`'s header note, which names the retired arrangement.
    - No module of the library may carry a specifier containing the segment `generated` or a final segment named `microservice-registry`. Routing, mount order, duplicate-path rejection, toggle names, accepted values, and every message text stay as they are.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8_
  - [x] 9.4 Seam 4 — `framework.ts`
    - In `packages/build-tools/src/framework.ts`: `OVERSEER.staging` becomes `"scoped-node-modules"`, and `OVERSEER_ENTRYPOINT` is deleted. Every former reader becomes a reader of `context.entryPointPath`.
    - _Requirements: 3.7, 7.1, 7.2_
  - [x] 9.5 Seam 5 — ordering
    - In `packages/build-tools/src/build-sequence.ts`, the single module declaring every statement's position: add the Entry_Statement whose single member is the Entry_Package, strictly after every Selected_Microservice and after the Overseer and strictly before the test-only Framework_Singletons; renumber the test-only and Spa statements; add `"entry"` to `WorkspaceNode.tier`; move the synthetic edges so one Prerequisite_Edge runs from each Selected_Microservice to the Entry_Package and none from a microservice to the Overseer; derive the Overseer→Entry_Package edge from the Entry_Package's declared scoped `overseer` dependency like any other declared edge. Keep the Spa bundler phase trailing and the relative order of every pre-existing statement.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_
  - [x] 9.6 Seam 6 — image staging
    - In `packages/build-tools/src/build-plan.ts`: the Entry_Package and the Selected_Microservices become the walk roots, the Overseer_Library being reached through the Entry_Package's declared dependency rather than as a root; `stageOf` gains its fourth group; `StagedPackage.justification` gains `"entry-package"`. Stage the Entry_Package as a real directory at the Entry_Root holding its `package.json` and compiled `dist` and no `src`; stage the Overseer at `node_modules/<Configured_Scope>/overseer` and no longer at its package directory; keep `contracts` always staged; keep `build-tools`, `integration-tests`, the microservice Discovery_Root, and any Generated_Registry source out of every Image_Tree; report no `[image-tree:unjustified]` diagnostic for the Entry_Package's package-directory staging.
    - _Requirements: 3.7, 7.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.9_
  - [x] 9.7 Seam 7 — the registry-presence guard
    - Add `packages/build-tools/src/entry-registry.ts` holding the policy, pure over an injected `PathExists` probe so it is testable without a tree. It reads no content of the registry: it asks only whether a file exists at `generatedRegistryPath(context)`. When absent it writes exactly one stderr diagnostic naming the absent path and the command that produces it, invokes no compiler, emits no compiled output for the Entry_Package, and exits non-zero.
    - Wire it ahead of every `tsc` invocation whose roots include the Entry_Package: immediately before `executeBuildPlan`'s `tsc --build`, and before the Dev_Supervisor's builder's first pass.
    - _Requirements: 2.10, 5.3, 5.5_
  - [x] 9.8 Seam 8 — startup
    - `packages/build-tools/src/dev-supervisor.ts`: parameterise the spawn path on `context.entryPointPath`, spawning and respawning it, keeping at most one supervised child and waiting for the previous child's exit before spawning its replacement. Include the Entry_Package in the watched project set. Leave the pure decision core — `DevEvent`, `DevState`, `DevAction`, `decide`, `reduceDevEvents` — untouched.
    - `scripts/start.js` and `scripts/dev.js`: same four ordered steps as the Pre_Change_Baseline — environment load, bootstrap build, registry generation, server start — with generation writing the new path and the spawn naming the Entry_Point_Path. `npm start` exits with the spawned process's status and watches nothing.
    - Keep `scripts/build.js` and `scripts/common-startup.js` and their position in every startup sequence.
    - _Requirements: 7.2, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 14.13_
  - [x] 9.9 Seam 9 — install and ignore
    - Remove the `prepare` script performing the Template_Copy_Step from the root `package.json`, so neither `npm install` nor `npm ci` writes a Generated_Registry. In `.gitignore`, drop the entry naming `packages/overseer/src/generated/microservice-registry.ts` and add one naming the Generated_Registry's path under the Entry_Root; exclude the same path from the container build context in `.dockerignore`.
    - _Requirements: 3.6, 5.1, 5.2, 5.7_
  - [x] 9.10 Seam 10 — the Emit_Script and the template
    - `scripts/emit-effective-dockerfile.sh`: read `entry` the same way the three roots are read — the character sequence delimited by the surrounding double quotes, no trimming, no normalisation — falling back to the Entry_Root_Default when the key or the file is absent; emit exactly one manifest `COPY` line for the Entry_Package's `package.json`; keep the Exclusion_List derivation unchanged. Add pass-2 validation that the template holds the `# --- CMD ---` anchor (failing with `[emit-effective-dockerfile] <template> is missing the '# --- CMD ---' anchor`) and declares no `CMD` of its own (failing with a message naming the offending line), both before printing a line, leaving the temporary file empty and unmoved. At the anchor print `CMD ["node", "<Entry_Point_Path>"]` and nothing else. `fail("entry")` aborts inside pass 1 before `mktemp`, writing no generated `Dockerfile` and leaving any file at that path byte-identical. Invoke no external command the baseline did not already invoke.
    - `Dockerfile.template`: remove the two stand-in `COPY` instructions (build stage and production-dependency stage) with their comment blocks, remove any literal entrypoint path, add the `# --- CMD ---` anchor, and keep `ENTRYPOINT ["dumb-init", "--"]` as committed source so the toggle-default `ENV` block keeps anchoring on the last `ENTRYPOINT`.
    - _Requirements: 5.7, 7.3, 7.4, 7.5, 7.6, 7.8_
  - [x] 9.11 Seam 11 — the recorder's registry path
    - In `scripts/record-baseline.js`, delete `REGISTRY_PATH` and have `recordRegistries` derive the path, keeping the two-module-shape tolerance the script already uses so it still runs at the Pre_Change_Baseline commit: import `generateRegistry` and `generatedRegistryPath` from the compiled `generate-registry.js`, and resolve `packages/overseer/src/generated/microservice-registry.ts` when `generatedRegistryPath` is `undefined`, otherwise `generatedRegistryPath(context)`.
    - Same entry point, same observable, same public function as the Pre_Change_Baseline recording.
    - _Requirements: 14.10_
  - [x] 9.12 Seam 12a — add the two layout arbitraries
    - In `packages/build-tools/tests/arbitraries/tree.ts`: `arbSynthesizedTreeWithEntry` — a Synthesized_Tree of 1–5 microservices, 0–3 Common_Packages, and an Entry_Package at a generated Entry_Root, each with a minimal manifest and a seeded one-line `dist/`, materialized in an OS temporary directory; and `arbWorkspacesPermutation` — a permutation of a Root_Manifest's `workspaces` entries.
    - No property builds a layout inline, and no generator is written twice: the relocated module already supplies `arbIdentifier`, `arbPath`, `buildExpressRouter`, `arbSelectorString`, `arbEnvironment`, `toggleVarName`, and `arbNamespaceDirectories`.
    - _Requirements: 12.4, 13.12_
  - [x] 9.13 Seam 12b — the `build-tools` property suites
    - Each file declares at least 100 runs in the file and carries the header comment `Feature: registry-inversion, Property N: …`. Properties 1, 2, 6, 7, and 8 run in memory over `registryText` and the derivations; only 5 and 9 touch disk, each creating one temporary root in `beforeAll`, a per-input subdirectory, and removing the root in `afterAll` whether assertions passed or failed.
    - Extend `registry-generator.property.test.ts` — **Property 1: The emitted import-specifier sequence is the Selected_Microservices**. **Validates: Requirements 4.3, 13.1**
    - Extend `registry-generator.scope.property.test.ts` — **Property 2: Every emitted specifier carries the Configured_Scope**. **Validates: Requirements 4.5, 13.2**
    - Add `registry-generator.write.property.test.ts` — **Property 5: Regenerating the registry is idempotent and replaces rather than accumulates**. **Validates: Requirements 4.7, 13.5**
    - Add `entry-root-relocation.property.test.ts` — **Property 6: Every derived path differs only in the Entry_Root prefix**. **Validates: Requirements 13.6**
    - Add `build-sequence-entry.property.test.ts` — **Property 7: The derived order places the Entry_Package last, invariantly under `workspaces` permutation**. **Validates: Requirements 8.1, 13.7**
    - Extend `build-order-violation.property.test.ts` — **Property 8: The Verification_Pass rejects exactly the orders that violate a Prerequisite_Edge**. **Validates: Requirements 8.6, 13.8**
    - Add `image-tree.entry-staging.property.test.ts` — **Property 9: Exactly one staged package sits at a package directory, and it holds the Entry_Point_Path**. **Validates: Requirements 9.6, 13.9**
  - [x] 9.14 Seam 12c — the boot-pipeline property suites
    - Add `packages/integration-tests/tests/registry-boot-equivalence.property.test.ts` — **Property 3: Boot over a generated registry agrees with boot over a hand-built one**. **Validates: Requirements 13.3**
    - Add `packages/integration-tests/tests/registry-mounted-paths.property.test.ts` — **Property 4: The mounted path set is a function of the Selector and the toggles alone**. **Validates: Requirements 13.4, 14.2**
    - Extend `packages/overseer/tests/toggle-validation.property.test.ts` — **Property 11: Toggle variable names and value semantics are unchanged**. **Validates: Requirements 14.3, 13.11** — classifying each generated value against a table of the Pre_Change_Baseline's accepted values fixed in the test rather than read from the code under test.
    - These two suites live in `integration-tests` because they drive the Overseer_Library's boot pipeline and the Registry_Generator in one test; they bind no socket. Each declares at least 100 runs and carries its `Feature: registry-inversion, Property N: …` comment.
  - [x] 9.15 Seam 12d — the example-based suites
    - Add `packages/integration-tests/tests/entry-fresh-clone.test.ts` — **Property 14: The fresh-clone guarantee and its named diagnostic hold over a materialized copy**. **Validates: Requirements 5.4, 5.5, 13.14** — two examples over one `pristineWorktree()` copy shared in `beforeAll` (the `npm ci` inside it is the slowest thing this feature adds): the Entry_Package's own `typecheck` with no Generated_Registry present exits zero and leaves one at its path; and compiling with the Registry_Generation_Step suppressed writes the R5.5 diagnostic, invokes no compiler, and exits non-zero. Skip with the returned `reason` when `available === false`, assert nothing against the checked-out repository in its place, report no failure for the skip, and remove any partial temporary directory.
    - Add `packages/integration-tests/tests/entry-package-conventions.test.ts` — a sibling of `common-package-conventions.test.ts`: the composed `name`, `type: "module"`, the four scripts, the two scoped dependencies, the absence of a Microservice_Package dependency and of `main`/`types`, and all four Load_Bearing_Settings. _Requirements: 1.10, 1.11, 1.12, 1.13, 1.14_
    - Add `packages/integration-tests/tests/property-run-floor.test.ts` — **Property 12: Every property above is a fast-check property over at least 100 inputs**. **Validates: Requirements 13.12** — over the fixed finite set of the suite's own property files, checking the `fast-check` use, the `.property.test.ts` file-name convention, and the declared run floor, so a lowered `numRuns` cannot pass unnoticed.
  - [x] 9.16 Seam 12e — update every suite the relocations force
    - `worktree-safety-guard.test.ts`: the permitted in-place write set becomes exactly a package's gitignored `dist/`, a `*.tsbuildinfo`, and `<Entry_Root>/src/generated/microservice-registry.ts`. It must name the new path and **no** path under the retired `packages/overseer/src/generated/`. Keep it failing on a destructive git command by any means, on a restore helper under any name, and on a mutation destined inside the checked-out tree outside that set; keep it failing when its scanned set is empty, omits the shared helper module, or yields no executable text after comment and literal elision. _Requirements: 12.1, 12.2, 12.7, 12.8_
    - `migration-facts.test.ts`: the absence of the Registry_Template and the Template_Copy_Step, and the presence of the Entry_Package. `baseline-equivalence.test.ts`: compare against the four re-recorded fixture families, the two held-fixed families keeping their assertions unchanged, failing with a diagnostic naming the observable, the recorded value, and the observed value, rewriting no recording and leaving the tree unmodified. `shipped-import-reachability.test.ts`: the Entry_Module joins the walk roots.
    - `framework.test.ts`, `framework.property.test.ts`; `workspace-coverage.property.test.ts`; `build-sequence.test.ts`, `build-sequence.property.test.ts`, `build-sequence-spa-phase.property.test.ts`, `build-sequence-verification.property.test.ts`; `build-order-preservation.property.test.ts`, `workspace-order.permutation.property.test.ts`, `ordered-build.property.test.ts`; `dev-project-list.property.test.ts`, `dev-image-parity.property.test.ts`; `image-tree.staging.property.test.ts`, `image-tree.integrity.property.test.ts`, `image-tree-minimality.test.ts`, `shared-package-staging.test.ts`; `dockerfile.test.ts`, `effective-dockerfile.test.ts`, `emit-dockerfile-config.test.ts`, `emit-dockerfile-failures.test.ts`, `emit-dockerfile.property.test.ts`; `start-parity.test.ts`, `dev-start-parity.test.ts`, `dev-cold-start.test.ts`, `dev-warm-tree.test.ts`, `dev-error-recovery.test.ts`, `dev-session-scope.test.ts`, `dev-selector-relay.test.ts`, `dev-environment-passthrough.test.ts`, `dev-additive-only.test.ts`; `repository-build.test.ts`, `ci-wiring.test.ts`; `scope-literal.property.test.ts` (unchanged in shape, still reporting nothing now that it scans a directory holding the relocated arbitraries); `non-default-configuration.test.ts` (a non-default `entry` alongside a non-default scope and roots, declared inside a copy or a Synthesized_Tree — never in the checked-out tree).
    - `dev-restart-decision.property.test.ts` deliberately does **not** change: the decision core is untouched and only the spawned path moves.
    - Any suite causing the Generated_Registry to be written captures its bytes beforehand when present, restores them with a filesystem write whether assertions passed or failed, and removes the file when it was absent before the run — never through git. Suites needing another layout synthesize it in an OS temporary directory, re-root every written path there, pass it as the working directory of every spawned process, and remove it on the way out; no package, directory, or `node_modules` symlink is created inside the checked-out tree.
    - _Requirements: 6.4, 6.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 13.13, 14.11_
  - [x] 9.17 Seam 13 — re-record the baselines
    - Run `npm run build && node scripts/record-baseline.js`. The recorder rewrites all thirteen files; four families are expected to change and two to come back byte-identical. Do not accept a diff until tasks 9.18–9.21 confirm each family's confinement — a difference outside those rules is a defect in this step, not a new expectation.
    - _Requirements: 14.10, 14.11, 14.15_
  - [x] 9.18 Confirm the `registry.<slug>.ts` ×3 confinement
    - The **only** permitted difference is the removal of the contiguous comment lines naming the Registry_Template. Byte-equal: the generator-and-Selector header lines, every import declaration and its position, the exported binding's name and type annotation, every entry with its field names, field order, and field values, and the single trailing newline.
    - _Requirements: 14.6, 14.11, 14.15_
  - [x] 9.19 Confirm the `dockerfile.<slug>` ×3 confinement
    - Permitted: exactly three items plus comments — the two stand-in `COPY` instructions gone from the build stage and the production-dependency stage; one `COPY app/package.json app/` added to each manifest block; the single `CMD`'s path argument now `app/dist/index.js`. Every `ARG`, `ENV`, `FROM`, `WORKDIR`, `RUN`, `EXPOSE`, `USER`, `ENTRYPOINT`, and retained `COPY` is byte-identical and in the same position, the toggle-default `ENV` lines included. Comment differences are confined to lines naming the Registry_Template, the Template_Copy_Step, or the retired entrypoint path — which is the ground on which the header's image-layout comment loses its `packages/overseer/` line.
    - _Requirements: 14.7, 14.11, 14.15_
  - [x] 9.20 Confirm the `image-tree.<slug>.json` ×2 confinement
    - Permitted: exactly three edits — `packages/overseer` removed, `node_modules/@microservices/overseer` added, and one entry naming `app` added. Every other entry present with byte-identical text, the ascending code-point order kept, and no entry for a Selected_Microservice, for `contracts`, or for a Required_Dependency added or removed.
    - _Requirements: 14.8, 14.11, 14.15_
  - [x] 9.21 Confirm the `build-order.<slug>.json` ×3 confinement
    - Permitted: exactly one entry naming `app` inserted into each of the two recorded sequences — into `buildOrder` immediately after `packages/overseer` and before `packages/integration-tests`, and into `projectList` immediately after `packages/overseer`. The `selector` value, the membership otherwise, and the relative order of every other entry are equal, with nothing removed. For `build-order.all.json`, `buildOrder` goes from ten entries to eleven and `projectList` from seven to eight.
    - Also confirm `discovery.json` and `check-invariants.txt` come back byte-unchanged: "held fixed" means "rewritten with identical bytes", and the empty diff on those two paths is what distinguishes them.
    - _Requirements: 14.4, 14.5, 14.9, 14.11, 14.15_

- [x] 10. Checkpoint — Step 4 gate
  - `npm ci && npm run ci` at exit status zero — this is the first green point since task 9.1, and the design's reason for that is stated in task 9's preamble. Then `git diff packages/integration-tests/baseline/` showing exactly the four re-recorded families within the confinement rules of tasks 9.18–9.21 and nothing else. Also confirm the two documented image builds for `*` and for `microservice1,microservice2` each exit zero, start from the Entry_Point_Path, and answer each enabled microservice's declared path from its own router (R9.8). Ensure all tests pass, ask the user if questions arise.

- [x] 11. Step 5 — steering and the README
  - [x] 11.1 Update `.kiro/steering/structure.md`
    - The Entry_Package: at the Entry_Root outside the directory holding the Framework_Singletons, default `app`, in no Consumer_Category and discovered by no Discovery_Root, holding the committed Entry_Module and receiving the generated registry; shown in the layout as a direct child of the Project_Directory, with relocating it requiring the same-change `workspaces` update already stated for a relocated Discovery_Root. The registry at `<Entry_Root>/src/generated/microservice-registry.ts`, gitignored, statically imported only by the Entry_Module. The Overseer as a library whose public API is its barrel, importing no generated file, staged at `node_modules/<scope>/overseer` while the Entry_Package is staged at its package directory because the entrypoint is invoked by path. The arbitraries under `packages/build-tools/`, `contracts` types-only, and a package importing them declaring `build-tools` as a development dependency. Keep the always-staged `contracts` statement and the open question about types-only packages open. Describe none of the deferred work — no published package, no bootstrap removal, no tier split, no shipped presets, no wiring generator, no CI/release split.
    - _Requirements: 15.1, 15.3, 15.4, 15.8, 15.11, 15.12, 15.13_
  - [x] 11.2 Update `.kiro/steering/tech.md`
    - `entry` as the third recognised top-level key with its default, and rejection of an Entry_Root equal to, inside, or containing a Discovery_Root or the Framework_Singleton container with a named diagnostic before any discovery or build. Every path compiling the Entry_Package generates the registry first, the Entry_Package's own `build` and `typecheck` included — and no statement anywhere that `prepare` copies a registry template, no reference to the Registry_Template as a committed file, and none to `[scope:template]` as a check `check:invariants` performs. The Build_Sequence placing the Entry_Package after the Selected_Microservices and the Overseer and before the test-only Framework_Singletons, the Spa bundler build still trailing. The Entry_Point_Path as the module `npm start`, `npm run dev`, and a container run each execute, naming no Framework_Singleton's compiled path in that role. The Emit_Script reading `entry` alongside the three roots, emitting the Entry_Package's manifest `COPY` line and the `CMD`. The worktree-safety permitted-write set gaining the new registry path and losing the retired one.
    - _Requirements: 15.2, 15.5, 15.6, 15.7, 15.9, 15.10, 15.11_
  - [x] 11.3 Update `README.md`
    - Name the Entry_Point_Path, and no Framework_Singleton's compiled path, as the module a local run and a container run execute.
    - _Requirements: 7.9, 15.7_
  - [x] 11.4 Widen `stale-documentation-guard.test.ts`'s forbidden-string set
    - Add the retired generated-registry path under `packages/overseer/src/`, the Registry_Template, the Template_Copy_Step, `[scope:template]`, and the Retired_Testing_Specifier, failing naming the offending document and line. This is what turns Step 5 from a promise into a gate.
    - _Requirements: 15.14_

- [x] 12. Final checkpoint
  - `npm ci` then `npm run ci` at exit status zero — ordered build, `check:invariants`, `typecheck --workspaces`, `lint --workspaces`, `npm test`, `test:types` — plus the baseline comparison showing only the four re-recorded families within their confinement rules. Ensure all tests pass, ask the user if questions arise.

## Notes

- **Nothing here is marked optional.** The six migration steps are the feature, and the test work is not decoration: Requirement 13 makes the property and example suites a deliverable in their own right, Requirement 12 makes the worktree guard one, and the baseline comparison in every checkpoint depends on the suites being in place. Skipping any sub-task would leave a requirement uncovered.
- **The green rule, precisely.** `npm run build`, `npm run check:invariants`, `npm run typecheck --workspaces`, `npm run lint --workspaces`, `npm test`, `npm run test:types`, and the baseline comparison all pass at every step boundary — tasks 2, 4, 6, 8, 10, and 12. Within Step 4 the tree is red between tasks 9.1 and 9.16, because exactly one location can hold the Generated_Registry and both packages cannot compile at once; the design records this and rejects the dual-write alternative for writing under a Framework_Singleton in the interim.
- **Worktree safety is a constraint on every task that touches a test.** The only permitted in-place writes are a package's gitignored `dist/`, a `*.tsbuildinfo`, and the Generated_Registry at its new path under the Entry_Root — captured before the first write, restored by writing the captured bytes back whether assertions passed or failed, removed when it was absent before the run. No destructive git command under any name, and no restore-through-git helper. Everything else goes in a `pristineWorktree()` copy or a Synthesized_Tree in an OS temporary directory, removed on the way out even when assertions fail.
- **This repository stays unconfigured.** No `scaffold.config.json` is added; `app` comes from the Entry_Root_Default. Tasks 5.4, 9.13, and 9.16's `non-default-configuration.test.ts` are the ones needing a non-default `entry`, and each declares it inside a copy or a synthesized tree.
- **Two sequencing observations, neither a design gap.** (1) `shipped-import-reachability.test.ts` lands in Step 1 (task 3.5) but R11.10 names the Entry_Module among its walk roots, and the Entry_Module does not exist until task 9.2 — so the Entry_Module joins the guard's roots in task 9.16. (2) `scripts/record-baseline.js` is edited twice, in tasks 1.1 and 9.11, which is the design's own split: the path derivation cannot move before `generatedRegistryPath` exists.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3"] },
    { "id": 3, "tasks": ["3.4", "3.5"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3"] },
    { "id": 5, "tasks": ["5.4", "5.5"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["7.2"] },
    { "id": 8, "tasks": ["9.1", "9.5"] },
    { "id": 9, "tasks": ["9.2", "9.3"] },
    { "id": 10, "tasks": ["9.4"] },
    { "id": 11, "tasks": ["9.6", "9.9"] },
    { "id": 12, "tasks": ["9.7"] },
    { "id": 13, "tasks": ["9.8"] },
    { "id": 14, "tasks": ["9.10", "9.11", "9.12"] },
    { "id": 15, "tasks": ["9.13", "9.14", "9.15"] },
    { "id": 16, "tasks": ["9.16"] },
    { "id": 17, "tasks": ["9.17"] },
    { "id": 18, "tasks": ["9.18", "9.19", "9.20", "9.21"] },
    { "id": 19, "tasks": ["11.1", "11.2", "11.3"] },
    { "id": 20, "tasks": ["11.4"] }
  ]
}
```

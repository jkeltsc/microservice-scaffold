# Implementation Plan: api-dev-server

## Overview

Implementation proceeds in five movements, each of which leaves the workspace buildable and `npm run ci`-clean:

1. **Single-source Common_Startup** — add `scripts/common-startup.js` (uncompiled ESM, because it *performs* the Bootstrap_Build and so cannot itself require compilation) and refactor `scripts/start.js` to consume it. Production_Start's observable behavior is preserved by the `tag` option and verified later by the parity test rather than by inspection.
2. **The pure decision core** — `DevEvent` / `DevState` / `DevAction` / `decide` / `reduceDevEvents` in `packages/build-tools/src/dev-supervisor.ts`, paired immediately with the model-based property test over generated event interleavings. This is the verification of Requirement 5, the design's central problem, and it is testable with no process spawned.
3. **Project_List derivation** — `projectListFrom`, reusing `resolveSelected`, `listMicroserviceDirectories`, `discoverSharedPackages`, and `requiredSharedPackages` from existing build-tools modules rather than reimplementing selection or closure logic.
4. **The process-effect shell and the wiring** — the in-process solution builder, the Overseer child, the bin wrapper, `scripts/dev.js`, and the root `dev` script. After this movement the Dev_Command runs end to end.
5. **Integration tests and documentation** — the session harness, the six process-level suites, the structural additive-only assertions, then `README.md` and `.kiro/steering/tech.md`, then the full quality gate.

The five movements above describe the original plan; two movements were added after the fact and account for the difference between that count and the task list. Movement 10 corrects the session's initial-start rule, which shipped gated on emit and so left a warm tree with a Build_Watcher and no Overseer. Movement 11 is structural only: it consolidates the supervisor's CLI layer into an exported `runDevSupervisorCli` per design 4d, leaving the bin a one-liner symmetric with its two siblings, and changes no behavior.

Language: TypeScript (strict, ES modules, Node 22) for the supervisor, plain ESM JavaScript for the two `scripts/` entry points, matching the existing workspace. Property tests use `fast-check` with a minimum of 100 iterations and carry the tag comment `Feature: api-dev-server, Property {number}: {property_text}`.

No dependency is added: `typescript` and `fast-check` are already root devDependencies. No change to the root `workspaces` array is needed — `packages/build-tools` is already positioned before the microservices and the Overseer.

## Tasks

- [x] 1. Single-source Common_Startup and refactor Production_Start
  - [x] 1.1 Create `scripts/common-startup.js`
    - Export `runCommonStartup({ tag, selector, env })` performing the two Common_Startup steps in order: Bootstrap_Build of `@microservices/contracts` + `@microservices/build-tools`, then the compiled bin `packages/build-tools/dist/bin/generate-registry.js` with the inherited environment and the `MICROSERVICES` value passed through unmodified
    - Return the discriminated result `{ ok: true, selector, steps }` / `{ ok: false, step, message, status, steps }`; never call `process.exit` and never write to a stream, so the caller owns every process effect
    - Record the step names in `steps` in the order they ran, so the two entry points' sequences can be compared directly
    - Move the clean-checkout ordering comment block out of `scripts/start.js` verbatim and make this module its sole owner: Bootstrap_Build before the generator bin, registry generation before the full TypeScript build, and both relying on the topological root `workspaces` array; record why the module cannot move into `packages/build-tools/`
    - _Requirements: 1.3, 2.1, 2.2, 2.5, 11.1, 11.2_

  - [x] 1.2 Refactor `scripts/start.js` to consume `runCommonStartup`
    - Replace the two inline `runOrExit` calls (bootstrap build, registry generation) with one `runCommonStartup({ tag: "start" })` call plus a failure branch; leave `npm run build --workspaces`, the `spawnSync` of `packages/overseer/dist/index.js`, and the exit-status propagation untouched
    - Preserve the failure line byte-for-byte on stderr: `[start] "<command> <args>" failed (<reason>); refusing to start the Overseer`
    - Keep Production_Start one-shot: no watching, no Overseer_Restart, exits with the Overseer process's status
    - _Requirements: 9.9, 11.5, 11.6_

  - [x] 1.3 Write property test for registry-generation determinism
    - `packages/build-tools/tests/dev-common-startup.property.test.ts`; invoke `generateRegistry(selector)` twice per generated selector over the discovered directory listing, read the emitted file each time, and assert byte-identical content plus an identifier set equal to `resolveSelected(selector, directories)`; restore the generated registry afterwards
    - **Property 10: Common_Startup yields one registry for both entry points** (determinism half)
    - **Validates: Requirements 11.3**

- [x] 2. Implement the pure decision core
  - [x] 2.1 Define the supervisor's types in `packages/build-tools/src/dev-supervisor.ts`
    - Declare `DevEvent` (`file-change`, `compile-start`, `compile-complete` with `errorCount` + `emitted`, `overseer-ready`, `overseer-exited`, `signal`), `OverseerPhase`, `DevState` (`overseer`, `compiling`, `generation`, `runningGeneration`, `restartPending`, `awaitingCleanPass`, `hasLastGood`, `terminating`), `DevAction` (`start-overseer`, `stop-overseer`, `stop-watcher`, `log`), and `initialDevState`
    - Keep `DevAction` closed over exactly those four variants, so no action can regenerate the registry or re-list `packages/microservices/` at the type level
    - _Requirements: 2.6, 7.1, 7.3_

  - [x] 2.2 Implement `decide(state, event)`
    - Total and pure: no I/O, no timers, no clock, no filesystem, no observation of the Compiled_Tree
    - Encode the transition table from the design: `file-change` / `compile-start` set `compiling` and emit no start/stop; an erroring `compile-complete` logs the completion and its error count and emits no start/stop, additionally logging that no Overseer will start when `hasLastGood` is false; a clean non-emitting pass logs only; a clean emitting pass advances `generation`, sets `hasLastGood`, clears `awaitingCleanPass`, then starts, or stops-with-`restartPending`, or records `restartPending` only, according to phase
    - `overseer-ready` moves `starting` → `running` and logs the restart record; `overseer-exited` from `stopping` honours `restartPending`; `overseer-exited` from `starting` or `running` logs to stderr, sets `awaitingCleanPass`, and starts no replacement; `signal` sets `terminating` and emits `stop-overseer` then `stop-watcher`; no action follows once `terminating` is set
    - Emit `start-overseer` only from phase `none` and always carrying the current `generation`, so two children can never be alive at once and the executed output is always a Last_Good_Output
    - _Requirements: 1.6, 4.2, 4.5, 4.6, 4.7, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.2, 6.4, 6.5, 6.6, 6.7_

  - [x] 2.3 Implement `reduceDevEvents(events, state?)`
    - Fold an event sequence through `decide`, returning the final state and the concatenated action trace; used by both the property test and the shell so there is one folding implementation
    - _Requirements: 5.4, 5.6_

  - [x] 2.4 Write property test for restart gating over event interleavings
    - `packages/build-tools/tests/dev-restart-decision.property.test.ts`; generate arbitrary `DevEvent` sequences including physically impossible orderings (a `compile-complete` with no preceding `compile-start`, an `overseer-exited` with no child) so totality is exercised; assert the live-child counter never exceeds 1, every `start-overseer` follows a clean emitting pass and carries its `generation`, no start/stop appears between a `compile-start` and its `compile-complete`, no start follows an erroring pass without an intervening clean pass, an unrequested exit yields no replacement, one completion log per `compile-complete` and one restart record per `overseer-ready`, and a `signal` yields `stop-overseer` then `stop-watcher`
    - **Property 3: Restart gating over arbitrary event interleavings**
    - **Validates: Requirements 1.6, 2.6, 4.2, 4.6, 4.7, 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8, 6.2, 6.5, 6.6, 7.1, 7.3**

  - [x] 2.5 Write property test for no-op pass restart-idempotence
    - A separate `describe` in `packages/build-tools/tests/dev-restart-decision.property.test.ts`; for any sequence whose `compile-complete`s after the first clean emitting pass all have `emitted === false`, assert exactly one `start-overseer`; for any settled burst, assert at most one
    - **Property 4: A no-op Compile_Pass is restart-idempotent**
    - **Validates: Requirements 4.5, 5.4**

- [x] 3. Checkpoint - Common_Startup and the decision core
  - Run `npm run typecheck --workspaces`, `npm run lint --workspaces`, and `npm test` (its `pretest` builds every workspace)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Derive the Project_List
  - [x] 4.1 Implement `projectListFrom` and `devProjectList` in `packages/build-tools/src/dev-supervisor.ts`
    - `projectListFrom(selector, directories, shared, readDependencies)` returns the root projects in build order: required shared packages (topological), then the selected microservices, then `packages/overseer`
    - Compose `resolveSelected` from `./selector.js` and `requiredSharedPackages` from `./shared-packages.js`; reimplement neither selection nor closure logic, so an unmatched identifier surfaces as the existing `[selector:unmatched]` error
    - Keep it pure over injected inputs; add `devProjectList()` supplying the real-filesystem defaults (`listMicroserviceDirectories`, `discoverSharedPackages`, a manifest-based `readDependencies`), listing `packages/microservices/` exactly once at startup
    - Exclude `packages/build-tools` and `packages/integration-tests` from the list by construction
    - _Requirements: 2.1, 2.2, 2.4, 3.1, 3.6, 3.7, 7.1, 7.3_

  - [x] 4.2 Write property tests for Project_List membership, ordering, and selector equality
    - `packages/build-tools/tests/dev-project-list.property.test.ts`; generate synthetic layouts (a shared-package DAG, microservice directories with `@microservices` dependency subsets, an arbitrary selector) in the style of `packages/build-tools/tests/shared-packages.order.property.test.ts`; assert membership equals the shared closure of the selected set plus the Overseer with no build-tools or test-only package present, that every dependency edge places the dependency first and every selected microservice precedes `packages/overseer`, that the microservice members equal `resolveSelected(selector, directories)` for unset, blank, `*`, padded and duplicated selectors, and that an unmatched identifier throws `[selector:unmatched]` naming every offender
    - **Property 1: Project_List membership and topological order**
    - **Property 2: Selector resolution is the existing behavior**
    - **Validates: Requirements 2.1, 2.2, 2.4, 3.1, 3.6, 3.7**

- [x] 5. Wire the process-effect shell and the Dev_Command
  - [x] 5.1 Implement the shell in `packages/build-tools/src/dev-supervisor.ts`
    - Build the watcher with `ts.createSolutionBuilderWithWatchHost(sys, undefined, reportDiagnostic, reportBuilderStatus, reportWatchStatus)` then `ts.createSolutionBuilderWithWatch(host, projectList, { incremental: true }, {})` and `.build()`; map TS 6032 → `compile-start` and TS 6193 / TS 6194 → `compile-complete` with the reporter's typed `errorCount`
    - Report diagnostics through TypeScript's `formatDiagnosticsWithColorAndContext`, so each names the source file with its line and character position
    - Wrap the host's `writeFile` to record whether the current cycle emitted, supplying `emitted`; read and reset the flag when the cycle settles — bookkeeping about the supervisor's own writes, never a watcher on `dist/` and never a debounce timer
    - Spawn the Overseer with `spawn(process.execPath, ["packages/overseer/dist/index.js"], { env, stdio: ["ignore", "pipe", "inherit"] })`, passing the session-start environment through with no mutation; forward the child's stdout verbatim and scan it for the existing `[boot] Overseer listening on port` line to raise `overseer-ready`, adding no branch to `packages/overseer/src/`
    - Perform returned actions in order and hold no policy of its own: `stop-overseer` sends `SIGTERM` and waits for `exit`, whose handler is the only source of `overseer-exited`; `SIGINT` / `SIGTERM` raise a `signal` event, stop the child, close the builder's watchers, and exit
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.8, 4.1, 4.3, 4.4, 5.6, 6.1, 6.3, 8.1, 8.2, 9.4_

  - [x] 5.2 Add the bin wrapper `packages/build-tools/src/bin/dev-supervisor.ts`
    - Read `process.env.MICROSERVICES`, call `devProjectList()`, and start the shell; report a watcher launch failure as `[dev] failed to start the build watcher: <reason>` on stderr and exit non-zero
    - Register `"dev-supervisor": "./dist/bin/dev-supervisor.js"` in the `bin` block of `packages/build-tools/package.json` alongside `generate-registry` and `build-image-tree`; add no barrel, keeping the bin-only exception intact
    - _Requirements: 1.4, 1.5, 2.4_

  - [x] 5.3 Create `scripts/dev.js` and register the Dev_Command
    - Call `runCommonStartup({ tag: "dev" })`; on failure write `[dev] <message>` to stderr naming the failed step and exit with that status without spawning any Overseer
    - On success spawn `packages/build-tools/dist/bin/dev-supervisor.js` with `stdio: "inherit"` and the inherited environment, exit with its status, and forward `SIGINT` / `SIGTERM` to it, waiting for it to exit
    - Add `"dev": "dotenvx run -- node scripts/dev.js"` to the root `package.json` scripts and change nothing else there — no dependency entries, no change to the `ci` script composition
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.3, 8.3, 9.6, 9.7_

  - [x] 5.4 Verify the wired chain builds and passes the existing suite
    - Run `npm run typecheck --workspaces`, `npm run lint --workspaces`, and `npm test`; fix any fallout in the new sources rather than in the Overseer or the image pipeline
    - _Requirements: 9.5, 9.6_

- [x] 6. Checkpoint - the Dev_Command runs end to end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Integration tests
  - [x] 7.1 Extend `packages/integration-tests/tests/helpers.ts` with the session harness
    - Add `startDevSession()`: spawn the Dev_Command, capture both streams, expose a deadline-bounded `waitForOutput(pattern)`, and guarantee teardown so no child outlives the test
    - Add `pristineWorktree()`: materialize a clean tree with `git archive HEAD` into a temp directory plus `npm ci` there, and signal unavailability so its consumers skip with a clear message instead of failing when `git` is absent
    - Restore any working-tree source file a session test mutates; `dist/` and the generated registry are gitignored and are expected to churn
    - _Requirements: 1.6, 3.7_

  - [x] 7.2 Write the error-then-fix round-trip test
    - `packages/integration-tests/tests/dev-error-recovery.test.ts`; example one introduces a type error into a microservice source and asserts a diagnostic naming the file with a line and character position while the endpoint still answers from the Last_Good_Output, then restores the file and asserts the new behavior is served with no manual restart; example two starts a session whose first Compile_Pass errors and asserts no Overseer binds while the Build_Watcher stays resident, then fixes and asserts it starts
    - **Property 5: Error-then-fix round trip**
    - **Validates: Requirements 6.1, 6.3, 6.4, 6.7**

  - [x] 7.3 Write the environment pass-through test
    - `packages/integration-tests/tests/dev-environment-passthrough.test.ts`; one session with a `.env`-supplied Toggle and inline `PORT` and `MICROSERVICES` assignments, asserting the inline values win, the disabled microservice's path 404s while the enabled one answers, and the port is the inline one; a second cheap assertion runs with an invalid Toggle token and confirms the existing non-zero exit reporting every offender
    - **Property 6: Environment pass-through is the existing behavior**
    - **Validates: Requirements 2.3, 8.1, 8.2, 8.3, 8.4, 8.5**

  - [x] 7.4 Write the session-scoped registration test
    - `packages/integration-tests/tests/dev-session-scope.test.ts`; with a session running, create a directory under `packages/microservices/`, touch an existing source to force a Compile_Pass and an Overseer_Restart, assert the routing table is unchanged across the restart, then restart the session and assert the new microservice is registered
    - **Property 9: The registered microservice set is session-scoped**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

  - [x] 7.5 Write the cold-start test
    - `packages/integration-tests/tests/dev-cold-start.test.ts`; from a `pristineWorktree()` with no `dist/`, no `*.tsbuildinfo` and no generated registry, run the Dev_Command and assert the Overseer answers a request, that it was launched from `packages/overseer/dist/index.js`, and that every Project_List package has compiled output; skip with a clear message when `git` is unavailable
    - **Property 8: One execution model, cold start included**
    - **Validates: Requirements 1.3, 3.4, 3.7, 4.1, 4.3, 4.4, 9.1**

  - [x] 7.6 Write the Common_Startup single-sourcing and Production_Start parity test
    - `packages/integration-tests/tests/dev-start-parity.test.ts`; static half asserts exactly one module exports `runCommonStartup`, that both `scripts/start.js` and `scripts/dev.js` import it, that neither contains a bootstrap-build or registry-generation invocation of its own, and that the clean-checkout ordering constraints are documented in `scripts/common-startup.js` and in no other entry point; one example asserts the `steps` arrays returned for both entry points are equal; the execution half runs Production_Start on a `pristineWorktree()` and asserts its step order, its messages on their existing streams, its exit-status propagation for a failed step and for the Overseer, and that it terminates without watching or restarting — skipping with a clear message when `git` is unavailable
    - **Property 10: Common_Startup yields one registry for both entry points** (single-sourcing and step-sequence halves)
    - **Property 11: Common_Startup is single-sourced and Production_Start is unchanged**
    - **Validates: Requirements 11.1, 11.2, 11.4, 11.5, 11.6**

  - [x] 7.7 Write the additive-only structural assertions
    - `packages/integration-tests/tests/dev-additive-only.test.ts`; assert no Dev_Server branch, flag or conditional under `packages/overseer/src/`; no dev-specific TypeScript configuration, generated artifact, `.gitignore` entry or template; no `paths`, `baseUrl` or module alias anywhere; the root `prepare` script, `Dockerfile.template`, `scripts/emit-effective-dockerfile.sh` and `packages/build-tools/src/image-tree.ts` unchanged; the `ci` script string unchanged and no dev typecheck script added; no new `dependencies` entry in any manifest and every devDependency introduced by this feature pinned exactly; the change to `scripts/start.js` confined to consuming Common_Startup; and the supervisor source free of any `npm run build` invocation, `dist/` watcher, or debounce timer
    - **Property 7: Additive-only structural invariants**
    - **Validates: Requirements 3.8, 5.6, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9**

- [x] 8. Document the Dev_Server
  - [x] 8.1 Document the Dev_Command in `README.md`
    - Name every Startup_Sequence step in order — environment load, Bootstrap_Build, registry generation, Build_Watcher start, Overseer start
    - State what a running session picks up without action (a TypeScript source change in a Project_List package) and what requires terminating and re-invoking it (adding, removing or renaming a directory under `packages/microservices/`, a Selector change, a Toggle or other environment change)
    - Present the Dev_Command and `npm start` together: the Dev_Command as the recommended entry point for iterative development, `npm start` as the one-shot path executing the same compiled artifacts without a Build_Watcher, and both running the same `dist/` output through `packages/overseer/dist/index.js`; record that Production_Start terminates when its Overseer exits while a Dev_Session runs until the developer terminates it
    - List the Dev_Command in both the quick-start section and the script table
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.8, 10.9, 10.10_

  - [x] 8.2 Add the Dev_Command to `.kiro/steering/tech.md`
    - List it in the common-commands section alongside `npm start` and the two image-build commands
    - _Requirements: 10.5_

- [x] 9. Final checkpoint - full quality gate
  - Run `npm run ci` (build, typecheck, lint, test, test:types) and ensure it passes with the Dev_Command wired and the new suites present
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 9.6_

- [x] 10. Correct the warm-tree initial Overseer start
  - [x] 10.1 Correct the `compile-complete` rules in `decide`
    - In `packages/build-tools/src/dev-supervisor.ts`, encode the four zero-error cases from design 4b: with `awaitingCleanPass` set, only an emitting pass lifts the gate, advances `generation` and starts, while a non-emitting pass logs the completion and leaves the gate in force; with no gate in force, an emitting pass behaves exactly as today, a non-emitting pass with `hasLastGood === false` advances `generation` to 1, sets `hasLastGood` and emits `start-overseer` — the warm-tree initial start — and a non-emitting pass with `hasLastGood === true` logs only and leaves a running child in place
    - Change the `generation` advance rule to: advanced by a zero-error pass that either emitted or is the session's first clean pass; update the field's doc comment to match
    - Add no `DevState` field, remove none, rename none; keep `decide` total and pure with no I/O, timer, clock or filesystem access; leave the erroring-pass, `overseer-ready`, `overseer-exited`, `signal` and post-`terminating` rules unchanged
    - _Requirements: 4.5, 4.7, 4.8, 5.1, 5.6, 6.5_

  - [x] 10.2 Extend the restart-gating property tests for the warm-tree start
    - In `packages/build-tools/tests/dev-restart-decision.property.test.ts`, assert a clean non-emitting `compile-complete` from phase `none` with `hasLastGood === false` and no gate in force yields exactly one `start-overseer` carrying `generation` 1; that the same event from phase `running` yields no start and no stop; and that the same event with `awaitingCleanPass` set yields no start and leaves the gate in force
    - Update the existing assertion that every `start-overseer` follows a clean *emitting* pass so it now requires only a clean pass, with `emitted === true` additionally required when the start replaces a running child or lifts a crash gate
    - Replace the `|starts| ≤ |cleanEmittingPasses|` bound with a bound over clean passes, and build the warm-tree prefix into the generators explicitly rather than relying on it arising by chance, since that is the shape the original rule table got wrong
    - **Property 3: Restart gating over arbitrary event interleavings**
    - **Property 4: A no-op Compile_Pass never restarts a running Overseer**
    - **Validates: Requirements 4.5, 4.7, 4.8, 5.1, 5.4, 5.6, 6.5**

  - [x] 10.3 Add a warm-tree end-to-end regression test
    - `packages/integration-tests/tests/dev-warm-tree.test.ts`; one integration example asserting that a Dev_Session started against a fully built tree — every Project_List package's `dist/` and `*.tsbuildinfo` already up to date, so the first Compile_Pass emits nothing — still starts the Overseer and answers a request, and that the session's output carries the Overseer's `[boot] Overseer listening on port` line
    - `packages/integration-tests/tests/dev-environment-passthrough.test.ts` currently clears the Overseer's build output before each session to force an emitting first pass; that workaround exists only because of this defect and is removed once 10.1 lands, so the suite exercises the warm-tree path it will then support
    - **Property 8: One execution model, cold start included** (warm-tree counterpart)
    - **Validates: Requirements 4.8, 5.1**

  - [x] 10.4 Re-run the full quality gate
    - Run `npm run ci` and confirm build, typecheck, lint, the whole Vitest suite and `test:types` all pass with the corrected rule and the new regressions present
    - Confirm by hand that `npm run dev` on an already-built tree now reaches `[boot] Overseer listening on port <PORT>` and serves a request, which is the developer-visible symptom the defect produced
    - _Requirements: 4.8, 9.6_

- [ ] 11. Consolidate the supervisor's CLI layer into `runDevSupervisorCli`
  - [ ] 11.1 Add the exported `runDevSupervisorCli()` to `packages/build-tools/src/dev-supervisor.ts`
    - Own the Project_List derivation by calling `devProjectList()`, which already defaults `selector = process.env.MICROSERVICES`, so no environment reading remains in the bin
    - Own the two distinct error-reporting contracts of design 4d, both observable and both preserved exactly: a Selector failure reaches stderr **verbatim**, because `devProjectList()` / `projectListFrom` already produce prefixed messages — `[selector:unmatched]`, `[shared:unresolved]` — and re-wrapping one as a watcher-launch failure would corrupt the contract R2.4 states; a Build_Watcher launch failure is framed as `[dev] failed to start the build watcher: <reason>`, with no Overseer child spawned because the spawn is downstream of a clean compile. Both exit non-zero, status 1
    - Preserve the ordering guarantee by deriving the Project_List before, and separately from, starting the shell, so a bad Selector exits 1 without a Build_Watcher or an Overseer ever existing
    - Leave `runDevSupervisor` throwing unframed on a watcher-launch failure, so this function is the single author of the `[dev]` framing that was previously split across the shell and the bin
    - Carry the bin's inline reasoning over rather than dropping it with the bin: why a Selector message must reach stderr unmodified, and why a watcher failure leaves no Overseer behind, belong with the code that owns them
    - _Requirements: 1.4, 1.5, 2.4_

  - [ ] 11.2 Reduce `packages/build-tools/src/bin/dev-supervisor.ts` to a one-liner
    - `#!/usr/bin/env node`, one `import { runDevSupervisorCli } from "../dev-supervisor.js";`, one `runDevSupervisorCli();` — byte-for-byte the shape of the two sibling bins, `packages/build-tools/src/bin/generate-registry.ts` and `build-image-tree.ts`, so the package's bin layer holds no policy at all and there is one bin shape to learn rather than two
    - Drop the `try`/`catch` blocks, the `process.stderr.write` calls, the `process.exit(1)` calls, the inline comments and the `devProjectList` / `runDevSupervisor` imports, all of which move to 11.1; leave the `bin` block of `packages/build-tools/package.json` untouched and add no barrel, keeping `structure.md`'s bin-only exception intact
    - _Requirements: 1.4, 1.5, 2.4_

  - [ ] 11.3 Confirm the existing suite still pins both error contracts, then re-run the quality gate
    - This is a behavior-preserving refactor, so add **no** new behavioral test: both contracts are already pinned, and the movement's job is to confirm they still hold through `runDevSupervisorCli` rather than to restate them
    - `packages/integration-tests/tests/dev-environment-passthrough.test.ts` pins the process-level before-binding path — the Overseer's invalid-Toggle abort naming every offender, the supervisor's before-binding report, and the session staying resident with its Build_Watcher (R8.5); confirm it passes unchanged
    - The `[selector:unmatched]` message is pinned by `packages/build-tools/tests/dev-project-list.property.test.ts` ("throws `[selector:unmatched]` naming every unknown identifier") and by `packages/build-tools/tests/registry-generator.unmatched.property.test.ts`, both against `projectListFrom` / `resolveSelected` rather than across the CLI boundary; confirm those pass unchanged, and add an assertion for the verbatim relay itself **only** if inspection shows that relay is pinned nowhere — one assertion in that case, nothing beyond it
    - Close with `npm run ci` (build, typecheck, lint, the whole Vitest suite, `test:types`) and leave the workspace clean
    - _Requirements: 1.4, 1.5, 2.4, 9.6_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; core implementation tasks are never optional.
- Every property test carries the tag comment `Feature: api-dev-server, Property {number}: {property_text}` and runs at least 100 `fast-check` iterations.
- Task 2.4 is deliberately paired with the decision core rather than deferred: it is the verification of Requirement 5, the two-watcher race, and it spawns nothing.
- Task 1.1 lands before both 1.2 and 5.3, since `scripts/start.js` and `scripts/dev.js` both consume `runCommonStartup`.
- Tasks 7.5 and 7.6 use `pristineWorktree()` and are the slow tail of `npm test`; they skip with a clear message when `git` is unavailable rather than failing.
- `packages/overseer/src/`, `Dockerfile.template`, `scripts/emit-effective-dockerfile.sh`, `packages/build-tools/src/image-tree.ts`, the root `prepare` script, and the root `workspaces` array are intentionally untouched; task 7.7 asserts those guarantees rather than changing the sources.
- Requirements 10.6 and 10.7 (the rejected source-execution alternative with each recorded reason, and the two Dev_Server extension points) are already recorded in this spec's `requirements.md` and `design.md`, so no task writes them again.
- Movement 10 fixes a shipped defect: the emit/change condition, correct for gating an Overseer_Restart of an already running process, was wrongly applied to the session's initial start, so a Dev_Session on an already-built tree — whose first Compile_Pass reported zero errors and emitted nothing — got a Build_Watcher and no server; criterion 4.8 and the split zero-error rules table in design 4b are the fix.
- Movement 11 changes no behavior: the supervisor bin, unlike its two siblings, held CLI policy of its own — environment-defaulted Project_List derivation, two error-reporting contracts, and two exit paths — and the `[dev]` framing was split across the shell and the bin. Design 4d moves that policy into an exported `runDevSupervisorCli`, leaving the bin a one-liner symmetric with `generate-registry` and `build-image-tree`. No requirement changes, so the movement adds no behavioral test and instead confirms the tests that already pin the `[selector:unmatched]` and watcher-failure paths pass untouched.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2"] },
    { "id": 2, "tasks": ["1.3", "2.3"] },
    { "id": 3, "tasks": ["2.4"] },
    { "id": 4, "tasks": ["2.5", "4.1"] },
    { "id": 5, "tasks": ["4.2", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3"] },
    { "id": 7, "tasks": ["5.4", "7.1"] },
    { "id": 8, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 9, "tasks": ["7.5", "7.6"] },
    { "id": 10, "tasks": ["7.7", "8.1", "8.2"] },
    { "id": 11, "tasks": ["10.1"] },
    { "id": 12, "tasks": ["10.2", "10.3"] },
    { "id": 13, "tasks": ["10.4"] },
    { "id": 14, "tasks": ["11.1"] },
    { "id": 15, "tasks": ["11.2"] },
    { "id": 16, "tasks": ["11.3"] }
  ]
}
```

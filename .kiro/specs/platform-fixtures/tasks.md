# Implementation Plan: platform-fixtures

## Overview

This plan follows the design's **Migration Order** exactly: twelve ordered steps, one top-level task each, in the design's order. The ordering is designed, not incidental — the coverage guard follows the scenarios it checks, the Classification_Record and its guard follow the Fixture_Equivalents they name (the guard fails on a Fixture_Equivalent that is not a Platform_Test_Set member), the Worktree_Guard extension follows the helpers, the fixture path constants, and the fixture-writing suites, and the run-floor check follows every property file. Each task states what it depends on.

The feature is **additive**. After every step the repository is green and the baseline diff is empty. Every step therefore ends with the same verification:

```
git diff --exit-code packages/integration-tests/baseline/
git status --porcelain packages/integration-tests/baseline/
npm run ci
```

All three must be clean — no tracked recording's bytes changed, no recording added or removed, and the whole quality gate at exit status zero. All thirteen Baseline_Recordings are byte-unchanged throughout, and `scripts/record-baseline.js` is never re-run.

Language: TypeScript (the design fixes every file path and every helper signature in TypeScript; no language choice is open).

## Tasks

- [x] 1. Step 1 — the tier skeleton and its exclusions

  - [x] 1.1 Create the Fixture_Tier skeleton and its exclusion entries
    - Create `fixtures/`, `fixtures/trees/`, and `fixtures/projects/` as directories directly inside the Project_Directory; the tier carries Fixture_Scenarios in those two subdirectories and nowhere else
    - Write `fixtures/README.md` stating what the tier is, stating the partition criterion in both directions (a Tree_Fixture holds hostility an npm clean install rejects and is never installed and never built; a Project_Fixture holds hostility npm does not care about and is installed once through the Fixture_Projects_Root), and naming the directory a new scenario of each kind belongs in
    - Add one `fixtures/` entry to `.dockerignore`
    - Confirm — do not edit — that the existing unanchored `.gitignore` patterns `node_modules/`, `dist/`, and `*.tsbuildinfo` already cover every such path under `fixtures/`; add no `.gitignore` pattern
    - Add no root `workspaces` entry matching any path under `fixtures/`, and add no path literal `fixtures` to any source under `packages/build-tools/src/`
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 10.1, 10.8, 11.2_

  - [x] 1.2 Add the tier layout suite
    - Create `packages/integration-tests/tests/fixture-tier-layout.test.ts` asserting: the tier's shape and its two partitions; that no root `workspaces` entry and no enumerated workspace path matches anything under `fixtures/`; that no source under `packages/build-tools/src/` spells `fixtures` as a path literal; that `scripts/emit-effective-dockerfile.sh`, `scripts/build.js`, `scripts/start.js`, and `scripts/dev.js` read no path under `fixtures/`; that `.dockerignore` excludes the tier; that the root Vitest run collects no file from under `fixtures/`; and that every file under `fixtures/` is either tracked or ignored, failing by naming the path
    - Leave the per-scenario enumeration (R4.7, R4.8) for task 4.7 — there are no scenarios yet
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 10.1, 10.2, 10.8, 10.9, 10.10, 10.11, 11.1, 11.5_

  - [x] 1.3 Write the additive-invariance property test
    - **Property 5: The Fixture_Tier's presence changes no discovery result, no derived order, no Project_List, and no staged Image_Tree**
    - Create `packages/integration-tests/tests/fixture-additive-invariance.property.test.ts`, tagged `Feature: platform-fixtures, Property 5: …`, with `numRuns` of at least 100 on every `fc.assert`
    - Take a single `pristineWorktree()` copy in `beforeAll`, place generated Fixture_Tier content at `fixtures/` inside that copy, and re-run the four derivations in-process against it with the tier present and absent, comparing value-for-value in order; skip with the returned `reason` when `available === false`
    - Export from `packages/build-tools/src/testing/` any generator this suite needs that does not already exist (the generated Fixture_Tier content generator, and the Selector generator if it is not already reachable): a suite in `packages/integration-tests` cannot import `packages/build-tools/tests/arbitraries/` by relative path, and the design's cross-package rule sends a generator two packages need to `src/testing/`, imported from `@microservices/build-tools/dist/testing/index.js`
    - Derive every subject from a generated configuration, never from a path or scope literal
    - _Requirements: 10.5, 10.6, 10.7, 16.1, 16.6, 16.11_

  - [x] 1.4 Write the baseline byte-stability property test and pin the thirteen
    - **Property 10: The thirteen Baseline_Recordings are byte-unchanged**
    - Create `packages/integration-tests/tests/baseline-byte-stability.property.test.ts`, tagged `Feature: platform-fixtures, Property 10: …`, with `numRuns` of at least 100: for any permutation of the thirteen recordings and any order of recomputation, each recomputed observable's bytes equal the committed recording's bytes, the recomputation rewrites no recording, and the file set under `packages/integration-tests/baseline/` is exactly those thirteen names; a failure names the observable, the recorded value, and the observed value
    - Recompute through the same public functions and the same `scripts/record-baseline.js` entry points that produced the recordings, and **do not invoke the recorder to write**
    - In `packages/integration-tests/tests/baseline-equivalence.test.ts`, add the exactly-thirteen file-set assertion if it is not already present, and leave every existing per-recording comparison unchanged
    - Note for the reviewer: the design's step list does not assign this file or this `baseline-equivalence.test.ts` change to a numbered step. It is placed here because Step 10's run-floor list names all ten of this feature's property files, so the file must exist by then, and because the claim it asserts is the per-step verification this step performs for the first time
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 16.1_

  - [x] 1.5 Checkpoint — verify additivity after Step 1
    - Run `git diff --exit-code packages/integration-tests/baseline/` and `git status --porcelain packages/integration-tests/baseline/`; both must be clean, so all thirteen recordings are byte-unchanged and none is added or removed
    - Run `npm run ci` and require exit status zero
    - Do not run `scripts/record-baseline.js`. Ask the user if questions arise
    - _Requirements: 1.6, 15.1, 15.2, 15.11_

- [x] 2. Step 2 — the Fixture_Projects_Root, the install script, and the CI step

  - [x] 2.1 Add the Fixture_Projects_Root manifest and lockfile
    - Create `fixtures/projects/package.json` declaring `private: true`, an **empty** `workspaces` array (members arrive in task 5.2), and `devDependencies` drawn only from packages the root `package.json` already declares, each at a version this repository's own lockfile already resolves
    - Commit `fixtures/projects/package-lock.json`, resolved from that manifest
    - _Requirements: 3.2, 3.11, 11.1, 11.4_

  - [x] 2.2 Add the `fixtures:install` script
    - Add exactly one script to the root `package.json`: `"fixtures:install": "npm ci --prefix fixtures/projects"`
    - Add no dependency and no devDependency; change no existing script's text; add no lifecycle script performing a Fixture_Install; leave the `ci` script's composition and order exactly as it is
    - Pass no `--workspaces`, so the Repo_Invariant_Checker's build-order-source check stays silent over the Root_Manifest
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 15.13_

  - [x] 2.3 Add the CI install step
    - In `.github/workflows/ci.yml`, add a step named `Install fixture projects` running `npm run fixtures:install`, positioned after the root install step and before the quality-gate step, failing the workflow when it exits non-zero
    - _Requirements: 6.5_

  - [x] 2.4 Add the install-wiring suite and the availability-probe assertion
    - Create `packages/integration-tests/tests/fixture-install.test.ts` asserting the `fixtures:install` script's shape, that no lifecycle script and neither root `npm install` nor `npm ci` performs a Fixture_Install, that the `ci` script keeps its Pre_Change_Baseline composition and order, that the script passes no `--workspaces`, and that the availability probe is one shared function (the probe itself is task 3.2; assert against it once it exists, or add that assertion in task 3.2 and keep this file's other assertions here)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.8_

  - [x] 2.5 Extend the CI wiring suite
    - In `packages/integration-tests/tests/ci-wiring.test.ts`, assert the Fixture_Install step exists in `ci.yml` after the root install step and before the quality-gate step, and that the workflow fails when that step exits non-zero
    - _Requirements: 6.5_

  - [x] 2.6 Checkpoint — verify additivity after Step 2
    - Both baseline commands clean (thirteen recordings byte-unchanged, none added or removed) and `npm run ci` at exit status zero. The `ci` script's text is unchanged, so `check-invariants.txt` recomputes identically
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 6.3, 15.1, 15.2, 15.5, 15.13_

- [x] 3. Step 3 — the shared helpers (depends on Steps 1 and 2: the tier exists and the install script names the directory the probe looks for)

  - [x] 3.1 Declare the fixture path constants and the generic filesystem-tree generator
    - Add a `fixture-paths.ts` to each test directory that needs one — `packages/build-tools/tests/` and `packages/integration-tests/tests/` — holding that package's single `fixtures/` literal, derived relative to the test file's own location. These are the constants task 9.1 teaches the Worktree_Guard to treat as Checked_Out_Anchors
    - Extend `packages/build-tools/tests/arbitraries/tree.ts` with a generic filesystem-tree generator carrying depth bounds and generated symlinks whose targets are generated relative path texts, for Properties 3 and 4
    - _Requirements: 1.7, 9.3, 16.4, 16.5, 16.11_

  - [x] 3.2 Implement the availability probe
    - Add `installedFixtureProjects(): CloneHandle` to `packages/build-tools/src/testing/`, path-parameterised and holding no `fixtures` literal
    - Absent `node_modules/` under the Fixture_Projects_Root yields `{ available: false, reason }` naming the `fixtures:install` script; where the environment variable `CI` holds a non-empty value the same absence must make the calling suite **fail** with that same reason rather than skip
    - One shared function; no suite spells its own probe
    - _Requirements: 1.7, 6.6, 6.7, 6.8_

  - [x] 3.3 Implement the Fixture_Clone
    - Add `fixtureClone(relativePath: string): CloneHandle` to `packages/build-tools/src/testing/`: copies a Fixture_Scenario or the whole installed Fixture_Projects_Root into an OS temp directory **outside** the Project_Directory, returning an absolute path and an idempotent `cleanup`
    - Reproduce the source's relative path set exactly, every regular file's bytes byte-for-byte, and every symlink **as a symlink with the same target text** (this is what makes a copy of the installed root usable without a further install)
    - Use a copy-on-write or hard-linking copy where the host supports one (`cp -c` on APFS, `cp --reflink=auto -a` on a Linux CoW filesystem), falling back to `cpSync` with `dereference: false, preserveTimestamps: true`; the contract holds identically under either mechanism
    - On environmental failure, remove any directory already created, return `available: false` with a reason naming the step that failed, and leave no partial copy
    - Write nothing inside the checked-out tree; read the source only; neither call `pristineWorktree()` nor duplicate its working-tree capture
    - _Requirements: 1.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.9_

  - [x] 3.4 Implement Output_Clearing
    - Add `clearOutput(directory: string): void` to `packages/build-tools/src/testing/`: removes every `dist/` directory and every `*.tsbuildinfo` file under the directory it is handed, idempotently, removing nothing else and in particular no `node_modules/` directory and no file inside one
    - Refuse — making no removal and reporting the rejected path — when the directory is neither inside the Fixture_Tier nor inside an OS temp directory, taking the Fixture_Tier root as an **argument** rather than spelling it
    - _Requirements: 1.7, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 3.5 Implement the Scenario_Directory_Name derivation pair
    - Add to `packages/build-tools/src/testing/`: `scenarioDirectoryName(tag: string, qualifier?: string): string` and `expectedDiagnosticOf(directoryName: string): string`
    - Derivation: drop the brackets, replace the single `:` with `--`, append `.` plus the qualifier when one is given. Recovery: discard any `.` qualifier, split on the **first** `--`, rejoin with `:`. Throw naming the directory when the name holds no `--` or more than one
    - They live in `src/testing/` because both packages' suites (tasks 4.3, 4.5, 6.3) import them
    - _Requirements: 4.1, 4.2_

  - [x] 3.6 Write the Fixture_Clone property test
    - **Property 3: A Fixture_Clone reproduces its source's path set, bytes, and symlinks, and its cleanup removes the copy**
    - Create `packages/build-tools/tests/fixture-clone.property.test.ts`, tagged `Feature: platform-fixtures, Property 3: …`, `numRuns` at least 100, over generated trees of 0 to 20 files across 0 to 4 nesting levels including symlinks; assert the copy is outside the Project_Directory, path sets equal, bytes equal, symlinks still symlinks with equal target text, `cleanup` leaves no path present, and the source is unchanged
    - _Requirements: 7.2, 7.3, 7.6, 16.1, 16.4, 16.11_

  - [x] 3.7 Write the Output_Clearing property test
    - **Property 4: Output_Clearing is idempotent and removes exactly the Generated_Fixture_Output**
    - Create `packages/build-tools/tests/output-clearing.property.test.ts`, tagged `Feature: platform-fixtures, Property 4: …`, `numRuns` at least 100, over generated trees carrying arbitrary `dist/` directories at arbitrary depths, arbitrary `*.tsbuildinfo` files, arbitrary other files, and a `node_modules/`; assert one application equals two as path set plus per-file bytes, no `dist/` and no `*.tsbuildinfo` remains, and every other path — `node_modules/` included — is present with bytes unchanged
    - _Requirements: 8.3, 8.4, 16.1, 16.5, 16.11_

  - [x] 3.8 Write the Output_Clearing rejection and stale-output suites
    - Create `packages/build-tools/tests/output-clearing.rejection.test.ts`: a path neither inside the Fixture_Tier nor inside an OS temp directory is rejected with the path reported and nothing removed
    - Create `packages/build-tools/tests/output-clearing.stale-output.test.ts`: a build run immediately after a failed build over the same directory reports what a never-built directory reports
    - Both operate inside OS temp directories
    - _Requirements: 8.5, 8.6_

  - [x] 3.9 Checkpoint — verify additivity after Step 3
    - This is the step that adds to `packages/build-tools/src/`, so the baseline check matters most here: both baseline commands clean and `npm run ci` at exit status zero. Nothing the recorder reaches is touched, and no existing Build_System behaviour changed
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 15.1, 15.2, 15.5, 15.11, 15.12_

- [x] 4. Step 4 — the Tree_Fixtures (depends on Step 3: the naming derivation pair, the fixture path constants, and the Fixture_Clone the perturbation property mutates)

  - [x] 4.1 Add the scenario generators
    - Add to `packages/build-tools/src/testing/`, because both packages' property suites draw on them: a Diagnostic_Tag generator over the `[<category>:<detail>]` form, a Scenario_Directory_Name qualifier generator, and a behaviour-preserving perturbation generator producing the three perturbation kinds (a permutation of the scenario's Root_Manifest `workspaces` entries; an added well-formed package in a Consumer_Category the Expected_Diagnostic does not concern; a relocation of the scenario's Discovery_Roots to any assignment the Config_Parser accepts)
    - Create `packages/build-tools/tests/arbitraries/fixtures.ts` for the generators only that package's suites use, and extend `arbitraries/config.ts` with the Discovery_Root reassignment generator the perturbation kind needs
    - _Requirements: 16.3, 16.7, 16.11_

  - [x] 4.2 Add a Tree_Fixture for each enumerated fault
    - Under `fixtures/trees/`, add one scenario directory per row of the design's enumerated scenario set: `config--unparsable`, `config--shape.not-object`, `config--shape.scope`, `config--shape.roots`, `config--shape.entry`, `config--unknown-key`, `config--scope`, `config--root-path`, `config--root-overlap`, `config--root-framework`, `config--root-missing`, `config--root-not-directory`, `config--root-is-package`, `config--entry-path`, `config--entry-overlap`, `discovery--manifest`, `discovery--name`, `discovery--duplicate`, `discovery--mirror`
    - Each holds `fixture.json` (the Scenario_Manifest: `expectedDiagnostic` with brackets, `entryPoint`, one-sentence `fault`, and `partition` with `kind: "tree"` and the justification that an npm clean install over the tree would fail), its own `package.json` Root_Manifest, an optional `scaffold.config.json`, and every package its Expected_Diagnostic concerns at a path its own configuration makes discoverable
    - The Scenario_Manifest is the only file at a scenario root that is not part of the tree under test; no Scenario_Directory_Name and no qualifier may contain `dist`
    - Each is self-contained: no dependency resolved from outside it, no symlink, no Vitest test file, no `scripts.test` invoking Vitest
    - Add **no** scenario for the invalid-npm-package-name item: it is dropped from R2.5's minimum by recorded design decision, because the Build_System emits no diagnostic for it and a scenario naming an invented tag would fail its own minimality assertion. Invent no tag
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 4.1, 4.3, 4.4, 4.5, 10.10, 11.1_

  - [x] 4.3 Add the deterministic per-scenario diagnostics suite
    - Create `packages/integration-tests/tests/fixture-scenario-diagnostics.test.ts`: for each scenario, recover the tag from the directory name and assert it equals the tag the Scenario_Manifest declares (failing by naming the directory, the recovered tag, and the declared tag, and failing when the name holds no `--` or more than one), then invoke the entry point the manifest names as a **spawned process** with the scenario's directory as its working directory and assert the reported Diagnostic_Tag set is exactly the one-element set holding the Expected_Diagnostic
    - Resolve the platform's bin from the platform's own tree (`packages/build-tools/dist/bin/…`), reached from the test file's location; derive every reported path from the scenario directory; install nothing, build nothing, execute no fixture module, write no file inside a Tree_Fixture
    - Pass the fixture's tree to the component's pure core where one exists, reaching the filesystem only through that component's own effect shell
    - _Requirements: 2.2, 2.6, 2.7, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 4.4 Write the scenario minimality property test
    - **Property 2: Every Fixture_Scenario reports exactly the Diagnostic_Tag its name declares, under every behaviour-preserving perturbation**
    - Create `packages/integration-tests/tests/fixture-scenario-diagnostics.property.test.ts`, tagged `Feature: platform-fixtures, Property 2: …`, `numRuns` at least 100
    - Apply each generated perturbation to a **Fixture_Clone** of the scenario, never to the committed scenario; invoke the entry point as an **imported function** taking the copy's directory as its Project_Directory so the run floor stays affordable; assert the reported tag set equals the one-element Expected_Diagnostic set — no extra tag, not the empty set
    - Clone once per suite, reuse across examples, restore captured bytes rather than re-cloning, and call `cleanup` in an unconditional teardown that also runs when an assertion fails or a test throws
    - _Requirements: 4.5, 4.6, 7.2, 7.5, 7.7, 7.8, 16.1, 16.3, 16.11_

  - [x] 4.5 Write the scenario naming property test
    - **Property 6: Scenario_Directory_Name and Diagnostic_Tag round-trip, and the derivation is injective**
    - Create `packages/build-tools/tests/scenario-naming.property.test.ts`, tagged `Feature: platform-fixtures, Property 6: …`, `numRuns` at least 100: derive a name from a generated tag and an optional generated qualifier, recover a tag from that name, and assert it equals the tag generated; and for any two distinct generated tags with the same qualifier, assert the derived names differ
    - _Requirements: 4.1, 4.2, 16.1, 16.7_

  - [x] 4.6 Write the fixture/synthesized agreement property test
    - **Property 1: Discovery over a materialised fixture tree agrees with discovery over the equivalent in-memory Synthesized_Tree**
    - Create `packages/build-tools/tests/fixture-synthesized-agreement.property.test.ts`, tagged `Feature: platform-fixtures, Property 1: …`, `numRuns` at least 100, over Synthesized_Trees holding 0 to 5 Consumer_Packages per Consumer_Category with generated directory names, declared names composed from the tree's generated Configured_Scope, generated Dependency_Specifier lists, and any Discovery_Root assignment the Config_Parser accepts
    - Materialise the tree inside an OS temp directory, run Package_Discovery's effect shell with that directory as its Project_Directory, and assert per-category equality with the pure core over the same tree as in-memory input: equal length, identical order, and per-index equality of Consumer_Category, directory name, declared name, build kind, and Dependency_Specifier list compared element-by-element in order
    - Extend `packages/build-tools/tests/arbitraries/tree.ts` with the materialiser-friendly variant carrying per-package manifests
    - Also assert, for at least one Fixture_Scenario per Consumer_Category, that the effect shell's result over the fixture read from disk equals the pure core's result over the in-memory transcription of that same fixture
    - _Requirements: 13.5, 16.1, 16.2, 16.11_

  - [x] 4.7 Activate the per-scenario layout enumeration
    - Extend `packages/integration-tests/tests/fixture-tier-layout.test.ts`: every direct subdirectory of `fixtures/trees/` and of the Fixture_Projects_Root other than that root's own files is a Fixture_Scenario holding a Scenario_Manifest and bearing a well-formed Scenario_Directory_Name, failing by naming the offending directory; and no two scenarios share a Scenario_Directory_Name across both partitions, failing by naming the shared name and both paths
    - _Requirements: 4.7, 4.8_

  - [x] 4.8 Checkpoint — verify additivity after Step 4
    - Both baseline commands clean and `npm run ci` at exit status zero. No Tree_Fixture is under any Discovery_Root of this project and none is matched by a `workspaces` entry
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 15.1, 15.2, 15.5, 15.6, 15.11_

- [x] 5. Step 5 — the Project_Fixtures (depends on Step 2 for the Fixture_Projects_Root and its install script, and on Step 3 for the availability probe these suites gate on)

  - [x] 5.1 Add a Project_Fixture for each enumerated fault
    - Under `fixtures/projects/`, add one scenario directory per fault R3.10 enumerates — a Common_Package with no `main` or no `types`; a Spa_Package with no `scripts.build`; a name not mirroring its directory; a relative import escaping its own package; a microservice importing a peer; a microservice importing the Overseer; an import of a Spa_Package by a compiled package; a Common_Package depending on a microservice or the Overseer; a manifest depending on a Microservice_Package; a Common_Package dependency cycle; a Spa_Package depending on a Spa_Package; a Common_Package depending on a Spa_Package; a scoped Dependency_Specifier resolving to no declared package; a Selector naming an unmatched identifier; a Selector resolving to no microservice; a workspace package matched by no `workspaces` entry; a workspace package matched by more than one; a Tsc_Project violating each of the four Load_Bearing_Settings; a Tsc_Project with no `tsconfig.json`; a package staged into an Image_Tree with no compiled output; an Entry_Package compiled with no Generated_Registry — plus a scenario for `tsconfig:unresolvable` (a `tsconfig.json` whose `extends` names a path that is not there), which the R3.10 minimum does not name but the Diagnostic_Coverage_Record's total binds
    - Each holds `fixture.json` with `partition.kind: "project"` and the justification that an npm clean install succeeds while a named entry point still reports; its **own** `package.json` Root_Manifest with its own `workspaces` array (the array the Repo_Invariant_Checker reads for Workspace_Coverage, and the array a Workspace_Coverage scenario makes deliberately wrong); and a `scaffold.config.json` declaring a Configured_Scope distinct from every other Project_Fixture's and from this project's own
    - Declare no dependency on and import no module of this platform; a scenario needing the request-handler contract declares its own local stub
    - Each provokes at least one Diagnostic_Tag and exactly one per R4.5; a package **inside** a scenario may be entirely well-formed, which is what isolates the fault. Add **no** happy-path Project_Fixture
    - Place no Vitest test file and no `scripts.test` invoking Vitest inside any scenario
    - _Requirements: 3.1, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 4.1, 4.3, 4.4, 4.5, 10.10, 11.1_

  - [x] 5.2 Wire the members into the Fixture_Projects_Root and re-resolve its lockfile
    - Extend `fixtures/projects/package.json`'s `workspaces` array so every glob matches a **member package inside** a Project_Fixture (`*/packages/*` shapes, plus the specific member paths for a scenario whose fault concerns a relocated Discovery_Root) and **no** Project_Fixture's own directory, so npm never reads a scenario's own `workspaces` array and the two workspace roots do not nest
    - Add to that manifest's `devDependencies` every third-party package a fixture build needs, at a version this repository's own lockfile already resolves and already declared by the root `package.json`
    - Re-resolve and commit `fixtures/projects/package-lock.json`; run `npm run fixtures:install` to confirm one install serves every member
    - _Requirements: 3.2, 3.3, 3.11, 6.1, 11.1, 11.4_

  - [x] 5.3 Write the scope-disjointness property test
    - **Property 8: Distinct Project_Fixture scopes yield disjoint declared-name sets**
    - Create `packages/build-tools/tests/fixture-scope-disjointness.property.test.ts`, tagged `Feature: platform-fixtures, Property 8: …`, `numRuns` at least 100: for any generated pair of distinct Valid_Scopes each distinct from this project's own, and any generated pair of member-directory-name sets — equal sets included — the composed declared-name sets are disjoint
    - Add the distinct-scope-pair generator to `packages/build-tools/tests/arbitraries/config.ts`
    - _Requirements: 3.5, 16.1, 16.9, 16.11_

  - [x] 5.4 Add the fixture worktree cleanliness suite
    - Create `packages/integration-tests/tests/fixture-worktree-cleanliness.test.ts`: after a Fixture_Install, a fixture build, and an Output_Clearing, both the modified-tracked set and the untracked-and-not-ignored set are empty
    - Gate on the shared availability probe: skip with the reason naming `fixtures:install` locally, fail with that same reason when `CI` is non-empty; run no assertion against an uninstalled fixture
    - Write nothing outside a fixture's `dist/`, a fixture's `*.tsbuildinfo`, and the Fixture_Projects_Root's `node_modules/` — which only `fixtures:install` writes
    - Use no destructive git subcommand and declare no working-tree restore helper under any name
    - _Requirements: 6.6, 6.7, 6.8, 7.10, 9.1, 9.2, 11.2, 11.3, 11.4_

  - [x] 5.5 Checkpoint — verify additivity after Step 5
    - Both baseline commands clean and `npm run ci` at exit status zero. The deliberately-broken packages sit outside the platform's `--workspaces` lint and typecheck fan-out because the root `workspaces` array matches nothing under `fixtures/`
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 10.1, 10.2, 15.1, 15.2, 15.5, 15.11_

- [x] 6. Step 6 — the Diagnostic_Coverage_Record and its guard (depends on Steps 4 and 5: the guard asserts every named scenario exists and every scenario is named, so placed earlier it would fail on its first run)

  - [x] 6.1 Implement the two-recogniser tag derivation
    - Add a derivation module beside the guard in `packages/integration-tests/tests/` computing the set of Diagnostic_Tags the Build_System emits over every tracked `.ts` file under `packages/build-tools/src/`, as the **union of two recognisers**:
      - **Form A — bracketed literal:** every match of `\[([a-z][a-z-]*):([a-z][a-z-]*)\]` in the file's raw text, comments and JSDoc **included** (some tags occur only in a `@throws` annotation, so a comment-stripping scan would lose them)
      - **Form B — tag-union member:** within the span of a `type <Name>Tag = …;` declaration or of a `readonly tag: …;` property signature, every quoted string literal matching `^[a-z][a-z-]*:[a-z][a-z-]*$`
    - Form B is required, not optional: a bracketed-only scan misses six tags the Build_System really emits — `config:unparsable`, `config:root-not-directory`, `config:root-is-package` (composed in `project-config.ts` from a `ConfigTag` union) and `tsconfig:setting`, `tsconfig:absent`, `tsconfig:unresolvable` (composed in `tsconfig-verifier.ts`) — and the record's completeness claim would be false on the day it lands
    - Confine Form B to those two declaration positions; accepting any tag-shaped literal anywhere would import phantom keys
    - _Requirements: 5.2_

  - [x] 6.2 Commit the Diagnostic_Coverage_Record
    - Create `fixtures/diagnostic-coverage.json` with one entry per tag the task 6.1 derivation yields, naming either the Scenario_Directory_Name of the covering Fixture_Scenario or the reason the tag is not an Expressible_Tag
    - Record `config:unreadable` and `config:root-unreadable` as not Expressible, each because it requires a permission state committed bytes cannot express; record no other kind of reason
    - Give the invalid-npm-package-name gap no entry: it is not a tag, so the record has no key for it; invent no tag
    - _Requirements: 5.1, 5.4, 11.1_

  - [x] 6.3 Add the coverage guard
    - Create `packages/integration-tests/tests/diagnostic-coverage.test.ts`: compare the derived tag set with the record's key set **both ways**, failing by naming every tag present in one and absent from the other; assert every Scenario_Directory_Name the record names exists as a scenario directory and every scenario is named by the record; assert every non-Expressible reason is a filesystem state committed bytes cannot express, failing by naming the tag and the rejected reason; and treat a tag whose entry names a scenario as covered only when that scenario's R4.6 minimality assertion (task 4.3) is present and passing
    - Recover a scenario's tag through the shared derivation of task 3.5, not through a local copy
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 6.4 Checkpoint — verify additivity after Step 6
    - Both baseline commands clean and `npm run ci` at exit status zero
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 15.1, 15.2, 15.11_

- [x] 7. Step 7 — the Fixture_Equivalents (depends on Step 4 for the Tree_Fixture subjects and Step 5 for the Project_Fixture subjects; every Payload_Coupled_Test stays in place and passing beside its new equivalent, and the two agreeing is the evidence the fixture is faithful)

  - [x] 7.1 Add the discovery and registry-generator equivalents
    - Create `packages/build-tools/tests/discovery-fixture-tree.test.ts` asserting the per-category Package_Discovery claim over a Tree_Fixture and over the Synthesized_Tree transcribed from it
    - Create `packages/build-tools/tests/registry-generator-fixture.test.ts` asserting the Registry_Generator's emitted specifiers and entries over a Tree_Fixture
    - Derive every Discovery_Root, Configured_Scope, Entry_Root, and package path from the subject's own configuration; spell no path literal and no scope literal; assert no fact about the committed Payload_Tree
    - _Requirements: 13.1, 13.2, 13.3, 13.7_

  - [x] 7.2 Add the build-order and image-tree equivalents
    - Create `packages/build-tools/tests/workspace-build-order-fixture-tree.test.ts` asserting the derived build order and the Project_List over a Tree_Fixture
    - Create `packages/build-tools/tests/image-tree-fixture.test.ts` asserting the staged Image_Tree entry set over a Tree_Fixture
    - Same derived-configuration discipline; between these two and task 7.1, cover the R13.6 obligations — at least one assertion over a Configured_Scope other than the Scope_Default and at least one over a set of Discovery_Roots all differing from their Root_Defaults
    - _Requirements: 13.1, 13.2, 13.3, 13.6, 13.7_

  - [x] 7.3 Add the Tsconfig_Verifier and Repo_Invariant_Checker equivalents
    - Create `packages/build-tools/tests/tsconfig-verifier-fixture-tree.test.ts` asserting the Tsconfig_Verifier violation set over a Project_Fixture (resolution follows an `extends` chain, so the subject must be a tree TypeScript can resolve over)
    - Create `packages/integration-tests/tests/check-repo-invariants-fixture.test.ts` asserting the Repo_Invariant_Checker's reported violation set over a Project_Fixture, invoked as a process spawned with the scenario's directory as its working directory, with the bin resolved from the platform's own tree
    - Gate both on the shared availability probe (skip locally with the reason naming `fixtures:install`, fail when `CI` is non-empty)
    - _Requirements: 3.7, 6.6, 6.7, 13.1, 13.2, 13.3, 13.7_

  - [x] 7.4 Add the Emit_Script equivalent
    - Create `packages/integration-tests/tests/emit-dockerfile-fixture.test.ts` asserting the emitted manifest `COPY` lines and toggle `ENV` lines over a Tree_Fixture, spawning the dependency-free script with the scenario's directory as its working directory and deriving every reported path from that directory
    - _Requirements: 2.6, 13.1, 13.2, 13.3, 13.7_

  - [x] 7.5 Add the three constructed-module equivalents
    - Create `packages/integration-tests/tests/mount-dispatch-constructed.test.ts`, `toggle-behaviour-constructed.test.ts`, and `registry-boot-constructed.test.ts`
    - Each constructs its microservice modules **in the test**: an `express.Router()` with the routes the claim needs plus a path constant, assembled into registry entries and passed to `boot` as an argument. Read nothing from disk; ship no executable handler in any fixture
    - _Requirements: 13.1, 13.2, 13.4, 13.7_

  - [x] 7.6 Checkpoint — verify additivity after Step 7
    - Both baseline commands clean and `npm run ci` at exit status zero. Every Payload_Coupled_Test still passes with its assertions unchanged, and no Drift_Detector assertion was touched
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 13.1, 14.5, 15.1, 15.2, 15.11_

- [x] 8. Step 8 — the Classification_Record and its guard (depends on Step 7: the guard fails an entry naming a Fixture_Equivalent that is not itself a Platform_Test_Set member, so placed earlier every Payload_Coupled_Test entry would name a missing file and the guard would land failing)

  - [x] 8.1 Extract the shared Platform_Test_Set derivation
    - Add one shared module with two consumers — the Classification_Guard here and the Worktree_Guard in task 9.1 — deriving the set as: `git ls-files`; keep names ending `.test.ts`, `.property.test.ts`, or `.test-d.ts`; keep those under a Framework_Singleton's directory or under the Entry_Root, both taken from threaded configuration (the singleton names from the Build_System's single list, the Entry_Root from `ProjectContext`) so no path literal is spelled; add each tracked non-test module in the same directory that such a file imports by relative path (today exactly `packages/integration-tests/tests/helpers.ts`, encoded as the rule rather than the file)
    - Two derivations meant to agree would eventually not, which is why this is one module
    - _Requirements: 12.5, 13.2_

  - [x] 8.2 Commit the Classification_Record
    - Create `packages/integration-tests/platform-test-classification.json`: one array of entries, each carrying the Project_Directory-relative POSIX `path`, exactly one `class` of the three Test_Class names, and exactly one per-class field — `fixtureEquivalent` for a Payload_Coupled_Test, `retainedReason` for a Drift_Detector, neither for a Payload_Independent_Test
    - Cover every member of the Platform_Test_Set including the helper modules and every suite added in tasks 1 through 7; include no Payload_Owned_Test; order entries by ascending code-point comparison of `path`
    - Classify `packages/build-tools/tests/discovery-real-tree.test.ts` and `packages/build-tools/tests/workspace-build-order-real-tree.test.ts` as Drift_Detectors, recording for each that it is retained pending the payload's relocation and that the next feature decides its fate
    - Apply R12.3's criterion — the subject of the assertion: would an assertion have to change if a payload package were renamed, relocated, or removed
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.10, 14.1, 14.2, 14.6, 11.1_

  - [x] 8.3 Add the Classification_Guard
    - Create `packages/integration-tests/tests/platform-test-classification.test.ts` asserting: totality and single-valuedness, rejecting an entry with no class, more than one, or an unknown one, and checking single-valuedness structurally so an entry carrying both `fixtureEquivalent` and `retainedReason` fails; referential integrity of each `fixtureEquivalent` against the derived set; both-ways completeness reported in one failure with the direction stated rather than short-circuiting; set **equality** between the record's Drift_Detectors and an explicit list held in the guard's own source; for each Payload_Independent_Test, no static and no dynamic import whose specifier is this repository's Configured_Scope plus `/` plus a discovered Consumer_Package name, with both halves derived (scope from the Effective_Config, names from a Package_Discovery run) and failing by naming the file and the specifier; that the record names no path under any configured Discovery_Root; and the non-vacuity floor of fewer than two derived members
    - Derive the set through the task 8.1 module
    - _Requirements: 12.1, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 14.2_

  - [x] 8.4 Write the Classification_Guard property test
    - **Property 7: The Classification_Guard accepts exactly the total, single-valued, fixture-complete records**
    - Create `packages/integration-tests/tests/classification-guard.property.test.ts`, tagged `Feature: platform-fixtures, Property 7: …`, `numRuns` at least 100, over generated Platform_Test_Set-shaped path lists and generated candidate records including each malformation — omitting a path, naming a path outside the list, no class, more than one class, an unknown class, a Payload_Coupled_Test entry with no `fixtureEquivalent` or with one outside the list
    - Assert acceptance **if and only if** the record assigns every path exactly one of the three classes, names an in-list `fixtureEquivalent` for every Payload_Coupled_Test entry, names a `retainedReason` for every Drift_Detector entry, and names no path outside the list; and that every rejection's reported offence names the offending path
    - Export the path-list and candidate-record generators from `packages/build-tools/src/testing/` — this suite lives in `packages/integration-tests`, and the design's cross-package rule sends a generator across the boundary through `src/testing/` rather than through another package's private `tests/arbitraries/`
    - _Requirements: 12.5, 12.6, 16.1, 16.8, 16.11_

  - [x] 8.5 Checkpoint — verify additivity after Step 8
    - Both baseline commands clean and `npm run ci` at exit status zero
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 12.11, 15.1, 15.2, 15.11_

- [x] 9. Step 9 — the Worktree_Guard extension (depends on Steps 3, 5, and 8: the helpers and the fixture path constants must exist for the anchors to recognise, the fixture-writing suites for the widened scan to have a real population, and the task 8.1 derivation for the widened set itself; placed earlier the widened set would be smaller than the floor it asserts)

  - [x] 9.1 Extend the Worktree_Guard
    - In `packages/integration-tests/tests/worktree-safety-guard.test.ts`:
    - Extend the Permitted_Write_Location set by exactly three, giving six and no more: a `dist/` under `fixtures/`, a `*.tsbuildinfo` under `fixtures/`, and the Fixture_Projects_Root's `node_modules/`. Keep the existing three, keep location 3 derived from the Build_System's single Generated_Registry derivation rather than spelled, and keep every location under a Framework_Singleton's directory outside the set
    - Restrict the two in-fixture permissions to destinations whose text names the Fixture_Tier, so the extension widens nothing outside `fixtures/`
    - Carry the **three-part sufficiency fix**, not merely new anchors — anchors alone are necessary and not sufficient, because a span carrying only a bare `root` assigned from `FIXTURES_DIR` two lines up passes unexamined today:
      1. **Checked-out anchors are decisive.** A span carrying both a checked-out anchor and a temp anchor is classified checked-out
      2. **A bare `dir` or `root` requires file-level temp provenance.** `dir` and `root` stay temp anchors only in a file that also contains a temp-creating call — `mkdtemp`, `tmpdir`, `pristineWorktree`, or the Fixture_Clone; a file that never creates a temporary directory cannot claim a temporary anchor
      3. **Fixture constants are checked-out anchors by name and by shape.** The Fixture_Tier root token, the two partition roots, the Fixture_Projects_Root, and any identifier whose name matches `FIXTURE` case-insensitively, matched on word boundaries so `\broot\b` does not match inside `FIXTURE_PROJECTS_ROOT`
    - Hold the six-location set **explicitly** and assert over it: each of the six permitted, and each of five rejected — a tracked source under a Consumer_Package's `src/`; a Project_Config_File written into the checked-out tree; a file at the Generated_Registry's retired `packages/overseer/src/generated/` location; a Scenario_Manifest; and a manifest inside a Fixture_Scenario
    - Widen the scanned set to every member of the Platform_Test_Set except itself, through the task 8.1 derivation, keeping the fewer-than-two floor and the token fragmentation that keeps the guard's own source from holding a forbidden token contiguously
    - Leave the existing anchors, the existing three permitted locations, and the fragment-assembly discipline unchanged; re-assert the prohibition on every destructive git subcommand and on a working-tree restore helper under any name over the widened set
    - _Requirements: 7.10, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 9.2 Write the fixture-anchor property test
    - **Property 9: The Worktree_Guard flags a fixture-anchored write outside the Permitted_Write_Location set and no write inside it**
    - Create `packages/integration-tests/tests/worktree-guard-fixture-anchors.property.test.ts`, tagged `Feature: platform-fixtures, Property 9: …`, `numRuns` at least 100: for a generated mutating-call fragment whose destination joins a generated fixture path anchor with a generated tail, an offence naming the fragment's line when the tail resolves outside the six locations and none when it resolves to a `dist/` under the Fixture_Tier, a `*.tsbuildinfo` under the Fixture_Tier, or the Fixture_Projects_Root's `node_modules/`; and for a generated destination whose text does not name the Fixture_Tier, the two in-fixture permissions do not apply and an offence is reported
    - Extend `packages/build-tools/tests/arbitraries/source.ts` with the mutating-call fragment generator; assemble forbidden tokens from fragments so this file never holds one contiguously
    - _Requirements: 9.3, 9.4, 16.1, 16.10_

  - [x] 9.3 Checkpoint — verify additivity after Step 9
    - Both baseline commands clean and `npm run ci` at exit status zero. The widened scan classifies positively, so it cannot turn the repository red for a write it merely fails to understand; a real violation it newly reveals is fixed in the test, never by widening the permitted set
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 9.8, 15.1, 15.2, 15.11_

- [x] 10. Step 10 — the run-floor check for this feature's properties (depends on every property file existing, so its list names no absent file)

  - [x] 10.1 Add this feature's run-floor suite
    - Create `packages/integration-tests/tests/fixtures-property-run-floor.test.ts` listing this feature's ten property files — `fixture-synthesized-agreement.property.test.ts` (P1), `fixture-scenario-diagnostics.property.test.ts` (P2), `fixture-clone.property.test.ts` (P3), `output-clearing.property.test.ts` (P4), `fixture-additive-invariance.property.test.ts` (P5), `scenario-naming.property.test.ts` (P6), `classification-guard.property.test.ts` (P7), `fixture-scope-disjointness.property.test.ts` (P8), `worktree-guard-fixture-anchors.property.test.ts` (P9), `baseline-byte-stability.property.test.ts` (P10) — and asserting for each that it exists, ends `.property.test.ts`, imports `fast-check`, declares a run count on every `fc.assert` call, and declares none below 100
    - Leave `packages/integration-tests/tests/property-run-floor.test.ts` **unchanged**, including its own file list, so the two features' floors are checked side by side
    - _Requirements: 16.1, 16.12_

  - [x] 10.2 Checkpoint — verify additivity after Step 10
    - Both baseline commands clean and `npm run ci` at exit status zero
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 15.1, 15.2, 15.11_

- [x] 11. Step 11 — the steering update (last, because the steering guard asserts `tech.md` names all three in-fixture Permitted_Write_Locations and the `fixtures:install` script, final only after Steps 2 and 9)

  - [x] 11.1 Update `.kiro/steering/structure.md`
    - Name the Fixture_Tier, place it at `fixtures/` as a direct child of the Project_Directory, state it is neither a workspace nor a package nor a Discovery_Root, and show its two partitions in the repository layout
    - State the partition criterion in both directions and state that a separate workspace root is what keeps deliberately-broken packages out of the platform's `--workspaces` lint and typecheck fan-out
    - State that the Fixture_Projects_Root is deliberately hostile-only and that the happy-path live subject is the example project a later feature introduces
    - Under "Where things go", state the directory a new hostile scenario of each kind belongs in, the Scenario_Directory_Name rule, and the obligation to declare a Scenario_Manifest and a Diagnostic_Coverage_Record entry
    - State which files under `fixtures/` are committed and which are gitignored
    - State that every platform test is assigned a Test_Class in the Classification_Record, name the three classes and the sorting criterion, and state that the two named real-tree tests are retained as Drift_Detectors
    - Keep every statement about the Payload_Tree's present location true — nothing moved — and describe none of the out-of-scope behaviours
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.10, 17.11, 17.12, 17.13_

  - [x] 11.2 Update `.kiro/steering/tech.md`
    - Name the `fixtures:install` script, state that no lifecycle script and no root install performs a Fixture_Install, state that CI runs it as its own step before the quality gate, and state the skip-locally / fail-when-`CI`-is-set asymmetry
    - Extend the worktree-safety rules with exactly the three in-fixture Permitted_Write_Locations, keep the three existing ones, and state that every other in-fixture mutation goes to a Fixture_Clone
    - State the Output_Clearing rule and its reason: a previously failed build leaves partial output that can make a later run pass spuriously
    - State that `pristineWorktree()` is retained, that its subject is uncommitted platform source and the Fixture_Clone's subject is a fixture, and keep the prohibition on destructive git commands and on a working-tree restore helper stated in full
    - State the tier's exclusion from the `workspaces` array, the `--workspaces` fan-out, the Tsconfig_Verifier, the Repo_Invariant_Checker's checks over this repository, the container build context, and the Image_Assembler, with the reason for each
    - Carry the same Test_Class statement R17.11 requires, describe only the post-Step-10 repository, and keep every Payload_Tree location statement true
    - _Requirements: 17.5, 17.6, 17.7, 17.8, 17.9, 17.11, 17.12, 17.13_

  - [x] 11.3 Add the steering guard
    - Create `packages/integration-tests/tests/fixture-steering-guard.test.ts` asserting mechanically that no Steering_Document states a test may write into a Fixture_Scenario outside the Permitted_Write_Location set, and that each of the three in-fixture locations and the `fixtures:install` script is named in `.kiro/steering/tech.md`, failing by naming the offending document and line
    - _Requirements: 17.14_

  - [x] 11.4 Checkpoint — verify additivity after Step 11
    - Both baseline commands clean and `npm run ci` at exit status zero
    - Do not run `scripts/record-baseline.js`
    - _Requirements: 15.1, 15.2, 15.11_

- [x] 12. Step 12 — final verification

  - [x] 12.1 Exercise the tier and confirm the working tree stays clean
    - Run the two baseline commands and `npm run ci` once more, then `npm run fixtures:install`, a fixture build, and an Output_Clearing, and confirm both `git status --porcelain` sets — modified tracked files and untracked-not-ignored files — are empty
    - Confirm no file under `fixtures/` is neither tracked nor ignored
    - _Requirements: 1.6, 11.2, 11.3, 11.5_

  - [x] 12.2 Confirm the thirteen recordings and the untouched recorder
    - Confirm the file set under `packages/integration-tests/baseline/` is exactly the thirteen names it was, each byte for byte, with none added and none removed
    - Confirm `scripts/record-baseline.js` was never invoked at any step of this feature, and that no package moved, no test was deleted, and no existing Build_System behaviour changed
    - _Requirements: 1.4, 1.5, 15.1, 15.2, 15.11, 15.12, 15.13_

## Notes

- **Nothing here is optional.** All twelve steps are load-bearing, and the ten property tests are required by R16 and mechanically listed by task 10.1, so no sub-task carries the `*` postfix.
- **`scripts/record-baseline.js` is never re-run by this feature, at any step.** It is a one-shot developer script that writes into the checked-out tree, and re-running it is the one action that could change a recording's bytes without anyone intending to. No observable it records changes: the tier is matched by no `workspaces` entry, discovered under no Discovery_Root, verified by no Tsconfig_Verifier target, staged into no Image_Tree, and adds no scope literal under `packages/build-tools/src/`. The recorder's correctness is attested by the recomputation the test suite performs, not by a fresh recording.
- **No package moves, no test is deleted, and no existing Build_System behaviour changes.** Anything resembling the payload relocation — moving the Payload_Tree into `example/`, deleting a superseded payload-coupled test, retiring `pristineWorktree()` or the bootstrap build — belongs to the next spec.
- **This repository adds no `scaffold.config.json`.** Every non-default scope and root this feature exercises lives inside a fixture or in a generated configuration.
- **Worktree safety applies to every task.** No destructive git subcommand under any name, no working-tree restore helper under any name, and nothing written into the checked-out tree beyond the six permitted locations: a package's gitignored `dist/`, a `*.tsbuildinfo`, the Generated_Registry at its derived path, a `dist/` under `fixtures/`, a `*.tsbuildinfo` under `fixtures/`, and the Fixture_Projects_Root's `node_modules/` (written only by `fixtures:install`). Synthesized trees live in OS temp directories only and are removed even when assertions fail; a mutating fixture test clones rather than writing in place.
- **The invalid-npm-name item is dropped from R2.5's minimum** by recorded design decision — the Build_System emits no diagnostic for it, so no task invents a tag or adds a scenario for it, and the Diagnostic_Coverage_Record has no key for it.
- **Two placement items the design leaves unstated**, both flagged in the tasks that carry them rather than decided silently: (1) `baseline-byte-stability.property.test.ts` (Property 10) and the `baseline-equivalence.test.ts` thirteen-file assertion are named in the Testing Strategy but assigned to no numbered step — task 1.4 places them in Step 1, since Step 10's run-floor list requires all ten property files to exist and the claim is exactly the per-step verification; (2) the design's arbitraries table places the Platform_Test_Set path-list and candidate-Classification_Record generators in `packages/build-tools/tests/arbitraries/fixtures.ts` while their only consumer is an integration-tests suite, so tasks 8.4 and 1.3 follow the design's own cross-package rule and export them from `packages/build-tools/src/testing/`. A consequence worth noting: that puts a small `src/testing/` addition in Step 1, ahead of Step 3's designated `src/testing/` work.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5"] },
    { "id": 3, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 4, "tasks": ["2.4", "2.5"] },
    { "id": 5, "tasks": ["2.6"] },
    { "id": 6, "tasks": ["3.1"] },
    { "id": 7, "tasks": ["3.2"] },
    { "id": 8, "tasks": ["3.3"] },
    { "id": 9, "tasks": ["3.4"] },
    { "id": 10, "tasks": ["3.5"] },
    { "id": 11, "tasks": ["3.6", "3.7", "3.8"] },
    { "id": 12, "tasks": ["3.9"] },
    { "id": 13, "tasks": ["4.1"] },
    { "id": 14, "tasks": ["4.2"] },
    { "id": 15, "tasks": ["4.3", "4.4", "4.5", "4.6"] },
    { "id": 16, "tasks": ["4.7"] },
    { "id": 17, "tasks": ["4.8"] },
    { "id": 18, "tasks": ["5.1"] },
    { "id": 19, "tasks": ["5.2"] },
    { "id": 20, "tasks": ["5.3", "5.4"] },
    { "id": 21, "tasks": ["5.5"] },
    { "id": 22, "tasks": ["6.1"] },
    { "id": 23, "tasks": ["6.2"] },
    { "id": 24, "tasks": ["6.3"] },
    { "id": 25, "tasks": ["6.4"] },
    { "id": 26, "tasks": ["7.1", "7.2", "7.3", "7.4", "7.5"] },
    { "id": 27, "tasks": ["7.6"] },
    { "id": 28, "tasks": ["8.1"] },
    { "id": 29, "tasks": ["8.2"] },
    { "id": 30, "tasks": ["8.3", "8.4"] },
    { "id": 31, "tasks": ["8.5"] },
    { "id": 32, "tasks": ["9.1"] },
    { "id": 33, "tasks": ["9.2"] },
    { "id": 34, "tasks": ["9.3"] },
    { "id": 35, "tasks": ["10.1"] },
    { "id": 36, "tasks": ["10.2"] },
    { "id": 37, "tasks": ["11.1", "11.2"] },
    { "id": 38, "tasks": ["11.3"] },
    { "id": 39, "tasks": ["11.4"] },
    { "id": 40, "tasks": ["12.1"] },
    { "id": 41, "tasks": ["12.2"] }
  ]
}
```

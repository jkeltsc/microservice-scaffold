# Requirements Document

## Introduction

The platform's tests assert against whatever payload happens to be checked in. `packages/build-tools/tests/discovery-real-tree.test.ts` pins the exact six rows discovery yields over this repository. `packages/integration-tests/tests/helpers.ts` imports `@microservices/microservice1`, `microservice2`, and `microservice3` by package name and hands the real modules to the Overseer. The recorded image trees name `packages/common/config`. None of that is wrong today, because the platform and the project it builds are the same tree — but the payload is going to move out from under those tests, and a test that asserts a fact about the committed payload will then assert a fact about nothing.

This feature builds the **Fixture_Tier**: a new top-level `fixtures/` directory holding test subjects the platform owns, and gives every payload-coupled platform test a fixture-based equivalent **while the Payload_Tree is still present under `packages/`**. That ordering is the whole point. Adding a fixture-based equivalent next to a still-passing payload-coupled test is additive: both assert, both pass, and the two agreeing is itself evidence the fixture is a faithful subject. Deleting the payload-coupled test after the payload has moved is then a deletion of something already superseded, rather than a leap.

**Nothing moves in this feature.** No package changes directory, no test is deleted, no build path changes shape, and the repository is green at every commit. The strongest single expression of that is mechanical: all thirteen committed Baseline_Recordings under `packages/integration-tests/baseline/` are **byte-unchanged**, and Requirement 15 states that as a checkable obligation. A feature that changed any observable the platform records would have to change one of those thirteen files; this one changes none.

The tier is partitioned by a single question — **can npm install this?** Hostility that npm itself rejects (malformed JSON, an invalid package name, two packages declaring the same name) can only live in a tree nobody installs, so it goes in `fixtures/trees/`, which is read and never installed and never built. Hostility npm does not care about (a missing `main`, a peer import, a missing `scripts.build`, a name that does not mirror its directory, a selector naming nothing) needs a genuinely installed tree, so it goes in `fixtures/projects/`, a single npm workspace root with its own `workspaces` array and its own lockfile, so one install serves every member. That separate workspace root is not an aesthetic choice: it is what keeps deliberately-broken packages out of the platform's own `--workspaces` lint and typecheck fan-out, which follows the root `workspaces` array and would otherwise be asked to lint a package that is broken on purpose.

`fixtures/projects/` is deliberately **hostile-only**. The happy-path live subject is the `example/` project, which arrives in the next feature and doubles as that fixture; a happy-path project fixture here would be a second thing to keep in step with it for no gain.

The other half of the feature is a **classification**. Roughly seventy tracked files name a payload package today, and they are not one population. Some are the payload's own tests, which move with the payload and are not this feature's business. Some are platform tests whose assertion subject is a fact about the committed Payload_Tree — those are what need fixture-based equivalents. Some are platform tests that merely generate a tree whose members happen to be called `microservice1`; those are already decoupled and need no change at all. Requirement 12 gives the **criterion** that sorts them and requires the sorting to be **recorded and mechanically checked**, so that the next feature's deletions are safe by construction rather than by inspection. That record is this feature's most valuable output.

`pristineWorktree()` stays. Its reason to exist — capturing uncommitted **platform** source, because the test tree and the platform tree are the same tree — disappears only once they are different trees, which is the next feature. This feature introduces the install-once-clone-many helper alongside it; the next feature retires it.

This feature also creates a tension it must resolve. The prohibition on writing into the checked-out tree is absolute, and `fixtures/` **is** in the checked-out tree, and tests build inside it. Requirement 9 states precisely which in-fixture paths are permitted in-place writes — a fixture's gitignored `dist/`, a fixture's `*.tsbuildinfo`, and the installed `node_modules/` under the Fixture_Projects_Root, and nothing else — and extends the worktree guard's anchor set so that a fixture-anchored write is classified rather than silently unexamined.

Explicitly **out of scope**, and each the subject of the next feature or a later one: relocating the Payload_Tree into `example/`; deleting any superseded payload-coupled test; the platform's example-as-subject tests; collapsing the root build to a plain `tsc --build`; retiring the bootstrap build (`scripts/build.js` and `scripts/common-startup.js` stay); retiring `pristineWorktree()`; publishing any package to any registry; shipped tsconfig, eslint, or prettier presets; the wiring generator; and the CI/release split.

Provenance: this feature implements decisions D2, D3, and D4 of `.kiro/steering/platform-split.md`, together with the test-decoupling intent D5 records. Those citations record where the decisions came from; every behaviour this document requires is stated here in its own terms and reads correctly with that record unloaded.

## Glossary

Terms carried over unchanged from the `config-driven-discovery` and `registry-inversion` specs — Build_System, Project_Directory, Project_Config_File, Project_Config, Effective_Config, Config_Parser, Config_Loader, Config_Diagnostic, Configured_Scope, Scope_Default, Valid_Scope, Discovery_Root, Root_Default, Valid_Root_Path, Consumer_Category, Consumer_Package, Microservice_Package, Common_Package, Spa_Package, Microservice_Identifier, Framework_Singleton, Package_Discovery, Dependency_Specifier, Repo_Invariant_Checker, Registry_Generator, Generated_Registry, Selector, Selected_Microservices, Tsc_Project, Bundler_Project, Load_Bearing_Setting, Tsconfig_Verifier, Root_Manifest, Workspace_Coverage, Build_Sequence, Project_List, Image_Assembler, Image_Tree, Required_Dependencies, Emit_Script, Exclusion_List, Dev_Supervisor, ProjectContext, Entry_Package, Entry_Root, Entry_Point_Path, Synthesized_Tree, Payload_Tree, Pre_Change_Baseline, Baseline_Recording, Steering_Documents — keep their meanings and are not redefined here. The terms below are new.

- **Fixture_Tier**: The directory `fixtures/` directly inside the Project_Directory, together with everything under it. Test subjects the platform owns and points itself at. Not a workspace, not a package, and not a Discovery_Root of this project.
- **Tree_Fixture**: A direct subdirectory of `fixtures/trees/`. An inert manifest tree: read by a test, never installed, never built, never executed.
- **Fixture_Projects_Root**: The directory `fixtures/projects/`, which declares its own Root_Manifest with its own `workspaces` array and carries its own committed `package-lock.json`, so that one install serves every package under it.
- **Project_Fixture**: A direct subdirectory of the Fixture_Projects_Root other than that root's own files. A miniature project: it declares its own Root_Manifest, may declare its own Project_Config_File, and is a Project_Directory a test points a platform entry point at. Its member packages are workspace members of the Fixture_Projects_Root.
- **Fixture_Scenario**: A Tree_Fixture or a Project_Fixture. The unit of the tier: one directory, one named fault, one declared diagnostic.
- **Scenario_Manifest**: The file `fixture.json` at a Fixture_Scenario's root, recording that scenario's Expected_Diagnostic, the platform entry point that produces it, a one-sentence statement of the fault, and the partition justification. Read by the test suite and by a human; read by no Build_System component.
- **Expected_Diagnostic**: The single Diagnostic_Tag a Fixture_Scenario is built to provoke, declared by that scenario's Scenario_Manifest and encoded in its directory name.
- **Diagnostic_Tag**: One of the bracketed message prefixes the Build_System emits, of the form `[<category>:<detail>]` where both parts are lowercase letters and hyphens — for example `[config:root-overlap]`, `[discovery:mirror]`, `[barrel:invalid]`, `[deps:direction]`, `[tsconfig:setting]`, `[selector:unmatched]`.
- **Scenario_Directory_Name**: The name of a Fixture_Scenario's directory, derived from its Expected_Diagnostic by taking the tag's text without brackets and replacing the single `:` with `--`, optionally followed by `.` and a qualifier of lowercase letters, digits, and hyphens distinguishing several scenarios covering the same tag. The doubled hyphen rather than a single one is what keeps the derivation reversible, because a tag's category may itself contain a hyphen — `[build-order:cycle]` becomes `build-order--cycle`, and `build-order` is recoverable from it while `build-order-cycle` would not be.
- **Expressible_Tag**: A Diagnostic_Tag the Build_System can be made to emit by pointing it at a tree whose whole content is committed bytes. A tag is not Expressible when it requires either (a) a filesystem state committed bytes cannot express — an unreadable path, a permission failure — or (b) a state no hostile input can produce because the tag guards the Build_System's own internal consistency rather than validating an input: a self-consistency assertion the code runs over its own output (so only a Build_System bug, never a fixture, could trip it), an unreachable internal invariant guard, or a runtime status line that merely shares the Diagnostic_Tag shape. Neither recorded reason may stand in for a tag that simply lacks a fixture.
- **Diagnostic_Coverage_Record**: The committed machine-readable record at `fixtures/diagnostic-coverage.json`, listing every Diagnostic_Tag the Build_System emits, and for each either the Fixture_Scenario covering it or the recorded reason it is not an Expressible_Tag.
- **Fixture_Install**: The single act of installing the Fixture_Projects_Root — an npm clean install run with that root as its working directory — exposed as the root npm script `fixtures:install`.
- **Installed_Fixture_Projects**: The state of the Fixture_Projects_Root after a successful Fixture_Install: its `node_modules/` present, with one symlink per workspace member.
- **Fixture_Clone**: The install-once-clone-many helper: it copies an Installed_Fixture_Projects subtree, or a Tree_Fixture, into an operating-system temporary directory and returns a handle to the copy, so that a test needing to mutate a tree mutates a copy and the install runs once rather than once per suite.
- **Clone_Handle**: The value a Fixture_Clone returns: either `{ available: true, dir, cleanup }` carrying the absolute path of the copy and an idempotent removal function, or `{ available: false, reason }` carrying a human-readable skip reason. The shape `pristineWorktree()` already uses.
- **Generated_Fixture_Output**: The build output a fixture build produces inside a fixture directory: any `dist/` directory and any `*.tsbuildinfo` file under the Fixture_Tier.
- **Output_Clearing**: Removing every Generated_Fixture_Output under a given fixture directory before a build is run against it, so that partial output left by an earlier failed build cannot make a later run pass.
- **Platform_Test_Set**: Every tracked test source the platform owns: each tracked file whose name ends `.test.ts`, `.property.test.ts`, or `.test-d.ts` that lies under a Framework_Singleton's directory or under the Entry_Root, together with each tracked non-test module in the same directory that such a file imports by relative path — `packages/integration-tests/tests/helpers.ts` being the one such module today.
- **Payload_Owned_Test**: A tracked test source under a Consumer_Package's own directory. Tests the payload's own behaviour, moves with the payload, and is outside this feature's scope.
- **Payload_Coupled_Test**: A member of the Platform_Test_Set at least one of whose assertions has as its subject a fact about this repository's committed Payload_Tree — a package that is checked in, its declared name, its exported path, its declared dependencies, or its position in a derived order or a staged tree.
- **Drift_Detector**: A Payload_Coupled_Test deliberately retained for the narrow purpose of detecting disagreement between a pure Build_System core and the committed repository, whose assertions are confined to that purpose.
- **Payload_Independent_Test**: A member of the Platform_Test_Set every one of whose assertions has as its subject a component's behaviour for any conforming layout, where payload-shaped names appear only as values of a Synthesized_Tree or a Fixture_Scenario.
- **Test_Class**: One of Payload_Coupled_Test, Drift_Detector, or Payload_Independent_Test.
- **Classification_Record**: The committed machine-readable record at `packages/integration-tests/platform-test-classification.json`, assigning every member of the Platform_Test_Set to exactly one Test_Class, naming for each Payload_Coupled_Test its Fixture_Equivalent and for each Drift_Detector the reason it is retained. It lives with the platform's own test package rather than under `fixtures/`, because its subject is the platform's tests rather than a fixture.
- **Fixture_Equivalent**: A member of the Platform_Test_Set that asserts, over a Fixture_Scenario or a Synthesized_Tree, the claim a named Payload_Coupled_Test asserts over the Payload_Tree.
- **Classification_Guard**: The test that checks the Classification_Record against the discovered Platform_Test_Set.
- **Worktree_Guard**: The existing test `packages/integration-tests/tests/worktree-safety-guard.test.ts`, which scans the test sources for destructive git invocations and for writes into the checked-out tree outside a permitted set.
- **Permitted_Write_Location**: A path inside the checked-out tree a test may write in place. Before this feature: a package's gitignored `dist/`, a `*.tsbuildinfo`, and the Generated_Registry at `<Entry_Root>/src/generated/microservice-registry.ts`.
- **Checked_Out_Anchor**: A token the Worktree_Guard treats as evidence that a write destination lies inside the checked-out tree. Before this feature: `repoRoot`, `TESTS_DIR`, `__dirname`.

## Requirements

### Requirement 1: The Fixture_Tier exists, additively

**User Story:** As a platform maintainer, I want a directory of test subjects the platform owns, so that a platform test can assert against a tree I control rather than against whatever payload happens to be checked in.

#### Acceptance Criteria

1. THE repository SHALL hold the Fixture_Tier at `fixtures/` directly inside the Project_Directory, holding exactly two subdirectories carrying Fixture_Scenarios — `fixtures/trees/` and `fixtures/projects/` — and SHALL place no Fixture_Scenario anywhere else.
2. THE repository SHALL commit a `fixtures/README.md` stating what the tier is, stating the partition criterion of Requirement 2.1 and Requirement 3.1, and naming the directory a new Fixture_Scenario of each kind belongs in.
3. THE Fixture_Tier SHALL be neither a workspace package nor a member of any Consumer_Category nor a Framework_Singleton nor a Discovery_Root of this project, and THE repository SHALL declare no Root_Manifest `workspaces` entry matching any path under `fixtures/`.
4. THE repository SHALL relocate no package, SHALL delete no member of the Platform_Test_Set, SHALL delete no Payload_Owned_Test, and SHALL change no Discovery_Root, no Entry_Root, and no Configured_Scope of this project.
5. THE Payload_Tree SHALL remain present under `packages/` with every package at the directory it occupies in the Pre_Change_Baseline, because a fixture-based equivalent is added while the payload-coupled test it supersedes still passes.
6. WHEN `npm ci` followed by `npm run ci` runs on a fresh clone of this repository with no Project_Config_File present, THE quality gate SHALL complete every composed step with exit status zero and SHALL report no Config_Diagnostic.
7. THE Build_System SHALL contain no module that reads a path under `fixtures/`, and no Build_System source SHALL spell `fixtures` as a path literal, so that the tier is a subject tests point the platform at rather than a location the platform knows about.

### Requirement 2: Tree_Fixtures — inert, read, never installed

**User Story:** As a platform maintainer, I want a place for hostility npm itself rejects, so that I can test the platform's diagnostics for a malformed manifest without breaking my own install.

#### Acceptance Criteria

1. THE repository SHALL place a Fixture_Scenario under `fixtures/trees/` if and only if an npm clean install over that scenario's tree would fail, which is the scenario's partition criterion, and SHALL record that justification in the scenario's Scenario_Manifest.
2. THE test suite SHALL read a Tree_Fixture and SHALL neither install it, build it, execute any module of it, nor write any file inside it, so that a tree npm cannot install is never asked to be installed.
3. A Tree_Fixture SHALL be self-contained: every file its Expected_Diagnostic depends on SHALL lie inside that Tree_Fixture's own directory, and the tree SHALL declare no dependency resolved from outside it and SHALL contain no symlink.
4. A Tree_Fixture SHALL hold its own Root_Manifest at its scenario root, MAY hold its own Project_Config_File at its scenario root, and SHALL hold every package its Expected_Diagnostic concerns at a path its own configuration — declared or defaulted — makes discoverable.
5. THE repository SHALL cover with Tree_Fixtures, at minimum, each of these faults: a Project_Config_File that is not valid JSON; a Project_Config_File that is not a JSON object; a Project_Config_File declaring an unrecognised top-level key; a Project_Config_File declaring a wrong-typed value for each of `scope`, `roots`, and `entry`; an invalid Configured_Scope; an invalid Discovery_Root path; two Discovery_Roots that overlap; a Discovery_Root colliding with a Framework_Singleton directory; an absent microservice Discovery_Root; an invalid Entry_Root path; an Entry_Root overlapping a reserved path; a package manifest that is not valid JSON; a package manifest declaring no `name`; a package manifest declaring a name that is not a valid npm package name; and two packages declaring the same name.
6. THE test suite SHALL exercise a Tree_Fixture by passing that fixture's directory as the Project_Directory of the platform entry point under test and by passing that directory as the working directory of every process it spawns for that fixture, and SHALL derive every path it reports from that directory rather than from a path literal of its own.
7. THE test suite SHALL pass each Tree_Fixture's tree to the pure core of the component under test where that component exposes one, and SHALL reach the real filesystem only through that component's own effect shell, so that a Tree_Fixture exercises the same code path a real project exercises.

### Requirement 3: The Fixture_Projects_Root and its Project_Fixtures

**User Story:** As a platform maintainer, I want one installed workspace of deliberately-broken projects, so that I can test the platform's diagnostics over installed trees without one `npm ci` per suite and without my own lint and typecheck being asked to accept a broken package.

#### Acceptance Criteria

1. THE repository SHALL place a Fixture_Scenario under the Fixture_Projects_Root if and only if an npm clean install over that scenario's packages succeeds while at least one platform entry point reports a diagnostic over it, which is the scenario's partition criterion, and SHALL record that justification in the scenario's Scenario_Manifest.
2. THE Fixture_Projects_Root SHALL declare its own Root_Manifest with `private` set to `true`, its own `workspaces` array, and its own `devDependencies`, and SHALL carry its own committed `package-lock.json`, so that a single Fixture_Install serves every package under it.
3. THE Fixture_Projects_Root's `workspaces` array SHALL match the member packages inside each Project_Fixture and SHALL match no Project_Fixture's own directory, so that npm never reads a Project_Fixture's own `workspaces` array and the two workspace roots do not nest.
4. A Project_Fixture SHALL declare its own Root_Manifest with its own `workspaces` array — the array the Repo_Invariant_Checker reads for Workspace_Coverage when a test points the checker at that Project_Fixture — and MAY declare its own Project_Config_File.
5. EACH Project_Fixture SHALL declare a Configured_Scope distinct from the Configured_Scope of every other Project_Fixture and distinct from this project's own Configured_Scope, so that no two member packages under one hoisted `node_modules` declare the same name and so that each scenario exercises a non-default scope.
6. A Project_Fixture SHALL declare no dependency on a package of this platform and SHALL import no module of this platform, so that installing the Fixture_Projects_Root needs no platform build output and a fixture's install cannot resolve upward out of the Fixture_Projects_Root into this repository's own `node_modules`.
7. THE test suite SHALL invoke a platform entry point against a Project_Fixture as a process spawned with that Project_Fixture's directory as its working directory, or as an imported function taking that directory as its Project_Directory, and SHALL resolve the platform's own bin or module from the platform's own tree rather than from the fixture's `node_modules`.
8. EVERY Project_Fixture SHALL provoke at least one Diagnostic_Tag from at least one platform entry point, so that the Fixture_Projects_Root holds no happy-path project; a package **inside** a Project_Fixture MAY be entirely well-formed, which is what lets a scenario isolate exactly one fault.
9. THE repository SHALL add no happy-path Project_Fixture standing in for a complete working consumer project, because the live happy-path subject is the example project a later feature introduces.
10. THE repository SHALL cover with Project_Fixtures, at minimum, each of these faults: a Common_Package declaring no `main` or no `types`; a Spa_Package declaring no `scripts.build`; a package whose declared name does not mirror its directory; a relative import escaping its own package directory; a microservice importing a peer microservice; a microservice importing the Overseer; an import of a Spa_Package by a compiled package; a Common_Package declaring a dependency on a microservice or on the Overseer; a manifest declaring a dependency on a Microservice_Package; a dependency cycle among Common_Packages; a Spa_Package declaring a dependency on a Spa_Package; a Common_Package declaring a dependency on a Spa_Package; a scoped Dependency_Specifier resolving to no declared package; a Selector naming an identifier matching no discovered microservice; a Selector resolving to no microservice; a workspace package matched by no `workspaces` entry; a workspace package matched by more than one `workspaces` entry; a Tsc_Project whose resolved configuration violates each of the four Load_Bearing_Settings; a Tsc_Project declaring no `tsconfig.json`; a package staged into an Image_Tree with no compiled output; and an Entry_Package compiled with no Generated_Registry present.
11. THE Fixture_Projects_Root SHALL declare in its own `devDependencies` every third-party package a Project_Fixture's build needs, at a version this repository's own lockfile already resolves, and SHALL declare no dependency this repository's root Root_Manifest does not already declare.

### Requirement 4: Scenario naming, the Scenario_Manifest, and legibility

**User Story:** As a developer reading `fixtures/`, I want each scenario directory to tell me what it is for without my opening a test, so that I can find the fixture for a diagnostic I am changing.

#### Acceptance Criteria

1. EACH Fixture_Scenario SHALL be named by its Scenario_Directory_Name, being its Expected_Diagnostic's text without brackets with the single `:` replaced by `--`, optionally followed by `.` and a qualifier of lowercase letters, digits, and hyphens.
2. THE test suite SHALL recover a Fixture_Scenario's Expected_Diagnostic from its Scenario_Directory_Name by discarding any `.` qualifier and replacing the first `--` with `:`, SHALL assert that the recovered tag equals the tag the scenario's Scenario_Manifest declares, and SHALL fail naming the directory when the name holds no `--` or holds more than one, so that a renamed directory and a stale manifest cannot disagree silently.
3. EACH Fixture_Scenario SHALL hold a Scenario_Manifest at its scenario root declaring its Expected_Diagnostic, the platform entry point that produces it, one sentence stating the fault, and the partition justification Requirement 2.1 or Requirement 3.1 requires.
4. THE Scenario_Manifest SHALL be the only file at a Fixture_Scenario's root that is not part of the tree under test, and no Build_System component SHALL read it.
5. EACH Fixture_Scenario SHALL be minimal in the sense that it provokes its Expected_Diagnostic and no other Diagnostic_Tag, so that a test asserting over it asserts the whole reported output rather than a subset of it.
6. THE test suite SHALL assert, for each Fixture_Scenario, that the reported Diagnostic_Tag set of the entry point the Scenario_Manifest names is exactly the one-element set holding that scenario's Expected_Diagnostic.
7. THE test suite SHALL assert that every direct subdirectory of `fixtures/trees/` and of the Fixture_Projects_Root other than that root's own files is a Fixture_Scenario holding a Scenario_Manifest and bearing a well-formed Scenario_Directory_Name, and SHALL fail naming the offending directory otherwise, so that a scenario cannot be added without being declared.
8. THE test suite SHALL assert that no two Fixture_Scenarios share a Scenario_Directory_Name across both partitions.

### Requirement 5: Diagnostic coverage is recorded, not assumed

**User Story:** As a platform maintainer, I want a record of which of my diagnostics has a fixture, so that a diagnostic I add without a subject is a named failure rather than an untested branch.

#### Acceptance Criteria

1. THE repository SHALL commit the Diagnostic_Coverage_Record listing every Diagnostic_Tag the Build_System emits, and for each either the Scenario_Directory_Name of a Fixture_Scenario whose Expected_Diagnostic is that tag, or a recorded reason that tag is not an Expressible_Tag.
2. THE test suite SHALL derive the set of Diagnostic_Tags the Build_System emits by scanning every tracked `.ts` source under `packages/build-tools/src/` for the Diagnostic_Tag form, SHALL compare that set with the Diagnostic_Coverage_Record's key set, and SHALL fail naming every tag present in one and absent from the other.
3. THE test suite SHALL assert that every Scenario_Directory_Name the Diagnostic_Coverage_Record names exists as a Fixture_Scenario directory, and that every Fixture_Scenario is named by the record.
4. THE Diagnostic_Coverage_Record SHALL record, as the reason a tag is not an Expressible_Tag, either the filesystem state committed bytes cannot express or that the tag is not fixture-provokable by construction (a self-consistency assertion over the Build_System's own output, an unreachable internal invariant guard, or a runtime status line sharing the Diagnostic_Tag shape), and SHALL record no other kind of reason, so that "not covered" can never stand for "not got round to".
5. THE test suite SHALL treat a Diagnostic_Tag whose record entry names a Fixture_Scenario as covered only when the assertion Requirement 4.6 requires for that scenario is present and passing, so that a record entry cannot claim coverage a test does not provide.

### Requirement 6: Installing the Fixture_Projects_Root

**User Story:** As a developer, I want to install the fixture projects once and forget about them, so that running the platform's tests does not cost one npm install per suite and a fresh clone is not slower for it.

#### Acceptance Criteria

1. THE repository SHALL expose the Fixture_Install as the root npm script `fixtures:install`, performing an npm clean install with the Fixture_Projects_Root as its working directory, and SHALL make that script the only writer of the Fixture_Projects_Root's `node_modules/`.
2. THE root `npm install` and `npm ci` SHALL perform no Fixture_Install, and THE Root_Manifest SHALL declare no lifecycle script that performs one, so that a clone's install cost and its resolved dependency set are unchanged by this feature.
3. THE root `ci` script SHALL keep the composition and the order it has in the Pre_Change_Baseline and SHALL perform no Fixture_Install, so that the local quality gate does not pay the fixture install cost.
4. THE `fixtures:install` script SHALL invoke no build with `--workspaces`, so that the Repo_Invariant_Checker's build-order-source check stays silent over the Root_Manifest.
5. THE CI workflow SHALL run the Fixture_Install as its own step after the root install and before the quality gate step, and SHALL fail the workflow when that step exits non-zero.
6. IF a suite requiring Installed_Fixture_Projects finds the Fixture_Projects_Root's `node_modules/` absent, THEN THE suite SHALL be skipped with a reported reason naming the `fixtures:install` script, and SHALL execute no assertion against an uninstalled fixture in its place.
7. WHERE the environment variable `CI` holds a non-empty value, IF a suite requiring Installed_Fixture_Projects finds the Fixture_Projects_Root's `node_modules/` absent, THEN THE suite SHALL fail with a reported reason naming the `fixtures:install` script rather than being skipped, so that a workflow whose install step was removed cannot pass by skipping every fixture assertion.
8. THE test suite SHALL expose the availability probe of criteria 6 and 7 as one shared function returning the Clone_Handle shape, so that no suite spells its own probe.

### Requirement 7: The Fixture_Clone helper — install once, clone many

**User Story:** As a test author, I want to mutate a fixture without mutating the checked-out tree and without reinstalling, so that a suite that needs a broken variant of a fixture costs a copy rather than an install.

#### Acceptance Criteria

1. THE test suite SHALL expose the Fixture_Clone as one shared function taking the Project_Directory-relative path of a Fixture_Scenario or of the Fixture_Projects_Root and returning a Clone_Handle.
2. WHEN the Fixture_Clone succeeds, THE Clone_Handle SHALL carry `available` true, the absolute path of a directory inside an operating-system temporary directory located outside the Project_Directory, and an idempotent `cleanup` function removing that directory.
3. THE Fixture_Clone SHALL copy a source's regular files byte-for-byte, SHALL reproduce the source's relative path set exactly, and SHALL reproduce each symlink as a symlink with the same target text rather than as a copy of the file it names, so that an installed workspace's member symlinks survive the copy and the copy is usable without a further install.
4. THE Fixture_Clone SHALL use a copy-on-write or hard-linking copy where the host filesystem supports one and SHALL fall back to a plain recursive copy otherwise, and its result SHALL satisfy criterion 3 under either mechanism.
5. IF the copy cannot be made for an environmental reason, THEN THE Fixture_Clone SHALL remove any directory it had created, SHALL return `available` false with a reason naming the step that failed, and SHALL leave no partially copied directory behind.
6. THE Fixture_Clone SHALL write nothing inside the checked-out tree and SHALL read the source only, so that cloning a fixture cannot modify the fixture.
7. THE test suite SHALL remove every directory a Fixture_Clone created when the suite that created it finishes, including when an assertion in that suite fails, when a test throws, and when the suite is interrupted after the directory was created.
8. THE test suite SHALL perform the Fixture_Clone of a given source at most once per suite and SHALL reuse the returned directory across that suite's examples where the examples do not conflict, and a suite whose examples mutate the copy SHALL restore the bytes it captured from that copy rather than re-cloning, so that the copy cost is paid once.
9. THE test suite SHALL retain `pristineWorktree()` unchanged, because its subject is uncommitted platform source in the checked-out tree and the Fixture_Clone's subject is a fixture, and THE Fixture_Clone SHALL neither call `pristineWorktree()` nor duplicate its working-tree capture.
10. THE test suite SHALL declare no function that restores a file in the checked-out tree, under any name, and SHALL invoke no destructive git subcommand, including `checkout`, `reset`, `clean`, and `stash`.

### Requirement 8: Output_Clearing before a fixture build

**User Story:** As a test author, I want a fixture build to start from no build output, so that output left by an earlier failed build cannot make my run pass for the wrong reason.

#### Acceptance Criteria

1. WHEN a test runs a build against a fixture directory, THE test SHALL perform Output_Clearing over that directory first, removing every `dist/` directory and every `*.tsbuildinfo` file under it.
2. THE test suite SHALL expose Output_Clearing as one shared function taking a directory path, so that no suite spells its own removal walk.
3. THE Output_Clearing function SHALL be idempotent: running it twice over the same directory SHALL leave that directory in the state one run leaves it in, and running it over a directory holding no Generated_Fixture_Output SHALL succeed and remove nothing.
4. THE Output_Clearing function SHALL remove no file that is neither a `*.tsbuildinfo` nor inside a `dist/` directory, and SHALL remove no `node_modules/` directory and no file inside one, so that clearing output never forces a reinstall.
5. IF Output_Clearing is asked to operate on a path that is not inside the Fixture_Tier and not inside an operating-system temporary directory, THEN THE function SHALL make no removal and SHALL report the rejected path, so that the helper cannot be pointed at a platform package by mistake.
6. THE test suite SHALL assert that a fixture build run immediately after a failed fixture build over the same directory reports the same result it reports over a directory that was never built, which is what Output_Clearing exists to guarantee.

### Requirement 9: Worktree safety, extended to the Fixture_Tier

**User Story:** As a developer with uncommitted work, I want the guard that stops a test writing into my tree to keep holding now that tests build inside `fixtures/`, so that the new tier does not open a hole in the rule that has already cost me work twice.

#### Acceptance Criteria

1. THE Permitted_Write_Location set SHALL be extended by exactly three locations, all under the Fixture_Tier: a `dist/` directory under `fixtures/`, a `*.tsbuildinfo` file under `fixtures/`, and the `node_modules/` directory of the Fixture_Projects_Root — and by no other location.
2. THE test suite SHALL write no file inside the Fixture_Tier other than at a location criterion 1 names, and a test needing any other in-fixture mutation SHALL mutate a Fixture_Clone instead.
3. THE Worktree_Guard SHALL treat the Fixture_Tier's root and each fixture path constant a test source declares as a Checked_Out_Anchor, so that a mutating filesystem call whose destination is anchored at a fixture path is classified rather than passing unexamined for want of a recognised anchor.
4. THE Worktree_Guard SHALL restrict its `dist/` and `*.tsbuildinfo` permissions under the Fixture_Tier to destinations whose text names the Fixture_Tier, so that the extension of criterion 1 widens nothing outside `fixtures/`.
5. THE Worktree_Guard SHALL hold its Permitted_Write_Location set explicitly and SHALL assert, over that set, that each of the six permitted locations is permitted and that each of these is rejected: a tracked source under a Consumer_Package's `src/`, a Project_Config_File written into the checked-out tree, a file at the Generated_Registry's retired location under `packages/overseer/src/generated/`, a Scenario_Manifest, and a manifest inside a Fixture_Scenario — so that a widened or stale set cannot pass unnoticed through a scan that reports nothing when every write is permitted.
6. THE repository SHALL keep the Generated_Registry at `<Entry_Root>/src/generated/microservice-registry.ts` as a Permitted_Write_Location, derived from the Build_System's single derivation rather than spelled as a literal, and SHALL keep every location under a Framework_Singleton's directory outside the set.
7. THE test suite SHALL create every Synthesized_Tree either as inputs to a pure function or as directories inside an operating-system temporary directory located outside the Project_Directory, and SHALL create no directory, no package, and no symlink inside the checked-out tree.
8. THE Worktree_Guard SHALL scan every member of the Platform_Test_Set except itself, SHALL fail when its scanned set holds fewer than two sources, and SHALL assemble each forbidden token it searches for from fragments so that its own source never holds one contiguously.

### Requirement 10: The Fixture_Tier is excluded from every platform mechanism

**User Story:** As a platform maintainer, I want the fixture tier to be invisible to my build, my gates, and my images, so that adding a deliberately-broken package cannot break the platform that tests it.

#### Acceptance Criteria

1. THE Root_Manifest `workspaces` array SHALL match no path under `fixtures/`, because npm would otherwise install every deliberately-broken fixture package into this repository's own `node_modules`, symlink it under the Configured_Scope, and require a Workspace_Coverage entry for it.
2. THE platform's `--workspaces` fan-out for `lint`, `typecheck`, and `test` SHALL reach no fixture package, which follows from criterion 1 because the fan-out enumerates the `workspaces` array, and THE test suite SHALL assert that no fixture path appears in the enumerated workspace set.
3. THE Tsconfig_Verifier SHALL verify no fixture package over this repository, because its verified set is the four Framework_Singletons, the Entry_Package, and the discovered microservices and Common_Packages, and no fixture is discovered under any Discovery_Root of this project.
4. THE Repo_Invariant_Checker SHALL report no violation concerning any path under `fixtures/` when run over this repository, and SHALL observe a Fixture_Scenario's violations only when a test passes that scenario's directory as its Project_Directory.
5. THE Package_Discovery SHALL yield, over this repository, the same result with the Fixture_Tier present as it yields with the Fixture_Tier absent.
6. THE Build_Sequence SHALL derive, over this repository, the same order and the same Project_List with the Fixture_Tier present as it derives with the Fixture_Tier absent, and SHALL make no fixture package a root of `tsc --build`.
7. THE Image_Assembler SHALL stage no path under `fixtures/` into any Image_Tree, for any Selector, because it stages only Framework_Singletons, the Entry_Package, and packages in the Required_Dependencies, and no fixture is any of those.
8. THE `.dockerignore` file SHALL exclude `fixtures/` from the container build context, so that the build stage's whole-context copy carries no fixture and a deliberately-broken manifest never reaches an image build.
9. THE Emit_Script SHALL emit no manifest `COPY` line for any path under `fixtures/`, which follows from its manifest globs being the top-level `packages/*` manifests, one glob per configured Discovery_Root, and the Entry_Package's own manifest, and THE Exclusion_List SHALL gain no entry for the Fixture_Tier, because the Fixture_Tier is not a `packages/<name>` entry at all.
10. THE root Vitest run SHALL collect no test file from under `fixtures/`, and THE repository SHALL place no Vitest test file and no `scripts.test` invoking Vitest inside any Fixture_Scenario, so that the platform's collected test set is unchanged by the tier's presence.
11. THE `scripts/emit-effective-dockerfile.sh` script, `scripts/build.js`, `scripts/start.js`, and `scripts/dev.js` SHALL each read no path under `fixtures/`.

### Requirement 11: What is committed and what is gitignored

**User Story:** As a developer running `git status`, I want a fixture build to leave my status clean, so that building a fixture does not look like a change I made.

#### Acceptance Criteria

1. THE repository SHALL commit every file of every Tree_Fixture, every Scenario_Manifest, the Fixture_Projects_Root's Root_Manifest, the Fixture_Projects_Root's `package-lock.json`, every source and manifest of every Project_Fixture, the Diagnostic_Coverage_Record, the Classification_Record, and `fixtures/README.md`.
2. THE repository SHALL leave untracked every `node_modules/` directory under `fixtures/`, every `dist/` directory under `fixtures/`, and every `*.tsbuildinfo` file under `fixtures/`, each of which the existing `.gitignore` patterns already cover.
3. WHEN a Fixture_Install followed by a fixture build and an Output_Clearing has run, THE set of tracked files reported as modified and the set of untracked-and-not-ignored files reported SHALL each be empty, so that exercising the tier leaves the working tree clean.
4. THE repository SHALL commit no generated output of a fixture build and no lockfile other than this repository's own and the Fixture_Projects_Root's.
5. THE test suite SHALL assert that every file under `fixtures/` that is neither ignored nor tracked is reported as an offence naming that path, so that a scenario file left untracked fails rather than passing locally and failing on a fresh clone.

### Requirement 12: Every platform test is classified, and the classification is checked

**User Story:** As the author of the next feature, I want a record telling me which platform test asserts a fact about the payload and which fixture supersedes it, so that deleting the payload-coupled tests after the payload moves is safe by construction rather than by inspection.

#### Acceptance Criteria

1. THE repository SHALL commit the Classification_Record assigning every member of the Platform_Test_Set to exactly one Test_Class.
2. THE Classification_Record SHALL name, for each Payload_Coupled_Test, the Fixture_Equivalent that asserts over a Fixture_Scenario or a Synthesized_Tree the claim that test asserts over the Payload_Tree, and SHALL name, for each Drift_Detector, the reason it is retained.
3. THE classification criterion SHALL be the **subject of the assertion**: a member of the Platform_Test_Set is a Payload_Coupled_Test when at least one of its assertions would have to change if a package of the Payload_Tree were renamed, relocated, or removed, and is a Payload_Independent_Test when every one of its assertions holds for any conforming layout and payload-shaped names appear in it only as values of a Synthesized_Tree or a Fixture_Scenario.
4. THE repository SHALL classify a Payload_Owned_Test in no Test_Class and SHALL include no Payload_Owned_Test in the Classification_Record, because a Payload_Owned_Test tests the payload's own behaviour and moves with the payload.
5. THE Classification_Guard SHALL derive the Platform_Test_Set from the filesystem, SHALL compare it with the Classification_Record's path set, and SHALL fail naming every path present in one and absent from the other, so that a test added without a classification and a record entry naming a deleted test are each a named failure.
6. THE Classification_Guard SHALL fail naming the offending path when a record entry declares no Test_Class, declares more than one, declares a Test_Class other than the three, names a Fixture_Equivalent that is not itself a member of the Platform_Test_Set, or is a Payload_Coupled_Test entry naming no Fixture_Equivalent.
7. THE Classification_Guard SHALL assert that the set of Drift_Detectors equals an explicitly listed set held in the guard, so that retaining a further payload-asserting test is a deliberate edit to that list rather than a classification chosen in passing.
8. THE Classification_Guard SHALL assert, for each Payload_Independent_Test, that the file declares no static import and no dynamic import whose specifier is this repository's Configured_Scope followed by `/` and the name of a discovered Consumer_Package, and SHALL fail naming the file and the specifier otherwise — a necessary condition for payload independence, not a sufficient one, which is why criterion 3 states the criterion in terms of the assertion's subject.
9. THE Classification_Guard SHALL fail when the derived Platform_Test_Set holds fewer than two members, so that a rename that emptied the derivation cannot let the guard pass by classifying nothing.
10. THE Classification_Record SHALL be machine-readable, SHALL carry for each entry the path, the Test_Class, and the per-class field criterion 2 requires, and SHALL order its entries by ascending code-point comparison of path so that a reviewer reads a stable diff.
11. THE repository SHALL keep every member of the Platform_Test_Set passing, whatever its Test_Class, so that classification is a record about tests rather than a change to them.

### Requirement 13: A Fixture_Equivalent for every Payload_Coupled_Test

**User Story:** As the author of the next feature, I want every claim a payload-coupled platform test makes to be asserted over a fixture as well, so that the payload can move without a claim being lost.

#### Acceptance Criteria

1. THE repository SHALL provide, for each Payload_Coupled_Test the Classification_Record names, a Fixture_Equivalent asserting that test's claim over a Fixture_Scenario or a Synthesized_Tree, and SHALL leave the Payload_Coupled_Test in place and passing.
2. A Fixture_Equivalent SHALL derive every Discovery_Root, every Configured_Scope, every Entry_Root, and every package path it uses from the configuration of the subject it points at, and SHALL spell no path literal and no scope literal of its own.
3. THE repository SHALL provide a Fixture_Equivalent for the claims about Package_Discovery's per-category results, about the derived build order and the Project_List, about the staged Image_Tree's entry set, about the Repo_Invariant_Checker's reported violation set, about the Registry_Generator's emitted specifiers and entries, about the Tsconfig_Verifier's violation set, and about the Emit_Script's emitted manifest `COPY` and toggle `ENV` lines.
4. WHERE a Payload_Coupled_Test's claim concerns mounting, routing, or toggle behaviour over real microservice modules, THE Fixture_Equivalent SHALL assert that claim over microservice modules the test itself constructs, so that the claim survives the payload's departure without requiring a fixture to hold executable HTTP handlers.
5. THE test suite SHALL assert, for at least one Fixture_Scenario per Consumer_Category, that the result the component under test yields over that fixture read from the filesystem equals the result it yields over the in-memory Synthesized_Tree transcribed from the same fixture, so that a fixture and a synthesized tree are interchangeable subjects.
6. A Fixture_Equivalent SHALL exercise a Configured_Scope other than the Scope_Default in at least one assertion and a set of Discovery_Roots all differing from their Root_Defaults in at least one assertion, so that the fixture subjects do not silently re-import the assumptions the payload-coupled tests carried.
7. THE repository SHALL add no Fixture_Equivalent that asserts a fact about the committed Payload_Tree, so that no Fixture_Equivalent is itself a Payload_Coupled_Test.

### Requirement 14: The drift detectors stay

**User Story:** As a platform maintainer, I want to keep the narrow tests that catch the pure core disagreeing with the real repository, so that decoupling the general claims does not remove the only check that the platform's view of this tree is correct.

#### Acceptance Criteria

1. THE repository SHALL retain `packages/build-tools/tests/discovery-real-tree.test.ts` and `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`, classified as Drift_Detectors, for the narrow purpose of detecting disagreement between a pure Build_System core and the committed repository.
2. THE repository SHALL classify as a Drift_Detector every other member of the Platform_Test_Set whose assertions are confined to that same narrow purpose, and SHALL list each in the Classification_Guard's explicit Drift_Detector set.
3. A Drift_Detector SHALL run the same derivation the platform's own entry point runs, over the real filesystem, and SHALL assert the one result this repository's committed tree produces, so that what it catches is drift rather than a re-statement of a general claim.
4. THE repository SHALL add no general claim to a Drift_Detector, a general claim being an assertion whose subject is a component's behaviour for any conforming layout, and SHALL assert every such claim over a Fixture_Scenario or a Synthesized_Tree instead.
5. THE repository SHALL leave each Drift_Detector's assertions unchanged by this feature, because the Payload_Tree is unchanged by this feature.
6. THE Classification_Record SHALL record, for each Drift_Detector, that it is retained pending the payload's relocation and that the next feature decides its fate, so that a later reader does not mistake a deliberate retention for an oversight.

### Requirement 15: Nothing changes — the thirteen Baseline_Recordings and the green repository

**User Story:** As a reviewer, I want one mechanical check that this feature changed no behaviour, so that I can trust an additive claim without reading every diff.

#### Acceptance Criteria

1. THE repository SHALL leave the bytes of all thirteen Baseline_Recordings under `packages/integration-tests/baseline/` unchanged by this feature, each file's content after this feature being equal to its content at the Pre_Change_Baseline commit, and SHALL add no Baseline_Recording and remove none.
2. THE test suite SHALL assert that the set of files under `packages/integration-tests/baseline/` is exactly those thirteen, so that an added or removed recording is a named failure rather than a silently wider comparison.
3. THE test suite SHALL keep asserting each Baseline_Recording against the observable it records, through the same public function and the same `scripts/record-baseline.js` entry point that produced it, and SHALL report a difference by naming the observable compared, the recorded value, and the observed value.
4. IF an observed value differs from its Baseline_Recording, THEN THE comparison SHALL fail with a non-zero exit status, SHALL rewrite no Baseline_Recording, and SHALL leave the checked-out tree unmodified.
5. THE Repo_Invariant_Checker SHALL produce, over this repository, a concatenation of standard output and standard error byte-identical to the committed `check-invariants.txt` Baseline_Recording and SHALL terminate with exit status zero, because the Fixture_Tier is matched by no `workspaces` entry, is discovered by no Discovery_Root, is verified by no Tsconfig_Verifier target, and adds no scope literal under `packages/build-tools/src/`.
6. THE Package_Discovery SHALL yield, over this repository under the default Effective_Config, a result byte-identical to the committed `discovery.json` Baseline_Recording.
7. THE Build_Sequence SHALL yield, over this repository, build orders and Project_Lists byte-identical to the three committed `build-order.<slug>.json` Baseline_Recordings.
8. THE Registry_Generator SHALL emit, over this repository, registries byte-identical to the three committed `registry.<slug>.ts` Baseline_Recordings.
9. THE Emit_Script SHALL emit, over this repository, generated Dockerfiles byte-identical to the three committed `dockerfile.<slug>` Baseline_Recordings.
10. THE Image_Assembler SHALL stage, over this repository, Image_Trees byte-identical to the two committed `image-tree.<slug>.json` Baseline_Recordings.
11. THE repository SHALL keep every existing member of the Platform_Test_Set and every Payload_Owned_Test passing with its assertions unchanged, and SHALL change no source under a Consumer_Package's directory, no source under `packages/overseer/src/`, no source under `packages/contracts/`, and no source under the Entry_Root.
12. THE repository SHALL add to `packages/build-tools/src/` only what the Fixture_Tier's tests require of the Build_System, and SHALL change no existing Build_System behaviour, so that every criterion of this requirement holds because nothing was rewired rather than because a rewiring was compensated for.
13. THE root `package.json` SHALL gain exactly one script, `fixtures:install`, SHALL gain no dependency and no devDependency, and SHALL keep every existing script's text unchanged.

### Requirement 16: Correctness properties

**User Story:** As a platform maintainer, I want the fixture tier's guarantees expressed as properties over generated inputs, so that the tier's own machinery is tested the way the platform tests everything else.

#### Acceptance Criteria

1. THE test suite SHALL express each property of this requirement with `fast-check`, in a file whose name ends `.property.test.ts`, executing over at least 100 generated inputs per run, with every `fc.assert` call declaring its own run count.
2. THE test suite SHALL assert, for every generated Synthesized_Tree holding 0 to 5 Consumer_Packages per Consumer_Category, that materialising that tree as directories and manifests inside an operating-system temporary directory and running the component's effect shell over it yields, for each Consumer_Category, sequences of equal length in the same order whose corresponding entries carry identical Consumer_Category, directory name, declared name, build kind, and Dependency_Specifier list, to those the pure core yields over the same tree as in-memory inputs — which is the fixture-versus-synthesized agreement property.
3. THE test suite SHALL assert, for every Fixture_Scenario and every generated behaviour-preserving perturbation of it — a permutation of its Root_Manifest `workspaces` entries, an added well-formed package in a category its Expected_Diagnostic does not concern, and a relocation of its Discovery_Roots to any assignment the Config_Parser accepts — that the entry point its Scenario_Manifest names reports a Diagnostic_Tag set exactly equal to the one-element set holding that scenario's Expected_Diagnostic.
4. THE test suite SHALL assert, for every generated directory tree of 0 to 20 files across 0 to 4 nesting levels including symlinks, that a Fixture_Clone of it reproduces the relative path set exactly, reproduces every regular file's bytes exactly, reproduces every symlink as a symlink with the same target text, and that its `cleanup` leaves no path of the copy present.
5. THE test suite SHALL assert, for every generated directory tree carrying arbitrary `dist/` directories, arbitrary `*.tsbuildinfo` files, arbitrary other files, and a `node_modules/` directory, that Output_Clearing leaves the same filesystem state after one application and after two, removes every `dist/` directory and every `*.tsbuildinfo`, and leaves every other path and every path under `node_modules/` present with unchanged bytes — which is the idempotence property.
6. THE test suite SHALL assert, for every generated Selector accepted by the Build_System and every generated Fixture_Tier content placed under a copy of this repository, that the Package_Discovery result, the derived build order, the Project_List, and the staged Image_Tree are equal to those computed over the same copy with the Fixture_Tier absent — which is the additive-invariance property.
7. THE test suite SHALL assert, for every generated Diagnostic_Tag of the Diagnostic_Tag form, that deriving a Scenario_Directory_Name from it and recovering a tag from that name yields the tag that was generated, and that the derivation is injective over the set of Diagnostic_Tags the Build_System emits — which is the naming round-trip property.
8. THE test suite SHALL assert, for every generated Platform_Test_Set-shaped path list and every generated candidate Classification_Record over it, that the Classification_Guard accepts exactly those records that assign every path exactly one Test_Class, name an existing Fixture_Equivalent for every Payload_Coupled_Test entry, and name no path outside the list.
9. THE test suite SHALL assert, for every generated pair of distinct Project_Fixture scope assignments, that the declared package name sets of the two assignments are disjoint, so that the Fixture_Projects_Root's one hoisted `node_modules` can hold every member without a name collision.
10. THE test suite SHALL assert, for every generated mutating-filesystem-call source fragment whose destination is built from a fixture path anchor, that the Worktree_Guard reports an offence when the destination is outside the Permitted_Write_Location set and reports none when it is inside it.
11. THE test suite SHALL derive the subject of each property of this requirement from a generated configuration rather than from a path literal or a scope literal written in the test.
12. THE test suite SHALL check the run floor of criterion 1 for this feature's property files mechanically — each file existing, named with the `.property.test.ts` suffix, importing `fast-check`, declaring a run count for every `fc.assert` call, and declaring no run count below 100 — and SHALL leave the existing run-floor suite's own file list unchanged, so that the two features' floors are checked side by side rather than one replacing the other.

### Requirement 17: Steering documentation

**User Story:** As a developer adding a hostile scenario, I want the steering documents to tell me which partition it belongs in and what may be written where, so that I learn the tier's rules without reading its tests.

#### Acceptance Criteria

1. THE `.kiro/steering/structure.md` document SHALL name the Fixture_Tier, state that it lives at `fixtures/` as a direct child of the Project_Directory, state that it is neither a workspace nor a package nor a Discovery_Root, and show its two partitions in the repository layout.
2. THE `.kiro/steering/structure.md` document SHALL state the partition criterion — a Tree_Fixture holds hostility npm itself cannot install and is never installed and never built, a Project_Fixture holds hostility npm does not care about and is installed once through the Fixture_Projects_Root — and SHALL state that a separate workspace root is what keeps deliberately-broken packages out of the platform's `--workspaces` lint and typecheck fan-out.
3. THE `.kiro/steering/structure.md` document SHALL state that the Fixture_Projects_Root is deliberately hostile-only, and SHALL state that the happy-path live subject is the example project a later feature introduces.
4. THE `.kiro/steering/structure.md` document SHALL state, under its "Where things go" guidance, the directory a new hostile scenario of each kind belongs in, the Scenario_Directory_Name rule, and the obligation to declare a Scenario_Manifest and a Diagnostic_Coverage_Record entry.
5. THE `.kiro/steering/tech.md` document SHALL name the `fixtures:install` script, state that no lifecycle script and no root install performs a Fixture_Install, state that the CI workflow runs it as its own step before the quality gate, and state that a suite finding no installed fixture projects skips with a reason locally and fails when `CI` is set.
6. THE `.kiro/steering/tech.md` document SHALL extend its worktree-safety rules with exactly the three in-fixture Permitted_Write_Locations — a `dist/` under `fixtures/`, a `*.tsbuildinfo` under `fixtures/`, and the Fixture_Projects_Root's `node_modules/` — SHALL keep the three existing permitted locations, and SHALL state that every other in-fixture mutation goes to a Fixture_Clone.
7. THE `.kiro/steering/tech.md` document SHALL state the Output_Clearing rule and its reason: a previously failed build leaves partial output that can make a later run pass spuriously.
8. THE `.kiro/steering/tech.md` document SHALL state that `pristineWorktree()` is retained, state that its subject is uncommitted platform source in the checked-out tree, state that the Fixture_Clone's subject is a fixture, and SHALL keep the prohibition on destructive git commands and on a working-tree restore helper stated in full.
9. THE `.kiro/steering/tech.md` document SHALL state that the Fixture_Tier is excluded from the `workspaces` array, from the `--workspaces` fan-out, from the Tsconfig_Verifier, from the Repo_Invariant_Checker's checks over this repository, from the container build context, and from the Image_Assembler, and SHALL state the reason for each.
10. THE `.kiro/steering/structure.md` document SHALL state which files under `fixtures/` are committed and which are gitignored.
11. THE Steering_Documents SHALL state that every platform test is assigned a Test_Class in the Classification_Record, name the three classes and the criterion that sorts them, and state that the two named real-tree tests are retained as Drift_Detectors.
12. THE Steering_Documents SHALL describe the state of the repository after this feature lands, and SHALL describe none of the behaviours this feature does not implement: no relocated Payload_Tree, no `example/` directory, no deleted payload-coupled test, no example-as-subject test, no collapse of the root build to a plain `tsc --build`, no retirement of the bootstrap build, no retirement of `pristineWorktree()`, no published platform package, no shipped tsconfig, eslint, or prettier preset, no wiring generator, and no CI/release split.
13. THE Steering_Documents SHALL keep every statement they make about the Payload_Tree's present location true, because this feature moves nothing.
14. THE test suite SHALL assert mechanically that no Steering_Document states that a test may write into a Fixture_Scenario outside the Permitted_Write_Location set, and that each of the three in-fixture Permitted_Write_Locations and the `fixtures:install` script is named in `.kiro/steering/tech.md`, failing naming the offending document and line.

## Correctness Property Summary

| Property | Kind | Stated in |
| --- | --- | --- |
| Discovery over a materialised fixture tree agrees with discovery over the equivalent in-memory Synthesized_Tree | Model based | 13.5, 16.2 |
| Every Fixture_Scenario reports exactly the Diagnostic_Tag its name declares, under every behaviour-preserving perturbation | Invariant | 4.6, 16.3 |
| A Fixture_Clone reproduces its source's path set, bytes, and symlinks, and its cleanup removes the copy | Invariant | 7.3, 16.4 |
| Output_Clearing is idempotent and removes exactly the Generated_Fixture_Output | Idempotence | 8.3, 8.4, 16.5 |
| The Fixture_Tier's presence changes no discovery result, no derived order, no Project_List, and no staged Image_Tree | Metamorphic | 10.5, 10.6, 10.7, 16.6 |
| Scenario_Directory_Name and Diagnostic_Tag round-trip, and the derivation is injective | Round trip | 4.1, 4.2, 16.7 |
| The Classification_Guard accepts exactly the total, single-valued, fixture-complete records | Model based | 12.5, 12.6, 16.8 |
| Distinct Project_Fixture scopes yield disjoint declared-name sets | Invariant | 3.5, 16.9 |
| The Worktree_Guard flags a fixture-anchored write outside the Permitted_Write_Location set and no write inside it | Error condition | 9.3, 9.4, 16.10 |
| The thirteen Baseline_Recordings are byte-unchanged | Invariant | 15.1, 15.5–15.10 |

## Out of Scope

Each of the following is the subject of the next feature or a later one, and none is implemented here:

- **Relocating the Payload_Tree into `example/`.** Every microservice, Common_Package, and Spa_Package stays exactly where it is (Requirement 1.5).
- **Deleting any superseded Payload_Coupled_Test.** Each stays in place and passing (Requirement 13.1). The Classification_Record is what makes the later deletion safe.
- **The platform's example-as-subject tests** — running the example's own build, spawning a dev session against it, building its container.
- **Collapsing the root build to a plain `tsc --build`, and retiring the bootstrap build.** `scripts/build.js` and `scripts/common-startup.js` keep their present behaviour (Requirement 15.12).
- **Retiring `pristineWorktree()`.** It is retained (Requirement 7.9).
- **Publishing any package to any registry**, and the three-package split that goes with it.
- **Shipped tsconfig, eslint, or prettier presets.**
- **The wiring generator** and its drift alarm against the example.
- **The CI/release split.** `ci.yml` gains one step (Requirement 6.5); `release.yml` is unchanged.

## Open Questions Deliberately Deferred

- **Whether the Drift_Detectors survive the payload's relocation.** Once the Payload_Tree lives in `example/`, a real-tree test either points at the example — becoming an example-as-subject test — or has no subject. This feature retains both, records the retention (Requirement 14.6), and leaves the decision to the feature that moves the payload.
- **Whether the Classification_Record outlives the next feature.** Its job is to make one set of deletions safe. Afterwards it may be a live invariant worth keeping, or history worth deleting; nothing here depends on which.
- **Whether a Project_Fixture should ever depend on a platform package.** Requirement 3.6 forbids it, which costs a scenario needing contract types a local stub. Once the platform is published, a fixture could depend on a tarball instead; that belongs to the publishing feature.
- **Whether the fixture tier should hold a container-build scenario.** A Project_Fixture whose subject is an image build needs a Docker daemon, which the platform's own suite does not currently require of every run. Deferred rather than decided.

## Accepted Imprecisions

- **The Diagnostic_Tag set is derived by a textual scan.** Requirement 5.2 scans `packages/build-tools/src/` for the bracketed tag form. A tag composed at run time from fragments would escape the scan, and a tag mentioned only in a comment would be counted. The alternative — a hand-maintained catalogue module — is a second thing to keep in step with the messages, and a stale catalogue fails silently while a scan's false positive fails loudly. The scan is the cheaper error.
- **Payload independence is checked by a necessary condition, not a sufficient one.** Requirement 12.8 checks that a Payload_Independent_Test imports no Consumer_Package by name. A test could still assert a payload fact it read from the filesystem. The criterion that decides the class is the subject of the assertion (Requirement 12.3), which is a judgement a reviewer makes; the mechanical check catches the common mistake and the record makes the judgement reviewable.
- **A Fixture_Scenario's stub of a platform type can drift from the real type.** Requirement 3.6 keeps fixtures free of platform dependencies, so a scenario needing the request-handler contract declares its own stub. The real contract is covered by the platform's own typecheck and by the Drift_Detectors; a drifted stub would weaken a fixture's realism without weakening any claim about the real tree.
- **The Fixture_Projects_Root's lockfile is a second lockfile to maintain.** Requirement 3.11 bounds the cost by restricting its dependencies to versions this repository's own lockfile already resolves, so the two move together, but nothing mechanically verifies that they agree.
- **`fixtures/projects/node_modules` is an in-place write into the checked-out tree.** It is gitignored and written only by the `fixtures:install` script, never by a test (Requirement 6.1), which is why it is a Permitted_Write_Location rather than a violation. A test that needs a different installed state clones (Requirement 7.1).
- **The additive-invariance property compares against a copy with the tier absent, not against the Pre_Change_Baseline commit.** Requirement 16.6 removes the Fixture_Tier from a copy rather than checking out an earlier commit, because checking out an earlier commit is exactly the destructive git operation the worktree rules forbid. The Baseline_Recordings of Requirement 15 carry the comparison against the earlier commit instead, as committed bytes.

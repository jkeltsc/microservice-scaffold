# Requirements Document

## Introduction

The only way to run the scaffold locally today is `npm start`, implemented by `scripts/start.js`: bootstrap-build `packages/contracts` and `packages/build-tools`, run the registry generator, `npm run build --workspaces`, then execute `packages/overseer/dist/index.js`. Every local iteration pays a full ahead-of-time build, and nothing reacts to a source edit — after changing a line in a microservice router a developer must stop the process and repeat the whole sequence.

This feature adds a Dev_Server: a watch-mode variant of that same production path, not a second execution model. The Dev_Command loads the local environment the same way `npm start` does, bootstrap-builds the two packages the registry generator bin is made of, runs the existing registry generator exactly once for the existing `MICROSERVICES` Selector, then keeps two things running for the life of the session — a Build_Watcher that incrementally recompiles changed TypeScript into each package's `dist/`, and the Overseer process, restarted when its compiled output changes.

The Dev_Command joins `npm start` rather than replacing it. `npm start` has no non-human consumers — a Container image runs `packages/overseer/dist/index.js` directly, `ci.yml` runs `npm ci` followed by `npm run ci`, and `release.yml` needs no Node setup at all — so the two commands split along the npm ecosystem convention: `start` runs once and exits with the Overseer's exit status, the Dev_Command runs until the developer interrupts it and watches for changes. Their first three steps are identical, so those steps are implemented once as Common_Startup and consumed by both entry points; the two paths diverge on exactly one boolean, watch or not. Keeping a supervisor-free one-shot path also has diagnostic value: it isolates whether a problem lies in the application or in watch coordination.

The consequence is that the Dev_Server executes the *same* compiled artifacts from `dist/` that production executes, through the *same* `packages/overseer/dist/index.js` entrypoint. Type safety is inherent rather than bolted on: `tsc` is the compiler, so a type error fails the emit for that package and the previous good output stays in place — code that does not typecheck cannot become new running output. Parity with production is structural, because there is one set of artifacts and one entrypoint. No dev-specific module resolution, no dev-specific entrypoint, no generated dev artifact, and no new TypeScript configuration are introduced, and `npm run typecheck --workspaces` / `npm run ci` remain the unchanged quality gate. A Dev_Session does churn each package's `dist/` as it recompiles, and that churn needs no mitigation because `dist/` is gitignored.

Measured context for the latency budget, recorded so the design has grounding rather than guesses: a single-package incremental recompile from a cold `tsc` process costs roughly 0.6–0.7 s, and that figure is dominated by process startup, config parsing and `lib.d.ts` loading. Under a resident `--build --watch` program the per-edit latency is lower, but it was not measured and this document states no watch-mode latency figure. Separately, `npm run build --workspaces` costs about 7 s even when every package is already up to date, almost entirely npm spawning eight workspace processes rather than compilation — which is why the dev path drives the TypeScript build directly instead of going through npm. Production `scripts/start.js` keeps its observable behavior, including its use of `npm run build --workspaces` for the full build.

The central problem this feature must solve is that two watchers race. A process watcher can fire while the compiler is still emitting, restarting the Overseer against a partially written or internally inconsistent `dist/` and producing a spurious crash-restart cycle. The requirements below state the observable obligation — the Overseer only ever starts against a complete, consistent compiled tree, and a failed compile leaves the last-good process serving — without prescribing the coordination mechanism, which is a design decision. "Complete and consistent" means free of compile errors and free of a partially written tree; it does not additionally require that the Compile_Pass permitting the start emitted output. A zero-error pass that emitted nothing means every output was already up to date, so an already-built working tree qualifies and the session's first Overseer starts against it. Whether a Compile_Pass emitted output governs only whether an already running Overseer is restarted.

## Glossary

- **Dev_Server**: The local development runtime introduced by this feature: a watch-mode variant of the existing production start path that recompiles on source change and restarts the Overseer against the recompiled output.
- **Dev_Command**: The single npm script a developer runs to start the Dev_Server.
- **Dev_Session**: One execution of the Dev_Command, from invocation until the developer terminates it.
- **Common_Startup**: The startup steps shared by Production_Start and the Dev_Server: local environment load, Bootstrap_Build, and Microservice_Registry generation. It is the prefix both entry points perform before they diverge on whether the TypeScript build and the Overseer process watch for changes.
- **Startup_Sequence**: The ordered steps the Dev_Command performs before the Dev_Session enters its steady watch state: Common_Startup (local environment load, Bootstrap_Build, Microservice_Registry generation), followed by the two Dev_Server-specific steps, Build_Watcher start and Overseer start.
- **Bootstrap_Build**: A compile of `packages/contracts` and `packages/build-tools` only, performed so the compiled registry generator bin (`packages/build-tools/dist/bin/generate-registry.js`) exists. The existing `scripts/start.js` performs the equivalent step.
- **Registry_Generator**: The existing generator in `packages/build-tools` that writes the Microservice_Registry to `packages/overseer/src/generated/microservice-registry.ts`.
- **Microservice_Registry**: The generated TypeScript manifest that statically imports the selected microservices by package name and is consumed by the Overseer at build time.
- **Selector**: The existing `MICROSERVICES` build variable value, resolved by the existing `resolveSelected` semantics: unset, blank, or `*` selects every discovered candidate; otherwise a comma-separated list of Microservice_Identifiers.
- **Microservice_Identifier**: The directory name of a microservice under `packages/microservices/`.
- **Project_List**: The ordered set of TypeScript projects the Build_Watcher is given for the Dev_Session: the Overseer, every microservice selected by the resolved Selector, and every shared package the Overseer or a selected microservice depends on directly or transitively, ordered topologically so that each dependency precedes every package that depends on it.
- **Build_Watcher**: The resident TypeScript build process that watches the Project_List sources and incrementally emits to each package's `dist/`.
- **Compile_Pass**: One complete build cycle of the Build_Watcher, from the first change it reacts to until it has finished emitting and reports the cycle complete.
- **Settled_Compilation**: The state in which the most recently started Compile_Pass has reported its cycle complete and no subsequent Compile_Pass has started.
- **Compiled_Tree**: The union of the `dist/` directories of the packages in the Project_List, which is what the Overseer process executes.
- **Consistent_Compiled_Tree**: The state of the Compiled_Tree at the completion of a Compile_Pass that produced no compile errors.
- **Last_Good_Output**: The Consistent_Compiled_Tree produced by the most recent error-free Compile_Pass of the current Dev_Session.
- **Overseer**: The routing frontend application at `packages/overseer/`, whose process entrypoint is `packages/overseer/dist/index.js`.
- **Overseer_Restart**: Terminating the running Overseer process and starting a new one from `packages/overseer/dist/index.js`.
- **Production_Start**: The existing `npm start` path implemented by `scripts/start.js`.
- **Toggle**: An existing per-microservice runtime environment variable named `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED`.
- **Microservice_Router_Surface**: The existing public surface of a microservice module: an exported Microservice_Path string and an exported Express router.

## Requirements

### Requirement 1: A single Dev_Command that starts the Dev_Server

**User Story:** As a developer, I want one command that starts a watching local server, so that I can iterate on source without repeating a manual build-and-run sequence.

#### Acceptance Criteria

1. THE Dev_Server SHALL provide a Dev_Command exposed as an npm script in the root `package.json`.
2. WHEN the Dev_Command is invoked, THE Dev_Server SHALL load the local environment through the same `dotenvx run --` mechanism the Production_Start script uses.
3. WHEN the Dev_Command is invoked, THE Dev_Server SHALL perform the Startup_Sequence steps in this order: load the local environment, perform the Bootstrap_Build, run the Registry_Generator, start the Build_Watcher, start the Overseer.
4. IF a Startup_Sequence step before the Overseer start fails — a Bootstrap_Build compile error, a non-zero exit of the Registry_Generator, or a failure to launch the Build_Watcher — THEN THE Dev_Server SHALL exclude starting the Overseer and SHALL exit with a non-zero status.
5. IF a Startup_Sequence step fails, THEN THE Dev_Server SHALL write a message to standard error naming the failed step.
6. WHEN the Dev_Command process receives a termination signal, THE Dev_Server SHALL terminate the Build_Watcher and the Overseer process, and SHALL exclude leaving either process running after the Dev_Command process exits.

### Requirement 2: Reuse the existing Registry_Generator and Selector semantics

**User Story:** As a developer, I want the dev server to select microservices exactly the way a build does, so that what I run locally matches what a Container would contain.

#### Acceptance Criteria

1. WHEN the Dev_Command runs, THE Dev_Server SHALL generate the Microservice_Registry by invoking the existing Registry_Generator rather than by any Dev_Server-specific generation logic.
2. WHEN the Dev_Server invokes the Registry_Generator, THE Dev_Server SHALL pass the `MICROSERVICES` value through unmodified, so that the registered microservice set equals the set the existing Selector semantics resolve for that value and the discovered candidate microservices, in which an unset, blank, or `*` value selects every discovered candidate microservice.
3. WHEN the Dev_Server is invoked with `MICROSERVICES` assigned inline on the command line, THE Dev_Server SHALL use the inline value in preference to a value supplied by the local `.env` file.
4. IF the Selector names an identifier that is not a discovered candidate microservice, THEN THE Dev_Server SHALL write a message to standard error naming every such identifier, SHALL exit with a non-zero status, and SHALL exclude starting the Overseer.
5. THE Dev_Server SHALL write the generated Microservice_Registry to the existing well-known location `packages/overseer/src/generated/microservice-registry.ts`.
6. THE Dev_Server SHALL run the Registry_Generator exactly once per Dev_Session, excluding any further run on a watched source change, on a Compile_Pass completion, or on an Overseer_Restart.

### Requirement 3: Incremental recompilation of the Project_List

**User Story:** As a developer, I want an edit to any workspace source file to be recompiled automatically, so that I do not run a build myself.

#### Acceptance Criteria

1. WHILE a Dev_Session is running, THE Build_Watcher SHALL watch the TypeScript sources of every package in the Project_List.
2. WHEN a watched TypeScript source file changes, THE Build_Watcher SHALL start a Compile_Pass that recompiles the package owning the changed file.
3. WHEN a Compile_Pass recompiles a package and that recompilation changes the package's emitted declaration output, THE Build_Watcher SHALL recompile, within the same Compile_Pass, every package in the Project_List that imports the recompiled package by its `@microservices/<name>` package name.
4. WHEN a Compile_Pass completes with no compile error, THE Build_Watcher SHALL have written the emitted JavaScript and declaration output of every package it recompiled into that package's own `dist/` directory.
5. THE Build_Watcher SHALL exclude recompiling any package that is neither the package owning a changed source file nor a package whose build inputs that Compile_Pass changed.
6. THE Project_List SHALL consist of the Overseer, every microservice selected by the resolved Selector, and every shared package the Overseer or a selected microservice depends on directly or transitively, ordered so that each shared package appears before every package that depends on it and each selected microservice appears before the Overseer.
7. WHEN the Dev_Command runs in a working tree that contains no `dist/` output and no TypeScript incremental build state, THE Dev_Server SHALL compile every package in the Project_List successfully before starting the Overseer.
8. THE Dev_Server SHALL invoke the TypeScript build directly rather than through `npm run build --workspaces`.

### Requirement 4: Restart the Overseer against recompiled output

**User Story:** As a developer, I want the running server to pick up my change without me restarting it, so that I can test the change immediately.

#### Acceptance Criteria

1. WHILE a Dev_Session is running, THE Dev_Server SHALL execute the Overseer from the existing entrypoint `packages/overseer/dist/index.js`.
2. WHEN a Compile_Pass completes with no compile errors and its emitted output differs from the Compiled_Tree as that tree stood at the start of that Compile_Pass, THE Dev_Server SHALL perform an Overseer_Restart.
3. WHEN the Overseer process started by an Overseer_Restart has bound its HTTP server, THE Overseer SHALL answer requests from the Consistent_Compiled_Tree produced by the Compile_Pass that triggered that Overseer_Restart.
4. WHEN an Overseer_Restart starts the new Overseer process, THE Overseer SHALL run its existing boot pipeline unchanged, including module path validation, path collision rejection, Toggle validation, router construction, and HTTP server binding.
5. WHEN a Compile_Pass completes with no compile errors and leaves the Compiled_Tree identical to its state at the start of that Compile_Pass, THE Dev_Server SHALL keep the running Overseer process in place.
6. WHEN the Overseer process started by an Overseer_Restart has bound its HTTP server, THE Dev_Server SHALL write a message to standard output recording that the Overseer was restarted.
7. IF the Overseer process started by an Overseer_Restart exits with a non-zero status before binding its HTTP server, THEN THE Dev_Server SHALL keep the Dev_Session and the Build_Watcher running and SHALL exclude starting a replacement Overseer process until a subsequent Compile_Pass completes with no compile errors and changes the Compiled_Tree, so that the same unchanged output that failed to bind is excluded from being relaunched.
8. WHILE no Overseer process is running and no exclusion imposed by criterion 4.7 or criterion 6.5 is in force, WHEN a Compile_Pass completes with no compile errors, THE Dev_Server SHALL start the Overseer regardless of whether that Compile_Pass emitted output into the Compiled_Tree, because a Compile_Pass that completes with no compile errors and emits no output indicates that the Compiled_Tree was already complete and up to date. This criterion governs the initial Overseer start of a Dev_Session, and is distinct from criteria 4.2 and 4.5, which govern an Overseer_Restart of an already running Overseer process.

### Requirement 5: Coordinate the two watchers

**User Story:** As a developer, I want the server to restart only against a finished build, so that I never chase a crash caused by a half-written `dist/`.

#### Acceptance Criteria

1. THE Dev_Server SHALL start an Overseer process only against the Consistent_Compiled_Tree of a Compile_Pass that has reported its cycle complete with zero compile errors, and SHALL exclude additionally requiring that the Compile_Pass emitted output into the Compiled_Tree, because a Compile_Pass that reports its cycle complete with zero compile errors and emits no output indicates that the Compiled_Tree was already complete and up to date.
2. WHILE a Compile_Pass is in progress, THE Dev_Server SHALL keep any running Overseer process in place, serving requests from the Last_Good_Output.
3. WHEN a Compile_Pass writes emitted output into the Compiled_Tree, THE Dev_Server SHALL exclude performing an Overseer_Restart until that Compile_Pass reports its cycle complete.
4. WHEN one or more source changes arrive while a Compile_Pass is in progress, THE Dev_Server SHALL perform at most one Overseer_Restart for the resulting sequence of Compile_Passes, performed once Settled_Compilation is reached.
5. WHEN a Compile_Pass that recompiled more than one package reports its cycle complete with zero compile errors, THE Dev_Server SHALL perform the Overseer_Restart only after every package recompiled by that Compile_Pass has been emitted.
6. WHILE an Overseer process is running, THE Dev_Server SHALL perform an Overseer_Restart of that process only in response to a Compile_Pass that reported its cycle complete with zero compile errors and changed the Compiled_Tree, and SHALL exclude deriving an Overseer_Restart from any other observation of the Compiled_Tree.
7. WHILE an Overseer_Restart is in progress, THE Dev_Server SHALL exclude starting an additional Overseer process until the Overseer process being replaced has exited.
8. WHEN a Compile_Pass reports its cycle complete, THE Dev_Server SHALL write a message to standard output recording the completion of that Compile_Pass and whether it reported compile errors.

### Requirement 6: Compile errors keep the last-good server serving

**User Story:** As a developer, I want a type error to be reported without killing my running server, so that I can read the error, fix it, and continue.

#### Acceptance Criteria

1. WHEN a Compile_Pass reports a compile error, THE Build_Watcher SHALL write a diagnostic to the Dev_Session output, on standard output or standard error, that names the source file and the line and character position within that file.
2. IF a Compile_Pass reports a compile error, THEN THE Dev_Server SHALL keep the running Overseer process in place and SHALL exclude performing an Overseer_Restart for that Compile_Pass.
3. WHILE the most recent Compile_Pass has an unresolved compile error and a Last_Good_Output exists, THE Overseer SHALL continue serving requests from that Last_Good_Output.
4. WHEN a Compile_Pass completes without compile errors after the most recent Compile_Pass reported a compile error, THE Dev_Server SHALL perform an Overseer_Restart, or start the Overseer if no Overseer process is running, without requiring the developer to terminate and re-invoke the Dev_Session.
5. IF the running Overseer process exits on its own during a Dev_Session, THEN THE Dev_Server SHALL write a message to standard error reporting the exit, SHALL keep the Build_Watcher running, and SHALL exclude starting a replacement Overseer process until a subsequent Compile_Pass completes without compile errors and changes the Compiled_Tree, so that the same unchanged output that the exited process was executing is excluded from being relaunched.
6. THE Dev_Server SHALL restrict the compiled output it executes to the Last_Good_Output, excluding any output emitted by a Compile_Pass that reported a compile error.
7. IF the first Compile_Pass of a Dev_Session reports a compile error, so that no Last_Good_Output exists, THEN THE Dev_Server SHALL exclude starting the Overseer and SHALL keep the Build_Watcher running.

### Requirement 7: The registered microservice set is fixed for the Dev_Session

**User Story:** As a developer, I want the set of registered microservices to be stable within a session, so that the routing table I am testing does not change underneath me.

#### Acceptance Criteria

1. THE Dev_Server SHALL determine the registered microservice set once per Dev_Session, at registry generation time.
2. WHEN a directory under `packages/microservices/` is added, removed, or renamed during a Dev_Session, THE Dev_Server SHALL keep the registered microservice set of the current Dev_Session unchanged.
3. WHILE a Dev_Session is running, THE Dev_Server SHALL exclude re-scanning `packages/microservices/` for candidate microservice directories, keeping both the registered microservice set and the Project_List as resolved at Dev_Session start.
4. WHEN an Overseer_Restart occurs during a Dev_Session, THE Dev_Server SHALL start the new Overseer process from the Microservice_Registry generated during the Startup_Sequence of that Dev_Session.

### Requirement 8: Runtime environment and Toggles behave as in production

**User Story:** As a developer, I want environment handling to be identical to production, so that a configuration problem shows up locally in the same form it would in a Container.

#### Acceptance Criteria

1. WHEN the Dev_Server starts an Overseer process, including the process started by an Overseer_Restart, THE Dev_Server SHALL pass to that process the environment resolved at Dev_Session start, including every `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED` Toggle and `PORT`.
2. THE Dev_Server SHALL exclude adding, removing, or altering any Toggle value or the `PORT` value in the environment it passes to the Overseer, leaving the Overseer's existing boot-time Toggle validation and existing `loadConfig` port resolution as the sole authority over how those values are interpreted.
3. WHERE an environment variable is assigned inline on the Dev_Command line, THE Dev_Server SHALL resolve that variable to the inline value in preference to a value supplied by the local `.env` file.
4. WHEN the Overseer starts under the Dev_Server, THE Overseer SHALL reach the same outcome for the resolved environment that it reaches under Production_Start, accepting the existing Toggle token set `enabled`, `disabled`, `true`, `false`, `1`, `0`, case-insensitively after trimming, and resolving its listening port through the existing `loadConfig` function, which defaults to port 8080 when `PORT` is unset.
5. IF a registered microservice's Toggle is absent from the resolved environment or holds a value outside the accepted token set, THEN THE Overseer SHALL exit with a non-zero status and report every offending Toggle, exactly as it does under Production_Start.

### Requirement 9: One execution model, additive change only

**User Story:** As a maintainer, I want the dev server to add nothing to the production runtime, so that dev and production cannot drift apart and the existing pipeline stays intact.

#### Acceptance Criteria

1. THE Dev_Server SHALL execute the same artifacts a Container image executes, namely the compiled output under the `dist/` directory of each package in the Project_List, through the same `packages/overseer/dist/index.js` entrypoint a Container image uses.
2. THE Dev_Server SHALL exclude any Dev_Server-specific module resolution, path mapping, or module alias configuration.
3. THE Dev_Server SHALL exclude any Dev_Server-specific TypeScript configuration file, generated artifact, `.gitignore` entry, and committed template.
4. THE modules under `packages/overseer/src/` SHALL exclude any Dev_Server-specific branch, flag, or conditional.
5. THE Dev_Server SHALL leave the root `prepare` script, `Dockerfile.template`, `scripts/emit-effective-dockerfile.sh`, and the image-tree assembler unchanged.
6. THE Dev_Server SHALL leave the composition of the `npm run ci` quality gate unchanged, keeping `npm run typecheck --workspaces` the type-check gate, and SHALL exclude adding a Dev_Server-specific type-check script.
7. THE Dev_Server SHALL exclude adding a new production dependency to any package.
8. WHERE the Dev_Server requires a new devDependency, THE Dev_Server SHALL pin that devDependency to an exact version.
9. WHERE `scripts/start.js` changes, THE Dev_Server SHALL restrict that change to consuming the single Common_Startup implementation required by Requirement 11, preserving Production_Start's observable behavior.

### Requirement 10: Document the Dev_Server

**User Story:** As a developer new to the scaffold, I want the dev workflow documented next to the existing commands, so that I know what the dev server does and what it does not react to.

#### Acceptance Criteria

1. THE `README.md` SHALL document the Dev_Command as the npm script a developer runs, and SHALL name every Startup_Sequence step in the order the Dev_Server performs them: environment load, Bootstrap_Build, registry generation, Build_Watcher start, Overseer start.
2. THE `README.md` SHALL identify, as changes a running Dev_Session picks up without developer action, a change to a TypeScript source file of a package in the Project_List.
3. THE `README.md` SHALL identify, as changes that require terminating and re-invoking the Dev_Command, adding, removing, or renaming a directory under `packages/microservices/`, a change to the Selector, and a change to a Toggle or other environment variable.
4. THE `README.md` SHALL document that the Dev_Command and Production_Start execute the same compiled artifacts under `dist/` through the same `packages/overseer/dist/index.js` entrypoint.
5. THE `.kiro/steering/tech.md` common-commands section SHALL list the Dev_Command alongside `npm start` and the two image-build commands.
6. THE `api-dev-server` spec documents SHALL record the rejected source-execution alternative together with each recorded reason for rejecting it: the additional generated artifact and dev-only configuration, the execution of code that has not been type-checked, the stale declaration files read by the editor and type checker, and the resulting second execution model.
7. THE `api-dev-server` spec documents SHALL record the Startup_Sequence step list and the Microservice_Router_Surface as the two Dev_Server extension points a future single-page-application effort can build on.
8. THE `README.md` SHALL present the Dev_Command and `npm start` together, identifying the Dev_Command as the recommended entry point for iterative development and `npm start` as the one-shot path that executes the same compiled artifacts without a Build_Watcher.
9. THE `README.md` quick-start section and the `README.md` script table SHALL each list the Dev_Command as the recommended developer entry point alongside `npm start`.
10. THE `README.md` SHALL document that Production_Start terminates when the Overseer process it started exits, and that a Dev_Session runs until the developer terminates the Dev_Command.

### Requirement 11: Common_Startup is implemented once

**User Story:** As a maintainer, I want the startup steps `npm start` and the Dev_Command share to live in one implementation, so that the two entry points cannot drift apart and the clean-checkout ordering reasoning is recorded in one place.

#### Acceptance Criteria

1. THE repository SHALL contain exactly one implementation of the Common_Startup steps, from which both Production_Start and the Dev_Command obtain their startup behavior, excluding any entry-point-specific copy of a Common_Startup step.
2. THE Common_Startup implementation SHALL be the single location that enforces and documents the clean-checkout step-ordering constraints: the Bootstrap_Build before the Registry_Generator bin is invoked, Microservice_Registry generation before the full TypeScript build, and the reliance of both on the topological order of the root `workspaces` array.
3. WHEN Production_Start and the Dev_Command run for the same Selector and the same resolved environment, THE Common_Startup implementation SHALL produce identical Microservice_Registry content for both entry points.
4. THE Production_Start path and the Dev_Command path SHALL differ only in whether the TypeScript build watches for source changes and whether the Overseer process is restarted on recompilation, performing identical steps before that divergence.
5. WHEN Production_Start is invoked after Common_Startup is extracted, THE Production_Start path SHALL retain its existing observable behavior: the same step order, the same exit-status propagation for a failed step and for the Overseer process, and the same messages on the same output streams.
6. THE Production_Start path SHALL terminate when the Overseer process it started exits, exiting with that process's exit status, and SHALL exclude watching for source changes and SHALL exclude performing an Overseer_Restart.

## Non-Goals

- **Single-page-application concerns are out of scope** and will be a separate later effort. This feature specifies no bundler integration, no static-asset serving, no hot module replacement, and no websocket transport. It also forecloses nothing: the Startup_Sequence is an ordered step list a future effort can extend, and a future SPA-serving microservice needs only the existing Microservice_Router_Surface — an exported path plus an exported Express router — which this feature leaves untouched.
- **No authentication or authorization layer, no persistence, and no cross-service communication pattern**, per the scaffold's product non-goals.
- **No dev-only type-check path.** Type safety is a property of the chosen approach rather than a separate mechanism, so no dev type-check script or dev type-check configuration is added.

## Rejected Alternative (recorded)

A source-execution runner — `tsx watch` over `packages/overseer/src/index.ts` — combined with a generated dev-time path mapping of `@microservices/*` to each package's `src/` was considered and rejected. The reasons, recorded so the alternative is not re-proposed:

- It requires a new generated artifact plus a committed template for it, plus a `.gitignore` entry, plus a dev-only TypeScript configuration — four new moving parts, none of which production uses.
- It runs code that has not been type-checked. A transpile-only runner strips types and executes anyway, so a type error becomes a runtime surprise instead of a failed emit.
- It lets the editor and the type checker read stale `.d.ts` files from `dist/` while the server runs newer `src/`, so the three views of the code can disagree.
- It creates a genuinely second execution model, which means dev-versus-production parity becomes something to prove with a battery of tests rather than something that holds by construction.

The chosen build-watch approach buys type safety and parity by construction, at the cost of a few hundred milliseconds of restart latency per edit.

## Correctness Properties Worth Testing

Parity is structural in this design — one set of artifacts, one entrypoint, one Common_Startup implementation — so the property surface is deliberately small. The heavy dev-versus-production battery that a two-mechanism design would have needed is not warranted here.

**Property 1 — Project_List membership and topological order (property-based).** The Project_List contains exactly the Overseer, the selected microservices, and the dependency closure of shared packages, and for every dependency edge between two packages in the list the dependency appears first. Pure list-and-manifest computation, cheap to generate over synthetic workspace graphs, and the failure it catches (a fresh clone that cannot cold-build) is invisible on a warm tree. *Covers: 3.6, 3.7.* This mirrors the existing shared-package ordering property in `packages/build-tools/tests/`.

**Property 2 — Selector resolution is the existing behavior (property-based, already covered).** The Dev_Server's registered microservice set equals `resolveSelected(selector, discoveredDirectories)` for every selector and directory set, and an unknown identifier is rejected rather than silently dropped. The existing `selector-semantics.property.test.ts` and registry generator properties already establish the semantics; the Dev_Server property is the equality with that function, not a restatement of it. *Covers: 2.1, 2.2, 2.4, 2.6.*

**Property 3 — Restart gating under arbitrary event interleavings (property-based, model-based).** Over a generated sequence of compile-start, compile-complete, compile-error, file-change, and overseer-exited events, the restart decision function starts the Overseer only after a compile-complete event with no error; the initial start of a session is emit-independent, so a clean compile-complete event that emitted nothing starts the Overseer when none is running; a restart of an already running Overseer additionally requires that the clean pass changed the Compiled_Tree; no start follows an unrequested Overseer exit or a failed bind without an intervening clean pass that changed the Compiled_Tree; at most one restart occurs per settled burst; no restart follows a compile-error event; two Overseer processes are never alive at once (the interleaving that otherwise yields two processes contending for the same port); and a completion record is emitted for every compile-complete event. This is the central design problem stated as a property, and it is worth 100 iterations precisely because the failure is a rare interleaving. It requires the restart decision to be a pure function of the event stream, testable without spawning processes. *Covers: 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.2, 6.5, 6.6.*

**Property 4 — No-op Compile_Pass is idempotent with respect to restarts (property-based).** A Compile_Pass that leaves the Compiled_Tree unchanged produces no Overseer_Restart of a *running* Overseer, so a settled session converges to a stable process. The claim is about restarts, not about starts, so it is compatible with the initial start occurring on a non-emitting pass: a Dev_Session begun on a warm working tree, whose first clean Compile_Pass emits nothing because every output is already up to date, still starts exactly one Overseer process, and every later non-emitting clean pass leaves that process in place. *Covers: 4.5, 4.8, 5.4.*

**Property 5 — Error-then-fix round trip (integration, 1–2 examples).** Break a source file, observe the diagnostic naming file, line and character and the server still answering from Last_Good_Output; fix the file, observe the server serving the new output with no manual restart. A second example starts a session whose first Compile_Pass errors, and observes that no Overseer starts while the Build_Watcher keeps watching. Behavior does not vary meaningfully with the specific input, so a couple of representative examples beat 100 iterations. *Covers: 6.1, 6.3, 6.4, 6.7.*

**Property 6 — Environment pass-through is the existing behavior (already covered).** Toggle token parsing and boot-time validation, and `PORT` resolution, are already established by the existing `toggles` and `config` properties. The Dev_Server adds no new property here; a single end-to-end check that a Dev_Session passes the session-start environment through unaltered — honoring a Toggle, an inline `PORT`, and an inline `MICROSERVICES` in preference to `.env` — is sufficient. *Covers: 2.3, 8.1, 8.2, 8.3, 8.4, 8.5.*

**Property 7 — Structural additive-only assertions (static checks, single execution).** Assert by inspection of the repository that `packages/overseer/src/` contains no Dev_Server branch, that no Dev_Server-specific TypeScript configuration, generated artifact, `.gitignore` entry, or template exists, that no Dev_Server-specific module resolution or path mapping is configured, that the root `prepare` script and the image pipeline files (`Dockerfile.template`, `scripts/emit-effective-dockerfile.sh`, the image-tree assembler) are unchanged, that any change to `scripts/start.js` is confined to consuming the single Common_Startup implementation, that the `ci` script composition is unchanged, that no new production dependency was added, and that any new devDependency is pinned to an exact version. These are deterministic facts about the tree, so they are example tests, not properties. *Covers: 9.2–9.9.*

**Property 8 — Cold-start end to end (integration, 1 example).** From a tree with no `dist/`, no incremental build state, and no generated registry, the Dev_Command reaches a state where the Overseer answers a request, executing the compiled output through `packages/overseer/dist/index.js`. Single expensive execution, so one example. *Covers: 1.3, 3.7, 4.1, 4.3, 4.4, 9.1.*

**Property 9 — Session-scoped registration (integration, 1 example).** Adding a microservice directory during a running Dev_Session leaves the routing table unchanged, including across an Overseer_Restart triggered by a later source edit; restarting the Dev_Session registers it. Confirms the intended boundary rather than a bug. *Covers: 7.1, 7.2, 7.3, 7.4.*

**Property 10 — Common_Startup produces one registry for both entry points (property-based).** For a generated Selector and workspace layout, the Microservice_Registry content produced along the Production_Start path equals the content produced along the Dev_Command path, and the two paths' step sequences agree up to the watch-or-not divergence. This is the regression guard against the two entry points drifting: it is cheap because both paths delegate to the same Common_Startup function, so the property is an equality over its output rather than over two spawned processes, and it is worth many iterations because drift would otherwise show up only for some selectors. *Covers: 11.3, 11.4.*

**Property 11 — Common_Startup is single-sourced and Production_Start is unchanged (static checks and 1–2 examples).** Assert by inspection that exactly one implementation of the Common_Startup steps exists, that both `scripts/start.js` and the Dev_Command entry point call it rather than re-implementing a step, and that the clean-checkout ordering constraints are documented there. Then run Production_Start on a clean checkout and observe its existing step order, its messages on their existing streams, its exit-status propagation for a failed step and for the Overseer process, and that it terminates without watching for changes or restarting the Overseer. Deterministic facts and one expensive execution, so example tests. *Covers: 11.1, 11.2, 11.5, 11.6.*

Requirement 10's documentation criteria (10.1–10.10) are verified by review of `README.md` and `.kiro/steering/tech.md` rather than by an automated property; they assert the presence of prose, which a test can only approximate.

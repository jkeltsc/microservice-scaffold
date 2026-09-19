# Implementation Plan: config-driven-discovery

## Overview

The task list follows the eleven ordered migration steps of the design's "Migration Order and Baseline Comparison" section, in that order and with those dependencies intact. The order is a designed property, not a convenience: step 1 records the baseline before anything moves, step 3's deprecated shims are what make step 4's seam-by-seam threading bisectable, step 6 deletes the shims so the compiler enumerates every remaining reader, step 7 proves the Tsconfig_Verifier silent over this repository before it is wired in, and step 8 lands `[scope:literal]` only after step 6 removed the last literal so the check arrives green.

Language: TypeScript for every module and test (the Emit_Script stays POSIX sh, and `scripts/record-baseline.js` stays plain Node), matching the design and this repository's stack.

**The gate after every task** — the repository must be green when a task is finished:

```
npm run build && npm run check:invariants && npm run typecheck --workspaces \
  && npm run lint --workspaces && npm test && npm run test:types
```

plus the baseline comparison added in task 1 (`baseline-equivalence.test.ts` and `migration-facts.test.ts`, both part of `npm test` once they exist).

## Tasks

- [x] 1. Step 1 — Record the Pre_Change_Baseline and prove the comparison harness on an unchanged tree
  - [x] 1.1 Write `scripts/record-baseline.js`
    - Plain Node, no TypeScript, ES module, no Vitest. **This is a deliberate one-shot developer script that writes committed fixtures under a human's hand — it is not a test, is not invoked by `npm test` or by `npm run ci`, and Requirement 13.6's prohibition on a test writing into the checked-out tree does not apply to it.**
    - Records into `packages/integration-tests/baseline/`: `discovery.json` (every Consumer_Package's category, directory name, package directory, declared name, build kind, sorted Dependency_Specifier list); `build-order.<selector>.json` (workspace build order and Project_List as ordered package-directory sequences) for `*`, blank, `microservice1,microservice2`; `image-tree.<selector>.json` (sorted Project_Directory-relative staged entry paths) for `*` and `microservice1,microservice2`; `registry.<selector>.ts` (exact bytes) for `*`, blank, `microservice1,microservice2`; `dockerfile.<selector>` (exact bytes) for `*`, unset, `microservice1,microservice2`; `check-invariants.txt` (the Repo_Invariant_Checker's exact output).
    - Selector spellings in filenames: `all`, `blank`, `microservice1-microservice2`.
    - Goes through the compiled bins and the two public entry points only, never through internal module signatures, so the same script runs unchanged before and after the threading.
    - _Requirements: 15.3, 15.4, 15.5, 15.10, 11.2, 7.8, 8.5_

  - [x] 1.2 Run the recorder on the Pre_Change_Baseline tree and commit `packages/integration-tests/baseline/`
    - Snapshot the generated Microservice_Registry's bytes before the registry recordings are produced and write those bytes back afterwards, by `writeFileSync` of the captured bytes and never through git.
    - _Requirements: 13.7, 13.8, 15.3, 15.4, 15.5, 15.10_

  - [x] 1.3 Extend `packages/integration-tests/tests/baseline-equivalence.test.ts` with the Requirement 15 comparisons it owns
    - Compare discovery, build order and Project_List per Selector, registry bytes per Selector, and the Repo_Invariant_Checker output against the recorded fixtures. Example-based, not generated.
    - Failure shape: name the observable compared, the recorded value and the observed value; exit non-zero; leave the checked-out tree unmodified. Fail even when every observable matches if a Config_Diagnostic was reported during the run.
    - _Requirements: 15.3, 15.4, 15.10, 7.8, 15.12, 15.13, 14.12_

  - [x] 1.4 Extend `packages/integration-tests/tests/migration-facts.test.ts` with the two build-costing comparisons
    - Image_Tree staged entry sets for `*` and `microservice1,microservice2`, and generated `Dockerfile` bytes for `*`, unset and `microservice1,microservice2`, each against its recorded fixture, with the same failure shape as 1.3.
    - _Requirements: 15.5, 11.2, 15.12, 15.13, 14.12_

- [x] 2. Step 2 — Add the configuration layer, wired to nothing
  - [x] 2.1 Create `packages/build-tools/src/project-config.ts`
    - Declare `EffectiveConfig`, `SCOPE_DEFAULT` (`@microservices`), `ROOT_DEFAULTS` (`packages/microservices`, `packages/common`, `packages/spa`, spelled as whole literals, not composed from `PACKAGES_DIR`), `PROJECT_CONFIG_FILE` (`scaffold.config.json`), `defaultEffectiveConfig()` as a function so the absent-file and `{}` paths return equal values by construction, the twelve-member `ConfigTag`, `ConfigDiagnostic` in its four non-empty parts, the non-empty `Diagnostics` type, the module-private `unique symbol`-branded `ParsedConfig`, `ParseOutcome`, the Config_Parser and the Config_Serializer.
    - The parser is total: every input string yields exactly one of a `ParsedConfig` or a non-empty diagnostic list, with no throw and no process exit. Diagnostics are collected (one per distinct tag-and-key-path pair) and sorted by code-point comparison of tag then key path, with `<`/`>` on raw strings and never `localeCompare`.
    - The module imports neither `node:fs` nor `node:process`, and imports only `framework.ts`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.13, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_

  - [x] 2.2 Create `packages/build-tools/tests/arbitraries/config.ts`
    - `validScope()`, `invalidScope()` (pool seeded with each spelling Requirement 3.3 enumerates), `validRootPath()`, `invalidRootPath()` (pool seeded per condition plus deliberate two-condition combinations), `nonOverlappingRootTriple()` (built constructively with a distinct generated first segment per root, one `filter` retained only as a guard), `overlapProneRootTriple()` (narrow pool: `a`, `a/b`, `a/b/c`, `ab`, `b`, `packages/contracts`, `packages`), `configText()`, `pathologicalText()` (with exactly one `fc.constant` of a 1,048,576-character string).
    - A plain module, not a `*.test.ts`, so Vitest does not collect it.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.9_

  - [x] 2.3 Write `packages/build-tools/tests/project-config.totality.property.test.ts`
    - **Property 1: Config parsing is total**
    - **Validates: Requirements 2.1, 2.3, 2.13, 14.1**

  - [x] 2.4 Write `packages/build-tools/tests/project-config.roundtrip.property.test.ts` — round-trip half
    - **Property 2: Parse and print round-trip**
    - **Validates: Requirements 2.9, 2.10, 14.2**

  - [x] 2.5 Add the idempotence property to `packages/build-tools/tests/project-config.roundtrip.property.test.ts`
    - **Property 3: Print is idempotent under re-parsing** — discard without failure each generated text the parser rejects.
    - **Validates: Requirements 14.3**

  - [x] 2.6 Write `packages/build-tools/tests/project-config.defaults.property.test.ts`
    - **Property 4: An undeclared value takes its default**, plus the separate assertion that `{}` yields all four defaults.
    - **Validates: Requirements 1.4, 1.5, 1.6, 14.4**

  - [x] 2.7 Write `packages/build-tools/tests/project-config.scope.property.test.ts`
    - **Property 5: A scope is accepted exactly when it is a Valid_Scope**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 2.8 Write `packages/build-tools/tests/project-config.roots.property.test.ts` — path-shape half
    - **Property 6: A root path is accepted exactly when it is a Valid_Root_Path**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [x] 2.9 Add the overlap property to `packages/build-tools/tests/project-config.roots.property.test.ts`
    - **Property 7: Root overlap is diagnosed exactly when two roots are equal or nested** — over `overlapProneRootTriple()`.
    - **Validates: Requirements 4.5, 4.6, 14.9**

  - [x] 2.10 Add the framework-collision property to `packages/build-tools/tests/project-config.roots.property.test.ts`
    - **Property 8: A root colliding with a Framework_Singleton is rejected, defaults included**
    - **Validates: Requirements 4.7, 4.8**

  - [x] 2.11 Write `packages/build-tools/tests/project-config.determinism.property.test.ts`
    - **Property 9: Diagnostics are deterministic and identically ordered**
    - **Validates: Requirements 2.8, 14.10**

  - [x] 2.12 Write `packages/build-tools/tests/project-config.shape.test.ts`
    - Example-based, one case per JSON type for the non-object input and per wrong-typed recognised key, plus the unknown-key cases and the rule that a rejected `roots` member is excluded from the overlap and framework comparisons with no default substituted.
    - _Requirements: 2.4, 2.5, 2.6, 3.4, 4.10_

  - [x] 2.13 Write `packages/build-tools/tests/project-config.purity.test.ts`
    - Assert by reading `project-config.ts`'s own import list that it imports neither `node:fs` nor `node:process`, and that the parser's result is a function of its declared inputs alone.
    - _Requirements: 2.2, 4.11_

  - [x] 2.14 Create `packages/build-tools/src/project-context.ts` and `packages/build-tools/tests/project-context.property.test.ts`
    - `ProjectContext` with `config`, `scopedName()`, `specifierPrefix`, `scopeDir`, `roots`, the four `FrameworkSingleton` records plus `all`, and `frameworkByName()`; `projectContext(config)` pure and total over any `EffectiveConfig`.
    - The property test builds a context from a generated Valid_Scope and asserts each Framework_Singleton name is the scope followed by `/` and the unchanged directory name, and that `frameworkByName` is exact and case-sensitive.
    - _Requirements: 1.9, 3.6, 3.7, 3.8_

  - [x] 2.15 Create `packages/build-tools/src/config-loader.ts`
    - `ConfigFileRead` (absent / text / unreadable), `RootProbe`, `ProbeRoot`, `LoadOutcome`; `validateDiscoveryRoots(parsed, probeRoot)` as the only function in the layer taking a prober, with a branded `ParsedConfig` first parameter so the inverted order does not compile; `loadProjectConfig(readConfigFile, probeRoot, configPath?)` in the four-statement shape the design fixes; `requireProjectContext()` as the single place a Config_Diagnostic reaches stderr and the only place the process exits over one.
    - Probe exactly three times, in `microservice, common, spa` order, and answer the `package.json` question from a field of the returned `RootProbe` rather than a second call. Order Filesystem_Validation diagnostics by Consumer_Category then tag; skip the root-is-package validation for a root already reported absent or non-directory.
    - _Requirements: 1.5, 1.10, 1.11, 1.12, 2.11, 2.12, 2.14, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [x] 2.16 Create `packages/build-tools/tests/arbitraries/probe.ts` and `packages/build-tools/tests/config-loader.filesystem.property.test.ts`
    - `proberResponses()` draws each Consumer_Category as absent, directory, entry-resolving-to-non-directory, directory-holding-a-`package.json`, or probe failure, wrapped in a recording prober so the probed path set is assertable.
    - **Property 10: The Config_Loader accepts exactly the root sets passing every Filesystem_Validation**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 14.14**

  - [x] 2.17 Write `packages/build-tools/tests/config-loader.unreadable.test.ts`
    - Absent versus unreadable, and that the unreadable branch substitutes neither the Scope_Default nor any Root_Default. No `scaffold.config.json` is written into the checked-out tree — the reader is injected.
    - _Requirements: 1.12, 2.11, 2.12, 13.6_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Step 3 — Split `framework.ts`, keeping deprecated shims
  - [x] 4.1 Introduce `FrameworkDirectory` in `packages/build-tools/src/framework.ts`
    - Four scope-free records (`dirName`, `packageDir`, `staging`) plus `FRAMEWORK_DIRECTORIES`; `singleton()` drops the composed `name`. Keep `PACKAGES_DIR`, `ALWAYS_STAGED_SCOPED_ENTRIES`, `OVERSEER_ENTRYPOINT`, `ConsumerCategory`, `CONSUMER_CATEGORIES`, `assertFrameworkDirectoriesPresent` unchanged.
    - _Requirements: 3.7, 1.8_

  - [x] 4.2 Add the deprecated shims to `framework.ts`
    - Keep `WORKSPACE_SCOPE`, `NAMESPACE_CONTAINER`, `FRAMEWORK_SINGLETONS` and `frameworkSingletonByName` as deprecated exports derived from `SCOPE_DEFAULT` and `ROOT_DEFAULTS` in `project-config.ts`, so the four defaults now have exactly one declaration site while every existing caller keeps compiling. Mark each with `@deprecated` naming task 8 as its removal point.
    - _Requirements: 1.7, 1.8, 15.3, 15.4_

  - [x] 4.3 Keep `framework.test.ts` and `framework.property.test.ts` green against the split
    - Assert the four directory names, the staging classification, `assertFrameworkDirectoriesPresent`, and that each shim equals the value derived from the single declaration site. Assertions about the deleted exports are dropped later, in task 8.2.
    - _Requirements: 1.8, 15.3_

- [x] 5. Step 4 — Thread the context through the nine seams, innermost first
  - Each sub-task changes exactly one signature, updates that seam's callers to pass a context — `projectContext(defaultEffectiveConfig())` at any caller not yet threaded — and updates that module's own tests to construct one. Run the full gate and the baseline comparison after each sub-task, so a moved observable names the seam that moved it.

  - [x] 5.1 Thread `packages/build-tools/src/discovery.ts`
    - `discoverPackagesFrom(context, listRoot, readManifest)` and `discoverPackages(context)`; `RootEntry`, `ListRoot` (returns `undefined` for an absent path), `ReadManifest`. `candidatesOf` reads `context.roots[category]` and hands the lister a path it never derives; `assertNamesMirrorDirectories` expects `context.scopedName(dirName)`; `scopedDependencySpecifiers` filters on `context.specifierPrefix`; `assertNamesUnique` seeds from `context.framework.all`. The five stages keep their order and their tags, and the `package.json` filename stays the module's only path literal.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14, 1.9_

  - [x] 5.2 Thread `packages/build-tools/src/required-dependencies.ts`
    - `requiredDependencies(context, …)`; root directories from `context.roots.microservice`, specifier prefix from `context.specifierPrefix`, and `[deps:cycle]` / `[shared:unresolved]` message text naming `context.config.scope`.
    - _Requirements: 1.9, 10.7_

  - [x] 5.3 Thread `packages/build-tools/src/build-sequence.ts`
    - `buildSequence(context, …)`; `microservicePackageDir` and the Overseer ordering edge from `context.roots.microservice`, specifier prefix and `[build-order:cycle]` text from the context. `packages/contracts` stays first and each package stays ahead of every package declaring a Dependency_Specifier resolving to it, for any root assignment.
    - _Requirements: 1.9, 10.7, 10.8_

  - [x] 5.4 Thread `packages/build-tools/src/build-plan.ts`
    - `buildPlan(context, …)`; `SCOPE_DIR` becomes `context.scopeDir` and `microserviceDir` reads `context.roots.microservice`.
    - _Requirements: 1.9, 10.7_

  - [x] 5.5 Thread `packages/build-tools/src/image-tree.ts` and its bin
    - `buildImageTree(context, plan)` as the domain function; new `runImageTreeCli()` holding the config load, diagnostic reporting and non-zero exit; `src/bin/build-image-tree.ts` stays a shebang, one import, one call.
    - _Requirements: 1.9, 1.10, 15.5_

  - [x] 5.6 Thread `packages/build-tools/src/dev-supervisor.ts`
    - `devProjectList(context, plan)`; `runDevSupervisorCli()` obtains its context through `requireProjectContext()`.
    - _Requirements: 1.9, 1.10, 10.7, 15.8, 15.11_

  - [x] 5.7 Thread `packages/build-tools/src/generate-registry.ts` and its bin
    - `generateRegistry(context, selector, discovery?)` as the domain function; new `runGenerateRegistryCli()`; `src/bin/generate-registry.ts` stays a three-line wrapper. Every emitted import specifier and `sourcePackage` value, the `contracts` type-import specifier, and the banner's generator attribution are composed from `context.scopedName(...)`. `OUTPUT_PATH` keeps using `OVERSEER.packageDir`. Preserve the unmatched-identifier message and its non-zero exit, write nothing on failure, and fail non-zero for a Selector resolving to zero microservices, distinguishing the unmatched-identifier case from an existing-but-empty microservice root.
    - _Requirements: 8.1, 8.2, 8.3, 8.6, 8.7, 8.8, 15.10, 1.9, 1.10_

  - [x] 5.8 Write `packages/build-tools/tests/registry-generator.scope.property.test.ts`
    - **Property 14: Every emitted specifier carries the Configured_Scope**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 14.7**

  - [x] 5.9 Thread `packages/build-tools/src/repo-invariants.ts`
    - `collectViolations(context, discovery)`; the peer-microservice, Overseer and Spa_Package rules compare against `context.framework.overseer.name` and context-composed names; a specifier whose scope differs from the Configured_Scope is external and reports nothing; Workspace_Coverage evaluates the four Framework_Singleton directories plus every Consumer_Package discovered under the configured roots. `runRepoInvariantsCli()` goes through `requireProjectContext()`, which already discharges "perform no check when a Config_Diagnostic was reported". Every pre-existing violation message and tag keeps its text.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 5.10 Thread `packages/build-tools/src/workspace-build-order.ts`
    - `runOrderedBuildCli()` obtains its context through `requireProjectContext()` and passes it into the Build_Sequence derivation; no part of the order comes from the `workspaces` entry order.
    - _Requirements: 1.9, 1.10, 10.7, 10.8, 10.9, 15.4_

  - [x] 5.11 Add the context argument to every existing test that calls a threaded seam
    - Mechanical, `projectContext(defaultEffectiveConfig())` as the new first argument, claims unchanged: `build-plan.property.test.ts`, `build-sequence*.property.test.ts`, `build-sequence.test.ts`, `workspace-build-order.property.test.ts`, `required-dependencies.property.test.ts`, `image-tree.*.property.test.ts`, `image-tree-minimality.test.ts`, `dev-*.property.test.ts`, `registry-generator*.property.test.ts`, `repo-invariants.property.test.ts`, `workspace-coverage.property.test.ts`, `selector-semantics.property.test.ts`, `ordered-build.property.test.ts`, `build-order-*.property.test.ts`, `spa-build-sequencing.property.test.ts`, `check-repo-invariants.test.ts`, `build-workspaces-bin.test.ts`.
    - _Requirements: 13.1, 13.3, 15.3, 15.4_

- [x] 6. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Step 5 — Relocate the container-missing failure
  - [x] 7.1 Delete the `[discovery:container-missing]` throw from `packages/build-tools/src/discovery.ts`
    - The Config_Loader's `[config:root-missing]` (task 2.15) now fails the run before discovery is called, so an absent microservice root can no longer reach discovery. An absent common or spa root yields zero packages for that category with no error; an existing-but-empty microservice root is a discovery result of zero packages, not a configuration failure.
    - _Requirements: 5.1, 5.2, 6.14_

  - [x] 7.2 Retire `packages/build-tools/tests/discovery-container-missing.test.ts` and add `packages/build-tools/tests/config-loader.root-missing.test.ts`
    - The new test asserts the same handling under the new tag: the run fails, no Effective_Config is yielded, no discovery runs. This is the feature's one intentional message change.
    - _Requirements: 5.1, 1.10_

  - [x] 7.3 Rewrite the claim of `packages/build-tools/tests/discovery.containers.property.test.ts`
    - Uniform for all three categories: an absent root yields zero packages for that category, no error, and the remaining categories unaffected. Roots come from the generated context, not from `NAMESPACE_CONTAINER`.
    - _Requirements: 5.2, 6.14, 13.1_

- [x] 8. Step 6 — Delete the shims
  - [x] 8.1 Remove `WORKSPACE_SCOPE`, `NAMESPACE_CONTAINER`, `FRAMEWORK_SINGLETONS` and `frameworkSingletonByName` from `packages/build-tools/src/framework.ts`
    - The compiler enumerates every remaining reader; convert each to the context (`context.specifierPrefix`, `context.scopedName()`, `context.scopeDir`, `context.roots[...]`, `context.framework.*`, `context.frameworkByName()`). After this task no module under `packages/build-tools/src/` other than `project-config.ts` spells the Scope_Default or a Discovery_Root.
    - _Requirements: 1.8, 12.5, 12.7_

  - [x] 8.2 Drop the assertions about the deleted exports from `framework.test.ts` and `framework.property.test.ts`
    - Keep the four directory names, the staging classification and `assertFrameworkDirectoriesPresent`. The name-composition and exact-lookup claims already live in `project-context.property.test.ts` (task 2.14).
    - _Requirements: 3.7, 3.8, 1.8_

- [x] 9. Step 7 — The Tsconfig_Verifier, verified before it is wired
  - [x] 9.1 Create `packages/build-tools/src/tsconfig-verifier.ts`
    - `LoadBearingSetting`, `ResolvedTsconfig`, `TsconfigResolution` (resolved / absent / failed), `ResolveTsconfig`, `TsconfigViolation`, `verifyTsconfigs(context, discovery, resolveTsconfig)`, `renderTsconfigViolation`, and `resolveTsconfigWithCompiler` built on `ts.getParsedCommandLineOfConfigFile` over `ts.sys`. Add the `typescript` devDependency to `packages/build-tools/package.json` at a pinned version matching the root.
    - Verified list: `context.framework.all` plus `discovery.byCategory.microservice` plus `discovery.byCategory.common`; no Spa_Package and no Selector in the signature. `composite` and `declaration` judged as resolved `=== true`; `outDir`/`rootDir` compared as normalised absolute paths against `resolve(projectDirectory, packageDir, "dist")` and `"src")`. The `absent` and `failed` shapes each emit exactly one whole-package violation, with the per-setting loop living inside the `resolved` branch of a single `switch` so suppression is structural. Four fixed reason texts. Sorted by `packageDir` then setting name, whole-package shapes sorting first via an empty sort key. Returns violations, never throws.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.13, 9.15, 9.16, 1.11_

  - [x] 9.2 Create `packages/build-tools/tests/arbitraries/tsconfig.ts` and `packages/build-tools/tests/tsconfig-verifier.property.test.ts`
    - `resolvedTsconfig()` spans the assignment space plus the `absent` and `failed` resolution shapes.
    - **Property 15: The Tsconfig_Verifier accepts exactly the configurations satisfying the four settings**
    - **Validates: Requirements 9.1, 9.4, 9.5, 9.7, 9.10, 9.15, 14.8**

  - [x] 9.3 Write `packages/build-tools/tests/tsconfig-verifier-real-tree.test.ts`
    - Example-based: resolve this repository's Tsc_Project `tsconfig.json` files through `resolveTsconfigWithCompiler` once each and assert an empty violation list, so a value inherited through `extends` is shown to satisfy the check. **This test must pass before task 9.4 wires the verifier in.**
    - _Requirements: 9.2, 9.3, 9.14, 14.13, 15.9_

  - [x] 9.4 Wire the verifier into `collectViolations` and assert the gate position
    - Append `verifyTsconfigs(context, discovery, resolveTsconfigWithCompiler).map(renderTsconfigViolation)` to the violation list, leaving the other checks and their messages untouched and the root `ci` script unchanged. Extend `packages/integration-tests/tests/ci-wiring.test.ts` with the assertion that `check:invariants` runs after the repository build and before the typecheck, lint, test and type-assertion gates.
    - _Requirements: 9.11, 9.12, 9.14, 7.7, 7.8_

- [x] 10. Step 8 — `[scope:template]`, then `[scope:literal]`
  - [x] 10.1 Create `packages/build-tools/src/scope-checks.ts` with the Registry_Template check, wire it, and add `packages/build-tools/tests/scope-template.test.ts`
    - `ReadTemplate` and `checkRegistryTemplateScope(context, readTemplate)`, at most one violation ever. Parse-only `ts.createSourceFile`, collect every import and export module specifier, treat a specifier beginning with `@` as scoped, and report one `[scope:template]` violation for a mismatched scope, for no scoped specifier at all, or for an unreadable template. The module imports no write function from `node:fs`. Call it from `collectViolations` after the existing checks.
    - The test covers the three failure branches through the injected reader and one passing case over the committed template.
    - _Requirements: 8.9, 8.10, 7.7, 7.8_

  - [x] 10.2 Add the `[scope:literal]` check to `packages/build-tools/src/scope-checks.ts` and wire it
    - Parse-only walk of every TypeScript file under `packages/build-tools/src/`, collecting the cooked text of `StringLiteral`, `NoSubstitutionTemplateLiteral`, `TemplateHead`, `TemplateMiddle`, `TemplateTail`; a violation is a collected text containing `SCOPE_DEFAULT` as a substring, reported with the Project_Directory-relative path, the 1-based line number and the offending literal. Import `SCOPE_DEFAULT` from `project-config.ts` rather than spelling it. Exempt exactly `packages/build-tools/src/project-config.ts` by path. Scan nothing else — no `tests/`, no manifest, no Markdown, no template, no other package. Exit status derives from the collected list's length, never from the rendered report.
    - Landing after task 8 means the check arrives green; if it does not, its output is the list of readers task 8.1 missed.
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 7.7_

  - [x] 10.3 Create `packages/build-tools/tests/arbitraries/source.ts` and `packages/build-tools/tests/scope-literal.property.test.ts`
    - `buildToolsSource()` assembles labelled fragments: line comment, block comment, doc comment, string literal, template chunk, `\u0040` escape, template substitution — the expected verdict fixed by each fragment's label.
    - **Property 18: A scope literal is reported exactly when it is outside a comment**
    - **Validates: Requirements 12.4, 12.6, 12.7**

- [x] 11. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Step 9 — The Emit_Script reads the config in POSIX sh
  - [x] 12.1 Rewrite `scripts/emit-effective-dockerfile.sh`
    - One `awk` pass over the Project_Config_File extracting the three `roots` members — and no other value — as `"`-delimited single-line unescaped runs, validating each against the Valid_Root_Path set, and failing with a message naming the file and the `roots` member it could not read; read the three values back with shell builtins only, no `eval`. Absent file or no declared `roots` member means the three Root_Defaults. The script neither reads nor writes the Configured_Scope — the scope reaches the container build as a `WORKSPACE_SCOPE` build argument declared in `Dockerfile.template` (task 12.5). Derive the Exclusion_List as the first path segment of each configured root plus the by-name `integration-tests`. Emit the Manifest_Copy_Block at both anchors, including when it is empty, ordered root manifests, then non-excluded direct subdirectories of `packages`, then the microservice, common and spa root groups, each group by ascending byte comparison of directory name and locale-independent. `ENV` line emission and identifier uppercasing unchanged. Non-zero exit with no `Dockerfile` written for an unreadable value, for an absent microservice root under an all-microservices Selector, and for a Selector resolving to zero identifiers. Invoke no command the baseline does not, import no compiled module, require no install and no compile.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11_

  - [x] 12.2 Write `packages/integration-tests/tests/emit-dockerfile-config.test.ts`
    - Non-default configuration in a `pristineWorktree()` copy materialised once in `beforeAll`, skipped with the returned reason when unavailable, carrying its own `scaffold.config.json` inside that copy and passing the copy's directory as both Project_Directory and spawn `cwd`. **No `scaffold.config.json` is written into the checked-out repository.** The assertions cover the three configured `roots` only — the generated `Dockerfile` carries no scope value, so the suite asserts nothing about one. Cleanup removes the copy.
    - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6, 11.9, 11.11, 13.2, 13.5, 13.6, 13.10, 13.11_

  - [x] 12.3 Write `packages/integration-tests/tests/emit-dockerfile-failures.test.ts`
    - One case per rejected value shape, every case a `roots` member — value not `"`-delimited, spanning more than one line, carrying a `\` escape, outside the permitted character set, `roots` not an object — each asserting non-zero exit, the named message, and no `Dockerfile` written; plus the two Selector failure paths. No case supplies a rejected `scope` value, since the Emit_Script does not read one. Example-based, in a `pristineWorktree()` copy.
    - _Requirements: 11.7, 11.10, 14.12, 13.5, 13.10, 13.11_

  - [x] 12.4 Keep the default-configuration Dockerfile suites green against the recorded fixtures
    - `effective-dockerfile.test.ts`, `emit-dockerfile.property.test.ts` and `dockerfile.test.ts` keep their default-configuration cases and cite the `dockerfile.<selector>` recordings; the byte-level diff against them is the review artefact for this step.
    - _Requirements: 11.2, 11.8, 15.12_

  - [x] 12.5 Parameterize the workspace scope in `Dockerfile.template`
    - Declare `ARG WORKSPACE_SCOPE` with the Scope_Default (`@microservices`) as its default value, next to the existing `ARG MICROSERVICES=*` declaration; re-declare `ARG WORKSPACE_SCOPE` inside the prod-deps stage, which currently re-declares no argument, because an `ARG` declaration does not cross a stage boundary (the build stage already re-declares `MICROSERVICES`); change the workspace-symlink removal step from `RUN rm -rf node_modules/@microservices` to interpolate the argument.
    - The Emit_Script is untouched by this task and emits no `ARG WORKSPACE_SCOPE` line. The generated `Dockerfile` for a default-scope project stays byte-identical to the recorded `dockerfile.<selector>` fixtures, because the declared default value equals the literal it replaces.
    - **No guard, validation, or test for an empty or mismatched `WORKSPACE_SCOPE` is to be added.** That was considered and deliberately rejected: a wrong argument fails the container build inside the ephemeral prod-deps stage rather than producing a wrong image, so the failure is already loud and costs nothing to leave unguarded.
    - _Requirements: 11.12_

- [x] 13. Step 10 — Retire the Scope_Rename_Script and update steering
  - [x] 13.1 Delete `scripts/rename-scope.sh` and every reference to it
    - Remove it from any `package.json` `scripts` block, from every file under `.github/workflows/`, and from every tracked Markdown file.
    - _Requirements: 12.1, 12.2_

  - [x] 13.2 Write `packages/integration-tests/tests/scope-rename-retired.test.ts`
    - Assert no tracked file at `scripts/rename-scope.sh`, no other tracked script that rewrites the scope in place, and no occurrence of its name in a manifest `scripts` block, a workflow file, or a tracked Markdown file.
    - _Requirements: 12.1, 12.2_

  - [x] 13.3 Rewrite the affected parts of `.kiro/steering/tech.md` and `.kiro/steering/structure.md`, and update `stale-documentation-guard.test.ts`
    - `tech.md`: the Project_Config_File and its location, committed-source status, JSON shape and recognised keys; paths relative to the Project_Directory; the four defaults and the fact that a project with no config file is valid; load-once-and-thread; the four Load_Bearing_Settings, their reasons, and that an inherited value satisfies the check; `outDir`/`rootDir` staying in each package's own `tsconfig.json` and why; changing the scope being a `scope`-key edit; a rejected config failing the run before any discovery with one diagnostic per rejected value; and that a project whose Configured_Scope differs from the Scope_Default passes `--build-arg WORKSPACE_SCOPE=<scope>` to `docker build` alongside `--build-arg MICROSERVICES=<selector>`, the Emit_Script not carrying the Configured_Scope into the generated `Dockerfile`.
    - `structure.md`: category members as direct subdirectories of the configured root, the three Root_Defaults, the current layout presented as their result; relocating a root requires the same-change `workspaces` update and `check:invariants` reports the mismatch; a Consumer_Package's name is the Configured_Scope plus its directory name while the four Framework_Singleton directories stay fixed; the Emit_Script deriving its globs and Exclusion_List from the configured roots with a test-only top-level package still excluded by name, and the Configured_Scope not being among the values the Emit_Script reads.
    - Neither document mentions the Scope_Rename_Script or describes any out-of-scope behaviour (no published platform package, no registry inversion, no bootstrap-build removal, no tier split, no shipped presets, no wiring generator, no CI/release split).
    - _Requirements: 12.3, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.12_

- [x] 14. Step 11 — Decouple the general claims from the Payload_Tree
  - [x] 14.1 Create `packages/build-tools/tests/arbitraries/tree.ts`
    - `synthesizedTree()` (0–5 packages per category, manifests satisfying or violating their category contract, scoped specifiers drawn from the tree's own declared names, returned as `ListRoot` and `ReadManifest` plus a plain description), `acyclicTree()`, `relocatedAs(tree, roots)`, `rescopedAs(tree, scope)`, `importLayout()` with labelled positives. In-memory only — nothing is materialised on disk.
    - _Requirements: 13.1, 13.5, 13.6, 14.5, 14.6, 14.15, 14.16_

  - [x] 14.2 Write `packages/build-tools/tests/discovery.relocation.property.test.ts`
    - **Property 11: Discovery is invariant under relocating a Discovery_Root**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.10, 14.5**

  - [x] 14.3 Write `packages/build-tools/tests/discovery.scope-invariance.property.test.ts`
    - **Property 12: Discovery is invariant under a consistent scope rename**
    - **Validates: Requirements 6.6, 6.7, 6.8, 14.6**

  - [x] 14.4 Add the non-conforming-package property to `packages/build-tools/tests/discovery.validation.property.test.ts`
    - **Property 13: A non-conforming package fails the run by name** — seeded trees whose manifest declares no `name`, a non-mirroring `name`, unreadable or unparseable contents, or a category-contract violation; the run fails naming the package directory and the reason, and records no package, specifier or build kind for it. Placed in the existing discovery-validation property file, which already owns discovery's manifest-validation failures (the design's file table assigns no file to Property 13).
    - **Validates: Requirements 6.6, 6.12, 6.13**

  - [x] 14.5 Write `packages/build-tools/tests/workspace-order.permutation.property.test.ts`
    - **Property 16: Build order and Project_List are invariant under `workspaces` permutation**
    - **Validates: Requirements 10.1, 10.2, 10.4, 10.7, 10.8, 10.9, 14.15**

  - [x] 14.6 Write `packages/build-tools/tests/repo-invariants.relocation.property.test.ts`
    - **Property 17: Import-discipline violations are invariant under relocation and rename**
    - **Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6, 7.9, 14.16**

  - [x] 14.7 Retarget `discovery-real-tree.test.ts` and `workspace-build-order-real-tree.test.ts` to the loaded Effective_Config
    - Keep the six-row oracle and four negative assertions, and the ten-position table and two statement assertions, replacing every `NAMESPACE_CONTAINER.<category>` with `context.roots.<category>` and every `"@microservices/…"` constant with `context.scopedName(…)`. If the config cannot load, fail with a reported reason naming the load failure and substitute no path or scope literal.
    - _Requirements: 13.3, 13.4_

  - [x] 14.8 Write `packages/integration-tests/tests/non-default-configuration.test.ts`
    - End-to-end over a `pristineWorktree()` copy whose `scaffold.config.json` sets a scope other than the Scope_Default and all three roots away from their Root_Defaults, with the copy's directory passed as Project_Directory and as spawn `cwd`, materialised once in `beforeAll`, skipped with the returned reason when unavailable, removed on completion including on failure. **No config file and no package directory is created in the checked-out repository.**
    - _Requirements: 13.2, 13.5, 13.6, 13.10, 13.11_

  - [x] 14.9 Extend `packages/integration-tests/tests/worktree-safety-guard.test.ts` with the write-destination scan
    - Scan every test file's source and fail, naming the offending file and line, on a destructive git command (`git checkout -- <path>`, `git reset`, `git clean`, `git stash`, or any helper restoring a file through git under any name) or on a write whose destination is inside the checked-out repository and outside the three permitted locations (a gitignored `dist/`, a `*.tsbuildinfo`, the generated Microservice_Registry). A written `scaffold.config.json` inside the checked-out tree is a violation.
    - _Requirements: 13.6, 13.7, 13.8, 13.9_

- [x] 15. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **No task is optional.** Requirement 14 makes each correctness property a required deliverable, Requirement 13.9 makes the guard assertion a required check, and the eleven migration steps are a designed dependency chain — so nothing here carries the `*` marker.
- **Property coverage:** P1–P10 in task 2, P14 in 5.8, P15 in 9.2, P18 in 10.3, P11–P13 and P16–P17 in task 14. All eighteen are written.
- **Green after every task:** `npm run build`, `npm run check:invariants`, `npm run typecheck --workspaces`, `npm run lint --workspaces`, `npm test`, `npm run test:types`, plus the task 1 baseline comparison. Within task 5 the gate runs after each seam, not only at the end.
- **No `scaffold.config.json` is ever added to this repository.** Requirement 15.1's fresh-clone claim rests on this repository staying unconfigured. Any task needing a non-default configuration puts the file in a `pristineWorktree()` copy or a synthesized tree and passes that directory as both Project_Directory and spawn `cwd`.
- **Test-safety rules apply to every test task:** no destructive git command under any name; nothing written into the checked-out tree beyond a gitignored `dist/`, a `*.tsbuildinfo`, and the generated Microservice_Registry (captured before the first write and restored by writing the captured bytes back); every synthesized tree either in-memory inputs to a pure function or a directory inside an OS temporary directory, removed when its suite finishes including on failure.
- **`scripts/record-baseline.js` is not a test.** It is a one-shot developer script that writes committed fixtures under a human's hand, run once in task 1.2, and is not invoked by `npm test` or `npm run ci`.
- **The scope reaches the container build as a `WORKSPACE_SCOPE` build argument**, whose default value lives in `Dockerfile.template` (task 12.5), not through the Emit_Script. That argument and the Project_Config_File's `scope` are independent inputs whose agreement nothing verifies, and no task validates or tests a mismatched or empty argument — a wrong value fails the container build inside the ephemeral prod-deps stage.
- Requirement 15's remaining criteria are checked by the pipeline rather than by a recording: 15.1 and 15.2 are what `npm ci && npm run ci` on a fresh clone is; 15.6 runs in the existing mount-dispatch suite; 15.8 and 15.11 in the existing `start-parity`, `dev-start-parity` and `dev-warm-tree` suites; 15.9 is satisfied by touching no `tsconfig.json`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["2.2", "2.13", "2.14"] },
    { "id": 5, "tasks": ["2.3", "2.4", "2.6", "2.7", "2.8", "2.11", "2.12", "2.15"] },
    { "id": 6, "tasks": ["2.5", "2.9", "2.16"] },
    { "id": 7, "tasks": ["2.10", "2.17"] },
    { "id": 8, "tasks": ["4.1"] },
    { "id": 9, "tasks": ["4.2"] },
    { "id": 10, "tasks": ["4.3"] },
    { "id": 11, "tasks": ["5.1"] },
    { "id": 12, "tasks": ["5.2"] },
    { "id": 13, "tasks": ["5.3"] },
    { "id": 14, "tasks": ["5.4"] },
    { "id": 15, "tasks": ["5.5"] },
    { "id": 16, "tasks": ["5.6"] },
    { "id": 17, "tasks": ["5.7"] },
    { "id": 18, "tasks": ["5.8"] },
    { "id": 19, "tasks": ["5.9"] },
    { "id": 20, "tasks": ["5.10"] },
    { "id": 21, "tasks": ["5.11"] },
    { "id": 22, "tasks": ["7.1"] },
    { "id": 23, "tasks": ["7.2", "7.3"] },
    { "id": 24, "tasks": ["8.1"] },
    { "id": 25, "tasks": ["8.2"] },
    { "id": 26, "tasks": ["9.1"] },
    { "id": 27, "tasks": ["9.2", "9.3"] },
    { "id": 28, "tasks": ["9.4"] },
    { "id": 29, "tasks": ["10.1"] },
    { "id": 30, "tasks": ["10.2"] },
    { "id": 31, "tasks": ["10.3"] },
    { "id": 32, "tasks": ["12.1", "12.5"] },
    { "id": 33, "tasks": ["12.2", "12.3", "12.4"] },
    { "id": 34, "tasks": ["13.1"] },
    { "id": 35, "tasks": ["13.2", "13.3"] },
    { "id": 36, "tasks": ["14.1"] },
    { "id": 37, "tasks": ["14.2", "14.3", "14.4", "14.5", "14.6"] },
    { "id": 38, "tasks": ["14.7", "14.8", "14.9"] }
  ]
}
```

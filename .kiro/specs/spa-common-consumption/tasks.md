# Implementation Plan: spa-common-consumption

## Overview

The feature adds one dependency edge, one pure module, one page field, one Container
configuration, and two documentation passages. **No file under `packages/build-tools/src/` is
touched** — the ordering, resolution, staging, and invariant logic already handles the
`spa → common` edge, so the build-order work in this plan is *confirming* existing property
generators reach the newly reachable input shape, not writing new Build_System code.

Implementation language: TypeScript (the design is written in TypeScript throughout).

Ordering the tasks respect:

1. The `@microservices/extended-config` edge is declared in `packages/spa/demo/package.json`
   **first**, because nothing in the Demo_Spa can import the package before it is a declared
   dependency and a resolvable workspace symlink.
2. `packages/spa/demo/src/payload-preview.ts` exists **before** the Demo_Page markup and
   `main.ts` wiring tasks, so the wiring imports a real function rather than a stub.
3. The release-pipeline, root-script, and Dockerfile tasks come **after** the SPA and
   build-order tasks, so the third Container configuration is exercised against a bundle that
   already builds.

Every test task obeys the hard prohibition in `tech.md`: **no test mutates the checked-out
tree.** The one task that needs a mutated tree (deleting the Extended_Config_Package's `dist/`
to observe the resolution failure) re-roots everything at a `pristineWorktree()` copy from
`packages/integration-tests/tests/helpers.ts`, restores captured bytes with `writeFileSync`
rather than through git, and tears the copy down with `cleanup()`.

## Tasks

- [x] 1. Declare the Demo_Spa's Common_Package dependency
  - [x] 1.1 Add `@microservices/extended-config` to `packages/spa/demo/package.json` and rewrite the stale `//exports` comment
    - Add a `dependencies` object holding exactly `"@microservices/extended-config": "*"`. It
      must be `dependencies`, not `devDependencies`: `scopedDependencySpecifiers` in
      `packages/build-tools/src/discovery.ts` reads the `dependencies` object alone, so a
      `devDependencies` entry would be invisible to the Dependency_Resolver.
    - Keep it the manifest's only `@microservices`-scoped key in any dependency object; the
      Config_Package is reached only transitively, through the Extended_Config_Package's own
      `dependencies`.
    - Replace the `//exports` comment's final sentence ("No `@microservices`-scoped dependency
      is declared at all, which keeps the Demo_Spa a true sink.") with the statement from the
      design: one `@microservices`-scoped dependency IS declared, and it changes nothing else
      about the manifest shape.
    - Leave `scripts.build`, the `exports` map `{ ".": "./dist/index.html" }`, and the absence
      of `main`/`types` exactly as they are. Add no `references` array to
      `packages/spa/demo/tsconfig.json` — the package is not `composite` and is a root of no
      `tsc --build`.
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 7.5_

  - [x] 1.2 Invert the "true sink" case in `packages/integration-tests/tests/spa-package-conventions.test.ts`
    - Rewrite the case asserting the Demo_Spa "declares no @microservices-scoped dependency of
      any kind — a true sink": the scoped-key set across all four dependency objects is now
      exactly `["@microservices/extended-config"]`, with value `*`, present in `dependencies`
      alone.
    - Add a case asserting the `//exports` comment states the dependency and matches none of
      R1.7's forbidden phrases.
    - Rewrite the header comment's "true sink" paragraph. Leave every other case untouched —
      location, name mirroring, `scripts.build`, the four scripts, no `main`/`types`, the
      `exports` map, the pinned bundler, the Node floor, no `test` block, one `workspaces`
      match. Their continuing to pass is the assertion that nothing else moved.
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 7.5_

  - [x] 1.3 Update the Demo_Spa's expected specifiers in `packages/build-tools/tests/discovery-real-tree.test.ts`
    - Change the Demo_Spa's expected `dependencySpecifiers` from `[]` to
      `["@microservices/extended-config"]`, in both the expected-rows table and the
      spa-category case.
    - Update the header table's `[]` cell and both "a true sink" comments.
    - _Requirements: 1.1_

- [x] 2. Implement the Payload_Preview
  - [x] 2.1 Create `packages/spa/demo/src/payload-preview.ts`
    - Import `buildExtendedConfigPayload` from `@microservices/extended-config` by package name
      only — no relative specifier leaving `packages/spa/demo/`, no path segment below the
      package name, no dynamic `import()`.
    - Export exactly one function, `expectedPayloadText(name: string, path: string): string`,
      returning `JSON.stringify(buildExtendedConfigPayload(name, path), null, 2)`. Keep the
      indent width a module-private constant so the export list stays at one function.
    - Take the name and the path as arguments, not literals: that is what Properties 3 and 4
      quantify over, and it keeps every Microservice3-specific literal in `main.ts`.
    - Restate none of the Extended_Config_Package's values as a literal, read no `document`,
      `window`, `fetch`, `AbortController`, `setTimeout`, clock, or random source, and perform
      no network, filesystem, or console access at module evaluation or at call time.
    - _Requirements: 1.3, 2.9, 3.1, 3.2, 3.3_

  - [x] 2.2 Write unit tests in `packages/spa/demo/tests/payload-preview.test.ts`
    - Export surface: exactly one export, a function of arity 2.
    - The concrete Expected_Payload_Text for `"microservice3"` / `"/microservice3"`, computed in
      the test from `buildExtendedConfigPayload` — never restated as a literal.
    - No leading whitespace, no trailing whitespace, no trailing newline.
    - The `extendedSetting` value appears as a substring of the returned text.
    - Static half of purity: the module source references none of the forbidden globals and
      contains no `fetch`.
    - Runs in the Vitest default `node` environment with no DOM implementation present.
    - _Requirements: 3.1, 3.2, 3.7, 3.9_

  - [x] 2.3 Write the round-trip property test in `packages/spa/demo/tests/payload-preview.property.test.ts`
    - **Property 3: The Expected_Payload_Text round-trips through JSON**
    - **Validates: Requirements 3.8, 3.5, 3.2, 3.1**
    - `fast-check`, at least 100 iterations, tagged
      `Feature: spa-common-consumption, Property 3: …`.
    - Generators: `fc.fullUnicodeString({ maxLength: 2048 })` for both arguments, plus explicit
      constants `""`, `'"'`, `"\\"`, `"\u0000"`, an astral surrogate pair, a 2,048-character
      string, and the two Microservice3 literals, so the concrete criterion R3.5 reproduces
      with no seed.
    - Assert the return is a string of 1 or more characters, no error is thrown, and
      `JSON.parse` of it deep-equals `buildExtendedConfigPayload(name, path)`.

  - [x] 2.4 Write the metamorphic property test in the same property file
    - **Property 4: The Expected_Payload_Text equals what the Result_Formatter would render**
    - **Validates: Requirements 3.10, 3.6**
    - For every generated name/path pair, assert `expectedPayloadText(name, path)` equals,
      character for character, `formatBody(JSON.stringify(buildExtendedConfigPayload(name,
      path)))` — `formatBody` imported from `packages/spa/demo/src/result-formatter.ts`.
    - Issue no HTTP request and start no Microservice3 process; the relation is checked by
      calling two functions neither of which is written in terms of the other.
    - Include the `"microservice3"` / `"/microservice3"` pair explicitly so R3.6 reproduces
      without a seed.

  - [x] 2.5 Add the purity and determinism properties to the same property file
    - **Property 1: The Payload_Preview is pure**
    - **Validates: Requirements 3.3, 3.1**
    - **Property 2: The Payload_Preview is deterministic**
    - **Validates: Requirements 3.4**
    - Property 1: for any name/path, calling the function in the `node` environment with no DOM,
      no browser global, and no network returns a string and throws no error; assert no network,
      filesystem, or console access occurs (spy on `console`, assert `globalThis.fetch` is never
      invoked).
    - Property 2: for a generated repeat count from 2 upward, every call with equal arguments
      returns a string character-identical to the first.

- [x] 3. Checkpoint - the Demo_Spa's own suite is green
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Render and wire the Expected_Payload_Field
  - [x] 4.1 Add the Expected_Payload_Heading and Expected_Payload_Field to `packages/spa/demo/index.html`
    - Append after the Body_Field — the last field in the document today — so the new field
      follows both Service_Buttons, the Request_Field, the Status_Field, and the Body_Field, and
      none of them follows it.
    - `<p><label for="expected-microservice3">microservice 3 should yield:</label></p>` followed
      by `<textarea id="expected-microservice3" rows="16" cols="72" readonly></textarea>`. The
      heading is a `label` with `for`, not an `h2`, mirroring the Body_Field's existing
      `<p><label for="body">` treatment.
    - `readonly`, never `disabled`, so the field stays focusable, keyboard reachable,
      scrollable, and selectable — and so a keystroke or paste cannot change its value.
    - Ships empty; `main.ts` fills it. Declare no `aria-live`, here or anywhere in the document.
    - Leave the two Service_Buttons and the three existing fields at their positions with their
      existing `id` attributes.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.12, 2.13, 2.15_

  - [x] 4.2 Wire `fillExpectedPayload()` in `packages/spa/demo/src/main.ts`
    - Import `expectedPayloadText` from `./payload-preview.js`; add the two literals
      `MICROSERVICE3_NAME = "microservice3"` and `MICROSERVICE3_PATH = "/microservice3"` beside
      the existing `ENDPOINTS` map.
    - Add `fillExpectedPayload()` with its **own** `document.getElementById` lookup and its
      **own** `instanceof HTMLTextAreaElement` guard, deliberately kept out of `wireDemoPage`'s
      combined guard: an absent field must leave both Service_Buttons wired and behaving exactly
      as they do when it is present, with no uncaught error.
    - Call `fillExpectedPayload()` as a top-level synchronous statement, separate from and before
      `wireDemoPage()`. No `setTimeout`, no `await`, no listener — the module is loaded with
      `<script type="module">`, so it runs after parsing and well inside the 1-second bound.
    - Write the field exactly once, in that one statement. Add no `input`, `keydown`, or `paste`
      listener, and change nothing in `handleActivation`, `ENDPOINTS`, `setButtonsDisabled`, or
      `describeTransportFailure` — having no second writer is what makes the field's value
      invariant across activations, settlements, and keystrokes.
    - _Requirements: 2.8, 2.9, 2.10, 2.11, 2.14, 2.15_

  - [x] 4.3 Extend `packages/spa/demo/tests/demo-page.test.ts` for the second `textarea`
    - The document now holds **two** `textarea` elements: rewrite every assertion selecting
      `textareas[0]` to select by `id` instead.
    - Markup cases: the new field is `readonly` and not `disabled`; its document offset exceeds
      every button's and every existing field's; its `label` carries a matching `for`, precedes
      it, and holds exactly `microservice 3 should yield:`; its `id` appears exactly once in the
      document.
    - Wiring cases (source-text assertions over `main.ts`, no DOM): exactly one assignment of
      `expectedPayloadText(...)` to that field's `.value`; the call is a top-level synchronous
      statement; the field's id appears nowhere inside `wireDemoPage`'s guard;
      `fillExpectedPayload()` is a statement separate from `wireDemoPage()`; no
      `input`/`keydown`/`paste` listener is attached; `payload-preview.ts` restates none of the
      payload's literal values and contains no `fetch`.
    - Keep the existing no-`aria-live` assertion unchanged — it now also covers the new field.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.10, 2.11, 2.12, 2.13, 2.14, 2.15_

- [x] 5. Confirm the build order, the BUILD/STAGE split, and the invariants
  - [x] 5.1 Extend `packages/integration-tests/tests/shared-package-staging.test.ts` with the required-versus-staged cases
    - Add a **Required** column to the header's staged-set table, since the two sets are no
      longer equal for `microservice1`, and add a comment stating that Group 1's staged
      expectations are unchanged **on purpose** rather than by oversight.
    - Group 4: for Selector `microservice1`, assert `requiredDependencies` dirNames are
      `["config", "extended-config", "demo"]` with `config` at a lower index than
      `extended-config` and `extended-config` lower than `demo`, while `stagedDependencies` is
      `["demo"]`.
    - Add a table-driven pass over every Selector row of the design's table asserting the staged
      dirName list per row, derived from `buildPlan` with no assembly.
    - Derives everything from `buildPlan` / `discoverPackages`; writes nothing to the tree.
    - _Requirements: 4.1, 4.2, 5.3, 5.8, 5.9_

  - [x] 5.2 Confirm the ordering and resolution property generators reach the `spa → common` shape
    - **Property 5: A Spa_Package's Common_Packages are reached and ordered ahead of it**
    - **Validates: Requirements 4.1, 4.2**
    - **Property 6: The Tsc_Build_Pass roots are exactly the Tsc_Project half of the BUILD set**
    - **Validates: Requirements 4.3, 4.4**
    - **Property 7: The Bundler_Build_Phase members are exactly the Bundler_Project half of the BUILD set**
    - **Validates: Requirements 4.5, 4.12**
    - **Property 8: Every Common_Package precedes every Spa_Package in every produced order**
    - **Validates: Requirements 4.6**
    - **Property 9: No package is bundled, and nothing is copied, until every compile has succeeded**
    - **Validates: Requirements 4.7, 4.8, 4.13, 5.10, 5.2**
    - **Property 11: An unresolvable dependency specifier fails the resolve before any build**
    - **Validates: Requirements 4.11**
    - **Property 12: The Verification_Pass accepts every order the Build_Sequence produces**
    - **Validates: Requirements 4.10**
    - In `packages/build-tools/tests/required-dependencies.property.test.ts`, confirm the
      generator produces a `microservice → spa → common → common` chain and a Spa_Package
      declaring a dangling specifier; add those shapes where absent.
    - In `build-plan.property.test.ts`, confirm `arbRequiredSpaCase` covers a Spa_Package that IS
      a Required_Dependency with Common_Package dependencies of its own.
    - In `build-sequence-spa-phase.property.test.ts`, confirm memberships where a statement-7
      member declares a statement-3 member are produced.
    - In `spa-build-sequencing.property.test.ts`, confirm the recorded invocation sequence is
      asserted over plans whose SPA has Common_Package dependencies, with both failure
      injections (the `tsc` pass and the chosen SPA) covered.
    - In `build-sequence-verification.property.test.ts`, confirm layouts carrying a `spa → common`
      edge produce neither a `[build-order:prerequisite]` nor a `[build-order:divergence]`
      finding.
    - Extend generators only; change no file under `packages/build-tools/src/`.

  - [x] 5.3 Confirm the staging, integrity, and invariant property generators
    - **Property 10: The STAGE set omits exactly what only a Spa_Package reaches**
    - **Validates: Requirements 5.3, 5.8, 5.9, 5.11**
    - **Property 13: The Integrity_Assertion names every entry the plan does not justify and every one it does**
    - **Validates: Requirements 5.5, 5.12**
    - **Property 14: Import discipline holds in both directions across the Tsc/Bundler boundary**
    - **Validates: Requirements 7.2, 7.3**
    - **Property 15: A Common_Package may not depend on a Spa_Package**
    - **Validates: Requirements 7.4**
    - **Property 16: Every invariant finding of a run is reported in that run**
    - **Validates: Requirements 7.8**
    - In `image-tree.staging.property.test.ts`, confirm the strict-subset
      `microservice → spa → common` shape drives the staged-set assertions across selectors.
    - In `image-tree.integrity.property.test.ts`, confirm an unstaged-but-present entry registers
      as `[image-tree:unjustified]` and a staged-but-absent one as `[image-tree:missing]`.
    - In `repo-invariants.property.test.ts`, confirm a `bundler-project` owner importing a
      Common_Package yields no message, all three specifier forms naming a Spa_Package from a
      `tsc-project` owner yield `[imports:spa]`, and a defect set spanning 1 to 4 invariants
      reports every finding in one run.
    - Extend generators only; change no rule in `repo-invariants.ts` or
      `required-dependencies.ts`.

  - [x] 5.4 Create `packages/integration-tests/tests/spa-common-consumption.test.ts`
    - Case (a) — the prerequisite-absent failure. Materialise **one** `pristineWorktree()` copy
      in `beforeAll` and `it.skip(reason)` when `available === false`. Inside the copy: build the
      Extended_Config_Package, capture the Demo_Spa's `dist/index.html` bytes by reading them
      from the copy, delete `packages/common/extended-config/dist` **in the copy**, then run the
      Demo_Spa's `typecheck` and `build` with the copy as cwd. Assert both exit non-zero with a
      message naming `@microservices/extended-config`. Assert the captured bytes are unchanged
      after the `typecheck` run **only** (R1.11); do **not** assert the product is untouched after
      the `build` run — R1.12 requires only a proper failure there. Restore by `writeFileSync` of
      the captured bytes if a later example needs them; never through git. Tear down with
      `cleanup()`.
    - Case (b) — the invariants stay silent for the new edge. Spawn the compiled
      `packages/build-tools/dist/bin/check-repo-invariants.js` with the real repo root as cwd;
      assert exit 0 and that no output names `packages/spa/demo` — in particular no
      `[deps:direction]`, `[imports:peer]`, or `[imports:spa]`. Reads the real tree and writes
      nothing to it.
    - No `git checkout -- <path>`, `git reset`, `git clean`, or `git stash` anywhere in the file.
    - _Requirements: 1.11, 1.12, 7.1, 7.2_

  - [x] 5.5 Add the inlining assertions to `packages/integration-tests/tests/spa-bundle-output.test.ts`
    - Over the `dist/` the suite already builds: at least one emitted file contains the value of
      `extendedConfig.extendedSetting` as a substring — the value imported from the package, not
      restated in the test.
    - No emitted file carries a `from "@microservices/…"` or `import("@microservices/…")`
      specifier naming either Common_Package, so nothing in the bundle needs resolving at run
      time.
    - Note in the header that the Demo_Spa's build now has a compile-order prerequisite,
      satisfied by the root `pretest` ordered build.
    - _Requirements: 5.6, 5.11_

- [x] 6. Checkpoint - the edge builds, orders, stages, and inlines
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Ship the Spa_Only_Container
  - [x] 7.1 Add the third leg and the third prune step to `.github/workflows/release.yml`
    - Append the matrix leg `- variant: spa-only` / `selector: "microservice1"` /
      `image_suffix: microservice1`. Everything else the leg inherits from the matrix job as it
      stands: the same platform set, the same tag rules, the same
      `push: ${{ github.event_name != 'pull_request' }}` gate, the `MICROSERVICES` env for the
      Generate Dockerfile step, and the `MICROSERVICES` build-arg for the image build.
    - Leave `fail-fast: false` and the `permissions` block untouched.
    - Append one `cleanup` step mirroring the two present:
      `package: ${{ github.event.repository.name }}-microservice1` with `keep-n-untagged: 10`.
    - Update the workflow header comment: "both shipped Container configurations
      (Generic + Specific)" and "two image names" become three.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.13, 6.14, 6.15_

  - [x] 7.2 Add `docker:build:microservice1` to the root `package.json` and chain it into `docker:build`
    - `"docker:build:microservice1": "MICROSERVICES=microservice1 sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES=microservice1 -t scaffold:microservice1 ."` —
      the existing two scripts' shape verbatim: emit first, `&&`, then the image build, so the
      build runs only when emit exited 0.
    - `"docker:build"` chains all three per-configuration scripts with `&&`, appending the new
      one last so the existing two keep their positions.
    - Change nothing in `Dockerfile.template` and nothing in the Exclusion_List of
      `scripts/emit-effective-dockerfile.sh`; the four discovery globs already reach
      `packages/spa/*/package.json`, and the `toupper` loop already yields exactly one
      `ENV MICROSERVICE_MICROSERVICE1_ENABLED=enabled` line for this selector.
    - _Requirements: 6.9, 6.10, 6.11, 6.12, 7.9_

  - [x] 7.3 Update `packages/integration-tests/tests/release-workflow.test.ts` to three configurations
    - Change the task-12.6 clause: `toHaveLength(2)` becomes `toHaveLength(3)`, and the selector
      set becomes exactly `{"*", "microservice1,microservice2", "microservice1"}`.
    - Assert three pairwise-distinct suffixes, each matching the existing derivation rule, and
      that the leg whose selector is `microservice1` carries the suffix `microservice1`.
    - New cases: the `cleanup` job declares `needs: build-and-publish` and holds a step whose
      `package` is `<repo>-microservice1` with `keep-n-untagged: 10`; `strategy.fail-fast` is
      `false`; the Generate Dockerfile step's `env.MICROSERVICES` and the build step's
      `build-args` both reference `matrix.selector`; no leg sets `continue-on-error: true`.
    - Leave the permissions and tag-rule cases unchanged.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.13, 6.14, 6.15_

  - [x] 7.4 Add the root-script cases to `packages/integration-tests/tests/ci-wiring.test.ts`
    - `docker:build:microservice1` sets `MICROSERVICES=microservice1`, invokes
      `scripts/emit-effective-dockerfile.sh`, joins with `&&`, passes
      `--build-arg MICROSERVICES=microservice1`, and tags `scaffold:microservice1`.
    - `docker:build` names all three `docker:build:*` scripts joined by `&&`.
    - `checkBuildOrderSource` over the real Root_Manifest returns an empty finding list, so no
      new or changed script derives a build order from the `workspaces` array.
    - _Requirements: 6.9, 6.10, 7.9_

  - [x] 7.5 Add the single-identifier example to `packages/integration-tests/tests/effective-dockerfile.test.ts`
    - Run the real emit script with `MICROSERVICES=microservice1` and `EFFECTIVE_DOCKERFILE`
      pointed at an OS temp path — never the real `Dockerfile`, which the test must not write.
    - Assert the generated output holds exactly one `ENV MICROSERVICE_*_ENABLED=` line and that
      it is `MICROSERVICE_MICROSERVICE1_ENABLED`.
    - _Requirements: 6.11_

  - [x] 7.6 Create `packages/integration-tests/tests/spa-only-container.test.ts`
    - One assembly for Selector `microservice1` in `beforeAll` with a generous timeout (a real
      `tsc --build` plus a real `vite build`), reused across cases; stage into an OS temp
      `outDir`, never into the checked-out tree.
    - Assert the five Tsc_Build_Pass roots — `contracts`, `config`, `extended-config`,
      `microservice1`, `overseer` — appear in Build_Sequence order, no other
      Microservice_Package is among them, and each root's `dist/` is non-empty afterwards.
    - Drive `executeBuildPlan` with a recording `CommandRunner`: exactly one `npm run build`
      with cwd `packages/spa/demo`, ordered after the `npx tsc --build` invocation and before
      the first copy into the Image_Tree.
    - Assert the scope directory holds exactly `contracts`, `demo`, `microservice1` as real
      non-symlink directories, `packages/overseer` is present, and `packages/microservices` is
      absent; the assembly completing without throwing is the Integrity_Assertion's own result.
    - Mount an in-process Overseer with `microservice1` and assert `GET /` answers 200 with a
      body byte-identical to the `dist/index.html` the Demo_Spa's build wrote.
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.7_

- [x] 8. Document the pattern and the third configuration
  - [x] 8.1 Update `README.md`
    - In "The `spa` category and `packages/spa/demo`": a Spa_Package may declare a
      Common_Package as a key of the `dependencies` object of its own `package.json` and import
      it through `@microservices/<name>` — never by a relative path into that package's `src/`
      or `dist/` — with the Demo_Spa's dependency on `@microservices/extended-config` as the
      worked example. Record that this needs no change to `Dockerfile.template`, none to the
      Exclusion_List, and none to the Build_System.
    - Add a short subsection stating both halves of the BUILD/STAGE distinction for a
      Common_Package reachable only through a Spa_Package: a Required_Dependency, compiled
      before the Bundler_Build_Phase begins, inlined into the bundle; not a Staged_Dependency,
      and therefore absent from the Image_Tree.
    - In "Building a container image": add the third command pair and the third bullet —
      **Spa-only (`microservice1`)**, image-name suffix `microservice1`, staging the `spa`
      package `demo` and neither Common_Package, with one sentence saying why. The list must
      read as exactly three shipped configurations, each with its published suffix; the existing
      two bullets keep their wording.
    - Note in the `packages/spa/*` row of the project-structure table that `demo` consumes
      `@microservices/extended-config`.
    - Retain no statement that a Spa_Package declares no `@microservices`-scoped dependency,
      that the Demo_Spa is a dependency sink, or that the shipped configurations number other
      than three.
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6_

  - [x] 8.2 Update `.kiro/steering/structure.md`
    - Extend the spa category's "Dependency direction" bullet: a Spa_Package MAY declare a
      Common_Package dependency by the package name `@microservices/<name>` while keeping the
      leaf discipline already required of it (no dependency on a Microservice_Package and none
      on the Overseer), and name the Demo_Spa's dependency on the Extended_Config_Package as the
      worked example.
    - Retain none of the three forbidden statements listed in 8.1.
    - _Requirements: 8.4, 8.5_

  - [x] 8.3 Create `packages/integration-tests/tests/stale-documentation-guard.test.ts`
    - A short literal deny-list over `README.md` and `.kiro/steering/structure.md`: "true sink",
      "dependency sink", "declares no @microservices-scoped dependency", "both shipped Container
      configurations", "two shipped Container configurations".
    - Deliberately negative only — it forbids five phrases and pins no wording, so a legitimate
      rewrite does not break it. Reads both files; writes nothing.
    - _Requirements: 8.5_

- [x] 9. Final verification - run the full quality gate
  - Run `npm run ci` from the repo root: the ordered build, `check:invariants`, the per-package
    typecheck, the per-package lint, the test suite, and the type-level assertions, each
    exiting 0.
  - Confirm `git status` is clean apart from the intended change set — no test left a stray
    package, directory, symlink, or edited source behind.
  - Confirm `Dockerfile.template` and every file under `packages/build-tools/src/` are unchanged
    by this feature.
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.8, 1.9, 1.10, 3.7, 6.12, 7.1, 7.6, 7.7, 7.8, 7.9, 7.10_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP.
- No file under `packages/build-tools/src/` is edited by any task. Tasks 5.2 and 5.3 extend
  *generators* in existing property suites so the newly reachable `spa → common` input shape is
  actually exercised; they change no rule and add no parallel suite.
- No test mutates the checked-out tree. Task 5.4 is the only one needing a mutated tree and uses
  `pristineWorktree()` for it. The two sanctioned in-place exceptions stay available: a package's
  gitignored `dist/` and `*.tsbuildinfo`, and the generated microservice registry.
- The Demo_Spa's suite stays in the Vitest default `node` environment: `vite.config.ts` declares
  no `test` block, and no Demo_Spa test references `document` or `window`.
- Criteria covered by the gate rather than a dedicated test (per the design's Testing Strategy):
  R1.8, R1.9 via `typecheck`/`lint --workspaces`; R1.10 via `spa-bundle-output.test.ts`; R3.7 and
  R7.7 via the `node`-environment suite passing; R7.6 via `npm run ci` itself; R6.12 and R7.10 as
  no-change claims verified by the change set; R8.1–R8.4 and R8.6 as review criteria, with R8.5
  guarded by the deny-list in task 8.3.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "4.1"] },
    { "id": 4, "tasks": ["2.5", "4.2"] },
    { "id": 5, "tasks": ["4.3", "5.1", "5.2", "5.3", "5.4", "5.5"] },
    { "id": 6, "tasks": ["7.1", "7.2"] },
    { "id": 7, "tasks": ["7.3", "7.4", "7.5", "7.6"] },
    { "id": 8, "tasks": ["8.1", "8.2"] },
    { "id": 9, "tasks": ["8.3"] }
  ]
}
```

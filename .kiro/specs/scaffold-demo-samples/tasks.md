# Implementation Plan: scaffold-demo-samples

## Overview

This plan turns [requirements.md](./requirements.md) and [design.md](./design.md) into an ordered series of coding tasks. It adds two demonstration samples, adopts one architectural principle, and corrects one test-scope defect — none of which adds framework capability, and none of which changes a line under `packages/build-tools/src/`.

| Step | Parent task | Character |
| --- | --- | --- |
| 1 | Task 1 | **Additive groundwork** — the root Node floor, the browser-globals lint block, one new shared arbitrary |
| 2 | Task 2 | **Additive** — the Extended_Config_Package; nothing consumes it yet |
| 3 | Task 4 | **Behaviour change** — Microservice3 switches to the extended payload; both peers adopt Subtree_Ownership |
| 4 | Task 6 | **Precondition** — the framework/sample test boundary correction, landed *before* Microservice1 changes so it passes on the tree as it stands |
| 5 | Task 8 | **Additive** — the Demo_Spa, the first Spa_Package |
| 6 | Task 10 | **Highest-risk** — Microservice1 serves the Demo_Spa at its Mount_Root `/` |
| 7 | Task 12 | **Additive** — staging, startup, and script-wiring integration coverage |
| 8 | Task 14 | **Documentation** — README and steering, last, so they describe what the repo does |

**The order is chosen so the tree builds at the end of every top-level task**, and each dependency lands before its consumer: `@microservices/config` (already shipped) before `@microservices/extended-config`, `extended-config` before Microservice3, the Demo_Spa before Microservice1 serves it.

**Step 4 is placed before step 6 deliberately, and that is the one ordering decision worth stating.** Requirement 13's corrections — the mount-dispatch rewrite of `endpoint-contract.test.ts`, the six liveness probes reduced to the Mount_Root `status !== 404` rule, and the two retargeted mutation anchors — all pass against Microservice1's *current* identifier response as well as against the Demo_Page. Landing them first therefore keeps every step green, where landing them with step 6 would mean one step in which the Integration_Suite is red.

**Each package task carries its own repository-mirror updates.** `packages/build-tools/tests/discovery-real-tree.test.ts` and `workspace-build-order-real-tree.test.ts` enumerate the committed tree exactly, so they are invalidated the moment a package is added or a dependency edge declared (F10, D2). Every task that changes the tree updates those two oracles in the same task, which is what keeps the tree green step by step. These are data-and-prose edits to *test* files; no file under `packages/build-tools/src/` is touched by any task in this plan.

**The verification gate at the end of every step** (the checkpoint tasks below) is:

1. `npm run ci`
2. `MICROSERVICES='*' sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES='*' .`
3. `MICROSERVICES='microservice1,microservice2' sh scripts/emit-effective-dockerfile.sh && docker build --build-arg MICROSERVICES='microservice1,microservice2' .`

From step 5 onward the gate additionally includes `npm start` and a short `npm run dev` session, because those are the two paths on which the Spa_Root's presence and absence become observable.

Every property test carries the tag comment `// Feature: scaffold-demo-samples, Property {number}: {property_text}` and runs at `numRuns: 100` or more, matching the repository's existing suites. Each of the design's twenty-six correctness properties is implemented by exactly one property test, attributed below by a `_Properties:_` line.

## Tasks

- [x] 1. Step 1 — Additive groundwork

  - [x] 1.1 Raise the root Node floor and confirm the `workspaces` globs already cover both new packages
    - In the root `package.json`, replace `engines.node` `">=22"` with `">=22.12.0"`, so the declared floor agrees with the `engines.node` range the pinned bundler declares (`^20.19.0 || >=22.12.0`) and `npm ci` reports no engine mismatch for any Node version the repository claims to support
    - Change nothing else in the root manifest. **Confirm, and record in the commit, that no `workspaces` entry is added, removed, renamed, or reordered:** the array already declares the globs `packages/common/*` and `packages/spa/*`, in topological position ahead of `packages/microservices/*` and `packages/overseer`, so `packages/common/extended-config` and `packages/spa/demo` are each matched by exactly one existing entry with no manifest edit (F1, F2)
    - Verify by inspection that npm's own array traversal — the path `scripts/start.js` takes — expands `packages/common/*` to `config`, `extended-config` and places `packages/spa/*` before `packages/microservices/*`, so `config` precedes `extended-config` and `demo` precedes `microservice1` on that path too
    - _Requirements: 4.1, 6.17, 11.16_

  - [x] 1.2 Add the browser-globals ESLint block, scoped to the `spa` category
    - In `eslint.config.js`, add one `files`-scoped block granting `...globals.browser`, matching `packages/spa/*/src/**/*.ts` and `packages/spa/*/*.config.ts`
    - Place it before the trailing `prettier` entry so Prettier still wins on formatting, and scope it by `packages/spa/*/…` rather than `packages/spa/demo/…` so a second SPA needs no further edit
    - Add the comment recording that the Demo_Spa is the only package whose code runs in a browser and that every package outside `packages/spa/` keeps the global set it has today
    - _Requirements: 11.2_

  - [x] 1.3 Add an all-methods HTTP arbitrary to the shared test-support module
    - In `packages/contracts/testing/arbitraries.ts`, add `arbHttpMethod` covering **every** method including GET and HEAD, alongside the existing `arbHttpMethodNonGet`, and re-export it from `packages/contracts/testing/index.ts`
    - Record in its doc comment why both exist: a 405 method-policy property quantifies over the non-GET subset (and `arbHttpMethodNonGet` already documents why HEAD is excluded — Express routes HEAD through the registered GET handler), while a method-agnostic 404 property and a router-totality property must cover the methods a router *does* serve as well
    - This is the generator the Subtree_Ownership properties need; nothing else changes in `packages/contracts/`
    - _Requirements: 3.10, 3.11, 3.12, 7.12_

- [x] 2. Step 2 — The Extended_Config_Package (additive)

  - [x] 2.1 Create the `packages/common/extended-config/` skeleton
    - `package.json`: name `@microservices/extended-config` mirroring the directory exactly, `"type": "module"`, `"private": true`, `main` `./dist/index.js`, `types` `./dist/index.d.ts`, the four scripts `build`/`test`/`lint`/`typecheck` plus `test:types`, and exactly one dependency — `@microservices/config`
    - Declare **no** `@microservices/contracts` dependency: every type the package needs arrives through the Config_Package's barrel, which already anchors `ConfigPayload["path"]` to `MicroserviceModule["path"]`, and declaring an unused Framework_Singleton would be noise
    - `tsconfig.json` extending `../../../tsconfig.base.json` with `outDir: ./dist`, `rootDir: ./src`, `include: ["src/**/*"]`, mirroring `packages/common/config/tsconfig.json` in shape
    - `tsconfig.test.json` mirroring config's, so `vitest --typecheck` gets a program that actually contains `tests/`
    - Run `npm install` and confirm the glob `packages/common/*` picks the package up with no root-manifest edit, and that `dist/` and `tsconfig.tsbuildinfo` stay untracked
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 1.8, 4.7, 11.15_

  - [x] 2.2 Implement the barrel at `src/index.ts`
    - Import `buildConfigPayload`, `sampleConfig`, `ConfigPayload`, and `SampleConfig` from `@microservices/config` **by package name only** — no relative path, no reach into the Config_Package's `src/` or `dist/`
    - Export `interface ExtendedConfig extends SampleConfig` adding `readonly extendedSetting: string`, and `interface ExtendedConfigPayload extends Omit<ConfigPayload, "config">` re-declaring `config: ExtendedConfig`
    - Export `const extendedConfig: ExtendedConfig = { ...sampleConfig, extendedSetting: "extended-example-value" }` — the base values arrive by **spread from the imported value**, never restated as literals, which is what makes the own-key count exactly one greater than the base's and mutates nothing
    - Export `buildExtendedConfigPayload(name, path)` delegating to `buildConfigPayload(name, path)` and overriding only `config`, so identity echoing (including for empty strings) and the metamorphic base-versus-extended relation are true by construction rather than by coincidence
    - Re-export nothing from `@microservices/config`: a consumer wanting the base surface declares the base package
    - _Requirements: 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 2.3 Write the barrel-surface tests, value-level and type-level
    - Files: `packages/common/extended-config/tests/barrel-surface.test.ts` and `tests/barrel-surface.test-d.ts`, mirroring the pair in `packages/common/config/tests/`
    - Value-level: the barrel's exported names are exactly the four this package defines, and none of `@microservices/config`'s names is re-exported through it
    - Type-level with `expectTypeOf`: every `ExtendedConfig` value is assignable to `SampleConfig`; `ExtendedConfigPayload["path"]` still resolves through `ConfigPayload["path"]`; and a `@ts-expect-error` records that an object lacking `extendedSetting` is rejected as an `ExtendedConfig`
    - The type-level file is executed by `npm run test:types` through the package's `tsconfig.test.json`, not by `npm test`
    - _Requirements: 1.4, 2.4, 11.15_

  - [x] 2.4 Write the Extended_Config_Payload property tests
    - File: `packages/common/extended-config/tests/extended-config-payload.property.test.ts`
    - Implements design properties 1, 2, and 3: the identity-echo and exact-key-set property over names of 0 to 64 characters and paths of 0 to 128 characters (the empty string in either position included, so the no-error case is inside the generator rather than beside it); the metamorphic property that deleting `extendedSetting` from the extended `config` yields the base `config` deep-equal while `microservice-name` and `path` match character for character; and the purity property that 2 to 100 successive calls return pairwise deep-equal payloads and leave `sampleConfig` deep-equal to a snapshot taken before the first call
    - Tag each with `// Feature: scaffold-demo-samples, Property N: ` followed by the property title exactly as design.md states it
    - _Properties: 1, 2, 3_
    - _Requirements: 2.1, 2.5, 2.6, 2.7, 2.8, 2.9, 11.7_

  - [x] 2.5 Write the Extended_Config_Block content and manifest example tests
    - File: `packages/common/extended-config/tests/extended-config-block.test.ts`
    - Assert `extendedSetting` is exactly `"extended-example-value"` compared character for character, and that the block's own-key set is the Sample_Config_Block's plus that one key and nothing else
    - Assert the "not restated" half structurally: no source file under `packages/common/extended-config/src/` contains the string `example-value` other than inside `extended-example-value`, so the only occurrence of a base value in this package is the identifier `sampleConfig`
    - Assert the manifest facts: the name mirrors the directory, `main`/`types` are non-empty and resolve inside `dist/`, the four scripts are present and non-empty, and the only `@microservices`-scoped dependency across `dependencies`, `devDependencies`, and `peerDependencies` is `@microservices/config`
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 2.1, 2.2, 2.3, 4.7_

  - [x] 2.6 Update the two repository-mirror oracles for the new Common_Package
    - `packages/build-tools/tests/discovery-real-tree.test.ts`: add a `common/extended-config` row to `EXPECTED_ROWS` — `tsc-project`, `dependencySpecifiers: ["@microservices/config"]` — and update the two test titles and the header comment block that enumerate "four rows"
    - `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`: re-run the derivation over the tree as this step leaves it and replace `EXPECTED_ORDER` with the measured result, `packages/common/extended-config` following `packages/common/config`; rewrite the header comment's per-entry rationale table to match. The two focused assertions (contracts first, integration-tests last) still hold unchanged
    - These are data-and-prose edits to repository mirrors, not Build_System behaviour; no file under `packages/build-tools/src/` is touched
    - _Requirements: 4.2, 4.3_

  - [x] 2.7 Extend the Common_Package convention checks to `extended-config`
    - File: `packages/integration-tests/tests/common-package-conventions.test.ts`
    - Add the same convention assertions the file already makes about `packages/common/config` for `packages/common/extended-config`: location under `packages/common/`, name mirroring the directory, `"type": "module"`, `main`/`types` at `dist/`, the four scripts, a barrel `index.ts`, and coverage by exactly one `workspaces` entry
    - Add the dependency-direction assertion: the package names no Microservice_Package and not the Overseer in any dependency field
    - _Requirements: 1.1, 1.2, 1.3, 1.7, 4.1, 4.7_

- [x] 3. Checkpoint — step 2 verification gate
  - Run `npm run ci` and both documented two-command container builds. Confirm `check:invariants` reports zero violations for `extended-config` with no source change under `packages/build-tools/`
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 4.6, 11.1, 11.13_

- [x] 4. Step 3 — Microservice3's extended payload, and Subtree_Ownership for both peers

  - [x] 4.1 Swap Microservice3's shared-library dependency
    - In `packages/microservices/microservice3/package.json`, replace `@microservices/config` with `@microservices/extended-config`, leaving `@microservices/contracts`, `express`, and `@types/express` untouched
    - The scoped runtime dependency set becomes exactly `@microservices/contracts` and `@microservices/extended-config`, with no direct dependency on `@microservices/config` — which is the whole point of the sample: the base package is reached transitively
    - _Requirements: 3.1, 3.2_

  - [x] 4.2 Rewrite Microservice3's router for the extended payload and Subtree_Ownership
    - In `src/index.ts`, import `buildExtendedConfigPayload` from `@microservices/extended-config` by package name and use it for the `/config` response; leave the Mount_Root identifier response unchanged
    - Add `router.all("/config", …)` returning 405 with `Allow: GET` and an empty body, registered **after** `router.get("/config", …)` so GET and HEAD never reach it
    - Add a terminal `router.use((_req, res) => res.status(404).end())` registered **last**, after the four handlers, so every path in Microservice3's Owned_Subtree that the router does not serve is answered 404 by Microservice3 itself, for any method, instead of reaching the Overseer's catch-all
    - Record the registration order in a comment — root GET, `/config` GET, `/config` ALL, root ALL, terminal USE — and why the terminal handler must be last: a path-less `router.use` matches every path and every method, so registering it earlier would shadow the handlers above it and answer 404 at `/config` too
    - Record that the terminal handler is deliberately method-agnostic: the `Allow: GET` policy attaches to the two paths the microservice serves, while an unserved path answers 404 whatever the method
    - _Requirements: 3.3, 3.6, 3.7, 3.8, 3.10, 3.12_

  - [x] 4.3 Rewrite Microservice3's property tests
    - File: `packages/microservices/microservice3/tests/handler.property.test.ts`
    - Implements design properties 4, 6, and 25: the 405-with-`Allow: GET` property over `arbHttpMethodNonGet` at both `/` and `/config`, with the `/config` response body asserted to carry no Extended_Config_Payload; the method-agnostic terminal-404 property over `arbHttpMethod` for every sub-path other than the empty sub-path and `/config`; and the router-totality property over `arbHttpMethod` crossed with every path at or under the Mount_Root, asserting that a sentinel handler mounted after the router is never reached
    - Assert every response against Microservice3's exported router with **no Overseer composed** — the router is total over its Owned_Subtree, so its own suite reads the real status, headers, and body directly. The sentinel survives only in the totality property, mounted precisely so the property can assert it is unreachable
    - _Properties: 4, 6, 25_
    - _Requirements: 3.7, 3.8, 3.10, 3.12, 13.10_

  - [x] 4.4 Write Microservice3's fixed-payload example tests
    - File: `packages/microservices/microservice3/tests/payload.test.ts`
    - Assert `GET /config` → 200, `application/json`, and a body equal to the Extended_Config_Payload for the name `microservice3` and the path `/microservice3`, holding exactly the keys `microservice-name`, `path`, and `config`, with `config` holding exactly the Extended_Config_Block's keys
    - Assert `GET /` → 200, `application/json`, and a body holding exactly `microservice-name` and `path`
    - Add the registration-order guard: a GET at `/config` still returns its payload with the terminal handler registered — the assertion that fails if the `router.use` is ever moved ahead of the handlers above it
    - _Requirements: 3.3, 3.6, 3.10, 13.10_

  - [x] 4.5 Adopt Subtree_Ownership in Microservice2's router
    - In `packages/microservices/microservice2/src/index.ts`, add `router.all("/config", …)` returning 405 with `Allow: GET` and an empty body, registered after `router.get("/config", …)`, and a terminal `router.use((_req, res) => res.status(404).end())` registered last
    - No manifest change: Microservice2's scoped dependency set is already exactly `@microservices/config` and `@microservices/contracts`, and it keeps returning the base Config_Payload — the side-by-side comparison with Microservice3 is the sample
    - Carry the same registration-order and method-agnostic comments as Microservice3, so a reader of either sample sees the same reasoning
    - _Requirements: 3.4, 3.5, 3.9, 3.11, 3.12_

  - [x] 4.6 Rewrite Microservice2's property tests
    - File: `packages/microservices/microservice2/tests/handler.property.test.ts`
    - Implements design properties 5, 22, and 24: the 405-with-`Allow: GET` property at `/config` over `arbHttpMethodNonGet` with a body carrying no Config_Payload; the method-agnostic terminal-404 property over `arbHttpMethod`; and the router-totality property over `arbHttpMethod` and every path at or under `/microservice2`, asserting the sentinel is never reached
    - Keep these deliberately **duplicated** rather than shared with Microservice3's equivalents, and say so in a comment: hoisting a per-microservice method-policy or response assertion into anything shared is exactly what Requirement 13 forbids, and a shared helper would additionally have to carry an explicit enumeration of the microservices it covers
    - _Properties: 5, 22, 24_
    - _Requirements: 3.9, 3.11, 3.12, 13.5, 13.7, 13.9_

  - [x] 4.7 Write Microservice2's fixed-payload example tests
    - File: `packages/microservices/microservice2/tests/payload.test.ts`
    - Assert `GET /config` → 200, `application/json`, and a body equal to the Config_Payload for the name `microservice2` and the path `/microservice2`, with the negative assertion that its `config` member holds **no** `extendedSetting` key
    - Assert `GET /` → 200, `application/json`, and a body holding exactly `microservice-name` and `path`, plus the same terminal-handler registration-order guard
    - _Requirements: 3.4, 3.6, 3.11, 13.9_

  - [x] 4.8 Update the two repository-mirror oracles for Microservice3's changed edge
    - `packages/build-tools/tests/discovery-real-tree.test.ts`: `microservice3`'s `dependencySpecifiers` go from `["@microservices/config", "@microservices/contracts"]` to `["@microservices/contracts", "@microservices/extended-config"]`, sorted as discovery records them
    - `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`: re-run the derivation and update `EXPECTED_ORDER` and its header rationale if Microservice3's changed edge moves any entry
    - _Requirements: 4.2, 4.3_

  - [x] 4.9 Update the Integration_Suite's config-dependency and staged-set expectations
    - `packages/integration-tests/tests/migration-facts.test.ts` and `common-package-conventions.test.ts`: narrow the `it.each(["microservice2","microservice3"])` assertion that each declares `@microservices/config` to `microservice2` alone, and record why — Microservice3 now reaches the Config_Package transitively through `@microservices/extended-config`
    - `packages/integration-tests/tests/baseline-equivalence.test.ts`: the staged Common_Package sets for every selector reaching Microservice3 gain `extended-config`
    - _Requirements: 3.2, 5.2, 5.4_

- [x] 5. Checkpoint — step 3 verification gate
  - Run `npm run ci` and both documented two-command container builds. Confirm the Specific Container (`microservice1,microservice2`) still stages `config` and does **not** stage `extended-config`, and that the Generic Container stages both
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 5.1, 5.2, 5.4, 11.1, 11.13_

- [x] 6. Step 4 — The framework/sample test boundary correction (precondition for step 6)

  - [x] 6.1 Rewrite `endpoint-contract.test.ts` as a framework-scope mount-dispatch suite
    - File: `packages/integration-tests/tests/endpoint-contract.test.ts`, renamed to `mount-dispatch.test.ts` — the current name describes a contract that no longer exists at framework scope
    - Remove both looped assertions (the identical `{microservice-name, path}` body and the identical `405 Allow: GET`) and both `/config` body assertions: each is one sample's choice promoted into a framework-wide law the framework never declared
    - Keep three assertions over an **explicit enumeration** of `{id, path}` mounts, deriving that enumeration from neither filesystem discovery nor the generated registry: an enabled microservice probed at its Mount_Root itself — never a path under it — answers with a status other than 404; in a composition where no enabled microservice is mounted at `/`, an unselected or toggled-off microservice's path and a path under it each receive the Overseer's catch-all 404; and in a composition where Microservice1 is enabled at `/`, no request receives the catch-all 404 at all
    - State in the third assertion's description that the catch-all's unreachability is the intended consequence of Subtree_Ownership rather than a defect, and record in a comment why the probe point is the Mount_Root: under Subtree_Ownership a path *under* a Mount_Root may legitimately carry 404 from the owning microservice, so only at the Mount_Root does `status !== 404` distinguish dispatch from the catch-all
    - Exercise the Overseer through the real reference microservice modules and the existing in-process `buildApp` composition, with no change to the Overseer package and none to `packages/overseer/tests/router.property.test.ts`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.8, 13.17_

  - [x] 6.2 Reduce the six liveness probes to the Mount_Root rule
    - Files: `start-parity.test.ts`, `specific-container-404.test.ts`, `dev-cold-start.test.ts`, `dev-warm-tree.test.ts`, `dev-environment-passthrough.test.ts`, `dev-start-parity.test.ts`
    - Apply one rule to all six: a liveness probe asserts `status !== 404` at the Mount_Root of a microservice it names explicitly and asserts nothing else about the response — no body, no content type, no per-method status. Drop every `GET /` body equality; convert `dev-cold-start`'s `/microservice2` → 200 check to the same predicate
    - Each suite keeps the process-level or build-level subject it asserts today, and its selector and composition unchanged
    - Record in `dev-cold-start.test.ts` why the rule is not merely tidy: that suite materialises a pristine worktree and drives `npm run dev`, which never invokes a Spa build, so once step 6 lands Microservice1's Mount_Root answers **503** there rather than 200. `status !== 404` holds in both the 200 and the 503 case
    - Record in `specific-container-404.test.ts` and `dev-environment-passthrough.test.ts` that the 404 each observes for an unselected or toggle-disabled microservice's path is, once Microservice1 is mounted at `/`, **Microservice1's own** — returned because Microservice1 owns that path in a Container holding no such microservice — and not the Overseer's catch-all. The observed status is unchanged; only its source is
    - _Requirements: 13.12, 13.13_

  - [x] 6.3 Retarget the two mutation anchors away from Microservice1's identifier response
    - Files: `packages/integration-tests/tests/dev-session-scope.test.ts` and `dev-error-recovery.test.ts`
    - Retarget the observable-behaviour anchor `.json({ "microservice-name": "microservice1", path });` to Microservice2's identical literal in `packages/microservices/microservice2/src/index.ts`, and move each suite's marker probe from `/` to `/microservice2` — also a Mount_Root, so the probe reads a dispatched response rather than a path Microservice1 owns
    - Widen `dev-error-recovery.test.ts`'s selector from `microservice1` to `microservice1,microservice2` so the probed peer is mounted; `dev-session-scope.test.ts`'s selector already includes it
    - Leave `dev-error-recovery.test.ts`'s **type-error injection** anchor `'export const path = "/";'` untouched — Microservice1 still exports that exact line, so that anchor and the assertion that the diagnostic names `packages/microservices/microservice1/src/index.ts` both survive
    - Give `dev-error-recovery.test.ts` the anchor-not-found guard `dev-session-scope.test.ts` already has, in the shape of its two existing sanity checks: raise an error naming the source file and the anchor rather than proceeding with an unmodified file
    - _Requirements: 13.14, 13.15, 13.16_

  - [x] 6.4 Add the Integration_Suite scope guard
    - File: `packages/integration-tests/tests/integration-scope-guard.test.ts`
    - Assert that no file under `packages/integration-tests/tests/` contains a `405` status assertion or an `Allow` header assertion for any Microservice_Package, and that no assertion of a response body, a content type, or a status code other than the Mount_Root dispatched-versus-catch-all-404 distinction is quantified over discovered packages or over the generated registry
    - Worth having because the defect this step corrects was introduced by exactly the kind of edit a reviewer waves through
    - _Requirements: 13.4, 13.5, 13.6, 13.8_

- [x] 7. Checkpoint — step 4 verification gate
  - Run `npm run ci` and both documented two-command container builds. Every corrected suite must pass against Microservice1's **current** identifier response, which is the evidence that step 4 is a scope correction and not a behaviour change
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 11.1, 13.18_

- [x] 8. Step 5 — The Demo_Spa, the first Spa_Package (additive)

  - [x] 8.1 Create the `packages/spa/demo/` skeleton, bundler pin, and configs
    - `package.json`: name `@microservices/demo`, `"type": "module"`, `"private": true`, `"exports": { ".": "./dist/index.html" }`, the four scripts `build` (`vite build`), `test` (`vitest --run`), `lint`, `typecheck`, and `vite` pinned as a devDependency to the single exact version `8.3.0` — no `^`, `~`, `*`, `>`, `<`, `=`, or `||`
    - Declare **no** `main` and no `types`: a Spa_Package's category contract is a non-empty `scripts.build`, and a barrel would advertise an API the import-discipline check forbids anyone from importing. Declare **no** `@microservices`-scoped dependency at all, which keeps the Demo_Spa a true sink
    - Record in a comment that the `exports` map is this sample's half of the chosen Spa_Resolution_Pair: it makes `import.meta.resolve("@microservices/demo")` succeed and point inside `dist/` whether or not the bundle has been built, because `exports` resolution does not stat its target — and that it also hardens the no-static-import rule, since a `tsc` project importing the package would resolve to an `.html` file
    - `vite.config.ts`: `base: "./"` so every emitted asset reference is relative rather than root-absolute, `build.outDir: "dist"`, `build.emptyOutDir: true`, and **no `test` block**, so Vitest's default Node environment stays in force for this package's suite
    - `tsconfig.json` extending `../../../tsconfig.base.json` with `composite: false`, `declaration: false`, `noEmit: true`, `module: ESNext`, `moduleResolution: Bundler`, `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `types: []`, and `include: ["src/**/*", "tests/**/*", "vite.config.ts"]` — typecheck only, never a `tsc --build` root
    - Run `npm install` and confirm the glob `packages/spa/*` picks the package up with no root-manifest edit
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.8, 6.10, 7.15, 9.18, 11.3_

  - [x] 8.2 Write the Demo_Page markup at `index.html`
    - Place `index.html` at the package root, Vite's entry, referencing `./src/main.ts` as a module script
    - Exactly two native `button type="button"` elements, in document order labelled `Microservice 2` then `Microservice 3`, each accessible name computed from its text content with no `aria-label` overriding it and no `tabindex`
    - Exactly three display fields after both buttons, in the order request → status → body: two native `output` elements for the Request_Field and Status_Field, and one `textarea` for the Body_Field carrying `readonly` (not `disabled`) so it stays focusable, scrollable, and selectable
    - Each of the three fields programmatically associated with a visibly rendered `<label for=…>`; all three initially empty
    - Declare **no `aria-live` attribute anywhere in the document**, and record why in a comment: an `output` maps to the ARIA `status` role, which is an implicit polite live region, and an `output`'s content is a text node — the thing assistive technology can announce, unlike a `textarea`'s value. The Body_Field is deliberately left unannounced, because reading a multi-kilobyte JSON body aloud on every request would be hostile rather than helpful
    - _Requirements: 6.6, 6.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 8.3 Implement `src/result-formatter.ts`
    - Export **exactly three** functions, one per display field, each returning a single string: `formatRequestLine(requestLine)`, `formatStatus(status, reason)`, and `formatBody(body)`
    - `formatRequestLine` is branchless — it returns its argument character for character, with no truncation, normalisation, or substitution
    - `formatStatus` has two branches: a present status returns the bare decimal code for every code from 100 to 599, 2xx included; an absent status returns a settled-without-a-status-code text carrying the reason character for character when the reason holds one or more characters (whitespace-only included), and a transport-failure indication when the reason is absent or zero characters. Record that the split is on the reason's **length alone**, so the two guards partition the domain with nothing falling between them
    - `formatBody` takes the body as its **sole** parameter and receives no status code, with three branches in order: an absent or zero-character body returns a no-body indication; a body that parses as JSON returns `JSON.stringify(JSON.parse(body), null, 2)`; anything else returns the body verbatim, untruncated. Record that the absence of a status parameter is what lets a JSON error body with a non-2xx status be formatted rather than dumped
    - The module reads and writes no document, issues no request, and names no browser-provided global, so all three functions are callable under Node and drivable by fast-check — which is why it is a separate module from `main.ts`
    - _Requirements: 10.1, 10.3, 10.5, 10.6, 10.7, 10.11, 10.12, 10.13, 10.14, 10.15, 10.18_

  - [x] 8.4 Write the Result_Formatter property tests
    - File: `packages/spa/demo/tests/result-formatter.property.test.ts`
    - Implements design properties 15 through 21 and 26: the Request_Line identity over 0 to 2 048 characters (empty string, unicode, embedded newlines, and well-formed Request_Lines over the two paths the Demo_Page actually requests, so the metamorphic reading is exercised on real shapes as well as the bounds); the present-status decimal property over 100 to 599 crossed with an arbitrary reason, quantified over the reason axis even though the branch ignores it, so a reason cannot perturb a present status; the JSON round-trip property over `fc.jsonValue()`; the absent-status reporting property over reasons that are absent, empty, whitespace-only, the 10-second-limit text, or arbitrary — whitespace-only kept in the generator precisely because it must come back verbatim; the absent-or-empty-body property; the unparseable-body verbatim property; and the determinism and totality properties, both driven by one tagged call-shape generator that is a discriminated union of the three functions' argument tuples
    - Tag each with `// Feature: scaffold-demo-samples, Property N: ` followed by the property title exactly as design.md states it
    - _Properties: 15, 16, 17, 18, 19, 20, 21, 26_
    - _Requirements: 9.16, 10.3, 10.5, 10.6, 10.7, 10.8, 10.11, 10.12, 10.13, 10.15, 10.16, 10.17, 10.19, 10.20, 10.21, 11.8_

  - [x] 8.5 Write the Result_Formatter example tests
    - File: `packages/spa/demo/tests/result-formatter.test.ts`
    - Assert the module's exported names are exactly the three functions and each is callable — the surface Requirement 10 fixes
    - Assert `formatBody.length === 1`, and add a type-level assertion that a second argument is rejected, so the no-status-code constraint is checked structurally rather than by reading the branches
    - Add the single explicit 1 048 576-character unparseable-body example rather than generating at that size on every run
    - Add the source-level purity assertion: `result-formatter.ts` names none of `document`, `window`, or `fetch`. Record that the whole suite running under Vitest's default Node environment is itself the stronger check — a browser-global reference would throw on the first run
    - _Requirements: 10.1, 10.13, 10.14, 10.18, 11.3, 11.8_

  - [x] 8.6 Implement `src/main.ts` — the DOM wiring
    - Declare the endpoint map as two hard-coded root-absolute same-origin paths, `/microservice2/config` and `/microservice3/config`, reading no host from configuration; record why these are absolute where the asset references are relative — a peer is mounted at its own Microservice_Path by the Overseer regardless of where Microservice1 is mounted
    - Declare `PENDING` (the Status_Field's in-flight text) and `LIMIT_REASON` (naming the 10-second limit) as `main.ts` constants and **not** as formatter exports, because the Result_Formatter's surface is fixed at exactly three functions
    - Compose the Request_Line here as the method, a single space, and `new URL(path, location.origin).href`, and pass the string to `formatRequestLine` — so the entire dependence on the browser environment sits in this module while the formatter stays a deterministic function of a string. Emit **no** HTTP protocol version: `fetch` does not expose the negotiated version, so any version string would be a fabrication
    - On activation, before the request is sent: assign `formatRequestLine(requestLine)` to the Request_Field's `textContent`, `PENDING` to the Status_Field's `textContent`, and `""` to the Body_Field's value; disable both buttons
    - Read the response with `res.text()` and never `res.json()`, so the body function owns the parse attempt; on completion assign `formatStatus(res.status, undefined)` and `formatBody(text)`; on settling without a status assign `formatStatus(undefined, reason)` and leave the Body_Field holding no text
    - Use an `AbortController` with a 10 000 ms timeout cleared in the `finally`, calling `formatStatus(undefined, LIMIT_REASON)` on abort so an abandonment is one instance of the absent-status branch rather than a case of its own, and leaving the Request_Field holding the abandoned request's Request_Line
    - Guard re-entry with a module-level in-flight flag that returns **before any field is touched**, and re-enable both buttons in a `finally` so completion, transport failure, and abort are all covered
    - Assign `textContent` (not `value`) on the two `output` elements, read once at startup, never replaced or removed, with no `replaceChild`, `remove`, `outerHTML`, or `innerHTML` anywhere in the sources
    - _Requirements: 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 9.15, 9.16, 9.17, 10.2, 10.4, 10.8, 10.9, 10.10, 10.22, 10.23_

  - [x] 8.7 Write the Demo_Page markup and wiring tests
    - File: `packages/spa/demo/tests/demo-page.test.ts`, referencing neither `document` nor `window`
    - Parse the committed `index.html` and assert: exactly two `button` elements with the two labels in document order; exactly three display fields in the order request → status → body, all after both buttons; exactly two `output` elements, each with a `label[for]` pointing at its `id` and each label visibly rendered; exactly one `textarea`, `readonly` and not `disabled`, with its own associated visible label; **no `aria-live` attribute anywhere in the document**; no `tabindex` on either button; and all three fields initially empty
    - Assert over the Demo_Spa's own sources: the endpoint map's two literal values with no other origin and no configuration read; the three activation assignments with `PENDING` non-empty; both buttons disabled before the request and re-enabled in a `finally`; the in-flight guard returning before any field is touched; the Request_Line composition and the absence of any HTTP-version literal; the abort call passing `LIMIT_REASON`; the completion and no-status assignment pairs; the sole Body_Field assignment being `formatBody`'s return value with no formatting expression of `main.ts`'s own; and the two `output` references read once with only `textContent` ever assigned
    - Assert that no source branches on a selector, a toggle, or a 404 — which is what makes the Selector-excluded and toggle-disabled outcomes follow from the status and Request_Line properties together with Microservice1's own response, rather than from a special case here
    - Record in the file header that this is the deliberately weaker of the two treatments: it checks the wiring — which function's output lands in which element — while the interesting content of each field is the property suite's subject, and that the trade exists so no test of the Demo_Spa needs a DOM
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 9.15, 9.17, 10.2, 10.4, 10.8, 10.9, 10.10, 10.22, 10.23, 11.8_

  - [x] 8.8 Update the two repository-mirror oracles for the first Spa_Package
    - `packages/build-tools/tests/discovery-real-tree.test.ts`: add a `spa/demo` row — `bundler-project`, no dependency specifiers — and invert the "discovers zero Spa_Packages" test to "discovers exactly one Spa_Package, `demo`"; update the row-count titles and header comment again
    - `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`: re-run the derivation and update `EXPECTED_ORDER` and its header rationale. Record the counter-intuitive placement in the comment: `packages/spa/demo` is ready from the first step, declaring no scoped dependency, but its `packageDir` is the largest among the ready candidates until `packages/overseer` has been emitted, so eligibility is not placement
    - _Requirements: 6.17_

  - [x] 8.9 Invert the "spa is empty" assertions in the Integration_Suite
    - `packages/integration-tests/tests/package-categories-layout.test.ts`: replace the four `.gitkeep`-only assertions with assertions that `demo` is a member of `packages/spa/` and that the Namespace_Container itself still declares no manifest
    - `packages/integration-tests/tests/effective-dockerfile.test.ts`: invert the "spa holds no workspace" and "no `packages/spa` COPY line" assertions into expectations of `COPY packages/spa/demo/package.json packages/spa/demo/` and `COPY packages/common/extended-config/package.json packages/common/extended-config/` at **both** anchors, confirming no edit to `scripts/emit-effective-dockerfile.sh` or `Dockerfile.template` was needed — the script's globs pick both manifests up as they stand
    - _Requirements: 6.1, 6.2_

  - [x] 8.10 Write the bundle-output shape integration test
    - File: `packages/integration-tests/tests/spa-bundle-output.test.ts`
    - After the workspace build, parse `packages/spa/demo/dist/index.html`, extract every `src` and `href`, and assert each reference begins with neither `/` nor a URL scheme, resolves inside `dist/`, and has a file at that path — so no referenced path is left without a file and the Demo_Page keeps working if Microservice1 is later mounted somewhere other than `/`
    - One execution rather than a property loop: nothing about the bundler's output varies with an input under test. This is the **only** place the `index.html` filename is asserted, and it is asserted of the Demo_Spa's bundler configuration, never of the Build_System
    - _Requirements: 6.6, 6.7_

  - [x] 8.11 Write the Spa_Package convention and Node-floor tests
    - File: `packages/integration-tests/tests/spa-package-conventions.test.ts`
    - Assert the Demo_Spa's manifest facts: location at `packages/spa/demo`, name mirroring the directory as `@microservices/demo`, a non-empty `scripts.build`, the four scripts each non-empty, the bundler devDependency matching `/^\d+\.\d+\.\d+$/` with none of the range operators present, coverage by exactly one `workspaces` entry, and no `@microservices`-scoped dependency of any kind
    - Assert the Node floor: the root manifest's `engines.node` is `">=22.12.0"`, and every version its range admits satisfies the `engines.node` range the **installed** bundler declares — read from the installed `vite` manifest rather than restated, so a later bundler bump that raises its own floor fails this test instead of quietly re-opening the mismatch
    - Assert `vite.config.ts` declares no `test` block, so the Demo_Spa's suite runs under Vitest's default Node environment
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 9.18, 11.3, 11.16_

- [x] 9. Checkpoint — step 5 verification gate
  - The ordinary gate, plus `npm start` and a short `npm run dev` session with one source edit
  - Confirm the two-phase order the Build_System already implements: the single `tsc --build` pass over the ordered roots runs first, and the Demo_Spa's own `npm run build` runs second in its own directory, entered only after that pass exits 0 — the Demo_Spa appearing as a root of no `tsc --build` invocation
  - Confirm `npm run dev` invokes **no** Spa build and leaves the Spa_Root's file set and contents exactly as the developer's own `npm run build` last produced them
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 6.8, 6.9, 6.10, 6.11, 11.1, 11.4, 11.5, 11.6_
  - **Gate outcome:** `npm run ci` exits 0 (build, `check:invariants`, typecheck, lint, 76 files / 578 tests, `test:types` all green). Docker image builds were not run in this environment; the staged-set and `COPY`-line behaviour they would exercise is covered by the `baseline-equivalence` and `effective-dockerfile` integration suites, which assemble the real image tree and confirm `*` stages `config` + `extended-config` + `demo` while `microservice1,microservice2` omits `extended-config`.
  - **Remediation done to clear this gate — destructive tests replaced with the non-destructive pattern (spec-adjacent, applies repo-wide):** the gate surfaced that `dev-session-scope.test.ts` and `dev-error-recovery.test.ts` mutated the real working tree — editing tracked microservice sources (and, in one, creating a package directory and a `node_modules` symlink) and "restoring" via `restoreWorktreeFile()` (`git checkout -- <path>`), which reverts to committed content and silently discards uncommitted work. This destroyed task 4.5's (uncommitted) Subtree_Ownership handlers in `microservice2/src/index.ts` twice. Fixes applied:
    - Re-applied task 4.5's handlers to `packages/microservices/microservice2/src/index.ts` (the `router.all("/config")` 405 and terminal `router.use` 404).
    - Rewrote both suites to mutate only their own `pristineWorktree()` copy (the existing non-destructive helper — it captures uncommitted edits into an OS temp tree) and to restore by writing back captured bytes with `writeFileSync`, never git. Both verified to leave `git status` byte-identical.
    - Deleted the `restoreWorktreeFile()` footgun from `helpers.ts`.
    - Added `packages/integration-tests/tests/worktree-safety-guard.test.ts` — a mechanical guard failing any test that runs a destructive git subcommand, mutates a `repoRoot`-derived path, or reintroduces the restore helper.
    - Added a `### A test MUST NOT mutate the checked-out tree` section to `.kiro/steering/tech.md` recording the prohibition, why `git checkout` is destructive, and the `pristineWorktree()` recipe.
    - Wired `common/*` and `spa/*` projects into `vitest.workspace.ts` (per user decision) so the two new packages' suites run under the `npm run ci` gate; incidentally hardened task 8.11's semver load to be ESM- and typecheck-clean.
  - Also corrected a latent flaky generator in the `microservice2`/`microservice3` router-totality property tests: `.`/`..` path segments were generated that normalise outside the mount subtree and legitimately reach the sentinel. Excluded them, matching the sibling 404-property generators.

- [x] 10. Step 6 — Microservice1 serves the Demo_Spa at its Mount_Root

  - [x] 10.1 Declare the Demo_Spa dependency in Microservice1's manifest
    - Add `"@microservices/demo": "*"` to `packages/microservices/microservice1/package.json` `dependencies`
    - Record why the declaration exists at all: it is what puts the Demo_Spa in the Required_Dependencies, and therefore in the Spa build set and the stage set, while the code reaches it only through a run-time module-resolution call
    - _Requirements: 7.1_

  - [x] 10.2 Create `src/spa-root.ts` — resolve the Spa_Root exactly once
    - Export `resolveSpaRoot(): string` returning `dirname(fileURLToPath(import.meta.resolve("@microservices/demo")))`
    - The sole argument is the bare package name: **no static import, no dynamic import, and no relative path leaving the package**. Record that this is also what keeps `check:invariants` silent — its scanner matches `from "…"`, `import "…"`, and `import("…")`, none of which this is, and its Tsc_Project-naming-a-Spa_Package rule would otherwise reject it
    - Record the resolution-pair reasoning in the doc comment: this is the consumer half of the pair whose manifest half is the Demo_Spa's `"exports": { ".": "./dist/index.html" }`; Node does not stat an `exports` target while resolving, so the call succeeds whether or not the bundle has been built; the other pair — resolving `@microservices/demo/package.json` against a manifest declaring no `exports` — is equally permitted by the framework, but the halves cannot be mixed
    - Record the two layouts it must work in: in the workspace the resolved string may be the realpath or the symlinked path depending on whether `dist/` exists, and both read the same files because the intervening link is a *directory* link; in an image the walk lands on the real staged directory
    - _Requirements: 7.3, 7.4, 7.15_

  - [x] 10.3 Create `src/static-router.ts` — `createSpaRouter(spaRoot)`
    - Register a **single** path-less `router.use(handler)` whose handler takes `(req, res)` and **no `next` parameter**, so nothing can fall through and totality over the Owned_Subtree is a property of the signature rather than a convention. Record that TypeScript then makes a `next()` call a compile error rather than a review finding
    - Implement the eight steps in this order: (1) a method other than GET or HEAD → 405 with `Allow: GET, HEAD` and an empty body, decided **before any filesystem access**; (2) take the pathname from `req.path`, excluding the query string; (3) evaluate `index.html` presence **per request** — absent and the pathname is `/` → 503 `text/plain` naming the resolved Spa_Root and `npm run build --workspace @microservices/demo`, absent and any other pathname → 404; (4) pathname `/` → serve `index.html` as `text/html`; (5) percent-decode, then resolve against the Spa_Root, then test lexical containment → 404 with an empty body on escape, and 404 on a malformed escape sequence; (6) realpath the candidate and test containment against the realpath of the Spa_Root → 404 on a symlink escape, 404 on ENOENT; (7) not a regular file → 404, emitting neither a directory listing nor `index.html`; (8) serve with the content type of its extension
    - Serve via an explicit `Content-Type` header with **no charset** (the media types the requirements name are bare), status 200, and an empty body for HEAD — same status and content type as the corresponding GET
    - Use a frozen extension → content type record keyed on the lower-cased extension with `application/octet-stream` as the default, so the same extension yields the same content type for every request by construction
    - Record the four decisions in comments: the method check precedes every filesystem check, so the 405 is identical whatever the path shape and whether or not the Spa_Root is present; the presence check is per request, so both recovery directions work with no restart and no intervening request; decode-then-normalise is what puts a percent-encoded `..` in the same branch as a plain one; and two containment tests are needed because the resolved Spa_Root may itself be a symlinked path
    - Record that `express.static` was evaluated and rejected: three of its behaviours cannot be configured away — a 403 for an escaping path, followed symlinks, and `next()` as its answer for everything it does not serve, which Subtree_Ownership forbids outright
    - Record that the synchronous `node:fs` calls are a deliberate scaffold-sample choice and the first thing a production adopter would replace, and that a filesystem error other than "does not exist" is deliberately **not** caught, so it propagates to Express's error handler as Microservice1's own 500 rather than being hidden as a 404
    - _Requirements: 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 7.12, 7.14, 8.1, 8.2, 8.3, 8.5, 8.6_

  - [x] 10.4 Rewire `src/index.ts` to the resolved Spa_Root
    - Keep the exports exactly `path = "/"` and `router`, so the framework contract is unchanged and the surviving mutation anchor `export const path = "/";` stays intact
    - Set `router = createSpaRouter(resolveSpaRoot())`, making this the single place resolution happens, so the Spa_Root is determined exactly once while its presence is evaluated per request
    - Remove the identifier-JSON handler and the mount-root `405 Allow: GET` fallback: Microservice1's method policy is now `405 Allow: GET, HEAD` and lives in the handler. Record that this policy differs from Microservice2's and Microservice3's `Allow: GET` **deliberately**, so a template user reads a method policy as the owning microservice's own choice and not as a framework rule
    - _Requirements: 7.2, 7.3, 7.11_

  - [x] 10.5 Rewrite Microservice1's property tests for method policy and totality
    - File: `packages/microservices/microservice1/tests/handler.property.test.ts`
    - Implements design properties 13 and 23: every method other than GET and HEAD, at every path at or under the Mount_Root — the Mount_Root itself, a path naming a file, a directory, nothing, an escaping path, and a path inside an absent microservice's subtree — answered 405 with `Allow: GET, HEAD`, asserted twice against the same generator, once with a populated Spa_Root and once with an empty one; and the totality property over `arbHttpMethod` crossed with the same path generator, with the Spa_Root present and absent, asserting a sentinel handler mounted after the router is never reached
    - Record why one property covers the whole method axis: the handler decides on the method before touching the filesystem, so a single generator suffices where a reversed order would need one property per path shape
    - Import `createSpaRouter` by relative path from within the package and pass a `mkdtemp` directory, so no test touches the real bundle and the suite passes whether or not `packages/spa/demo/dist/` exists. Compose no Overseer
    - _Properties: 13, 23_
    - _Requirements: 7.11, 7.12, 8.2, 11.10, 13.11_

  - [x] 10.6 Write Microservice1's Spa-serving suite
    - File: `packages/microservices/microservice1/tests/spa-serving.test.ts`
    - Implements design properties 8, 9, 10, 11, and 12: byte-identical serving with a content type the extension alone determines, over a generator drawing from the mapped set *and* from unmapped extensions (`.qqq`, `.tar.zst`, no extension, an upper-cased `.HTML`), including the two-files-one-extension equality; a path naming no regular file answered 404 by Microservice1's own router with a body that is neither a directory listing nor the bytes of `index.html`; every escape shape — `..`, percent-encoded `..`, an absolute segment, a planted symlink — crossed with depth 1 to 5, answered 404 with a body never containing a sentinel file planted outside the Spa_Root; HEAD mirroring GET's status and content type with an empty body; and a query string changing nothing
    - Add the fixed examples: `GET /` → 200, `text/html`, byte-identical to `index.html`
    - Add the peer-subtree cases: a request at and under an absent microservice's Microservice_Path — `/microservice2`, `/microservice3/config` — answered by Microservice1's own router, 405 for a non-GET/HEAD method, 200 for a GET or HEAD naming a file inside the Spa_Root, 404 otherwise, and never 200-with-`index.html` for a path naming no file. Record that no Overseer and no toggle is involved: in a Container holding no such microservice the path is simply one Microservice1 owns
    - _Properties: 8, 9, 10, 11, 12_
    - _Requirements: 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.14, 11.10_

  - [x] 10.7 Write Microservice1's absent-Spa_Root suite
    - File: `packages/microservices/microservice1/tests/spa-root-absent.test.ts`
    - Implements design property 14: while the Spa_Root is absent, every path other than the Mount_Root is answered by Microservice1's own router — 404 for GET or HEAD, 405 with `Allow: GET, HEAD` for any other method — and no response carries 503, so the Mount_Root is the only path that reports the unbuilt bundle
    - Add the fixed examples: the 503 shape at the Mount_Root with `text/plain` and a body naming both the resolved Spa_Root path and `npm run build --workspace @microservices/demo`; a HEAD at the Mount_Root with an absent Spa_Root returning that status and content type with **no body**; and the two recovery transitions — absent → present and present → absent — each answered correctly on the very next request, driven on **one** router instance by writing and deleting `index.html` in a `mkdtemp` directory with no restart and no intervening request
    - _Properties: 14_
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6, 11.10, 13.11_

  - [x] 10.8 Update the two repository-mirror oracles for Microservice1's new edge
    - `packages/build-tools/tests/discovery-real-tree.test.ts`: `microservice1`'s `dependencySpecifiers` go from `["@microservices/contracts"]` to `["@microservices/contracts", "@microservices/demo"]`, sorted as discovery records them; confirm the oracle now holds six rows
    - `packages/build-tools/tests/workspace-build-order-real-tree.test.ts`: replace `EXPECTED_ORDER` **wholesale** with the ten-entry measured order of design.md's Data Models table, and rewrite the header comment's rationale table with it. Two entries are inserted **and** two move: `packages/microservices/microservice1` from position 4 to 9, because declaring `@microservices/demo` means it cannot precede `demo`, and `packages/integration-tests` from 8 to 10. The two focused assertions (contracts first, integration-tests last) still hold
    - Confirm the three ordering outcomes against the measured positions: `config` before `extended-config`, `extended-config` before `microservice3`, and `demo` before `microservice1`
    - _Requirements: 4.2, 4.3, 6.17_

  - [x] 10.9 Check the synthesised probe microservice in `dev-session-scope.test.ts`
    - File: `packages/integration-tests/tests/dev-session-scope.test.ts`
    - That suite synthesises a probe microservice by copying Microservice1's package directory and rewriting its manifest, so the copy now inherits the `@microservices/demo` dependency. It resolves and plans correctly — the probe simply becomes a second consumer of the Demo_Spa — but confirm the copy step, and drop the `demo` dependency from the synthesised manifest if any assertion in the suite enumerates the probe's dependencies
    - _Requirements: 13.13, 13.15_

- [x] 11. Checkpoint — step 6 verification gate
  - The ordinary gate, plus `npm start` and a short `npm run dev` session with one source edit
  - Confirm both Spa_Root states by hand: with the bundle built, the Overseer's base URL serves the Demo_Page; with `packages/spa/demo/dist/` removed, the base URL answers 503 naming the path and the build command while the Overseer starts and stays up, and every other enabled microservice's Mount_Root still answers
  - Confirm `check:invariants` reports zero violations for Microservice1 — the evidence that resolving the Spa_Root through a module-resolution call rather than an import is what keeps the import-discipline check silent
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 6.14, 7.4, 8.4, 11.1, 13.18_
  - **Gate outcome:** `npm run ci` exits 0 (build, `check:invariants` — zero violations for Microservice1, confirming the `import.meta.resolve` call is not matched by the import-discipline scanner — typecheck, lint, 78 files / 595 tests, `test:types` all green). Docker builds and the manual `npm start` / `npm run dev` Spa_Root-present/absent walk-through require a live/Docker environment not available here; the 503-absent-bundle behaviour is covered by Microservice1's own `spa-root-absent.test.ts` (Property 14 + the recovery transitions) and, in a real dev tree, by `dev-session-scope.test.ts`; the `demo` staging is covered by `baseline-equivalence.test.ts` (real directory at `node_modules/@microservices/demo`).
  - **Bug found and fixed by the property tests (task 10.6):** `static-router.ts` STEP 6 caught only `ENOENT` from `realpathSync`, so a path whose parent segment is a regular file (e.g. `/microservice2/nope` where `microservice2` is a file) threw `ENOTDIR` and surfaced as a 500 instead of the 404 R7.7 requires. Fixed to treat both `ENOENT` and `ENOTDIR` as "names no file" → 404, leaving any other fs error uncaught as Microservice1's own 500.
  - **Environment-compatibility fix — `resolveSpaRoot()` (spa-root.ts):** `import.meta.resolve` is `undefined` inside Vitest's SSR module runner, so composing the real Microservice1 router threw at module init and broke every integration suite that mounts it. `resolveSpaRoot()` now prefers native `import.meta.resolve` (production, `npm start`, dev) and falls back to `createRequire(import.meta.url).resolve(...)` when it is absent (the test runner). Both resolve the same `exports` target (`<demo>/dist/index.html`), both import nothing, and neither trips the import-discipline scanner.
  - **Spillover oracle/liveness edits needed to keep the gate green** (nominally tasks 12.1 and the Mount_Root rule of 6.2, applied now because Microservice1's new behaviour reaches them): `baseline-equivalence.test.ts`'s staged sets gain `demo` for both shipped Selectors (Microservice1 selects it); `dev-session-scope.test.ts`'s readiness/liveness probes moved off `/` (now Microservice1's SPA Mount_Root, answering 503 with no built bundle under `npm run dev`) — `waitForServer` polls the dispatched peer `/microservice2`, and the `/` assertions became `status !== 404`.

- [x] 12. Step 7 — Staging, startup, and script-wiring integration coverage

  - [x] 12.1 Extend the staged-set integration suite for both samples
    - File: `packages/integration-tests/tests/shared-package-staging.test.ts`
    - Add one case per staging outcome: the staged Common_Package directory-name set is `{config}` for the selector `microservice2`, `{config, extended-config}` for `microservice3` (the base package reached transitively, declared directly by no selected microservice), the empty set for `microservice1`, and `{config, extended-config}` for `*`
    - Add the resolver-order case: for `microservice3` the Required_Dependencies' Common_Package members are exactly the two packages with `config` at the lower index
    - Add the staging-shape case: a staged Common_Package is a **real directory** at `node_modules/@microservices/<name>` — proven with `lstat`, not a symlink — holding its `package.json` and its compiled `dist/` with the barrel module and its declarations, and holding no `src/`
    - Add the Spa_Package cases: the selector `microservice1` stages `demo` as a real directory holding exactly its `package.json` and the contents of its `dist/`, with no `src/`, `tests/`, or `node_modules/`; the selector `microservice2,microservice3` stages an empty Spa_Package set and creates no `node_modules/@microservices/demo`; and `@microservices/contracts` is staged for every selector while being excluded from the Required_Dependencies, so the counted Common_Package sets hold no Framework_Singleton
    - Add the plan-membership cases: the Demo_Spa is a root of no `tsc --build` invocation for any selector, is built through its own `npm run build` in its own directory, and its bundler build completes before staging
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 11.9_

  - [x] 12.2 Write the Dependency_Resolver determinism property test
    - File: `packages/integration-tests/tests/dependency-resolver-determinism.property.test.ts`
    - Implements design property 7: for any selector drawn from the repository's microservice identifiers including `*`, and any repeat count from 2 to 20, every run's Required_Dependencies and Staged_Dependencies lists are element-identical to the first run's, in the same order
    - Deep-import the compiled resolver module, as the repository's existing suites do for `@microservices/build-tools`
    - _Properties: 7_
    - _Requirements: 5.10_

  - [x] 12.3 Write the peer-shadowing integration test
    - File: `packages/integration-tests/tests/peer-shadowing.test.ts`
    - Compose the in-process Overseer with all three microservices enabled and assert that a request at an enabled peer's Mount_Root and at a path under it is dispatched to that peer's router and never to Microservice1's static serving, asserting **only** which mounted router answered and the status it carried — no body, no content type, no per-method status
    - Record that this holds with the Overseer exactly as it stands, because mounts are registered longest-path-first so Microservice1's `/` mount is registered last, and that the complement — what Microservice1 answers when the peer is *absent* — is deliberately asserted in Microservice1's own suite instead, where it is a statement about one router
    - _Requirements: 7.13, 11.11_

  - [x] 12.4 Write the Overseer-startup-with-absent-Spa_Root integration test
    - File: `packages/integration-tests/tests/overseer-startup-absent-spa.test.ts`
    - One composition with the Spa_Root absent: the Overseer completes startup without exiting, every enabled microservice other than Microservice1 is dispatched at its Mount_Root, and Microservice1's Mount_Root answers 503 — so Overseer startup does not depend on the Spa_Root
    - Record why the Mount_Root is the probe point: a request dispatched to a mounted router there never yields 404, while a path under it may legitimately carry 404 from the owning microservice
    - _Requirements: 8.4, 11.11_

  - [x] 12.5 Extend the clean-tree build-order integration test
    - File: `packages/integration-tests/tests/repository-build.test.ts`
    - Assert that on a tree with no `dist/` and no `tsconfig.tsbuildinfo`, the Config_Package's build completes before the Extended_Config_Package's build starts and the run exits 0
    - _Requirements: 4.4_

  - [x] 12.6 Extend the script-wiring and release-workflow tests
    - Files: `packages/integration-tests/tests/ci-wiring.test.ts` and `release-workflow.test.ts`
    - Assert the ordered build reaches the Demo_Spa's own `build` script and observes it exit 0 **before the first test executes** and **before the Overseer process is spawned**; that a non-zero exit from it runs no test, starts no Overseer, exits non-zero, and names the Demo_Spa's package directory; and that the gate executes no step after a failing one
    - Assert the Demo_Spa is absent from the dev supervisor's project list for every selector that reaches it, so `npm run dev` invokes no Spa build
    - Assert the release matrix still publishes exactly the two configurations — `*` and `microservice1,microservice2` — with both selector values and the trigger set unchanged
    - Assert every command the README quotes for the two samples resolves to a declared script
    - **What is asserted is the Demo_Spa `build` script's exit status and its position** relative to the first test and the Overseer spawn — **not** the presence of an `index.html` in the Spa_Root. That document is the Demo_Spa's bundler configuration's obligation, checked in the bundle-output test alone, and no step of the Build_System inspects the filename
    - _Requirements: 11.4, 11.5, 11.6, 11.12, 11.13, 11.14, 12.6_

  - [x] 12.7 Write the Container end-to-end test for the extended payload
    - File: `packages/integration-tests/tests/container-extended-config.test.ts`
    - One Overseer composition (or one image run where the suite already builds images) for the selector `microservice3`, asserting `GET /microservice3/config` → 200, `application/json`, and the Extended_Config_Payload for the name `microservice3` and the path `/microservice3`
    - _Requirements: 5.7_

- [x] 13. Checkpoint — step 7 verification gate
  - The ordinary gate, plus `npm start` and a short `npm run dev` session with one source edit
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 11.1, 11.13_
  - **Gate outcome:** `npm run ci` exits 0 (82 test files, all green; typecheck/lint/test:types clean); the tree is untouched by the gate and Microservice2's Subtree_Ownership handlers remain intact. Docker builds / manual `npm start` + `npm run dev` require a live environment; the staged-set, resolver-determinism, peer-shadowing, absent-Spa_Root startup, and extended-payload behaviours they would exercise are all covered by the new/extended integration suites.
  - **Guard false-positive corrected while landing 12.7:** the Integration_Suite scope guard (task 6.4) flagged `container-extended-config.test.ts`'s R5.7 body assertion because its `QUANTIFIER_SOURCES` treated the in-process `makeRegistry([...])` helper as a discovery/registry quantifier. But `makeRegistry(<literal list>)` is an EXPLICIT hand-written enumeration — exactly what R13.8 permits (like mount-dispatch's `MOUNTS`/`PEERS`), not a quantification over discovery or the generated registry. Removed `makeRegistry`/bare-`registry` from the anchors and narrowed them to `readdirSync`, `discover*(`, `generateRegistry(`, `generate-registry`, and `microservice-registry` — the real R13.8 targets. Verified the guard still catches a genuine body-assertion-quantified-over-discovery+generated-registry violation.

- [x] 14. Step 8 — Documentation and steering (last, so they describe what the repo does)

  - [x] 14.1 Update `README.md` for both samples and for Subtree_Ownership
    - **Running locally** — the Demo_Page is served by Microservice1 at the Overseer's base URL itself, its Mount_Root `/`, and is reachable only while Microservice1 is among the Selected_Microservices with its runtime toggle enabled; `npm run build --workspace @microservices/demo` is the command that produces the Spa_Root from the repository root; `npm run dev` neither produces nor refreshes it; and while it is absent the base URL answers 503 with the message naming the path and that command
    - **Shared packages** — Microservice2 consumes `@microservices/config`, Microservice3 consumes `@microservices/extended-config`, and `@microservices/extended-config` consumes `@microservices/config`, each named by package name. Add a subsection covering the `spa` category and `packages/spa/demo`
    - **Shared packages → a "Locating a SPA's build output" block**, placed immediately after the paragraph introducing `packages/spa/demo` so a reader meets it while the sample is in view: state **both** resolution pairs (an `exports` map plus a bare-name resolve, versus no `main`/`exports` plus resolving the package's `package.json`), that the manifest half and the resolution half must match and cannot be mixed — naming the two errors a mismatch produces — that the choice belongs to the microservice and Spa_Package that form the pair rather than to the framework, and that **this sample uses the `exports` pair because every cross-package reference in shipped `src/` code in this repository uses the bare `@microservices/<name>` form**
    - **Building a container image** — the Generic configuration (`*`) stages the Common_Packages `config` and `extended-config` and the Spa_Package `demo`; the Specific configuration (`microservice1,microservice2`) stages `config` and `demo` and does **not** stage `extended-config`; and under that Specific configuration activating the `Microservice 3` button shows 404 in the Status_Field alongside the requested path in the Request_Field, because Microservice3 is not among its Selected_Microservices
    - **Adding a microservice** — two statements written adjacently, explicitly as an obligation and its complement, because read apart they look like a contradiction. The obligation: a microservice owns the subtree rooted at its exported Microservice_Path and answers every request in it itself — including the status it chooses for a path it does not serve and for a method it does not serve — leaving none unhandled for the Overseer, whose responsibilities are exactly two, to mount the enabled Selected_Microservices and to respond 404 where no mount matches; and, as a consequence, a microservice mounted at `/` owns the whole origin, so in a Container holding one the Overseer's catch-all is unreachable, which is intended. The complement: a microservice's framework contract is its exported Microservice_Path plus its exported router, and what it serves there — bodies, content types, and per-method handling including the status code and `Allow` header for a method it does not serve — is its own choice, so Microservice2's identifier body and its `405 Allow: GET` are one sample's choices and Microservice1's `405 Allow: GET, HEAD` is an equally valid one. Join them with the sentence that the obligation fixes only *whether* the microservice answers while *what* it answers stays its own choice
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.7, 12.8, 12.9, 12.12_

  - [x] 14.2 Update `.kiro/steering/structure.md`
    - Correct what this feature makes untrue: `packages/spa/` no longer ships empty; the layout tree gains `common/extended-config/` and `spa/demo/`; and the `common` section's annotation on `config` becomes "consumed by microservice2 and by extended-config"
    - Add to the **`spa` — `packages/spa/<name>/`** Consumer_Category section a bullet alongside the existing ones: a microservice serving a Spa_Package locates the Spa_Root through a **run-time module-resolution call**; either resolution pair is permitted; the manifest half and the resolution half of the chosen pair must match; and the Build_System constrains neither half, because a Spa_Package's category contract is `scripts.build` alone and the invariant checker does not inspect a specifier passed to a module-resolution call. A user adding a second Spa_Package then finds the convention in steering rather than by reading this sample's source
    - Add to the **Microservice package conventions** section a record alongside the existing MUST list: a microservice owns the subtree rooted at its exported Microservice_Path and answers every request in it from its own router — including the status it chooses for a path it does not serve and for a method it does not serve — leaving none unhandled for the Overseer; the Overseer's responsibilities are exactly two, to mount the enabled Selected_Microservices and to respond 404 where no mount matches; the obligation fixes *whether* a microservice answers while the status, headers, and body stay its own choice; and, as a noted consequence, a microservice mounted at `/` owns the whole origin, so the Overseer's catch-all is unreachable in a Container holding one. Leave the existing MUST bullets unchanged — this is an addition to them — and name the three reference microservices as its worked examples, differing deliberately in the status each chooses
    - _Requirements: 12.5, 12.10, 12.13_

  - [x] 14.3 Correct the build-phase-order paragraph in `.kiro/steering/tech.md`
    - Replace the pre-inversion claim that "Required Spa builds run first, each in its own directory; the single `tsc --build` pass runs only after every one of them exits zero" with the order the Build_System implements and the `package-categories` spec defines as normative: the single `tsc --build` pass over the ordered Tsc_Project roots is the **first** phase, and the required Spa_Package bundler builds are the **second**, each still in its own directory, entered only after that pass exits with status 0 — because a Spa_Package's bundler may read a Tsc_Project's compiled output while no Tsc_Project ever reads a Spa_Package's output
    - Correct the "`packages/spa/` ships empty" claim wherever it appears in this document
    - Change **nothing else in `tech.md`**. In particular leave the `workspaces`-array-order claim and the `check:invariants` enforcement claim exactly as they stand: both are stale, both were stale before this feature, and correcting them belongs to the separate Build_System spec that owns the deferred build-order defect (see the Notes below)
    - _Requirements: 12.5, 12.11_

- [x] 15. Final checkpoint — full gate on a cold tree
  - Run the ordinary gate, plus `npm start` and a short `npm run dev` session with one source edit
  - **Run it once on a genuinely cold tree** — no `dist/`, no `*.tsbuildinfo`, no `node_modules/` — because a warm tree hides exactly the ordering defect a new dependency edge could introduce
  - Confirm `npm run ci` after `npm ci` executes every step in its declared order, skipping none, and exits 0; that `check:invariants` reports zero violations for both new packages and for Microservice1; that each of the four scripts of both new packages exits 0; and that the Demo_Spa's `test` script exits 0 under the default Node environment
  - Confirm no test asserts a behaviour Microservice1 no longer has, which is what the boundary correction of step 4 exists to guarantee
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 4.6, 6.4, 6.14, 7.4, 11.1, 11.3, 11.13, 13.18_
  - **Cold-tree gate outcome:** materialised a genuinely cold tree (`git ls-files --cached --others --exclude-standard` → tar into a temp dir; verified no `dist/`, no `*.tsbuildinfo`, no `node_modules/`, no generated registry), ran `npm ci` (its `prepare` populated the empty registry template), then `npm run ci` — **exit 0**, every step in declared order (build → check:invariants → typecheck → lint → test → test:types), 82 test files green, zero invariant violations, no type errors. On the cold tree the three fresh-clone build-order edges hold: `config` before `extended-config`, `extended-config` before `microservice3`, and `demo` before `microservice1` — the evidence that the two new dependency edges introduce no fresh-clone ordering defect. Each of the four scripts of both `@microservices/extended-config` and `@microservices/demo` exits 0, and the Demo_Spa's `test` runs green in the default Node environment. The warm-tree `npm run ci` is likewise green (82 files) and leaves the tree byte-identical. Docker image builds and the manual `npm start` / `npm run dev` walk-through require a live/Docker environment not available here; every behaviour they would exercise (staging, absent-Spa_Root 503, extended payload, method policy) is covered by the integration and per-package suites. "No test asserts a behaviour Microservice1 no longer has" is guaranteed by the step-4 boundary correction plus the Integration_Suite scope guard, both green.

## Notes

- **The eight-step order is fixed, and every step ends on a tree that builds.** There is no atomic step here: each parent task is independently shippable, and each is followed by a checkpoint carrying that step's verification gate.
- **No sub-task is marked optional.** The design designates the twenty-six correctness properties as the requirement evidence, and Requirements 11.7 through 11.11, 11.15, and 13.9 through 13.11 state the test suites as acceptance criteria in their own right — so marking a test sub-task skippable would drop requirement coverage rather than trade speed for scope. The mechanical mirror-oracle and Integration_Suite updates are likewise needed for `npm run ci` to pass at all.
- **No task modifies anything under `packages/build-tools/src/`.** The two Build_System files this plan does touch — `tests/discovery-real-tree.test.ts` and `tests/workspace-build-order-real-tree.test.ts` — are mirrors of the committed repository rather than of behaviour, and each file's own header comment says so. Updating a mirror is not a Build_System change; the scope fence is crossed deliberately and only for data and prose.
- **The root `workspaces` array is not edited.** Its entries already include the globs `packages/common/*` and `packages/spa/*` in topological position, so both new packages are matched by exactly one existing entry with no addition, removal, rename, or reorder. Task 1.1's obligation is to *confirm* that, not to change it. The one root-manifest edit in this plan is the `engines.node` floor.
- **The derived build-order defect is deferred, and no task addresses it.** Design deviation D11 records a completed evaluation of a framework-level defect: once Microservice1 declares `@microservices/demo`, the derived Workspace_Build_Order places `packages/overseer` at position 7 ahead of `packages/microservices/microservice1` at 9, because the Overseer's real compile-time dependency on the selected microservices is structurally undeclarable. This feature does not introduce the defect and does not fix it — it removes the alphabetical coincidence that has been hiding it. It carries no requirement, no task, and no correctness property here. **In particular, no task teaches the workspace-build-order derivation about `buildPosition`, no task changes `scripts/start.js`, and no task corrects `tech.md`'s `workspaces`-array-order or `check:invariants` claims.** All three belong to that separate future spec, along with the sequencing constraint D11 records: re-pointing `npm start` at the derived order must not land before the derivation honours `buildPosition`.
- **`Dockerfile.template` and `scripts/emit-effective-dockerfile.sh` are edited by no task.** The emit script already globs `packages/common/*/package.json` and `packages/spa/*/package.json` and emits a `COPY` line per match at both anchors, so both new packages are picked up as it stands. Task 8.9 asserts that outcome rather than producing it. Neither new package goes on the Exclusion_List — both ship into images, so both must contribute a `COPY` line.
- **The Overseer package is edited by no task**, including its mount ordering and its 404 catch-all, and `packages/overseer/tests/router.property.test.ts` is untouched: it builds its own synthetic stub microservice modules and never imports a reference microservice, so no behaviour change here reaches it. Subtree_Ownership needs no Overseer change — it is an obligation on each microservice's router, and the Overseer's two responsibilities are already exactly what it does. The visible effect is only that its catch-all becomes unreachable in a Container holding a microservice mounted at `/`, which is the principle's intended outcome.
- **The sentinel terminal handler survives only inverted.** Earlier test designs mounted a `599` handler after each router so that a fall-through was observable. Under Subtree_Ownership nothing falls through, so each router's own suite asserts the real status, headers, and body directly with no Overseer composed. The sentinel appears in exactly three places — the router-totality properties of the three microservices — where it is mounted precisely so the property can assert it is never reached, and it is the one assertion that fails if a later edit reintroduces a `next()`.
- **Two method policies differ deliberately.** Microservice1 answers a method it does not serve with `405 Allow: GET, HEAD`; Microservice2 and Microservice3 answer `405 Allow: GET`. Both satisfy the same obligation, and the difference is the sample's way of showing that a method policy is the owning microservice's own choice. That is why the 405 assertions live in three separate suites and why no shared helper hoists them.
- **The `index.html` asymmetry is intended and must not be "fixed" in either direction.** Microservice1 checks for `index.html` because it knows the one HTML-entry Spa_Package it serves; the Image_Tree_Assembler checks only that a staged `dist/` is non-empty, because a Spa_Package's category contract is a non-empty `scripts.build` alone and the framework has no basis for asserting one bundler's output shape. No task adds a filename check to the assembler, and no task removes one from Microservice1.
- **Reviewed, not asserted.** The README and steering prose of Requirement 12 — criteria 1 through 5 and 7 through 13 — is reviewed at task 15's gate rather than pinned by substring tests: such tests are brittle and the repository does not police documentation wording anywhere else. The one exception is criterion 6, that every command the README quotes exits 0, which task 12.6 covers.
- **Not tested, by decision.** The buttons' activation equivalence across Enter, Space, and pointer is a platform guarantee for a native `button` with a `click` listener, and testing it would mean adopting a DOM environment for a fact the platform owns. The announcement behaviour behind the `output` elements' implicit polite live region, and the deliberate non-announcement of the Body_Field, are ARIA mappings the user agent and screen reader own — the markup facts are asserted, the announcement needs manual verification with assistive technology. The 1-second re-enable bound is structural, being a `finally`, so timing it would measure the test runner.
- **Already covered by existing Build_System property suites, so no task duplicates them.** The failure modes of Requirements 1.9, 1.10, 4.8 through 4.10, 5.9, 6.15's staging half, 6.16, 8.7, and 11.14's abort path are general Build_System rules already quantified over generated layouts in `packages/build-tools/tests/`. Re-asserting them for these two packages would test the same code with less coverage.
- **One consequence of Requirement 4.5 worth recording as a negative.** No task asserts that a package-local `build` script is never invoked for the Extended_Config_Package, because on the repository-wide ordered build it always is. The criterion constrains the Image build path alone, and its wording now says so.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1"] },
    { "id": 1, "tasks": ["2.2", "4.1"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5", "2.6", "2.7", "4.2"] },
    { "id": 3, "tasks": ["4.3", "4.4", "4.5", "4.8", "4.9"] },
    { "id": 4, "tasks": ["4.6", "4.7", "6.1", "6.2", "6.3", "6.4"] },
    { "id": 5, "tasks": ["8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3"] },
    { "id": 7, "tasks": ["8.4", "8.5", "8.6", "8.8", "8.9", "8.11"] },
    { "id": 8, "tasks": ["8.7", "8.10", "10.1"] },
    { "id": 9, "tasks": ["10.2", "10.3"] },
    { "id": 10, "tasks": ["10.4", "10.8", "10.9"] },
    { "id": 11, "tasks": ["10.5", "10.6", "10.7", "12.1", "12.2", "12.5", "12.6"] },
    { "id": 12, "tasks": ["12.3", "12.4", "12.7"] },
    { "id": 13, "tasks": ["14.1", "14.2", "14.3"] }
  ]
}
```

The waves obey two constraints. **No two sub-tasks in one wave write the same file.** The four files written by more than one sub-task are the two repository-mirror oracles (2.6, 4.8, 8.8, 10.8 — waves 2, 3, 7, 10), `common-package-conventions.test.ts` (2.7 and 4.9 — waves 2 and 3), and `dev-session-scope.test.ts` (6.3 and 10.9 — waves 4 and 10); every pair sits in a different wave.

**Every source sub-task precedes the tests that assert against it, and every dependency precedes its consumer.** 2.1 before 2.2, which is before all three of the Extended_Config_Package's test sub-tasks and before 4.2, which imports its barrel; 4.1 (Microservice3's manifest) after the package exists in 2.1; 4.2 before 4.3 and 4.4, and 4.5 before 4.6 and 4.7; 8.1 before 8.2, 8.3, and 8.11; 8.3 and 8.2 before 8.6, which wires them together, and 8.6 before 8.7, which asserts over its sources; 8.1 and 8.2 before 8.10, which parses the bundler's output; 8.1 before 10.1, since Microservice1 cannot declare a package that does not exist; 10.2 and 10.3 before 10.4, which composes them, and 10.4 before all three of Microservice1's suites and before the two integration tests (12.3, 12.4) that compose an Overseer over the finished routers. Step 4's boundary-correction sub-tasks (6.1 through 6.4) sit in wave 4, before every Microservice1 change, which is the whole point of placing that step where it is.

# Implementation Plan: shared-packages

## Overview

Implementation proceeds in five movements, each of which leaves the workspace in a buildable state:

1. **Create the Sample_Shared_Package** (`packages/config/`) and wire it into the root `workspaces` array in topological position, so every later `npm run build --workspaces` resolves `@microservices/config` on a fresh clone.
2. **Add the pure Build_System module** (`packages/build-tools/src/shared-packages.ts`) — discovery plus the Required_Shared_Packages closure — with its property tests. Pure and injectable, so it is fully testable before anything consumes it.
3. **Generalize the image-tree assembler** to drive the `tsc --build` list and the staging loop from the closure, dropping the hard-coded `contracts` special-case and adding the non-required-shared-package minimality guard.
4. **Relocate the config concern** out of `microservice2`'s inline literal into the shared helper, and make `microservice3` a second consumer.
5. **Integration tests and the full quality gate** — endpoint contracts, Image_Tree staging for two selectors, the generated Dockerfile manifest lines, and `npm run ci`.

Language: TypeScript (strict, ES modules, Node 22), matching the existing workspace. Property tests use `fast-check` with a minimum of 100 iterations and carry the tag comment `Feature: shared-packages, Property {number}: {property_text}`.

## Tasks

- [x] 1. Create the Sample_Shared_Package and make the workspace topological
  - [x] 1.1 Create the `packages/config/` package skeleton
    - Add `packages/config/package.json`: `@microservices/config`, `"private": true`, `"type": "module"`, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, the four standard scripts (`build`, `test`, `lint`, `typecheck`), and `"dependencies": { "@microservices/contracts": "*" }`
    - Add `packages/config/tsconfig.json` extending `../../tsconfig.base.json`, emitting to `dist/`, mirroring `packages/contracts/tsconfig.json`
    - _Requirements: 2.1, 2.2, 2.3, 11.1, 11.2_

  - [x] 1.2 Implement the `packages/config/src/index.ts` barrel
    - Export the `SampleConfig` and `ConfigPayload` types, the `sampleConfig` constant (`sampleSetting: "example-value"`, `description: "demonstration sub-endpoint"`), and `buildConfigPayload(name, path)` returning `{ "microservice-name": name, path, config: sampleConfig }`
    - Import types from `@microservices/contracts` by package name only, creating the `config → contracts` shared-package edge; import nothing from any microservice or the Overseer
    - Keep the barrel the sole stable public API
    - _Requirements: 2.4, 3.4, 11.3, 11.4_

  - [x] 1.3 Insert `packages/config` into the root `workspaces` array
    - Order becomes: `packages/contracts`, `packages/config`, `packages/build-tools`, `packages/microservices/*`, `packages/overseer`, `packages/integration-tests`
    - `contracts` stays first (its dependency); `config` precedes every consumer and the Overseer
    - _Requirements: 4.1, 4.2, 11.5, 14.1_

  - [x] 1.4 Write property test for the config helper
    - `packages/config/tests/build-config-payload.property.test.ts`
    - **Property 7: The config helper echoes identity and carries the shared config block**
    - **Validates: Requirements 12.4**

- [x] 2. Add the pure shared-package discovery and closure module
  - [x] 2.1 Create `packages/build-tools/src/shared-packages.ts` with discovery
    - Define the `SharedPackage` interface (`name`, `dirName`, `packageDir`, `sharedDependencies`)
    - Implement `discoverSharedPackages()` returning `Map<packageName, SharedPackage>`: a candidate qualifies iff its `package.json` declares an `@microservices`-scoped `name` with both `main` and `types`, and it is not `@microservices/overseer`
    - Exclude the `packages/microservices/` namespace container, bin-only tooling (`build-tools`, no `main`/`types`), and test-only packages (`integration-tests`) by classification, not by a second hand-maintained name list
    - Take the directory listing and a `readManifest` reader as injectable inputs so the logic is pure and testable against in-memory layouts
    - _Requirements: 1.1, 1.2, 1.3, 3.2, 3.3_

  - [x] 2.2 Write property test for discovery classification
    - `packages/build-tools/tests/shared-packages.discovery.property.test.ts`
    - **Property 1: Discovery classifies exactly the shared packages**
    - **Validates: Requirements 1.1, 1.2, 3.2, 3.3**

  - [x] 2.3 Implement `requiredSharedPackages()` — the closure in topological order
    - Transitive closure over `@microservices`-scoped `dependencies` of the selected microservices plus the Overseer, restricted to discovered shared packages, returned with every package before its dependents
    - Take a `readDependencies(packageDir)` reader as an injected input; use a visited set so a malformed cycle terminates instead of looping
    - Throw `[shared:unresolved] "<consumer>" depends on unknown @microservices package(s): "<name>"` (sorted, deduplicated) for a dangling dependency
    - _Requirements: 6.3, 6.4, 7.1, 7.3_

  - [x] 2.4 Write property test for the closure
    - `packages/build-tools/tests/shared-packages.closure.property.test.ts`
    - **Property 3: The staged shared set equals the Required_Shared_Packages closure**
    - **Validates: Requirements 6.1, 7.1, 7.3, 7.4, 10.2, 14.2, 14.3**

  - [x] 2.5 Write property test for topological ordering
    - `packages/build-tools/tests/shared-packages.order.property.test.ts`
    - **Property 4: Build and workspace order are topological**
    - **Validates: Requirements 4.1, 4.2, 6.3, 14.1**

  - [x] 2.6 Write property test for the unresolvable-dependency failure
    - Extend `packages/build-tools/tests/shared-packages.closure.property.test.ts`
    - **Property 5: An unresolvable shared dependency fails the build**
    - **Validates: Requirements 6.4**

- [x] 3. Checkpoint - shared package and pure module
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Generalize the image-tree assembler
  - [x] 4.1 Drive the build list and staging from the closure
    - In `packages/build-tools/src/image-tree.ts`, add `readSharedDeps(packageDir)` reading the `@microservices`-scoped `dependencies` keys of a workspace manifest
    - Call `discoverSharedPackages()` + `requiredSharedPackages(selected, shared, readSharedDeps)`; emit the `tsc --build` list as required shared packages (topological) → selected microservices → overseer
    - Stage each required shared package with `copyPackage` as a real directory at `node_modules/@microservices/<name>` (`package.json` + `dist/`), never a symlink
    - Remove the literal `packages/contracts` from the build list and the hard-coded contracts `copyPackage` call; contracts re-enters through the closure because the Overseer depends on it
    - Update the layout comment at the top of the file to describe shared packages generally
    - _Requirements: 6.1, 6.2, 6.3, 7.1, 7.4, 10.2, 14.2, 14.3_

  - [x] 4.2 Add the non-required-shared-package minimality guard
    - Extract the existing check as `assertNoUnselectedMicroservice(outDir, selected)` with unchanged behavior
    - Add `assertNoNonRequiredSharedPackage(outDir, shared, required)`: for every discovered-but-not-required shared package present under `<outDir>/node_modules/@microservices/`, throw `[image-tree] non-required shared package "@microservices/<name>" found in …`, naming the offender
    - Call both guards after assembly so any regression exits non-zero locally and in CI
    - _Requirements: 7.2_

  - [x] 4.3 Write example test for the minimality guard
    - `packages/build-tools/tests/image-tree-minimality.test.ts`: inject a stray non-required shared directory into a temp `outDir` and assert the guard throws naming it
    - **Property 6: A non-required staged shared package fails the minimality guard**
    - **Validates: Requirements 7.2**

  - [x] 4.4 Extend the registry-generator property test for shared packages
    - In `packages/build-tools/tests/registry-generator.property.test.ts`, widen the generated layouts to include top-level shared-package names
    - **Property 2: The generated registry never contains a shared package**
    - **Validates: Requirements 5.1, 5.2, 5.3, 11.6**

- [x] 5. Relocate the config concern into the shared package
  - [x] 5.1 Make `microservice2` consume `@microservices/config`
    - Add `"@microservices/config": "*"` to `packages/microservices/microservice2/package.json` `dependencies`
    - In `src/index.ts`, replace the inline `/config` object literal with `buildConfigPayload("microservice2", path)`, imported by package name only
    - Keep the response `200` + `application/json` and the body byte-equivalent to the pre-relocation Config_Payload; leave `GET /`, the `ALL /` 405 fallback, and their registration order untouched
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 5.2 Make `microservice3` a second consumer
    - Add `"@microservices/config": "*"` to `packages/microservices/microservice3/package.json` `dependencies`
    - Register a `GET /config` handler after `GET /` and before `ALL /` returning `buildConfigPayload("microservice3", path)`, imported by package name only
    - Leave `GET /` and the 405 fallback unchanged; import nothing from any peer microservice
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

- [x] 6. Checkpoint - assembler and consumers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Integration tests across the pipeline
  - [x] 7.1 Extend `packages/integration-tests/tests/endpoint-contract.test.ts`
    - Tighten the `microservice2 GET /config` case to deep-equal the known Config_Payload; add a `microservice3 GET /config` case deep-equalling `buildConfigPayload("microservice3", "/microservice3")`
    - Confirm `GET /` (two keys) and `POST -> 405 Allow: GET` still pass for both services
    - _Requirements: 12.3, 12.5, 13.3, 13.4_

  - [x] 7.2 Add an Image_Tree staging test
    - `packages/integration-tests/tests/shared-package-staging.test.ts`: assemble for a selector including `microservice2` and assert `node_modules/@microservices/config` and `.../contracts` exist as real directories with `package.json` + `dist`; assemble for a `microservice1`-only selector and assert `config` is absent while `contracts` is present
    - _Requirements: 6.1, 6.2, 7.1, 7.3, 14.2, 14.3_

  - [x] 7.3 Extend `packages/integration-tests/tests/effective-dockerfile.test.ts`
    - Assert the generated Dockerfile carries `COPY packages/config/package.json packages/config/` in both the build-stage and prod-deps manifest blocks via the unchanged glob, and that `config` is not in the exclusion list
    - _Requirements: 8.1, 8.2, 8.3, 14.4_

  - [x] 7.4 Add a shared-package conventions test
    - `packages/integration-tests/tests/shared-package-conventions.test.ts`: assert `packages/config/package.json` fields (`type`, scoped name mirroring the directory, `main`/`types` under `dist/`, four scripts, no microservice/Overseer dependency); assert the barrel exports `sampleConfig`, `buildConfigPayload`, and the two types; assert `microservice2` and `microservice3` manifests declare `@microservices/config`; assert the root `workspaces` array places `packages/config` after `packages/contracts` and before `packages/microservices/*` and `packages/overseer`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 11.2, 11.5, 12.1, 13.1_

- [x] 8. Document the shared-package workflow
  - [x] 8.1 Add a shared-package section to the README
    - Describe the Shared_Package_Location, the package conventions, the required `workspaces` ordering (and that a misordered entry is what breaks a fresh-clone build), and how a microservice declares and imports a shared dependency
    - _Requirements: 4.3, 9.1, 9.2, 9.3, 10.1_

- [x] 9. Final checkpoint - full quality gate
  - Run `npm run ci` (build, typecheck, lint, test, test:types) and ensure it passes with `packages/config` present and consumed by `microservice2` and `microservice3`
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 10.2, 10.3_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; core implementation tasks are never optional.
- Every property test carries the tag comment `Feature: shared-packages, Property {number}: {property_text}` and runs at least 100 `fast-check` iterations.
- Task 1.3 (workspaces ordering) lands before any task expects a fresh-clone build to resolve `@microservices/config`.
- `generate-registry.ts`, `Dockerfile.template`, and `scripts/emit-effective-dockerfile.sh` are intentionally untouched; tasks 4.4, 7.3 assert those guarantees rather than change the sources.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2"] },
    { "id": 2, "tasks": ["1.3", "2.3"] },
    { "id": 3, "tasks": ["1.4", "2.4"] },
    { "id": 4, "tasks": ["2.5", "2.6", "4.1"] },
    { "id": 5, "tasks": ["4.2", "4.4"] },
    { "id": 6, "tasks": ["4.3", "5.1", "5.2"] },
    { "id": 7, "tasks": ["7.1", "7.2", "7.3", "7.4"] },
    { "id": 8, "tasks": ["8.1"] }
  ]
}
```

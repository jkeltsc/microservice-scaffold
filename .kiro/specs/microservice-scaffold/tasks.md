# Implementation Plan: Microservice Scaffold

## Overview

This plan turns [requirements.md](./requirements.md) and [design.md](./design.md) into an ordered series of small, atomic coding tasks. The scaffold is a TypeScript monorepo (Node 22 LTS, npm workspaces, ES modules) composed of:

- `packages/contracts/` — shared types
- `packages/microservices/{microservice1,microservice2,microservice3}/` — the three reference services
- `packages/build-tools/` — selector parser, namespace listing, registry generator, image helpers
- `packages/overseer/` — Express app, boot pipeline, toggle/routing logic
- `packages/integration-tests/` — cross-package integration coverage
- Root `Dockerfile` and `.github/workflows/release.yml` — Container builds and GHCR publish pipeline

Tests are interleaved with implementation. Property-based tests use `fast-check` and each maps to one of Properties 1, 1b, 2, 3, 4, 6, 7, 8, 9 defined in the design's Correctness Properties section. Optional test sub-tasks are marked with `*`; core implementation tasks are never optional.

Every leaf task cites the requirement clauses it satisfies (e.g., `R4.3, R7.1`) and, where applicable, the correctness property it implements (e.g., `Property 6`).

## Tasks

- [x] 1. Bootstrap the monorepo scaffolding
  - [x] 1.1 Create the root `package.json`
    - Declare `"type": "module"`, `"private": true`, `"engines": { "node": ">=22", "npm": ">=10" }`, and `"workspaces": ["packages/contracts", "packages/build-tools", "packages/microservices/*", "packages/overseer", "packages/integration-tests"]`
    - The array order **is** the build order: `npm run <script> --workspaces` visits packages in the order listed. The original order put `packages/overseer` ahead of `packages/microservices/*`, which inverted the dependency — the generated registry statically imports `@scaffold/microservice<N>`, so on a fresh clone `npm start` (generate registry → build) failed with `TS2307: Cannot find module '@scaffold/microservice1'`, and CI needed a second targeted Overseer rebuild after generating the registry. Reordered so the Overseer follows the microservices; the extra CI rebuild step was removed with it
    - Add root scripts: `build`, `test`, `lint`, `typecheck` (each delegating with `--workspaces`), plus `start` pointing to `node scripts/start.js`
    - Add shared devDependencies: `typescript`, `vitest`, `fast-check`, `eslint`, `prettier`, `@types/node`
    - _Requirements: R10.1_
  - [x] 1.2 Create `tsconfig.base.json`, `.gitignore`, and `.editorconfig`
    - `tsconfig.base.json`: `strict: true`, `target: ES2023`, `module: NodeNext`, `moduleResolution: NodeNext`, `declaration: true`, `composite: true`, `esModuleInterop: true`, `skipLibCheck: true`
    - `.gitignore`: `node_modules/`, `dist/`, `packages/overseer/src/generated/`, editor and OS junk
    - `.editorconfig`: two-space indent, LF, final newline, UTF-8
    - _Requirements: R10.2 (shared config guarantees identical build semantics)_
  - [x] 1.3 Add ESLint and Prettier root configuration
    - ESLint 9 flat config (`eslint.config.js`) with `@typescript-eslint` recommended + `eslint-config-prettier`; forbid CommonJS
    - `.prettierrc` with two-space indent, single quotes off, trailing commas, LF line endings
    - _Requirements: none directly; steering compliance_
  - [x] 1.4 Add root Vitest workspace configuration
    - Create `vitest.workspace.ts` (or `vitest.config.ts` + per-package configs) enabling `--run` mode for CI
    - Configure `fast-check` default `numRuns: 100`
    - _Requirements: none directly; enables all property tests_

- [x] 2. Build the `packages/contracts` package
  - [x] 2.1 Create the contracts package skeleton
    - `packages/contracts/package.json` with `"type": "module"`, name `@scaffold/contracts`, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"exports"` field for `.` and `./testing`, four required scripts
    - `packages/contracts/tsconfig.json` extending `../../tsconfig.base.json` with `outDir: ./dist`, `rootDir: ./src`
    - Empty `src/index.ts` placeholder
    - _Requirements: R8.1_
  - [x] 2.2 Define the core contract types in `src/index.ts`
    - Export `MicroserviceModule` (`path`, `router: Router` — no identifier; the directory name is authoritative and the generator puts it on the entry), `RegistryEntry` (`identifier`, `module`, `sourcePackage`), `MicroserviceRegistry`, and `ToggleMap` exactly as specified in design "Data Models"
    - `Selector` (the parsed-selector discriminated union) was originally exported here too; it has since moved into `packages/build-tools/src/selector.ts` as a local, non-exported declaration, because narrowing that module to `resolveSelected` left the type with one module-internal consumer (see 5.2)
    - Add `express` as a `dependencies` entry (needed for the `Router` type re-export)
    - _Requirements: R8.1, R8.4, R6.3_
  - [x] 2.3 ~~Implement `validateMicroservicePath` in `src/validate-path.ts`~~ — deleted, inlined into boot.ts
    - The entire function reduced to `path.startsWith("/")` — `false` for `""`, so the non-empty check was already covered. The one-liner is now inlined directly in `boot.ts` step 2. `src/validate-path.ts`, its `dist/` artifacts, and its re-export from `src/index.ts` are deleted
    - Historical: this task originally produced `src/assert.ts` with `assertMicroserviceModule(m: unknown, sourcePackage: string)`, a `MicroserviceModuleError` carrying a `defects` array, and a `ROUTER_METHODS` structural probe of the router's `use`/`get`/`post`/... members. All of it was deleted as redundant with the build's own type check, and the file was renamed to `validate-path.ts` so it is not named for an assertion it no longer makes. The validator itself was then deleted when the check was inlined
    - _Requirements: R8.5_
  - [x] 2.4* ~~Write property test for Microservice_Path validation~~ — deleted
    - **Property 5: Microservice_Path validation** — removed from the design. The check is now `path.startsWith("/")`, a single standard-library call inlined in boot step 2. A property test over `fc.string()` asserting that `s.startsWith("/")` agrees with `s.length > 0 && s.startsWith("/")` would be testing JavaScript, not the scaffold
    - `packages/contracts/tests/path-validation.property.test.ts` has been deleted. The boot test already covers the path-failure case with message assertions
  - [x] 2.5 Build the shared fast-check arbitraries under `testing/arbitraries.ts`
    - Implement `arbIdentifier`, `arbPath`, `buildExpressRouter` (a plain builder, not an arbitrary), `arbSelectorString`, `arbNamespaceDirectories`, `arbEnvironment`, `arbHttpMethodNonGet` (plus the `toggleVarName` helper)
    - Historical: this task originally also added `arbPathPair` (equal / segment-prefix / shared-raw-prefix categories), `arbMicroserviceModule` (a whole-`{ path, router }` generator), `arbIdentifiedMicroserviceModule` (`{ identifier, module }`, with `arbMicroserviceModule` as a `.map` projection of it) and `arbExpressRouter`. All have since been deleted as dead code. `arbPathPair` was removed when the collision property test was replaced by example-based tests in boot.test.ts. The latter three existed to support a Property 1 quantified over *generated* routers, which would have meant testing `buildExpressRouter`, a test helper, against itself; Property 1's genuine universal quantification is over HTTP methods (`arbHttpMethodNonGet`) against the three real reference routers. `arbMicroserviceModule`'s only consumer was Property 5 while that property still validated module *shape* at runtime; when the shape check moved to compile time and Property 5 narrowed to quantifying over path strings, the generator lost its last consumer. `buildExpressRouter` stays and is used directly wherever a test needs controlled identifier/path relationships (Properties 8, 9)
    - Export from `testing/index.ts`, wire the `./testing` sub-path export in `package.json`
    - _Requirements: enables Properties 1, 1b, 2, 3, 4, 7, 8, 9_
  - [x] 2.6* Write compile-time type tests for the module boundary
    - File: `packages/contracts/tests/types.test-d.ts`
    - Pin `keyof MicroserviceModule` to exactly `"path" | "router"`; assert internals cannot be typed and that `identifier` specifically is NOT typeable through the public module contract
    - _Requirements: R8.4_

- [x] 3. Build the three reference microservices
  - [x] 3.1 Create `packages/microservices/microservice1/` skeleton
    - `package.json` with name `@scaffold/microservice1`, `"type": "module"`, `express` runtime dep, `@scaffold/contracts` workspace dep, four scripts
    - `tsconfig.json` extending `../../../tsconfig.base.json`
    - _Requirements: R1.1, R1.2, R8.3_
  - [x] 3.2 Implement `microservice1`'s router and exports in `src/index.ts`
    - Export exactly two values: `path = "/"` and `router = createRouter()`. No identifier export — the directory name is the identifier
    - `createRouter()` registers `router.get("/", ...)` returning `200` `application/json` with body `{ "microservice-name": "microservice1", path }` (exactly those two keys). The name is a literal (nothing left to derive it from, and it only exists to make the samples distinguishable); `path` references the exported constant, because that is what the Overseer mounts at
    - Register `router.all("/", ...)` AFTER the GET, returning `405` with `Allow: GET`
    - _Requirements: R1.1, R2.1, R2.2, R2.3, R2.4, R8.1_
  - [x] 3.3* Write property test for microservice1's endpoint contract
    - **Property 1: Microservice endpoint contract at the mount path**
    - **Validates: Requirements R2.1, R2.2, R2.3, R2.4**
    - File: `packages/microservices/microservice1/tests/handler.property.test.ts`
    - Property 1 restated over `(name, path)`: a GET at the exported `path` returns `{ "microservice-name": N, path }`, where `N` is pinned here as the literal `"microservice1"` (the module exports no identifier to source it from, so this assertion is the only pin on the sample's reported name)
    - Use `arbHttpMethodNonGet` for the 405 branch; mount the router in a bare Express app and issue requests via `supertest` (or Node's `fetch` against `app.listen(0)`)
  - [x] 3.4 Create `packages/microservices/microservice2/` skeleton
    - Same shape as 3.1 with name `@scaffold/microservice2`
    - _Requirements: R1.1, R1.2, R8.3_
  - [x] 3.5 Implement `microservice2`'s router with a `/config` sub-endpoint
    - Export exactly two values: `path = "/microservice2"` and `router`. No identifier export
    - Router registers `router.get("/", ...)` for the identifier response (name as the literal `"microservice2"`, `path` from the exported constant), `router.all("/", ...)` for 405, and additionally `router.get("/config", ...)` returning `200` `application/json` with a JSON object body (illustrative fields) demonstrating a microservice-owned sub-endpoint
    - _Requirements: R1.1, R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R8.1_
  - [x] 3.6* Write property tests for microservice2 covering root and sub-endpoint
    - **Property 1: Microservice endpoint contract at the mount path**
    - **Property 1b: microservice2 sub-endpoint contract**
    - **Validates: Requirements R2.1, R2.2, R2.3, R2.4, R2.6**
    - File: `packages/microservices/microservice2/tests/handler.property.test.ts`
    - Property 1 restated over `(name, path)`, with the name pinned here as the literal `"microservice2"` (no identifier export to source it from)
    - One `it.prop` block per property; the sub-endpoint test parses the response body and asserts it is a JSON object
  - [x] 3.7 Create `packages/microservices/microservice3/` skeleton
    - Same shape as 3.1 with name `@scaffold/microservice3`
    - _Requirements: R1.1, R1.2, R8.3_
  - [x] 3.8 Implement `microservice3`'s router and exports
    - Export exactly two values: `path = "/microservice3"` and `router`; no identifier export. Router mirrors microservice1's contract (root GET reporting the literal `"microservice3"` plus the 405 fallback)
    - _Requirements: R1.1, R2.1, R2.2, R2.3, R2.4, R8.1_
  - [x] 3.9* Write property test for microservice3's endpoint contract
    - **Property 1: Microservice endpoint contract at the mount path**
    - **Validates: Requirements R2.1, R2.2, R2.3, R2.4**
    - File: `packages/microservices/microservice3/tests/handler.property.test.ts`
    - Property 1 restated over `(name, path)`, with the name pinned here as the literal `"microservice3"`
  - [x] 3.10* Write example-based tests pinning the reported name and path constants
    - No separate `tests/constants.test.ts` files exist: these pins live inside each microservice's `tests/handler.property.test.ts`, where Property 1 consumes them. With the identifier no longer exported, the only values left to pin are the exported `path` and the literal name the root response reports — both already asserted there
    - Assert the reported `microservice-name` and `path` equal their documented values (R1.1, R1.3)
    - _Requirements: R1.1, R1.3_

- [x] 4. Checkpoint - Contracts and microservices compile and pass tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Build the `packages/build-tools` package
  - [x] 5.1 Create the build-tools package skeleton
    - `package.json` with name `@scaffold/build-tools`, `"type": "module"`, `"bin"` entries for `generate-registry` and `build-image-tree`
    - **No barrel and no `main`/`types`.** This is a bin-only tooling package: its interface is the two CLI entry points, nothing imports it by package name (each bin imports its module by path, and the modules import each other by path), so `src/index.ts` plus `main`/`types` advertised a package-level API no consumer had. The one non-bin consumer is `packages/integration-tests/tests/effective-dockerfile.test.ts`, which deep-imports the compiled modules (`@scaffold/build-tools/dist/selector.js`, `dist/generate-registry.js`) the way the suite already reaches the Overseer. The exception is recorded in `.kiro/steering/structure.md`
    - `tsconfig.json` extending `../../tsconfig.base.json`
    - _Requirements: R5, R6, R10_
  - [x] 5.2 Implement selector parsing and application in `src/selector.ts`
    - Export **only** `resolveSelected(selector, directories)`. The parse step, the parsed-selector type and the unmatched-identifier error are internal: `resolveSelected` is the parser's only caller, nothing catches the error (it propagates out of the bin), and the error is a plain `Error` carrying the documented message rather than a subclass with an inspectable field
    - Semantics per design "Selector parsing": treat undefined / empty / whitespace-only / `*` / zero-entry as "all"; otherwise split on `,`, trim, discard empties, keep order
    - The parsed-selector type is declared locally here, not exported from `contracts`: once the parser stopped being exported its only consumer was the function that produces it
    - _Requirements: R5.2, R6.1, R6.2, R10.3, Property 2_
  - [x] 5.3* Write property test for selector semantics
    - **Property 2: Selector parsing**
    - **Validates: Requirements R5.2, R6.1, R6.2, R10.3**
    - File: `packages/build-tools/tests/selector-semantics.property.test.ts` (renamed from `selector-parser.property.test.ts`)
    - Stated over `resolveSelected` — the outcome — rather than the internal parse representation: an all-selector resolves to every discovered directory in discovery order, a list-selector to exactly the named identifiers in selector order. The namespace passed in always carries a sentinel directory no selector under test can name, so all-vs-list is unambiguous
    - Use `arbSelectorString` and the pinned edge cases (`""`, `"  "`, `",,,"`, `" microservice1 , microservice2 "`, `"*"`, `undefined`)
  - [x] 5.4 Implement the namespace listing
    - `listMicroserviceDirectories(namespacePath?)` lists `packages/microservices/` (path injectable for tests) and returns the direct subdirectory names sorted lexicographically
    - Lives in `src/generate-registry.ts` next to its only two callers (the generator and the toggle emitter); it is five lines and does not warrant its own module
    - No `package.json` reading and no content validation: a malformed candidate fails later at `tsc` build time via the generated static import
    - No duplicate detection at all: directory names are unique and one entry is emitted per directory, so identifier uniqueness holds by construction end-to-end — it is not checked here and, per R9.1, not at Overseer boot either. Throws on an unreadable namespace
    - _Requirements: R5.1, R5.5_
  - [x] 5.5 Implement the registry generator in `src/generate-registry.ts`
    - Composes the directory listing with `resolveSelected` (which parses the selector internally): resolves requested identifiers against the listed directories, throws `[selector:unmatched]` naming every unmatched identifier, throws `[selector:empty]` on an empty namespace under `*`
    - Emits `packages/overseer/src/generated/registry.ts` with static `import * as m<N> from "@scaffold/<identifier>"` lines and a typed `MicroserviceRegistry` export exactly as shown in design "Registry Generator". Each emitted row is `{ identifier: "<dir>", module: m<N>, sourcePackage: "@scaffold/<dir>" }` — the generator is where the directory name becomes the recorded identifier, since it is the component that listed the directory
    - `generateRegistry(selector = process.env.MICROSERVICES)` writes to the well-known output path relative to cwd; no options object, no injected directory list, no no-write mode. Properties 3 and 4 are exercised through `resolveSelected`, the pure selection function the generator composes with the listing
    - _Requirements: R5.1, R5.2, R5.3, R5.5, R6.1, R6.2, R10.2, Property 3_
  - [x] 5.6* Write property test for registry selection
    - **Property 3: Registry selection**
    - **Validates: Requirements R5.1, R5.3, R5.5, R6.1, R6.2, R10.2**
    - File: `packages/build-tools/tests/registry-generator.property.test.ts`
    - Use `arbSelectorString` and `arbNamespaceDirectories`; assert identifier-set equality on success and the empty-namespace throw
    - Asserts `resolveSelected` only. The all/list classification comes from a local oracle in the test file rather than from the parser, which is internal to `selector.ts`
  - [x] 5.7* Write property test for unmatched-identifier error
    - **Property 4: Unmatched-identifier error**
    - **Validates: Requirements R5.4, R6.4, R10.4**
    - File: `packages/build-tools/tests/registry-generator.unmatched.property.test.ts`
    - Generate selectors whose list contains ≥1 identifier absent from the generated namespace, and repeat some requested identifiers so deduplication is actually exercised
    - Assert the thrown error's **message** names exactly the deduplicated, sorted set difference: the message is the operator-facing contract pinned in design "Error message shape", and nothing catches the error, so there is no structured field worth keeping. The test parses the quoted identifiers back out of the message and compares the whole list, so the assertion is exact set equality in both directions plus the documented ordering — not a substring check
  - [x] 5.8 Add a CLI wrapper for the generator in `src/bin/generate-registry.ts`
    - Three lines: shebang, import, `generateRegistry()`. The selector comes from `process.env.MICROSERVICES`; the output path and the repo-root assumption (cwd) live in the core function
    - Errors propagate uncaught, so Node prints them and exits non-zero
    - Register the bin in `package.json`
    - _Requirements: R5.4, R5.5, R10.1, R10.4_
  - [x] 5.9 Implement the toggle-defaults emitter as `scripts/emit-effective-dockerfile.sh`
    - Superseded the original TypeScript `emit-toggle-env` bin: CI must produce the effective Dockerfile after checkout with no `actions/setup-node` and no `npm ci`, so the emitter is dependency-free POSIX sh + awk instead of a build-tools entry point
    - Reads `MICROSERVICES`, resolves it (`*`/unset/empty/whitespace-only → list `packages/microservices`; otherwise the trimmed comma-separated entries), and writes `Dockerfile.effective` = base `Dockerfile` + one `ENV MICROSERVICE_<X>_ENABLED=enabled` line per identifier injected before the last `ENTRYPOINT`, plus a header naming the selector
    - Honors `DOCKERFILE`, `EFFECTIVE_DOCKERFILE`, `MICROSERVICE_NAMESPACE` overrides; deliberately does not validate identifiers — `generate-registry` inside the container stays the authority and fails the build with `[selector:unmatched]`
    - _Requirements: R6.6_
  - [x] 5.10 ~~Implement the image-suffix helper in `src/image-suffix.ts`~~ — removed
    - Historical: this task added `deriveImageSuffix(selector)` in `src/image-suffix.ts` (`"generic"` for `{kind: "all"}`, otherwise `identifiers.map(toLowerCase).join("-")`)
    - The helper and its export have since been deleted. Its only consumer was `buildDockerBuildArgs` in the `container-build` helper, which task 5.12 removed during the `/out` redesign; CI never called it, so nothing was left to consume it
    - R11.4's naming rule is now expressed directly in the `release.yml` matrix, where each leg carries a literal `image_suffix` (`generic`, `microservice1-microservice2`)
    - _Requirements: R11.4 (no longer implemented in TypeScript)_
  - [x] 5.11* ~~Write property test for image-name derivation~~ — removed
    - Historical: this task added `packages/build-tools/tests/image-name.property.test.ts` covering the design's Property 11 (image-name derivation)
    - Deleted along with the helper it exercised (see 5.10); Property 11 is gone from the design, so no property backs R11.4 anymore
  - [x] 5.12 Implement the image-tree assembler in `src/image-tree.ts` and CLI in `src/bin/build-image-tree.ts`
    - Replaced the original docker-invoking container-build helper: the image is built by `docker build` directly (see 10.1/10.2), and build-tools' job is to stage what goes into it
    - `buildImageTree(outDir = "/out")` generates the registry for `MICROSERVICES`, resolves the selected identifiers, runs `npx tsc --build packages/contracts <selected microservices…> packages/overseer` (explicit order: the generated registry imports `@scaffold/<id>`, those projects are not references of the Overseer, and contracts must precede the microservices that resolve it through `node_modules`), runs `npm prune --omit=dev`, then assembles `outDir`
    - `outDir` layout: third-party runtime `node_modules/`, `node_modules/@scaffold/contracts/` and `node_modules/@scaffold/<selected>/` as real directories (package.json + dist, symlinks dereferenced), and `packages/overseer/`. No `packages/microservices/`, no root `package.json`. The assemble step skips the `@scaffold` scope, `.bin`, and the empty scope directories `npm prune` leaves behind
    - Post-assemble integrity check: after assembling, lists all microservice directories, subtracts the selected set, and verifies no unselected microservice leaked into `outDir/node_modules/@scaffold/`. Throws `[image-tree] unselected microservice "<name>" found in …` if any is present. This catches assembler bugs at build time, locally and in CI, identically — replacing the former CI-only image-scope assertion step
    - Register the bin in `package.json`. (Historical: this task also listed the barrel's exports as the package's public API. The barrel is gone — see 5.1 — and the package's interface is now its two bins; each module exports only what its own callers need: `resolveSelected`, `generateRegistry` + `listMicroserviceDirectories`, `buildImageTree`)
    - _Requirements: R6.1, R6.2, R6.5, R11.3_

- [x] 6. Checkpoint - build-tools generates a valid registry
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Build the `packages/overseer` package
  - [x] 7.1 Create the overseer package skeleton
    - `package.json` with name `@scaffold/overseer`, `"type": "module"`, `express` runtime dep, `@scaffold/contracts` workspace dep, four scripts
    - `tsconfig.json` extending `../../tsconfig.base.json` (with reference to contracts)
    - Add `src/generated/` to a package-local `.gitignore` entry
    - _Requirements: R3.1_
  - [x] 7.2 Implement `src/config.ts` (runtime config)
    - Read `PORT` env var, default to `8080`; return a typed `AppConfig` object
    - _Requirements: R3.1_
  - [x] 7.3 Implement `src/toggles.ts` (toggle parsing and validation)
    - Export `parseToggle(raw: string): { ok: true, enabled: boolean } | { ok: false, rawValue: string }` with case-insensitive token mapping per design "Accepted tokens"
    - Export `validateToggles(registry, env)` producing `{ ok: true, toggleMap } | { ok: false, missing, invalid, unknownEnabled }` — collects all four categories in one pass
    - _Requirements: R4.1, R4.3, R4.5, R7.1, R7.2, R7.3, Properties 7, 8_
  - [x] 7.4* Write property test for toggle-token parsing
    - **Property 7: Toggle-token parsing**
    - **Validates: Requirements R4.1, R4.5**
    - File: `packages/overseer/tests/toggle-token.property.test.ts`
    - Cover accepted tokens with case/whitespace variations, and arbitrary rejected strings via `fc.string`
  - [x] 7.5* Write property test for boot toggle validation
    - **Property 8: Boot toggle validation**
    - **Validates: Requirements R4.3, R7.1, R7.2, R7.3**
    - File: `packages/overseer/tests/toggle-validation.property.test.ts`
    - Use `arbEnvironment` composed with a generated registry; assert each of `Missing`, `Invalid`, `PhantomEnabled` sets is reported exactly, `PhantomDisabled` is ignored
  - [x] 7.6 Implement `src/collision.ts` (prefix path collision detection)
    - Export `detectCollisions(entries, reservedIntrospectionPath): CollisionResult`, where `CollisionResult` is `{ ok: true } | { ok: false, pathCollisions }`
    - Path check per R9.5: for every ordered pair including the reserved introspection path, collide iff `a === b`, `a + "/"` is a prefix of `b`, or `b + "/"` is a prefix of `a`. Keep the root-path special case: `/` owns the whole subtree and collides with every other path
    - No identifier check: a Microservice_Identifier IS a directory name under the Microservice_Namespace and the generator emits one registry entry per discovered directory, so two entries sharing an identifier is an unrepresentable state and there is nothing for a runtime check to detect. Paths differ in kind — each module authors its path freely, so `/auth` vs `/auth/x` is a genuine authoring mistake
    - Historical: this task originally also produced `detectIdentifierCollisions()`, an `IdentifierCollision` interface, and an `identifierCollisions` field on the failure branch. All were deleted for the reason above
    - _Requirements: R9.2, R9.4, R9.5, Property 6_
  - [x] 7.7* Write property test for path collision detection
    - **Property 6: Collision detection**
    - **Validates: Requirements R9.2, R9.4, R9.5**
    - Property 6 is covered by example-based tests in `packages/overseer/tests/boot.test.ts` rather than a dedicated property test file. The collision check is an exact-equality comparison inlined in a six-line loop; the interesting cases (duplicate path, distinct paths, root path) are finite and pinned as concrete examples
    - Historical: the file `packages/overseer/tests/collision.property.test.ts` was originally planned here using `arbPathPair` to exercise all three categories. Both the file and the generator have been removed; see Property 6 in the design's Correctness Properties section
  - [x] 7.8 Implement `src/validate-modules.ts` (boot-time Microservice_Path check) — **inlined into `boot.ts` step 2 as `startsWith("/")`**
    - The loop and `[module]` message formatting now live directly in `boot.ts`. The check is a single `entry.module.path.startsWith("/")` call — empty strings return `false`, so the non-empty guard is already covered. The separate `validateMicroservicePath` function, its `validate-path.ts` source file, and its re-export from `@scaffold/contracts` are deleted
    - Cross-module aggregation is preserved: every offending module is reported in a single startup attempt (R8.5)
    - Compile-time/runtime rationale unchanged: export shape is proven by `tsc` on the generated registry; only the `path` value is checked at runtime
    - `validate-modules.test.ts` removed; coverage lives in `boot.test.ts` (success on conforming registry, failure naming the offending package, cross-entry aggregation)
  - [x] 7.9 ~~Implement `src/introspection.ts` (`GET /_registry` handler)~~ — deleted
    - The introspection endpoint has been removed entirely. R6.3 is now satisfied by a boot log message listing every registered microservice with its path and toggle state. `src/introspection.ts` and its dist artifacts are deleted
    - _Requirements: R6.3 (now via boot log)_
  - [x] 7.10* ~~Write property test for the introspection response~~ — deleted
    - **Property 10: Introspection response** — removed from the design. `packages/overseer/tests/introspection.property.test.ts` has been deleted
  - [x] 7.11 Implement `src/router.ts` (build the Express mount table)
    - Constructs `express()`, mounts each enabled `RegistryEntry` via `app.use(entry.module.path, entry.module.router)` in deterministic order (path descending by length)
    - Registers the final app-level 404 fallback: `app.use((req, res) => res.status(404).end())`
    - The mount stack is now: enabled mounts (longest first) → 404 fallback
    - _Requirements: R3.1, R3.2, R3.3, R4.2, R4.4_
  - [x] 7.12* Write property test for the routing decision
    - **Property 9: Routing decision**
    - **Validates: Requirements R3.2, R3.3, R4.2**
    - File: `packages/overseer/tests/router.property.test.ts`
    - Build fixture apps and request against them; assert exact-one-of-three routing branches. Fixtures come from `buildExpressRouter` directly with controlled `/svcN` paths (a unique index per service supplies both identifier and path), **not** from a whole-module generator (the since-deleted `arbMicroserviceModule`): the property's premise is a set of modules whose paths pass the collision check, which a fully random module does not guarantee — and the assertions compare the response body against the identifier, so identifier and path have to be related
  - [x] 7.13 Implement `src/server.ts` (start the HTTP listener)
    - `startServer(app, port)`; returns a promise that resolves once `listen` succeeds
    - _Requirements: R3.1_
  - [x] 7.14 Wire the boot pipeline in `src/boot.ts` and `src/index.ts`
    - Ordered composition per design "Overseer Startup Sequence": load generated registry → validate module paths → detect path collisions → validate toggles (batched errors) → build router → bind server
    - `src/index.ts` loads the registry with a top-level static `import { microserviceRegistry } from "./generated/microservice-registry.js"`, so its type is derived rather than asserted and a template-level export rename in the generator becomes `TS2305` here instead of a runtime `TypeError`. An earlier revision used `await import()` behind a variable specifier plus an `as GeneratedRegistryModule` cast to keep the package typecheckable without the gitignored generated file; the root `prepare` script copies an empty template into place after every install instead. Consequence accepted: a missing registry at runtime is now Node's `ERR_MODULE_NOT_FOUND` rather than a `[boot] failed to load the generated registry…` message
    - Message formatting: one `[module] <sourcePackage>: <defect>` line per offending entry, plus the `[collision:path]` and `[toggle:*]` shapes. There is no `[collision:id]` branch — an identifier collision is unrepresentable in a generated registry (R9.1)
    - Every failure writes to stderr and exits non-zero before `listen` is called
    - _Requirements: R3.1, R4.3, R4.4, R7.1, R7.3, R8.5, R9.4_

- [x] 8. Wire up local development via `npm start`
  - [x] 8.1 Create `scripts/start.js` at the repo root
    - Spawns the `generate-registry` bin (which reads the inherited `MICROSERVICES`, unset meaning `*`), then `npm run build --workspaces`, then `node packages/overseer/dist/index.js`
    - Building all workspaces instead of selecting tsconfig projects keeps the selector logic in one place: the script contains no selector parsing of its own
    - The generate-then-build order is what gives `npm start` its parity with a Container build, and it depends on the root `workspaces` array being topological (see 1.1)
    - Verifying `npm start` against a genuinely clean checkout (tracked files only, `npm ci`, no `dist/`, no `*.tsbuildinfo`, no generated registry) exposed a second, earlier failure the reorder does not address: the generator runs as its **compiled** bin, and nothing builds or links it at install time, so step 1 died with `MODULE_NOT_FOUND` on `packages/build-tools/dist/bin/generate-registry.js` before any TypeScript ran. The script now bootstraps first — `npm run build --workspace @scaffold/contracts --workspace @scaffold/build-tools`, mirroring the Dockerfile build stage's `npx tsc --build packages/contracts packages/build-tools` — then generates, then builds every workspace, then runs the Overseer. Four steps, each aborting the sequence on failure
    - Propagates non-zero exit codes; refuses to start the overseer if generation or build fails
    - The root `prepare` script now copies an empty microservice registry template into the generated-file location after every install, which does NOT make these steps redundant: `npm start` must regenerate because its `MICROSERVICES` may differ from the empty template (regenerating is the whole of R10.2), and the template is a zero-microservice placeholder, so `npm start` cannot assume the generator has run. Here a failure must abort, and does
    - _Requirements: R10.1, R10.2, R10.3, R10.4_

- [x] 9. Checkpoint - Overseer boots locally with default selector
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Build the container image tooling
  - [x] 10.1 Author the root `Dockerfile` and `.dockerignore`
    - Two stages, no `deps` stage: `build` (`FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine${ALPINE_VERSION}`, `ARG MICROSERVICES` → `ENV MICROSERVICES`, `COPY . .`, `npm ci --workspaces --include-workspace-root` under `--mount=type=cache,target=/root/.npm`, then `npx tsc --build packages/contracts packages/build-tools && node packages/build-tools/dist/bin/build-image-tree.js`) and `runtime` (`node:${NODE_VERSION}-alpine${ALPINE_VERSION}`, `apk add --no-cache dumb-init`, NODE_ENV, PORT, a single `COPY --from=build /out ./`, the R6.6 injection marker comment, EXPOSE 8080, `USER node`, `ENTRYPOINT ["dumb-init", "--"]`, `CMD ["node", "packages/overseer/dist/index.js"]`)
    - No per-microservice manifest enumeration and no copy of `packages/microservices`, so adding a microservice needs no Dockerfile edit and a Specific_Container physically cannot ship an unselected service
    - Include placeholder `ARG MICROSERVICES=*` at file top
    - `.dockerignore` excludes `node_modules`, `dist`, `*.tsbuildinfo`, `packages/overseer/src/generated`, `.git`, `.env*` and editor junk, but deliberately not `Dockerfile.effective`. This also fixed a pre-existing inability to build from a clean context (build-tools' `tsc` needed `contracts/dist`, committed `*.tsbuildinfo` made `tsc --build` a no-op, and `npm run build --workspaces` built the Overseer before the microservices)
    - _Requirements: R6.1, R6.2, R6.5, R6.6_
  - [x] 10.2 Inject the R6.6 toggle defaults via `scripts/emit-effective-dockerfile.sh`
    - The injection lives in the shell script from 5.9 rather than in build-tools: it produces `Dockerfile.effective` by inserting the toggle `ENV` lines into the runtime stage before the last `ENTRYPOINT`
    - Callers (local builds and CI) then run `docker build -f Dockerfile.effective --build-arg MICROSERVICES=<selector> .`; `Dockerfile.effective` is gitignored
    - _Requirements: R6.6_
  - [x] 10.3* Write the Dockerfile structural and effective-Dockerfile tests
    - File: `packages/integration-tests/tests/dockerfile.test.ts` (6 tests) — `ARG MICROSERVICES=*` before the first `FROM`, exactly the `build` and `runtime` stages, the runtime stage's only `COPY` being `COPY --from=build /out ./`, no `COPY` mentioning `packages/microservices`, `EXPOSE`/`ENTRYPOINT` present, no references to the removed entry points
    - File: `packages/integration-tests/tests/effective-dockerfile.test.ts` (13 tests) — runs the real emit script against temp output for 8 selectors and pins the identifiers it bakes to `resolveSelected(selector, listMicroserviceDirectories())`, plus injection position before the last `ENTRYPOINT`, the auto-generated header naming the selector, byte-for-byte preservation of the base Dockerfile, and the no-`ENTRYPOINT` failure path. The pinning is what makes the shell/TypeScript duplication of selector resolution acceptable
    - _Requirements: R6.1, R6.2, R6.5, R6.6_

- [x] 11. Author the GHCR release pipeline
  - [x] 11.1 Create `.github/workflows/release.yml`
    - `on:` includes `push.branches: [main]`, `push.tags: ["v*.*.*"]`, `pull_request.branches: [main]`, `workflow_dispatch`
    - Top-level `permissions: { contents: read, packages: write, id-token: write }`
    - One `build-and-publish` job with a strategy matrix over `generic` (selector `*`, suffix `generic`) and `specific` (selector `microservice1,microservice2`, suffix `microservice1-microservice2`)
    - Steps: checkout, `docker buildx create --name mybuilder --use --bootstrap`, login-action to `ghcr.io`, metadata-action computing tags per R11.5 (`type=sha`, `type=ref,event=branch`, `type=ref,event=tag`, `type=raw,value=latest,enable={{is_default_branch}}`), "Generate effective Dockerfile" (env `MICROSERVICES: ${{ matrix.selector }}`; echoes the selector for R11.9, runs `sh scripts/emit-effective-dockerfile.sh`, greps the injected `ENV` lines into the log — no `actions/setup-node`, no `npm ci`), "Build and push (multi-arch)" build-push-action with `file: Dockerfile.effective`, `platforms: linux/amd64,linux/arm64`, `build-args` including `NODE_VERSION=22` and `ALPINE_VERSION=3.21`, `push: ${{ github.event_name != 'pull_request' }}`, `cache-from/to: type=gha`
    - The image-tree assembler's own post-assemble integrity check verifies at build time that no unselected microservice leaked into the staged tree, so there are no post-build assertion or smoke-test steps
    - A separate `cleanup` job using `dataaxiom/ghcr-cleanup-action@v1` with `keep-n-untagged: 10`, one step per image name
    - `fail-fast: false` on the matrix; steps default `continue-on-error: false`
    - _Requirements: R11.1, R11.2, R11.3, R11.4, R11.5, R11.6, R11.7, R11.8, R11.9_
  - [x] 11.2* Write structural tests for `release.yml` — implemented, deliberately narrower than first described
    - File: `packages/integration-tests/tests/release-workflow.test.ts` (8 tests). Parses `release.yml` (and `ci.yml`'s `permissions` block) with `js-yaml`
    - Asserts: exact `permissions` on both workflows (R11.6), `push: ${{ github.event_name != 'pull_request' }}` on the build step (R11.7), the four tag rules — `type=sha`, `type=ref,event=branch`, `type=ref,event=tag`, `type=raw,value=latest,enable={{is_default_branch}}` (R11.5), all four triggers (R11.2), and that each matrix leg's `image_suffix` is distinct and equals the rule derived from its own `selector` (`*` → `generic`; a comma list → identifiers lowercased and joined with `-`) (R11.4)
    - Does **not** assert the selector-echo step (R11.9), checkout/buildx/login steps, as originally planned. Rationale: every pull request runs `release.yml` for real — it builds both images, and the image-tree assembler's own integrity check verifies no unselected microservice leaked into the staged tree. Asserting in YAML that those steps exist adds nothing a green run already proves and makes every harmless workflow refactor a test failure. What a static test uniquely guards is failures that are invisible (over-broad `permissions` never fails at runtime), unobservable (a non-publish is an absence, and absences do not turn a run red), or deferred (the tag rules are dormant on a PR and first misfire on a release)
    - _Requirements: R11.2, R11.4, R11.5, R11.6, R11.7_
  - [x] 11.3 ~~Add the CI image-scope assertion and smoke-test steps for the built image (R11.3)~~ — superseded
    - Historical: this task added a "Build smoke image (local, single-arch)" build-push-action step with `load: true`, an externalized `.github/workflows/assert-image-scope.sh` that compared `ls -1 node_modules/@scaffold` against `matrix.expected_scope`, and an externalized `.github/workflows/smoke-test.sh` that polled `GET /` for a 200
    - **Superseded:** the image-scope assertion has moved into the image-tree assembler's post-assemble integrity check (task 5.12), which verifies at build time — identically in local and CI builds — that no unselected microservice leaked into the staged tree. The smoke test was removed because it tested sample content (the reference microservices' responses), not the scaffold's build correctness. Both scripts (`.github/workflows/assert-image-scope.sh`, `.github/workflows/smoke-test.sh`) and the `expected_scope` matrix field have been deleted
    - _Requirements: R6.2, R11.3 (now covered by 5.12's integrity check)_
  - [x] 11.4 Add the CI quality-gate workflow `.github/workflows/ci.yml`
    - Appended after 11.3 (numbering is stable; nothing above was renumbered). Splits the two jobs the repo needs: `ci.yml` is the quality gate and publishes nothing (`permissions: contents: read`), `release.yml` stays the publish pipeline (`packages: write`, Docker daemon, no test suite). A test failure is then reportable independently of an image build, and the gate never holds write authority it cannot use
    - Triggers: `push.branches: [main]`, `pull_request.branches: [main]`, `workflow_dispatch`. Steps: checkout → `actions/setup-node@v4` (Node 22, `cache: npm`) → `npm ci` → `npm run ci` (quality gate) → actionlint. The quality gate is a single `npm run ci` script that runs `typecheck --workspaces && lint --workspaces && npm test && test:types`. `npm test` triggers the root `pretest` script (`npm run build --workspaces`), which compiles everything — including the registry generator, the microservice registry via the empty template, and every workspace's `dist/`. On a fresh clone this makes `dist/` available for the integration tests; on a warm tree it is incremental (~2 s). No explicit bootstrap-build or generate step is needed: the empty template from `prepare` (which `npm ci` runs) is enough for the build, and the spawn-based integration suites (start-parity, toggle-abort) generate the registry themselves in setup
    - Wired the root `test:types` script (`npm run test:types --workspaces --if-present`) and added `packages/contracts/tsconfig.test.json` so `vitest --typecheck` has a program that actually contains `tests/`: the package's `tsconfig.json` is the emit config (`rootDir: ./src`), so `tests/types.test-d.ts` was outside every program and `--typecheck` silently checked **nothing** — it reported success with a deliberate type error planted in the file
    - actionlint pinned as `docker://rhysd/actionlint:1.7.12` (upstream release image rather than a wrapper action: one thing to pin, and it bundles the shellcheck binary actionlint delegates `run:` blocks to). Catches malformed `${{ }}` expressions, undefined `matrix` keys, wrong action input names, and shell defects in `release.yml`'s run steps
    - Two defects were exposed by running this sequence against a genuine clean checkout rather than assuming it: (a) `*.tsbuildinfo` files were tracked, and with `composite: true` `tsc` trusts a committed buildinfo over the gitignored (absent) `dist/`, so the very first build emitted nothing — they are now gitignored and untracked; (b) `test:types` was checking nothing, as above
    - The clean-checkout run also confirmed the registry is not a build product: build, typecheck, lint and the whole suite pass with no `packages/overseer/src/generated/registry.ts` present (the Overseer reaches it through a variable specifier, and the spawn-based integration suites generate it themselves). The `pretest` build uses the empty template from `prepare`, so no explicit generate step is needed
    - Note: the root `workspaces` array was reordered to `contracts`, `build-tools`, `packages/microservices/*`, `overseer`, `integration-tests` (see 1.1). With the array topological, `npm run build --workspaces` (via `pretest`) compiles everything in the right order. The root `pretest` script makes `npm test` self-contained — it builds everything first — and the root `ci` script composes typecheck, lint, test, and test:types into one command that CI invokes as a single step
    - _Requirements: R8.4 (type tests made live); steering compliance (`vitest --run` in CI). No new product requirement_

- [x] 12. Cross-package integration tests
  - [x] 12.1 Create the `packages/integration-tests` package skeleton
    - `package.json` name `@scaffold/integration-tests`, `"type": "module"`, workspace deps on `@scaffold/overseer`, `@scaffold/contracts`, `@scaffold/build-tools`, and the three microservices; devDep on `supertest`
    - `tsconfig.json` extending `../../tsconfig.base.json`; standard four scripts
    - _Requirements: R10.1_
  - [x] 12.2* End-to-end request contract for all three reference microservices
    - Boot the overseer in-process with a Generic_Container-equivalent registry and all three toggles enabled
    - For each microservice: `GET <path>` → `200 application/json` body `{ "microservice-name": identifier, path }`; non-GET → `405 Allow: GET`
    - For microservice2 additionally: `GET <path>/config` → `200 application/json`, body is a JSON object
    - _Requirements: R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R3.1, R3.2_
  - [x] 12.3* Specific_Container 404 behavior for absent + disabled microservices
    - Boot with a registry containing only microservice1 and microservice2, `MICROSERVICE_MICROSERVICE2_ENABLED=disabled`
    - `GET /microservice3/anything` → `404`; `GET /microservice2` → `404`; `GET /` → `200`
    - _Requirements: R3.3, R4.2, R6.2_
  - [x] 12.4* ~~Introspection endpoint end-to-end~~ — deleted
    - The introspection endpoint has been removed. `packages/integration-tests/tests/introspection.test.ts` is deleted
    - _Requirements: R6.3 (now via boot log)_
  - [x] 12.5* `npm start` local-parity integration
    - Programmatically invoke `scripts/start.js` with `MICROSERVICES=microservice1`, wait for the server, hit `/` and assert only microservice1 is present; confirm `/_registry` returns 404 (the introspection endpoint no longer exists)
    - _Requirements: R10.1, R10.2, R10.3_
  - [x] 12.6* Toggle-abort integration
    - Spawn the overseer with a registry containing microservice1 but no `MICROSERVICE_MICROSERVICE1_ENABLED` env var set
    - Assert non-zero exit code and stderr containing the R4.3 message naming `MICROSERVICE_MICROSERVICE1_ENABLED`
    - _Requirements: R4.3_
  - [x] 12.7* Collision-abort integration
    - Build a synthetic registry with two DISTINCT-identifier modules sharing a `path`; boot the overseer; assert non-zero exit and stderr containing R9.4's collision message naming both paths and identifiers. A path collision is the only collision kind there is, so this remains the whole scope of the task
    - _Requirements: R9.4, R9.5_

- [x] 13. Final checkpoint - Full workspace green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery. Core implementation tasks are never optional.
- Each task references specific requirement clauses for traceability, and every property test cites the property number from the design's Correctness Properties section.
- All property tests use `fast-check` per the tech steering.
- Task numbering is stable; the dependency graph below refers to leaf sub-task IDs.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["2.3", "2.5", "2.6", "3.1", "3.4", "3.7", "5.1", "7.1", "12.1"] },
    { "id": 4, "tasks": ["2.4", "3.2", "3.5", "3.8", "5.2", "5.4", "5.10", "7.2", "7.6", "7.8", "7.9", "7.13"] },
    { "id": 5, "tasks": ["3.3", "3.6", "3.9", "3.10", "5.3", "5.5", "5.9", "5.11", "7.3", "7.7", "7.10"] },
    { "id": 6, "tasks": ["5.6", "5.7", "5.8", "7.4", "7.5", "7.11"] },
    { "id": 7, "tasks": ["5.12", "7.12", "7.14"] },
    { "id": 8, "tasks": ["8.1"] },
    { "id": 9, "tasks": ["10.1"] },
    { "id": 10, "tasks": ["10.2", "11.1"] },
    { "id": 11, "tasks": ["10.3", "11.2", "11.3"] },
    { "id": 12, "tasks": ["12.2", "12.3", "12.4", "12.5", "12.6", "12.7"] }
  ]
}
```

# Requirements Document — Docker Build Optimization

## Introduction

The Docker image build for the Microservice Scaffold takes approximately 8.5 minutes in CI, even though the project is small (~600 KB of source). Two structural problems in the current Dockerfile cause this:

1. **Layer-cache invalidation on every source change.** The build stage uses a single `COPY . .` before `npm ci`, so any source-file change busts the npm-install layer cache. The `npm ci` step alone takes ~4.5 minutes.
2. **Slow in-place pruning.** After compilation, `buildImageTree` runs `npm prune --omit=dev` to strip devDependencies before assembling the staging tree. On Alpine in a buildkit container, this takes ~3.5 minutes because npm re-resolves the entire dependency graph.

The optimization replaces the monolithic `COPY . .` with a two-phase copy (manifests first, then sources) and replaces in-place `npm prune` with a dedicated production-only `npm ci --omit=dev` install stage. The `emit-effective-dockerfile.sh` script is enhanced to dynamically generate the per-workspace `COPY` lines from the filesystem, so adding a microservice still requires no manual Dockerfile change.

As part of this work, the template is renamed to `Dockerfile.template` (committed source) and the generated output becomes `Dockerfile` (the conventional name Docker tooling expects). This eliminates the `-f Dockerfile.effective` flag from every `docker build` invocation and aligns with Docker's default file discovery. The generated `Dockerfile` is gitignored and carries a comment marking it as generated.

## Glossary

- **Manifest-splitting**: Copying only `package.json` and `package-lock.json` files first (to establish the npm-install cache layer), then copying the remaining sources in a subsequent layer.
- **Prod-deps stage**: A dedicated Docker build stage that runs `npm ci --omit=dev` to produce a clean `node_modules/` containing only production runtime dependencies, avoiding the need for post-install pruning.
- **Generated COPY lines**: `COPY` instructions emitted by `emit-effective-dockerfile.sh` that enumerate each workspace's `package.json` file, derived from the filesystem at generation time rather than hardcoded in `Dockerfile.template`.
- **Dockerfile.template**: The committed Dockerfile source containing anchor comments. Not directly buildable — must be processed by `emit-effective-dockerfile.sh` to produce the generated `Dockerfile`.
- **Emit_Script**: The `scripts/emit-effective-dockerfile.sh` script that reads `Dockerfile.template` and writes the generated `Dockerfile`.
- **Single_Awk_Pass**: One `awk` invocation that performs all text processing (selector formatting, exclusion filtering, manifest COPY block construction, ENV toggle block construction, anchor injection, and anchor validation) in a single execution.
- **Acceptance_Oracle**: The existing integration test `packages/integration-tests/tests/effective-dockerfile.test.ts`, which defines the observable-behavior contract the refactor must satisfy without modification.

## Requirements

### Requirement O1: Manifest-Splitting COPY Generation

**User Story:** As a build engineer, I want `emit-effective-dockerfile.sh` to automatically generate per-workspace `COPY` lines for `package.json` files from the filesystem, so that Docker layer caching survives source-only changes and I never have to manually enumerate workspace manifests in the Dockerfile.

#### Acceptance Criteria

1. WHEN `emit-effective-dockerfile.sh` runs, it SHALL discover the workspace `package.json` files by listing every direct subdirectory of `packages/` and every direct subdirectory of `packages/microservices/`, and SHALL emit one `COPY` instruction per discovered workspace manifest, plus one for the root `package-lock.json` and root `package.json`. The discovery SHALL NOT hardcode individual package names — it uses `packages/*/package.json` and `packages/microservices/*/package.json` glob-style listing so that adding a new top-level package (alongside contracts, build-tools, overseer) requires no script change. `packages/integration-tests` is excluded from discovery because it is a test-only workspace with no production code; the script SHALL skip any directory whose `package.json` contains `"private": true` and has no `"main"` or `"bin"` field, OR (simpler) the script SHALL skip it by name via an exclusion list. The chosen mechanism is a design decision.
2. THE generated COPY lines SHALL be injected into the generated `Dockerfile` at clearly marked anchors in `Dockerfile.template`, replacing the anchor comments.
3. `Dockerfile.template` SHALL contain placeholder markers (comments) at the injection points; the script SHALL replace these markers with the generated COPY lines. `Dockerfile.template` SHALL NOT contain hardcoded per-workspace `COPY` instructions.
4. THE script SHALL remain dependency-free POSIX sh (no Node, no npm required), consistent with its current design.
5. THE generated `package.json` COPY lines SHALL create the target directory structure matching the source paths so that `npm ci --workspaces` can resolve the workspace topology.

### Requirement O2: Two-Phase Copy in the Build Stage

**User Story:** As a build engineer, I want the build stage to copy manifests and install dependencies in one layer, then copy sources in a separate layer, so that the expensive `npm ci` is cached across source-only changes.

#### Acceptance Criteria

1. THE build stage in `Dockerfile.template` SHALL be structured as: (a) anchor for manifest COPY injection, (b) run `npm ci`, (c) copy remaining sources via `COPY . .`, (d) compile and assemble.
2. THE `npm ci` layer SHALL be invalidated only when a `package.json` or `package-lock.json` file changes, not when source files change.
3. THE remaining source copy (`COPY . .`) SHALL follow the `npm ci` step, so that source changes create a new layer only from that point forward.

### Requirement O3: Production-Only Dependencies Stage

**User Story:** As a build engineer, I want a separate Docker stage that installs only production dependencies via `npm ci --omit=dev`, so that the runtime image gets a clean `node_modules/` without the slow `npm prune` step.

#### Acceptance Criteria

1. `Dockerfile.template` SHALL include a `prod-deps` stage (in addition to the existing `build` and `runtime` stages) that uses the same manifest COPY anchor, runs `npm ci --omit=dev --workspaces --include-workspace-root`, and produces a clean production `node_modules/`.
2. THE `prod-deps` stage SHALL use the same manifest-splitting COPY lines as the build stage (both generated from the same anchor by `emit-effective-dockerfile.sh`), so its layer cache has the same invalidation characteristics.
3. THE `prod-deps` stage SHALL run on `$BUILDPLATFORM` (same as the build stage) for native-speed installation.
4. THE `buildImageTree` function in `packages/build-tools/src/image-tree.ts` SHALL be updated to remove the `npm prune --omit=dev` step and the `copyThirdPartyDependencies` function. Instead, the runtime stage SHALL `COPY --from=prod-deps` the production `node_modules/` directly.
5. THE `buildImageTree` function SHALL continue to assemble the `/out` staging tree with the workspace packages (contracts, selected microservices, overseer), but third-party dependencies SHALL come from the `prod-deps` stage via a Dockerfile `COPY` rather than from the build stage's pruned `node_modules/`.

### Requirement O4: Runtime Stage Integration

**User Story:** As a build engineer, I want the runtime stage to compose the production dependencies from the prod-deps stage with the compiled workspace packages from the build stage, so that the final image is minimal and correct.

#### Acceptance Criteria

1. THE runtime stage SHALL copy production third-party dependencies from the `prod-deps` stage via `COPY --from=prod-deps`.
2. THE runtime stage SHALL copy the compiled workspace packages (staged at `/out` by the build stage) from the `build` stage, as it does today.
3. THE final image SHALL contain exactly the same set of files as before the optimization: production `node_modules/`, `node_modules/@microservices/contracts/`, `node_modules/@microservices/<selected>/` for each selected microservice, and `packages/overseer/`.
4. THE toggle-default ENV injection (R6.6) SHALL continue to work: `emit-effective-dockerfile.sh` SHALL inject the `ENV MICROSERVICE_<X>_ENABLED=enabled` lines before the last `ENTRYPOINT`, exactly as before.

### Requirement O5: Backward Compatibility

**User Story:** As a developer, I want the optimization to be transparent to all existing workflows, so that `npm start`, CI, and the release pipeline continue to work without changes beyond the Dockerfile and emit script.

#### Acceptance Criteria

1. THE `scripts/start.js` local development entry point SHALL require no changes.
2. THE `.github/workflows/release.yml` workflow SHALL be updated to reference `Dockerfile.template` (for the emit step's input) and to drop the `file: Dockerfile.effective` override from `docker/build-push-action` (since the generated output is now `Dockerfile`, which is the default).
3. THE `packages/build-tools/src/bin/build-image-tree.ts` entry point SHALL continue to work, though its internal implementation changes.
4. THE post-assemble integrity check in `buildImageTree` (verifying no unselected microservice leaked into the staging tree) SHALL be preserved.
5. THE `scripts/emit-effective-dockerfile.sh` SHALL remain backward-compatible for the ENV toggle injection: existing tests that verify ENV line placement relative to ENTRYPOINT SHALL continue to pass.

### Requirement O6: Integration Test Updates

**User Story:** As a developer, I want the integration tests to verify the new Dockerfile structure, so that regressions in the layer-splitting or stage composition are caught automatically.

#### Acceptance Criteria

1. THE `packages/integration-tests/tests/dockerfile.test.ts` structural assertions SHALL be updated to read `Dockerfile.template` (instead of `Dockerfile`) and reflect the new three-stage layout (build, prod-deps, runtime) and the new COPY pattern.
2. THE `packages/integration-tests/tests/effective-dockerfile.test.ts` pinning tests SHALL be updated to read `Dockerfile.template` as the base and verify that the generated `Dockerfile` contains the expected COPY lines matching the actual workspace structure on disk.
3. ALL existing integration tests that are unaffected by the Dockerfile restructuring SHALL continue to pass without modification.

### Requirement O7: Steering Update for Test-Only Package Exclusion

**User Story:** As a developer adding a new test-only package, I want the structure steering to tell me I need to add it to the emit script's exclusion list, so that the Docker build does not silently include a test-only workspace in the image manifest layer.

#### Acceptance Criteria

1. THE `.kiro/steering/structure.md` steering file SHALL document that new test-only packages under `packages/` (i.e., packages that have no production code shipped in the Container image) MUST be added to the exclusion list in `scripts/emit-effective-dockerfile.sh` so that their `package.json` is not included in the generated manifest COPY lines.
2. THE documentation SHALL appear in the "Where things go" section or an equivalent location where a developer adding a new package would naturally look.

### Requirement O8: Template Rename and Generated-File Marking

**User Story:** As a developer, I want the committed Dockerfile source to be clearly named as a template and the generated output to use the conventional `Dockerfile` name, so that Docker tooling works without `-f` overrides and nobody accidentally edits the generated file.

#### Acceptance Criteria

1. THE committed Dockerfile source SHALL be renamed from `Dockerfile` to `Dockerfile.template`.
2. THE `emit-effective-dockerfile.sh` script SHALL read `Dockerfile.template` as its input and write `Dockerfile` as its output.
3. THE generated `Dockerfile` SHALL begin with a comment line clearly marking it as generated, naming the source template and the generating script, and warning not to edit it. For example: `# AUTO-GENERATED from Dockerfile.template by scripts/emit-effective-dockerfile.sh. Do not edit.`
4. THE `.gitignore` SHALL be updated to ignore `Dockerfile` (the generated output) instead of `Dockerfile.effective`. `Dockerfile.template` SHALL be committed.
5. THE `.dockerignore` comment referencing `Dockerfile.effective` SHALL be updated to reflect the new names.
6. THE root `package.json` docker:build scripts SHALL be updated to drop the `-f Dockerfile.effective` flag (since `Dockerfile` is now the default name Docker discovers).
7. ALL references to `Dockerfile.effective` and to the base `Dockerfile` across the codebase (release workflow, steering files, emit script, integration tests, existing spec docs) SHALL be updated to use the new names.

### Requirement O9: KISS Refactor of the Emit_Script to a Single-Awk-Pass Shape

**User Story:** As a maintainer, I want `emit-effective-dockerfile.sh` collapsed into a clean two-part shape — a shell part that discovers directories and a single awk part that does all text processing — so that the injection logic is simpler to read and maintain, while the generated output stays byte-for-byte identical.

#### Acceptance Criteria

1. THE Emit_Script SHALL perform all text processing using a Single_Awk_Pass together with POSIX shell built-ins.
2. THE Emit_Script SHALL exclude `grep`, `sed`, and `tr` from its implementation.
3. THE Emit_Script SHALL determine the last `ENTRYPOINT` anchor line within the Single_Awk_Pass, without a separate awk pre-scan invocation.
4. WHEN the Emit_Script runs, THE Emit_Script SHALL list directories via the glob patterns `packages/*/` and `packages/microservices/*/` in the shell.
5. WHEN the Emit_Script lists a candidate directory, THE Emit_Script SHALL perform the `package.json` existence check in the shell and SHALL omit any directory that has no `package.json` from the lists passed to awk.
6. THE Emit_Script SHALL pass the discovered directory lists and the resolved selector value to awk through the process environment (`ENVIRON[]`), and SHALL use `ENVIRON[]` rather than awk `-v` assignment for these values.
7. THE Single_Awk_Pass SHALL perform selector-resolution formatting, exclusion-by-name filtering of `integration-tests` and `microservices`, manifest COPY block construction, R6.6 ENV toggle block construction, injection of both manifest blocks at their `# --- MANIFEST_COPY_BUILD ---` and `# --- MANIFEST_COPY_PRODDEPS ---` anchors, and injection of the ENV toggle block before the last `ENTRYPOINT`.
8. THE Single_Awk_Pass SHALL validate that both manifest anchors and the `ENTRYPOINT` anchor were seen during the pass.
9. THE Emit_Script SHALL use only POSIX awk features and SHALL avoid gawk-, mawk-, and busybox-specific extensions (for example `gensub` and non-POSIX regex), so that the Emit_Script produces identical output on BSD awk (macOS), busybox awk (Alpine CI), and other developer machines.
10. THE Emit_Script SHALL remain dependency-free POSIX sh, requiring neither Node nor npm to run.
11. FOR ALL selector forms accepted by the pre-refactor Emit_Script — the literal `*`, an unset selector, an empty selector, a whitespace-only selector, a single identifier, and a comma-separated list of identifiers with or without surrounding whitespace — THE refactored Emit_Script SHALL produce generated output that is byte-for-byte identical to the pre-refactor Emit_Script's output for the same selector, including the auto-generated header line, the `# Selector:` line, the manifest COPY block header comment, the exact COPY line format, and the COPY ordering (root `package.json` and `package-lock.json` first, then top-level packages, then microservices).
12. THE Emit_Script SHALL emit the manifest COPY block identically in both the build stage and the prod-deps stage.
13. THE Emit_Script SHALL inject the `ENV MICROSERVICE_<IDENTIFIER>_ENABLED=enabled` toggle lines before the last `ENTRYPOINT` instruction.
14. WHERE the selector is `*`, empty, or whitespace-only, THE Emit_Script SHALL resolve the selector to every direct subdirectory of `packages/microservices/`.
15. WHERE the selector is neither `*`, empty, nor whitespace-only, THE Emit_Script SHALL resolve the selector by splitting on commas, trimming surrounding whitespace from each entry, and dropping empty entries.
16. IF a required manifest anchor is absent from `Dockerfile.template`, THEN THE Emit_Script SHALL exit with a non-zero status, SHALL write the existing missing-anchor error message to standard error, and SHALL NOT produce the generated Dockerfile output.
17. IF `Dockerfile.template` contains no `ENTRYPOINT` instruction, THEN THE Emit_Script SHALL exit with a non-zero status, SHALL write the existing missing-ENTRYPOINT error message to standard error, and SHALL NOT produce the generated Dockerfile output.
18. IF the selector resolves to no microservices, THEN THE Emit_Script SHALL exit with a non-zero status, SHALL write the existing empty-resolution error message to standard error, and SHALL NOT produce the generated Dockerfile output.
19. THE refactored Emit_Script SHALL pass the existing Acceptance_Oracle test suite, and THE Acceptance_Oracle SHALL remain unmodified when doing so.

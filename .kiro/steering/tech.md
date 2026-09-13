# Tech Stack

## Runtime and language

- Node.js 22 LTS (minimum supported version).
- TypeScript with `strict` mode enabled. Prefer explicit types on module boundaries; type inference is fine inside function bodies.
- ES modules only (`"type": "module"` in every `package.json`). No CommonJS.
- Target `ES2023` or newer.

## Package management

- npm workspaces. Root `package.json` lists workspaces; individual packages live under `packages/`.
- **Build order comes from the Build_Sequence, not from the `workspaces` array.** The single ordering primitive (`buildSequence` in `packages/build-tools/src/build-sequence.ts`) derives the order every build path uses from package category and declared `@microservices`-scoped dependencies, and a Verification_Pass rejects any order that would place a package ahead of something it compile-depends on. The `workspaces` array order is load-bearing for nothing: no build path reads it to decide what builds first.
- **The `workspaces` field remains declared and remains expressed as globs.** npm reads it statically — before any repository code runs — to discover the workspaces and create the `node_modules/@microservices/*` symlinks that let one package import another by name. It therefore declares **membership**, not a package list and not an order; only its *sequence* has stopped being load-bearing. A new package must still appear in `workspaces` (this is the Workspace_Coverage invariant `check:invariants` enforces), but its *position* in the array no longer matters.
- The order the Build_Sequence produces places, in effect: `contracts` first (a Framework_Singleton whose types everything else may depend on; always built and always staged for every `MICROSERVICES` selector), then `build-tools`, then the required Common_Packages (in dependency order), then the selected microservices, then the Overseer (which statically imports the selected microservices through the generated registry), then `integration-tests`, and finally the Spa_Packages (built by their own bundler in a trailing phase). This ordering is a *consequence* of the Build_Sequence's statements, not a hand-maintained array you must keep topological.
- Pin Node and npm versions via `engines` in the root `package.json`.
- Open question (deliberately left open): whether a types-only Framework_Singleton like `contracts` needs to ship into a runtime image at all. This feature keeps `contracts` shipping unchanged; the fuller taxonomy write-up lives in `structure.md`.
- Lockfile (`package-lock.json`) is committed. `*.tsbuildinfo` must stay **untracked**: with `composite: true`, `tsc` trusts a committed buildinfo over the gitignored (therefore absent) `dist/` on a fresh clone, skips emitting, and the first build produces nothing.

## Testing

- Vitest for all tests. Prefer `vitest --run` in CI and scripts (non-watch mode).
- Property-based tests use `fast-check` where correctness properties are defined.
- Every package owns its own test suite. Cross-package integration tests live in a dedicated `packages/integration-tests` (or similar) package.

### A test MUST NOT mutate the checked-out tree

**No test writes to the working tree, and no test uses git to undo what it wrote.** This is a hard prohibition, not a preference, and `packages/integration-tests/tests/worktree-safety-guard.test.ts` enforces it mechanically.

Specifically forbidden in any test:

- **Any destructive git command** — `git checkout -- <path>`, `git reset`, `git clean`, `git stash`. `git checkout -- <path>` does **not** "undo the test's edit": it restores the file to its **committed** content, discarding every uncommitted change in that file, the developer's work included. In this repository a `restoreWorktreeFile()` teardown helper doing exactly this destroyed in-progress work **twice**, and silently — the suite passed each time, and the loss surfaced later as an unrelated-looking failure. That helper is deleted and must not return under any name.
- **Editing a tracked source file** under `packages/` — a microservice's `src/index.ts`, a manifest, a config.
- **Creating a package, directory, or `node_modules` symlink** in the checked-out tree. An untracked package pollutes `git status`, workspace discovery, and every `--workspaces` script; a symlink outlives a crashed run as a dangling link.

**The sanctioned pattern instead: `pristineWorktree()`** from `packages/integration-tests/tests/helpers.ts`. It lists `git ls-files --cached --others --exclude-standard` — tracked plus untracked-but-not-gitignored files, so the copy **captures uncommitted edits exactly as they are on disk**, which is precisely what a git-based restore throws away — tars them into an OS temp directory, and runs `npm ci` there. A test then:

1. materialises one copy in `beforeAll` (the `npm ci` is the slow step, so reuse it across examples) and skips with the returned `reason` when `available === false`;
2. re-roots every path it writes at the returned `dir`, and passes `cwd: dir` to `startDevSession` (or whatever it spawns);
3. captures original file contents by reading them **from that copy**, and restores them mid-run — when an example needs the original back — by writing those captured bytes with `writeFileSync`, never through git;
4. tears down with `cleanup()`, which removes the temp tree. There is nothing in the real tree to undo.

`packages/integration-tests/tests/dev-error-recovery.test.ts` and `dev-session-scope.test.ts` are the worked examples: both mutate microservice sources, and one synthesises a whole microservice package plus its workspace symlink, entirely inside their own copy.

Two narrow things a test **may** write in place, because both are gitignored generated output the repository already treats as churn: a package's `dist/` and `*.tsbuildinfo`, and the generated registry at `packages/overseer/src/generated/microservice-registry.ts` (snapshot and rewrite it if a later suite depends on its contents). Everything else goes in the copy.

## HTTP

- Express (v5) is the HTTP framework. Each microservice exports an Express router; the Overseer mounts each enabled router at its declared microservice path.
- Middleware is added only when a specific need is documented in a spec design. Default set: none.

## Tooling

- **Build_Kind is a function of package category alone** — it reads no manifest field. Every Framework_Singleton (`contracts`, `overseer`, `build-tools`, `integration-tests`), every Microservice_Package, and every Common_Package is a **Tsc_Project**: built through `tsc`, appearing as a root of the single selective `tsc --build` over the ordered roots. A **Spa_Package** (a package under `packages/spa/`) is a **Bundler_Project**: built through its OWN `npm run build` in its own directory, and is NEVER a root of `tsc --build`. The single `tsc --build` pass over the ordered Tsc_Project roots is the FIRST phase, and the required Spa_Package bundler builds are the SECOND, each still in its own directory, entered only after that pass exits with status 0 — because a Spa_Package's bundler may read a Tsc_Project's compiled output while no Tsc_Project ever reads a Spa_Package's output.
- The `spa` category is the documented design decision that adds a bundler to the scaffold: a Spa_Package brings its own bundler build (e.g. Vite) via its `npm run build`. Outside that category, TypeScript builds go through `tsc` (project references / the solution builder); no other bundlers unless a further spec design decision adds one.
- ESLint + Prettier for style; Prettier owns formatting, ESLint owns correctness rules.
- Every package exposes the same npm scripts: `build`, `test`, `lint`, `typecheck`.

## Common commands

Run from the repo root:

- `npm install` — install all workspaces. npm then runs the root `prepare` script, which copies the empty microservice registry template (`packages/overseer/src/generated/microservice-registry.template.ts`) into the generated-file location so the Overseer has a valid (empty) registry to compile against. A fresh clone therefore has a microservice registry before anything compiles, which is what lets the Overseer import it statically. `npm start`, CI, and the image build each regenerate the real registry for their own `MICROSERVICES` selector.
- `npm run build` (`node scripts/build.js`) — build the whole repository through the ordered path: the script spawns the compiled `build-workspaces` bin, which derives the order from the Build_Sequence and builds each package in that order. This is the repository-wide build; it does not fan out over the `workspaces` array.
- `npm test` — run the full Vitest suite. The root `pretest` script (`node scripts/build.js`, the same ordered build as `npm run build`) runs automatically before tests, so `npm test` works from a fresh clone after `npm ci` with no separate build step. On a warm tree the incremental build is ~2 s.
- `npm run ci` — the full quality gate, in order: `npm run build && npm run check:invariants && npm run typecheck --workspaces && npm run lint --workspaces && npm test && npm run test:types`. This is what CI runs in a single step. The leading `npm run build` is the ordered build above; the `--workspaces` fan-out is used only for the per-package typecheck and lint gates, neither of which decides build order.
- `npm run check:invariants` — runs the compiled `packages/build-tools/dist/bin/check-repo-invariants.js`, which enforces four things: (1) **Workspace_Coverage** — every workspace package is matched by exactly one `workspaces` entry (membership, not order); (2) **import discipline** — no relative import that escapes a package's own directory, and no microservice importing a peer microservice or the Overseer; (3) **Common_Package dependency direction** — a Common_Package points downward only and never names a microservice or the Overseer; and (4) the **build-order-source check** (`[workspaces:order-source]`) — no repository or npm script may derive a build order from the `workspaces` array, so the retired array-order mechanism cannot return unnoticed. It runs after the build (it is compiled output) and before the slower gates, so a coverage, discipline, direction, or order-source mistake fails fast.
- `npm run test --workspaces` — run every package's test suite
- `npm run lint --workspaces` — lint every package
- `npm run typecheck --workspaces` — typecheck every package
- `npm run test:types` — run the type-level assertions (`vitest --run --typecheck`). Separate from `npm test`, which does not enable `--typecheck`; without this command every `@ts-expect-error` in a `*.test-d.ts` file is dead weight.
- `MICROSERVICES=<selector> npm start` — run the Overseer locally with the same registry generation logic as a Container build (selector defaults to `*` when unset). Its bootstrap build goes through the ordered `build-workspaces` bin — the same Build_Sequence-derived order as `npm run build` — not a traversal of the `workspaces` array. `npm start` is wrapped with `dotenvx run --`, so the local `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle vars are injected from `.env`; `MICROSERVICES` can still be set inline as shown. One-shot: it exits with the Overseer process's status and does not watch for changes.
- `MICROSERVICES=<selector> npm run dev` (`dotenvx run -- node scripts/dev.js`) — run the Overseer locally in watch mode. Shares the same first three startup steps as `npm start` (environment load, bootstrap build, registry generation) and executes the same compiled `dist/` artifacts through `packages/overseer/dist/index.js`, but then keeps a Build_Watcher running that incrementally recompiles on source change and restarts the Overseer against the recompiled output. Runs until the developer terminates it, whereas `npm start` is one-shot. Same `dotenvx run --` env injection and inline `MICROSERVICES` override as `npm start`.

Building a container image is two commands, always in this order:

- `MICROSERVICES=<selector> sh scripts/emit-effective-dockerfile.sh` — reads the committed `Dockerfile.template` and writes the generated `Dockerfile`: the template with the manifest-splitting `COPY` lines filled in at their anchors (discovered from the filesystem) plus one `ENV MICROSERVICE_<IDENTIFIER>_ENABLED=enabled` line per identifier in the selector. Dependency-free POSIX sh, so it runs before any install. The generated `Dockerfile` is gitignored and carries an `# AUTO-GENERATED` header.
- `docker build --build-arg MICROSERVICES=<selector> .` — Docker discovers the generated `Dockerfile` by default (no `-f` needed); the selector is passed again as a build arg, and inside the image the registry generator is the authority on its validity and fails the build on an unknown identifier.

Everything else the image needs (registry generation, the selective `tsc --build`, staging the runtime tree) happens inside the build stage via `@microservices/build-tools`' `build-image-tree`. Production `node_modules/` come from a dedicated `prod-deps` stage (`npm ci --omit=dev`), not from in-place pruning.

## CI and release

- GitHub Actions is the CI/CD system. Workflow files live under `.github/workflows/`.
- `ci.yml` is the quality gate: `npm ci` → `npm run ci` → actionlint. The `ci` script composes, in order, the ordered repository build (`npm run build`), `check:invariants` (Workspace_Coverage, import discipline, Common_Package dependency direction, and the build-order-source check), typecheck, lint, test, and test:types. It publishes nothing.
- `release.yml` builds and publishes Container images to GitHub Container Registry (GHCR) under the repository's owner namespace. It does not run the test suite.
- Every merge to `main` and every semver tag (`v*.*.*`) publishes both shipped Container configurations (Generic and the `microservice1,microservice2` Specific). Pull requests run the same builds but do not publish.
- Workflows authenticate to GHCR with the workflow-provided `GITHUB_TOKEN` and use the minimum permissions (`contents: read`, `packages: write`, `id-token: write`).

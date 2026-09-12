# Tech Stack

## Runtime and language

- Node.js 22 LTS (minimum supported version).
- TypeScript with `strict` mode enabled. Prefer explicit types on module boundaries; type inference is fine inside function bodies.
- ES modules only (`"type": "module"` in every `package.json`). No CommonJS.
- Target `ES2023` or newer.

## Package management

- npm workspaces. Root `package.json` lists workspaces; individual packages live under `packages/`.
- **The `workspaces` array order IS the build order and must stay topological.** `npm run <script> --workspaces` visits packages in the order they are listed, so a consumer listed before its dependency breaks the build on any machine without warm output (a fresh clone has no prior `dist/` to fall back on). The **Workspace_Build_Order** — the relative order the root manifest declares — is:

  1. `packages/contracts`
  2. `packages/build-tools`
  3. `packages/common/*`
  4. `packages/spa/*`
  5. `packages/microservices/*`
  6. `packages/overseer`
  7. `packages/integration-tests`

  `contracts` (a Framework_Singleton — a scaffold package known by name, not discovered) is first because everything else may depend on its types; it is excluded from every consumer category's discovered set and is always built and always staged for every `MICROSERVICES` selector. `common/*` and `spa/*` sit after `contracts`/`build-tools` and before the microservices and the Overseer, so a Common_Package a microservice or the Overseer imports by name is already built when its consumer is visited. The Overseer follows the microservices because the generated registry statically imports the selected microservices. This order is now enforced automatically by the `check:invariants` check (see Common commands), not only by convention — a consumer listed before its dependency fails the check.
- Pin Node and npm versions via `engines` in the root `package.json`.
- Open question (deliberately left open): whether a types-only Framework_Singleton like `contracts` needs to ship into a runtime image at all. This feature keeps `contracts` shipping unchanged; the fuller taxonomy write-up lives in `structure.md`.
- Lockfile (`package-lock.json`) is committed. `*.tsbuildinfo` must stay **untracked**: with `composite: true`, `tsc` trusts a committed buildinfo over the gitignored (therefore absent) `dist/` on a fresh clone, skips emitting, and the first build produces nothing.

## Testing

- Vitest for all tests. Prefer `vitest --run` in CI and scripts (non-watch mode).
- Property-based tests use `fast-check` where correctness properties are defined.
- Every package owns its own test suite. Cross-package integration tests live in a dedicated `packages/integration-tests` (or similar) package.

## HTTP

- Express (v5) is the HTTP framework. Each microservice exports an Express router; the Overseer mounts each enabled router at its declared microservice path.
- Middleware is added only when a specific need is documented in a spec design. Default set: none.

## Tooling

- **Build_Kind is a function of package category alone** — it reads no manifest field. Every Framework_Singleton (`contracts`, `overseer`, `build-tools`, `integration-tests`), every Microservice_Package, and every Common_Package is a **Tsc_Project**: built through `tsc`, appearing as a root of the single selective `tsc --build` over the ordered roots. A **Spa_Package** (a package under `packages/spa/`) is a **Bundler_Project**: built through its OWN `npm run build` in its own directory, and is NEVER a root of `tsc --build`. Required Spa builds run first, each in its own directory; the single `tsc --build` pass runs only after every one of them exits zero.
- The `spa` category is the documented design decision that adds a bundler to the scaffold: a Spa_Package brings its own bundler build (e.g. Vite) via its `npm run build`. Outside that category, TypeScript builds go through `tsc` (project references / the solution builder); no other bundlers unless a further spec design decision adds one.
- ESLint + Prettier for style; Prettier owns formatting, ESLint owns correctness rules.
- Every package exposes the same npm scripts: `build`, `test`, `lint`, `typecheck`.

## Common commands

Run from the repo root:

- `npm install` — install all workspaces. npm then runs the root `prepare` script, which copies the empty microservice registry template (`packages/overseer/src/generated/microservice-registry.template.ts`) into the generated-file location so the Overseer has a valid (empty) registry to compile against. A fresh clone therefore has a microservice registry before anything compiles, which is what lets the Overseer import it statically. `npm start`, CI, and the image build each regenerate the real registry for their own `MICROSERVICES` selector.
- `npm run build --workspaces` — build every package
- `npm test` — run the full Vitest suite. The root `pretest` script (`npm run build --workspaces`) runs automatically before tests, so `npm test` works from a fresh clone after `npm ci` with no separate build step. On a warm tree the incremental build is ~2 s.
- `npm run ci` — the full quality gate, in order: `npm run build --workspaces && npm run check:invariants && npm run typecheck --workspaces && npm run lint --workspaces && npm test && npm run test:types`. This is what CI runs in a single step.
- `npm run check:invariants` — runs the compiled `packages/build-tools/dist/bin/check-repo-invariants.js`, which enforces (1) the Workspace_Build_Order, (2) import discipline — no relative import that escapes a package's own directory, and no microservice importing a peer microservice or the Overseer — and (3) Common_Package dependency direction (a Common_Package points downward only and never names a microservice or the Overseer). It runs after the build (it is compiled output) and before the slower gates, so an ordering or discipline mistake fails fast.
- `npm run test --workspaces` — run every package's test suite
- `npm run lint --workspaces` — lint every package
- `npm run typecheck --workspaces` — typecheck every package
- `npm run test:types` — run the type-level assertions (`vitest --run --typecheck`). Separate from `npm test`, which does not enable `--typecheck`; without this command every `@ts-expect-error` in a `*.test-d.ts` file is dead weight.
- `MICROSERVICES=<selector> npm start` — run the Overseer locally with the same registry generation logic as a Container build (selector defaults to `*` when unset). `npm start` is wrapped with `dotenvx run --`, so the local `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle vars are injected from `.env`; `MICROSERVICES` can still be set inline as shown. One-shot: it exits with the Overseer process's status and does not watch for changes.
- `MICROSERVICES=<selector> npm run dev` (`dotenvx run -- node scripts/dev.js`) — run the Overseer locally in watch mode. Shares the same first three startup steps as `npm start` (environment load, bootstrap build, registry generation) and executes the same compiled `dist/` artifacts through `packages/overseer/dist/index.js`, but then keeps a Build_Watcher running that incrementally recompiles on source change and restarts the Overseer against the recompiled output. Runs until the developer terminates it, whereas `npm start` is one-shot. Same `dotenvx run --` env injection and inline `MICROSERVICES` override as `npm start`.

Building a container image is two commands, always in this order:

- `MICROSERVICES=<selector> sh scripts/emit-effective-dockerfile.sh` — reads the committed `Dockerfile.template` and writes the generated `Dockerfile`: the template with the manifest-splitting `COPY` lines filled in at their anchors (discovered from the filesystem) plus one `ENV MICROSERVICE_<IDENTIFIER>_ENABLED=enabled` line per identifier in the selector. Dependency-free POSIX sh, so it runs before any install. The generated `Dockerfile` is gitignored and carries an `# AUTO-GENERATED` header.
- `docker build --build-arg MICROSERVICES=<selector> .` — Docker discovers the generated `Dockerfile` by default (no `-f` needed); the selector is passed again as a build arg, and inside the image the registry generator is the authority on its validity and fails the build on an unknown identifier.

Everything else the image needs (registry generation, the selective `tsc --build`, staging the runtime tree) happens inside the build stage via `@microservices/build-tools`' `build-image-tree`. Production `node_modules/` come from a dedicated `prod-deps` stage (`npm ci --omit=dev`), not from in-place pruning.

## CI and release

- GitHub Actions is the CI/CD system. Workflow files live under `.github/workflows/`.
- `ci.yml` is the quality gate: `npm ci` → `npm run ci` → actionlint. The `ci` script composes, in order, the workspace build, `check:invariants` (build-order and import-discipline enforcement), typecheck, lint, test, and test:types. It publishes nothing.
- `release.yml` builds and publishes Container images to GitHub Container Registry (GHCR) under the repository's owner namespace. It does not run the test suite.
- Every merge to `main` and every semver tag (`v*.*.*`) publishes both shipped Container configurations (Generic and the `microservice1,microservice2` Specific). Pull requests run the same builds but do not publish.
- Workflows authenticate to GHCR with the workflow-provided `GITHUB_TOKEN` and use the minimum permissions (`contents: read`, `packages: write`, `id-token: write`).

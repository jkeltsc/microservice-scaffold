# Tech Stack

## Runtime and language

- Node.js 22 LTS (minimum supported version).
- TypeScript with `strict` mode enabled. Prefer explicit types on module boundaries; type inference is fine inside function bodies.
- ES modules only (`"type": "module"` in every `package.json`). No CommonJS.
- Target `ES2023` or newer.

## Package management

- npm workspaces. Root `package.json` lists workspaces; individual packages live under `packages/`.
- **The `workspaces` array order IS the build order and must stay topological.** `npm run <script> --workspaces` visits packages in the order they are listed, so a dependency listed after its consumer breaks the build on any machine without warm output. Current order: `packages/contracts`, `packages/build-tools`, `packages/microservices/*`, `packages/overseer`, `packages/integration-tests` — the Overseer must follow the microservices because the generated registry statically imports them.
- Pin Node and npm versions via `engines` in the root `package.json`.
- Lockfile (`package-lock.json`) is committed. `*.tsbuildinfo` must stay **untracked**: with `composite: true`, `tsc` trusts a committed buildinfo over the gitignored (therefore absent) `dist/` on a fresh clone, skips emitting, and the first build produces nothing.

## Testing

- Vitest for all tests. Prefer `vitest --run` in CI and scripts (non-watch mode).
- Property-based tests use `fast-check` where correctness properties are defined.
- Every package owns its own test suite. Cross-package integration tests live in a dedicated `packages/integration-tests` (or similar) package.

## HTTP

- Express (v5) is the HTTP framework. Each microservice exports an Express router; the Overseer mounts each enabled router at its declared microservice path.
- Middleware is added only when a specific need is documented in a spec design. Default set: none.

## Tooling

- TypeScript builds go through `tsc` (project references) or a single build per package; no bundlers unless a spec design decision adds one.
- ESLint + Prettier for style; Prettier owns formatting, ESLint owns correctness rules.
- Every package exposes the same npm scripts: `build`, `test`, `lint`, `typecheck`.

## Common commands

Run from the repo root:

- `npm install` — install all workspaces. npm then runs the root `prepare` script, which copies the empty microservice registry template (`packages/overseer/src/generated/microservice-registry.template.ts`) into the generated-file location so the Overseer has a valid (empty) registry to compile against. A fresh clone therefore has a microservice registry before anything compiles, which is what lets the Overseer import it statically. `npm start`, CI, and the image build each regenerate the real registry for their own `MICROSERVICES` selector.
- `npm run build --workspaces` — build every package
- `npm test` — run the full Vitest suite. The root `pretest` script (`npm run build --workspaces`) runs automatically before tests, so `npm test` works from a fresh clone after `npm ci` with no separate build step. On a warm tree the incremental build is ~2 s.
- `npm run ci` — the full quality gate: `typecheck --workspaces && lint --workspaces && npm test && test:types`. This is what CI runs in a single step.
- `npm run test --workspaces` — run every package's test suite
- `npm run lint --workspaces` — lint every package
- `npm run typecheck --workspaces` — typecheck every package
- `npm run test:types` — run the type-level assertions (`vitest --run --typecheck`). Separate from `npm test`, which does not enable `--typecheck`; without this command every `@ts-expect-error` in a `*.test-d.ts` file is dead weight.
- `MICROSERVICES=<selector> npm start` — run the Overseer locally with the same registry generation logic as a Container build (selector defaults to `*` when unset). `npm start` is wrapped with `dotenvx run --`, so the local `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle vars are injected from `.env`; `MICROSERVICES` can still be set inline as shown.

Building a container image is two commands, always in this order:

- `MICROSERVICES=<selector> sh scripts/emit-effective-dockerfile.sh` — reads the committed `Dockerfile.template` and writes the generated `Dockerfile`: the template with the manifest-splitting `COPY` lines filled in at their anchors (discovered from the filesystem) plus one `ENV MICROSERVICE_<IDENTIFIER>_ENABLED=enabled` line per identifier in the selector. Dependency-free POSIX sh, so it runs before any install. The generated `Dockerfile` is gitignored and carries an `# AUTO-GENERATED` header.
- `docker build --build-arg MICROSERVICES=<selector> .` — Docker discovers the generated `Dockerfile` by default (no `-f` needed); the selector is passed again as a build arg, and inside the image the registry generator is the authority on its validity and fails the build on an unknown identifier.

Everything else the image needs (registry generation, the selective `tsc --build`, staging the runtime tree) happens inside the build stage via `@scaffold/build-tools`' `build-image-tree`. Production `node_modules/` come from a dedicated `prod-deps` stage (`npm ci --omit=dev`), not from in-place pruning.

## CI and release

- GitHub Actions is the CI/CD system. Workflow files live under `.github/workflows/`.
- `ci.yml` is the quality gate: `npm ci` → `npm run ci` → actionlint. The `ci` script composes typecheck, lint, test (with `pretest` build), and test:types. It publishes nothing.
- `release.yml` builds and publishes Container images to GitHub Container Registry (GHCR) under the repository's owner namespace. It does not run the test suite.
- Every merge to `main` and every semver tag (`v*.*.*`) publishes both shipped Container configurations (Generic and the `microservice1,microservice2` Specific). Pull requests run the same builds but do not publish.
- Workflows authenticate to GHCR with the workflow-provided `GITHUB_TOKEN` and use the minimum permissions (`contents: read`, `packages: write`, `id-token: write`).

# Microservice Scaffold

A template for composing HTTP microservices behind a single routing frontend (the Overseer).

## Quick start

```sh
npm install
npm start
# Overseer listens on port 8080 by default
curl http://localhost:8080/
```

## Adding a microservice

Create a directory under `packages/microservices/<name>/` with a `package.json`, `tsconfig.json`, and `src/index.ts` that exports `path` (the HTTP mount path) and `router` (an Express router). The build system picks it up automatically — no Dockerfile or workflow changes needed.

## Shared packages

A shared package is a plain, non-microservice library that more than one microservice (and/or the Overseer) imports by package name. `packages/contracts` is the original; `packages/config` is a worked example, consumed by both `microservice2` and `microservice3` to build their `GET /config` responses.

### Where they live

Shared packages live directly under `packages/<name>/` — alongside `packages/microservices/`, not inside it. The directory name is lowercase kebab-case and mirrors the scoped package name, so `packages/config/` is `@microservices/config`. The build system discovers shared packages by exclusion (anything under `packages/` that is not the `microservices/` namespace, a bin-only tool, or a test-only package), so there is no registry to edit — dropping the directory in is enough. A shared package is never discovered as a microservice, so it never gets a route or a registry entry.

### Package conventions

A shared package follows the same conventions as every other package:

- `package.json` with `"type": "module"`, a `@microservices/<name>` scoped name mirroring the directory, and `"main"`/`"types"` pointing at compiled output under `dist/`.
- `tsconfig.json` extending `../../tsconfig.base.json`.
- The four standard scripts: `build`, `test`, `lint`, `typecheck`.
- A barrel `src/index.ts` as the sole stable public API — nothing else in the package is stable.

A shared package points downward only. It may depend on third-party packages and other shared packages, but it must never import from a microservice or from the Overseer. That leaf-only rule is what keeps it safely shareable.

### Workspace ordering matters

Add a new shared package to the `workspaces` array in the root `package.json`, positioned **before every package that depends on it** — each consuming microservice, and the Overseer if it consumes the package. `npm run <script> --workspaces` visits packages in array order, and that order is the build order. A shared package listed *after* one of its consumers builds in the wrong order and breaks a fresh clone, where no compiled `dist/` exists yet to fall back on. `packages/config` sits after `packages/contracts` (its own dependency) and before `packages/microservices/*` and `packages/overseer`:

```jsonc
"workspaces": [
  "packages/contracts",
  "packages/config",        // before its consumers
  "packages/build-tools",
  "packages/microservices/*",
  "packages/overseer",
  "packages/integration-tests"
]
```

### Consuming a shared package

A microservice declares the dependency in its own `package.json` and imports it by package name only — never by a relative path into the shared package's `src/` or `dist/`:

```jsonc
// packages/microservices/microservice2/package.json
"dependencies": {
  "@microservices/config": "*"
}
```

```ts
// packages/microservices/microservice2/src/index.ts
import { buildConfigPayload } from "@microservices/config";
```

Adding a shared package and wiring up one consumer is a bounded change: create the package, insert it into `workspaces` in topological position, and add the dependency to the consuming microservice's `package.json`. No other microservice, `Dockerfile.template`, or workflow needs to change — the image build stages a shared package only when a selected microservice or the Overseer actually depends on it, so specific images stay minimal.

## Building a container image

```sh
# Generic (all microservices)
MICROSERVICES='*' sh scripts/emit-effective-dockerfile.sh
docker build -f Dockerfile.effective --build-arg MICROSERVICES='*' -t scaffold:generic .

# Specific (subset)
MICROSERVICES=microservice1,microservice2 sh scripts/emit-effective-dockerfile.sh
docker build -f Dockerfile.effective --build-arg MICROSERVICES=microservice1,microservice2 -t scaffold:specific .
```

`emit-effective-dockerfile.sh` bakes per-microservice runtime toggle defaults into the image so each selected service is enabled out of the box.

## Adopting this scaffold for a product

The workspace packages share an npm scope (`@microservices` by default). That scope
is a placeholder, not a product name — it shows up in package names, imports, the
generated registry, and test fixtures, but it does not identify your product. Since
each product is a fresh clone of this scaffold, rebrand the scope once after cloning:

```sh
sh scripts/rename-scope.sh @your-product
npm install
```

The script rewrites the `@microservices/` token across sources, `package.json`
names and dependency keys, tests, and comments. It deliberately leaves generated
output (the registry, the Dockerfile) and `package-lock.json` alone — those
regenerate — and it only touches the scoped token, so the repo/folder name and
image tags are untouched. The following `npm install` re-resolves the workspace
symlinks under the new scope and regenerates the lockfile.

To rename from a scope other than the default, pass it as a second argument:
`sh scripts/rename-scope.sh @your-product @old-scope`.

## Configuration

Copy `.env.example` to `.env` and adjust. See `.env.example` for all available variables.

## Project structure

| Package | Role |
|---|---|
| `packages/contracts` | Shared package: shared TypeScript types (request handler contract, exported module shape). |
| `packages/config` | Shared package: sample config data, shape, and helper consumed by `microservice2` and `microservice3`. |
| `packages/build-tools` | Registry generator and container image-tree assembler (CLI-only). |
| `packages/overseer` | The routing frontend — mounts enabled microservice routers and serves HTTP. |
| `packages/microservices/*` | Individual microservice modules. Each exports a `path` and a `router`. |
| `packages/integration-tests` | Cross-package integration test suites. |

## Scripts

| Command | Description |
|---|---|
| `npm start` | Run locally (uses dotenvx for `.env` injection). |
| `npm test` | Run the root test suite. |
| `npm run test --workspaces` | Run every package's test suite. |
| `npm run build --workspaces` | Build all packages. |
| `npm run typecheck --workspaces` | Typecheck all packages. |
| `npm run lint --workspaces` | Lint all packages. |
| `sh scripts/rename-scope.sh @your-product` | Rebrand the npm scope after cloning (see "Adopting this scaffold"). |

## Runtime toggles

Each microservice can be enabled or disabled at runtime via an environment variable:

```
MICROSERVICE_<IDENTIFIER>_ENABLED=enabled|disabled|true|false|1|0
```

When running locally, these are loaded from `.env` by dotenvx. In a container image, defaults are baked in by `emit-effective-dockerfile.sh` and can be overridden with `docker run -e`.

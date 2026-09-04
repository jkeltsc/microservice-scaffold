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
| `packages/contracts` | Shared TypeScript types (request handler contract, exported module shape). |
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

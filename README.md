# Microservice Scaffold

A template for composing HTTP microservices behind a single routing frontend (the Overseer).

## Quick start

```sh
npm install
npm run dev   # recommended for iterative development — watches and restarts on source changes
# or: npm start   # one-shot build-and-run, exits when the Overseer exits
# Overseer listens on port 8080 by default
curl http://localhost:8080/
```

`npm run dev` is the entry point for local development: it builds once, then keeps watching your sources and restarts the Overseer whenever you change them. `npm start` runs the same compiled output once and exits. See [Running locally](#running-locally) for the difference.

## Running locally

There are two ways to run the scaffold locally, and both execute the *same* compiled artifacts: the `dist/` output of each package, run through the same `packages/overseer/dist/index.js` entrypoint a container image uses. They differ only in whether a build watcher stays running.

### `npm run dev` — the dev server (recommended)

`npm run dev` is the recommended entry point for iterative development. It performs these startup steps in order:

1. **Environment load** — `.env` is injected via dotenvx, the same way `npm start` loads it.
2. **Bootstrap build** — `packages/contracts` and `packages/build-tools` are compiled so the registry generator can run.
3. **Registry generation** — the microservice registry is generated once for the current `MICROSERVICES` selector.
4. **Build watcher start** — a resident TypeScript build watches the sources of the selected microservices, the Overseer, and their shared-package dependencies, recompiling incrementally into each package's `dist/`.
5. **Overseer start** — the Overseer launches from `packages/overseer/dist/index.js`.

Once the session is running, it **picks up automatically** any change to a TypeScript source file of a package it is building: the watcher recompiles, and once the compile finishes cleanly, the Overseer restarts against the new output. A failed compile leaves the last good Overseer serving and prints the error with its file, line, and character position, so you can read the error, fix it, and continue without restarting anything.

Some changes are **not** picked up by a running session and require terminating it (Ctrl-C) and re-invoking `npm run dev`:

- Adding, removing, or renaming a directory under `packages/microservices/` — the registered microservice set is fixed for the session.
- A change to the `MICROSERVICES` selector.
- A change to a `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle or any other environment variable.

A dev session runs until you terminate it.

### `npm start` — one-shot run

`npm start` runs the same compiled artifacts without a build watcher: it loads the environment, bootstrap-builds, generates the registry, builds every package once, then runs the Overseer. It does not watch for changes, so it will not pick up edits — you restart it yourself. `npm start` terminates when the Overseer process it started exits, propagating that exit status. Use it as a one-shot path, or to isolate whether a problem is in the application rather than in the dev server's watch coordination.

### The demo page and its bundled output

`microservice1` serves the `@microservices/demo` SPA (the demo page) at the Overseer's base URL itself — Microservice1's mount root `/`. It is reachable there only while `microservice1` is among the selected microservices and its runtime toggle is enabled; disable the toggle or omit it from the `MICROSERVICES` selector and the base URL stops serving the page.

The demo page is a separate bundler build that neither `npm run dev` nor `npm start` produces. Build it from the repository root with:

```sh
npm run build --workspace @microservices/demo
```

That produces the demo's bundled output — its Spa_Root, the `dist/` directory inside `packages/spa/demo/`. `npm run dev` does not build or refresh it: the watcher only recompiles TypeScript sources, never invokes the SPA's bundler. So a fresh clone running under `npm run dev` has no Spa_Root yet, and until you run the build command above, a GET or HEAD at the base URL answers `503` with a `text/plain` body naming the resolved Spa_Root path and the exact build command that produces it (the `@microservices/demo` build command shown in the code block above). Once the build finishes, the base URL serves the page on the next request with no Overseer restart.

## Adding a microservice

Create a directory under `packages/microservices/<name>/` with a `package.json`, `tsconfig.json`, and `src/index.ts` that exports `path` (the HTTP mount path) and `router` (an Express router). The build system picks it up automatically — no Dockerfile or workflow changes needed.

### Subtree ownership: an obligation and its complement

Two statements govern what a microservice does at its mount path. Read apart they look contradictory; together they are one obligation and its complement.

**The obligation.** A microservice owns the subtree rooted at its exported mount path and answers every request in that subtree itself — including the status it chooses for a path it does not serve and for a method it does not serve — leaving none unhandled for the Overseer. The Overseer's responsibilities are exactly two: mount the enabled selected microservices at their exported paths, and respond `404` where no mount matches. It is not a fallback handler for a path a microservice owns but chose not to answer. As a consequence, a microservice mounted at `/` owns the whole origin, so in a container holding one (as `microservice1` does, serving the demo page there) the Overseer's catch-all is unreachable — and that is intended.

**The complement.** A microservice's framework contract is exactly its exported mount path plus its exported Express router. What it serves there — response bodies, content types, and per-method handling, including the status code and `Allow` header it returns for a method it does not serve — is that microservice's own choice, not a framework rule. `microservice2`'s identifier body and its `405 Allow: GET` for a non-GET request are one sample's choices; `microservice1`'s `405 Allow: GET, HEAD` for the same situation is an equally valid one. Read neither as a requirement on a microservice you add.

The two fit together because the obligation fixes only **whether** the microservice answers, while **what** it answers — status, headers, body — stays that microservice's own choice.

## Shared packages

A common package is a plain, non-microservice library that a microservice (and/or the Overseer) imports by package name. `packages/contracts` is the framework's own; `packages/common/config` (`@microservices/config`) and `packages/common/extended-config` (`@microservices/extended-config`) are worked examples of consumer-written ones. `microservice2` consumes `@microservices/config` to build its `GET /config` response. `microservice3` consumes `@microservices/extended-config`, and `@microservices/extended-config` in turn consumes `@microservices/config` — so `microservice3` reaches the base config transitively, never declaring `@microservices/config` itself. Each of those consumptions is by package name.

### Where they live

Common packages live under `packages/common/<name>/`, inside the `common` namespace container — not directly under `packages/`. The directory name is lowercase kebab-case and mirrors the scoped package name, so `packages/common/config/` is `@microservices/config` and `packages/common/extended-config/` is `@microservices/extended-config`. The build system discovers common packages by location — any direct subdirectory of `packages/common/` — so there is no registry to edit; dropping the directory in is enough. A common package is never discovered as a microservice, so it never gets a route or a registry entry.

### Package conventions

A common package follows the same conventions as every other package:

- `package.json` with `"type": "module"`, a `@microservices/<name>` scoped name mirroring the directory, and `"main"`/`"types"` pointing at compiled output under `dist/`.
- `tsconfig.json` extending `../../../tsconfig.base.json` (one `../` per directory level; a common package sits one level deeper than a top-level package).
- The four standard scripts: `build`, `test`, `lint`, `typecheck`.
- A barrel `src/index.ts` as the sole stable public API — nothing else in the package is stable.

A common package points downward only. It may depend on third-party packages and other common packages, but it must never import from a microservice or from the Overseer. That leaf-only rule is what keeps it safely shareable.

### Workspace membership matters

Add a new common package to the `workspaces` array in the root `package.json` — that entry is what makes it a workspace, so npm links it and every `--workspaces` script and the build system's discovery can see it. What matters is **that** it is listed, not **where**: the array declares membership only, and no path reads its order to decide a build order (see [How a build order is produced](#how-a-build-order-is-produced)). The build order comes from each package's declared `@microservices`-scoped dependencies through the Build_Sequence, so a package listed after one of its consumers still builds after that consumer's prerequisites — including on a fresh clone with no compiled `dist/` to fall back on. The existing glob entry already covers new common packages:

```jsonc
"workspaces": [
  "packages/contracts",
  "packages/build-tools",
  "packages/common/*",       // covers config, extended-config, and any new common package
  "packages/spa/*",
  "packages/microservices/*",
  "packages/overseer",
  "packages/integration-tests"
]
```

Because `packages/common/*` is a glob, a common package dropped into `packages/common/` is already a member — no array edit is needed for it. An entry needs adding only for a package the existing globs do not cover.

### Consuming a common package

A microservice declares the dependency in its own `package.json` and imports it by package name only — never by a relative path into the common package's `src/` or `dist/`:

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

Adding a common package and wiring up one consumer is a bounded change: create the package, make sure it is a `workspaces` member (the `packages/common/*` glob already covers one under `packages/common/`), and add the dependency to the consuming microservice's `package.json`. No other microservice, `Dockerfile.template`, or workflow needs to change — the image build stages a common package only when a selected microservice or the Overseer actually depends on it (directly or transitively), so specific images stay minimal.

### The `spa` category and `packages/spa/demo`

A `spa` package is a bundler-built frontend that lives under `packages/spa/<name>/`, inside the `spa` namespace container. It is discovered by location, and its category contract is a non-empty `scripts.build` (its own bundler build, e.g. Vite) rather than a barrel — a `spa` package declares no `main` and no `types`. `packages/spa/demo` (`@microservices/demo`) is the first member: the demo page `microservice1` serves at its mount root `/`. A microservice depends on a `spa` package only for staging — the microservice serves the SPA's bundled output; it never imports the SPA's code.

#### A `spa` package may consume a common package by name

A `spa` package reuses shared code the same way a microservice does: it declares a common package as a key of the `dependencies` object of its own `package.json` and imports it through the specifier `@microservices/<name>` — never by a relative path into that common package's `src/` or `dist/`. The worked example is `packages/spa/demo`, which declares `@microservices/extended-config` in its `dependencies` and imports it by that package name; because `@microservices/extended-config` in turn depends on `@microservices/config`, the demo reaches the base config transitively without declaring it.

Adding a common package dependency to a `spa` package needs no change to `Dockerfile.template`, none to the Exclusion_List in `scripts/emit-effective-dockerfile.sh`, and none to the build system — resolution already walks `@microservices`-scoped specifiers through the `spa` category, and staging already treats a `spa` package as a leaf.

##### Compiled and inlined, but not staged

A common package reachable only through a `spa` package sits on two different sides of the BUILD/STAGE distinction, and both halves are true at once:

- **It is a Required_Dependency (the BUILD set).** Dependency resolution walks the `spa` package's `@microservices`-scoped specifiers, so the common package is discovered, ordered ahead of the `spa` package, and compiled by the `tsc --build` pass before the Bundler_Build_Phase begins. The bundler then reads that compiled `dist/` and inlines the code into the `spa` package's self-contained bundle.
- **It is not a Staged_Dependency (the STAGE set).** Resolution arrives at the `spa` package and includes it, but does not expand it, so a common package reached *only* by way of a `spa` package is left out of the Image_Tree. Its code is already inlined into the bundle; no runtime process in the image can reach its `dist/`, so staging it would ship dead bytes and break minimality-by-construction.

A microservice serving a SPA must **compile and start with that SPA's bundle absent**. It compiles without the Spa_Root because it never statically imports the SPA — it resolves the bundle at run time (see below) — which is exactly what lets a `spa` package build in a trailing phase after the single `tsc --build` pass rather than as one of its roots: no TypeScript project ever reads a `spa` package's output. It starts without the Spa_Root too: while the bundle is missing, `microservice1` answers a GET or HEAD at its mount root `/` with `503` and a body naming the resolved Spa_Root and the build command that produces it, then serves the page on the next request once the bundle appears — no restart (see [The demo page and its bundled output](#the-demo-page-and-its-bundled-output)).

#### Locating a SPA's build output

A microservice serving a SPA locates that SPA's Spa_Root (its bundled `dist/`) through a run-time module-resolution call, not through the framework. There are two workable arrangements — a Spa_Resolution_Pair — and they are mutually exclusive:

- **Pair A** — the SPA declares `"exports": { ".": "./dist/index.html" }` (and no `main`), and the microservice resolves the bare name `@microservices/<name>`, then takes `dirname()` of the result.
- **Pair B** — the SPA declares neither `main` nor `exports`, and the microservice resolves `@microservices/<name>/package.json`, then takes `dirname()` and joins `dist`.

The manifest half and the resolution half of a pair must match; they cannot be mixed. Mixing them fails at resolution time: pair A's `exports` manifest makes pair B's `…/package.json` specifier throw `ERR_PACKAGE_PATH_NOT_EXPORTED` (declaring `exports` blocks every subpath it does not list), and pair B's bare manifest makes pair A's bare-name specifier throw `ERR_MODULE_NOT_FOUND` (there is no entry point to resolve, so the resolve points at nothing servable). The choice of pair belongs to the microservice and SPA that form it, not to the framework — the build system inspects neither half.

This sample uses **pair A**: `packages/spa/demo` declares the `exports` map and `microservice1` resolves the bare `@microservices/demo`. The reason is consistency — every cross-package reference in shipped `src/` code in this repository uses the bare `@microservices/<name>` form, so the locator matches that convention.

## Building a container image

A build is two commands, always in this order. The first reads `Dockerfile.template` and writes a generated `Dockerfile` (gitignored, carrying an `# AUTO-GENERATED` header); the second builds it. `docker build` discovers the generated `Dockerfile` by default, so no `-f` flag is needed.

```sh
# Generic (all microservices)
MICROSERVICES='*' sh scripts/emit-effective-dockerfile.sh
docker build --build-arg MICROSERVICES='*' -t scaffold:generic .

# Specific (subset)
MICROSERVICES=microservice1,microservice2 sh scripts/emit-effective-dockerfile.sh
docker build --build-arg MICROSERVICES=microservice1,microservice2 -t scaffold:specific .

# Spa-only (microservice1)
MICROSERVICES=microservice1 sh scripts/emit-effective-dockerfile.sh
docker build --build-arg MICROSERVICES=microservice1 -t scaffold:microservice1 .
```

`emit-effective-dockerfile.sh` bakes per-microservice runtime toggle defaults into the image so each selected service is enabled out of the box.

Each configuration stages only the packages its selector justifies, so specific images stay minimal:

- **Generic (`*`)** stages the common packages `config` and `extended-config` and the `spa` package `demo` (alongside every microservice).
- **Specific (`microservice1,microservice2`)** stages the common package `config` and the `spa` package `demo`, and does **not** stage `extended-config` — nothing in that selector reaches it, since only `microservice3` consumes `@microservices/extended-config`.
- **Spa-only (`microservice1`)**, published under the image-name suffix `microservice1`, stages the `spa` package `demo` and **neither** common package — `demo`'s dependencies on `config` and `extended-config` are compiled and inlined into its bundle, so nothing at runtime reaches their `dist/`.

A consequence to expect from the specific image: the demo page is served (`microservice1` is selected), but `microservice3` is not in it. Activating the `Microservice 3` button on the demo page shows `404` in the status field alongside the requested path in the request field — `microservice3` is not among that configuration's selected microservices, so the path falls inside the subtree `microservice1` owns at `/`, and `microservice1` answers it `404`.

## Adopting this scaffold for a product

The workspace packages share an npm scope (`@microservices` by default). That scope
is a placeholder, not a product name — it shows up in package names, imports, and
the generated registry, but it does not identify your product.

You declare your scope once, in the `scope` field of `scaffold.config.json` at the
repository root:

```jsonc
// scaffold.config.json
{ "scope": "@your-product" }
```

The build system reads that field once per run and derives every scoped name it
composes from it — discovery, the invariant checker, and the registry generator all
follow the configured scope. There is no tracked-file search-and-replace to run: a
project with no `scaffold.config.json` at all is valid and takes the `@microservices`
default. See [Configuration](#configuration) for the full config file.

One place npm still requires the scope written literally is each package's own
`package.json` `name`, because npm needs a literal package name. When you adopt the
scaffold you update those `name` fields (and the matching dependency keys) to your
scope, then run `npm install` so the workspace symlinks re-resolve under it. For a
container build, a project whose scope differs from `@microservices` passes it as a
build argument: `docker build --build-arg WORKSPACE_SCOPE=@your-product --build-arg MICROSERVICES=<selector> .`
alongside the usual selector — the Dockerfile emit script does not carry the scope
into the generated `Dockerfile`.

## Configuration

### Runtime configuration (`.env`)

Copy `.env.example` to `.env` and adjust. See `.env.example` for all available variables.

### Project configuration (`scaffold.config.json`)

`scaffold.config.json`, directly at the repository root, is committed source (not
generated output) in which a project declares its npm scope and where its packages
live. It is JSON with exactly two recognised top-level keys, both optional:

```jsonc
// scaffold.config.json
{
  "scope": "@your-product",
  "roots": {
    "microservice": "packages/microservices",
    "common": "packages/common",
    "spa": "packages/spa"
  }
}
```

- `scope` — the npm scope every scoped package name, dependency specifier, and
  emitted import specifier carries. Defaults to `@microservices`.
- `roots` — an object whose recognised keys are `microservice`, `common`, and
  `spa`, each a path (relative to the repository root) to the directory whose direct
  subdirectories are that category's packages. They default to `packages/microservices`,
  `packages/common`, and `packages/spa`.

Every declared path is relative to the repository root. A project with no
`scaffold.config.json` is valid and takes all four defaults, which is exactly how
this repository is configured. A rejected config file fails the run before any
package is discovered or built, reporting one diagnostic per rejected value that
names the JSON key path, the offending value, and why it was rejected.

## Project structure

| Package | Role |
|---|---|
| `packages/contracts` | Framework package: shared TypeScript types (request handler contract, exported module shape). |
| `packages/build-tools` | Registry generator and container image-tree assembler (CLI-only). |
| `packages/common/*` | Consumer-written common packages: `config` (consumed by `microservice2`) and `extended-config` (consumed by `microservice3`, and itself consuming `config`). |
| `packages/spa/*` | Bundler-built frontends: `demo`, the demo page `microservice1` serves at `/`; `demo` consumes `@microservices/extended-config`. |
| `packages/microservices/*` | Individual microservice modules. Each exports a `path` and a `router`. |
| `packages/overseer` | The routing frontend — mounts enabled microservice routers and serves HTTP. |
| `packages/integration-tests` | Cross-package integration test suites. |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Recommended for local development: build, watch, and restart the Overseer on source changes (see [Running locally](#running-locally)). |
| `npm start` | Run locally once and exit with the Overseer's status (uses dotenvx for `.env` injection). |
| `npm test` | Run the root test suite. |
| `npm run test --workspaces` | Run every package's test suite. |
| `npm run build` | Build all packages in dependency order. |
| `npm run typecheck --workspaces` | Typecheck all packages. |
| `npm run lint --workspaces` | Lint all packages. |

### How a build order is produced

Four entry points produce a build order, each through its own repo script and, in three cases, a compiled bin from `packages/build-tools` (bin paths below are relative to that package):

| Command | Repo script | Compiled bin | Order function | Membership |
|---|---|---|---|---|
| `npm run build` (also `npm test` via `pretest`, and `npm run ci`) | `scripts/build.js` | `dist/bin/build-workspaces.js` | `workspaceBuildOrder()` | whole repository |
| `npm start` | `scripts/start.js` | `dist/bin/build-workspaces.js` | `workspaceBuildOrder()` | whole repository |
| `docker build` | `scripts/emit-effective-dockerfile.sh`, then the image's `RUN` | `dist/bin/build-image-tree.js` | `buildPlanFrom()` | Selector-scoped |
| `npm run dev` | `scripts/dev.js` | `dist/bin/dev-supervisor.js` | `devProjectList()` → `buildPlanFrom()` | Selector-scoped |

There are two memberships here, not four. The whole-repository derivation builds every workspace package whatever the selector says — a test-only package such as `packages/integration-tests` is built by it and by nothing else. The Selector-scoped derivation builds only what the `MICROSERVICES` selector justifies, which is what keeps a specific image minimal.

No path reads the `workspaces` array for ordering. The array declares *membership* only — which packages are workspaces — not the order they build in. All four entry points reach their order through the same Build_Sequence, differing only in the membership they hand it: two memberships between them, the full-workspace membership that produces the Workspace_Build_Order (`npm run build` and `npm start`), and the Selector-scoped membership that produces the Tsc_Root_Order (`docker build` and `npm run dev`).

## Runtime toggles

Each microservice can be enabled or disabled at runtime via an environment variable:

```
MICROSERVICE_<IDENTIFIER>_ENABLED=enabled|disabled|true|false|1|0
```

When running locally, these are loaded from `.env` by dotenvx. In a container image, defaults are baked in by `emit-effective-dockerfile.sh` and can be overridden with `docker run -e`.

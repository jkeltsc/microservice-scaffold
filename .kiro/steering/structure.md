# Repository Structure

## The framework/consumer taxonomy

Every workspace package under `packages/` belongs to exactly one **Package_Category**, and the category axis is **framework versus consumer** — not "shared versus not shared". The single rule to remember:

> **The framework knows its own parts by name; it discovers the consumer's parts by location.**

- **Framework_Singleton** — a package that is part of the scaffold itself. The Build_System knows each one **by name**; none is ever discovered. There are exactly four, all direct subdirectories of `packages/`:
  - `packages/contracts/` — shared TS types (request handler contract, exported shape)
  - `packages/overseer/` — the routing frontend application
  - `packages/build-tools/` — registry generator, dependency resolver, image-tree assembler
  - `packages/integration-tests/` — cross-package integration test suite
- **Consumer_Category** — a kind of package a *user of this template* writes. The Build_System discovers these **by location**: each consumer package is a direct subdirectory of the one **Namespace_Container** that names its category. A Namespace_Container is not itself a package and declares no `package.json`. There are exactly three:
  - **microservice** → `packages/microservices/`
  - **common** → `packages/common/`
  - **spa** → `packages/spa/`

Only these seven entries — the four Framework_Singleton directories and the three Namespace_Container directories — sit directly under `packages/`, and nothing else. No Build_System check validates this; it is a convention that code review upholds. A direct subdirectory of `packages/` that is neither a Framework_Singleton nor a Namespace_Container has no category, and that is not an error — the build ignores it and exits zero.

## Layout

```
/
├─ package.json              # root; declares workspaces, shared devDependencies, engines
├─ tsconfig.base.json        # shared TS config extended by every package
├─ Dockerfile.template       # committed source: three-stage, selector-parameterized image build with COPY/ENV anchors
├─ .dockerignore             # keeps host node_modules/, dist/ and generated code out of the context
├─ scripts/                  # repo-level scripts not owned by any package
│  ├─ start.js               # npm start: generate microservice registry, build, run the Overseer
│  └─ emit-effective-dockerfile.sh   # reads Dockerfile.template, writes the generated Dockerfile with manifest COPY lines + toggle-default ENV lines
├─ .kiro/                    # specs, steering, hooks
└─ packages/
   ├─ contracts/             # Framework_Singleton: shared TS types (request handler contract, exported shape)
   ├─ overseer/              # Framework_Singleton: the routing frontend application
   ├─ build-tools/           # Framework_Singleton: registry generator, dependency resolver, image-tree assembler
   ├─ integration-tests/     # Framework_Singleton: cross-package integration test suite
   ├─ common/                # Namespace_Container for the common Consumer_Category (consumer-written shared libraries)
   │  └─ config/             # Common_Package: config data/shape/helper consumed by microservice2 + microservice3
   ├─ spa/                   # Namespace_Container for the spa Consumer_Category (bundler-built frontends); ships empty
   └─ microservices/         # Namespace_Container for the microservice Consumer_Category
      ├─ microservice1/      # reference microservice module
      ├─ microservice2/
      └─ microservice3/
```

The four Framework_Singletons and the three Namespace_Containers are the only direct children of `packages/`. Category members live *inside* their Namespace_Container: a microservice at `packages/microservices/<identifier>/`, a common library at `packages/common/<name>/`, a SPA at `packages/spa/<name>/`. A directory two or more levels below a Namespace_Container (for example a SPA source folder kept inside a microservice) is private content of its nearest enclosing member, never a discovered package of its own.

## Package conventions

Each package under `packages/` (whether a Framework_Singleton or a Consumer_Package) is a standalone npm workspace and follows these rules:

- Own `package.json` with `"type": "module"`, `"main"` pointing at compiled JS under `dist/`, and a `"types"` field.
- Own `tsconfig.json` extending `../../tsconfig.base.json` (add one `../` per extra directory level — `../../../tsconfig.base.json` for a package one level deeper, such as a microservice, common, or spa member).
- Own `src/` for TypeScript sources and `dist/` for build output (gitignored).
- Own `tests/` (or colocated `*.test.ts`) using vitest.
- Public API is limited to what `index.ts` re-exports. Nothing else is stable.
- **Exception — bin-only tooling packages.** A package whose entire interface is its CLI entry points may omit the barrel, and with it `main` and `types`; its `bin` block is the interface, and its modules are imported by path. `packages/build-tools/` is one: nothing imports it by package name, so a barrel would advertise an API no consumer has. A test that needs one of its functions deep-imports the compiled module (`@microservices/build-tools/dist/selector.js`).

Membership in a category is decided by **location alone**. A package's `main`/`types` (or their absence) never decides *which* category it belongs to; those fields are a per-category *contract* a package must satisfy once its category is fixed, not what makes it a member. Adding `main`/`types` to a bin-only tooling package does not turn it into a shared library, and removing them from a common library does not make it vanish — it fails the build loudly instead.

### Bins are thin wrappers

Every file under a package's `src/bin/` is a **thin wrapper only**: a `#!/usr/bin/env node` shebang, one import of a CLI entry point from a module under `src/`, and one call to it. Nothing else — no constants, no helpers, no filesystem access, no argument parsing, no exit-code logic:

```ts
#!/usr/bin/env node
import { runDevSupervisorCli } from "../dev-supervisor.js";

runDevSupervisorCli();
```

All CLI policy — environment-variable defaulting, filesystem walking, error framing, and exit statuses — lives in the module the bin imports, conventionally exported as `run<Thing>Cli()`. `packages/build-tools/src/dev-supervisor.ts`'s `runDevSupervisorCli()` and `packages/build-tools/src/repo-invariants.ts`'s `runRepoInvariantsCli()` are the references.

The reason is testability: a bin is compiled output invoked by path or by `bin` name, and it is the hardest surface to unit-test, so logic placed there is logic that cannot be tested without spawning a process. Keeping it in a module keeps it importable and testable.

## The three Consumer_Categories

### microservice — `packages/microservices/<identifier>/`

- **Directory naming:** the directory name IS the Microservice_Identifier; it must be lowercase and alphanumeric (see Naming). Nothing declares the identifier elsewhere.
- **Barrel:** not required. A microservice's module contract is its exported Microservice_Path plus an Express router, not a barrel — so no `main`/`types` validation is applied to it.
- **Dependency direction:** may depend on Common_Packages and Framework_Singletons (by package name). MUST NOT import from a peer microservice or from the Overseer.
- **Ships into an image:** yes, **iff** it is one of the Selected_Microservices for the build's Selector.
- **Build_Kind:** Tsc_Project — discovered as a root of `tsc --build` when selected. A subdirectory that is not a usable microservice module fails the subsequent `tsc` build rather than being flagged during discovery.

### common — `packages/common/<name>/`

- **Directory naming:** lowercase kebab-case that mirrors the package's `@microservices/<name>` name exactly (directory `config` ↔ name `@microservices/config`). A mismatch is a build failure.
- **Barrel:** **REQUIRED.** The `package.json` must declare both `main` and `types` as non-empty strings, and `index.ts` is the sole stable public API. A missing barrel field fails the build by name — it does not silently drop the package.
- **Dependency direction:** points **downward only**. May depend on third-party packages, other Common_Packages, and Framework_Singletons. MUST NOT depend on a Microservice_Package or the Overseer. This is the invariant that keeps a Common_Package a leaf library.
- **Ships into an image:** yes, **iff** it is in the Required_Dependencies of a selected microservice or the Overseer (reached transitively by following `@microservices`-scoped dependencies).
- **Build_Kind:** Tsc_Project — a `tsc --build` root when it is in the Required_Dependencies.

A Common_Package is imported by consumers **by package name only** (`@microservices/<name>`), never by a relative path into its `src/` or `dist/`. That is the only sanctioned way for two microservices to reuse the same code; microservices still never import each other.

### spa — `packages/spa/<name>/`

- **Directory naming:** lowercase kebab-case that mirrors its `@microservices/<name>` name exactly, the same rule as common. A mismatch is a build failure.
- **Barrel:** not required. Instead, the `package.json` **must declare a non-empty `scripts.build`** — that is the Spa_Package's category contract, and a missing build script fails the build.
- **Dependency direction:** same leaf discipline as common (third-party, other consumer libraries, Framework_Singletons; never a peer or the Overseer).
- **Ships into an image:** yes, **iff** it is in the Required_Dependencies.
- **Build_Kind:** **Bundler_Project** — built by invoking its own `npm run build`, **never** as a root of `tsc --build`. `packages/spa/` currently ships empty; the category and its tooling exist so that adding the first SPA needs no Build_System change.

## Common_Package guidance (replaces the former "Shared packages" section)

A **Common_Package** is a consumer-written leaf library whose public API is imported by package name (`@microservices/<name>`) by one or more microservices and/or the Overseer. It is discovered by **living under `packages/common/`** — location is the whole membership rule. A Common_Package MUST:

- Live at `packages/common/<name>/` (a common library is never placed directly under `packages/`).
- Declare a barrel: `package.json` with `"type": "module"`, `"main"`/`"types"` at `dist/`, the four standard scripts, and a barrel `index.ts` that is its sole stable public API. The barrel is a *contract the package must satisfy*, not what classifies it — a package placed under `packages/common/` that omits `main`/`types` is still a Common_Package, and it fails the build for a missing barrel rather than disappearing.
- Declare a `name` that mirrors its directory (`@microservices/<dirName>`).
- Be listed in the root `workspaces` array **before every package that depends on it** — every consuming microservice, and the Overseer if it consumes the package (see the workspace-order rule in `tech.md`). A consumer listed before its dependency breaks the fresh-clone build.
- Point **downward only**: depend on third-party packages, other Common_Packages, and Framework_Singletons, never on a Microservice_Package or the Overseer.

A microservice that consumes a Common_Package declares it in its own `package.json` `dependencies` by the `@microservices/<name>` package name and imports it only by that name.

Discovery is by location, not registration: the registry generator scans only `packages/microservices/`, so a Common_Package is never discovered as a microservice and never appears in the generated Microservice_Registry. The image pipeline stages it like any other consumer package (see "Container image contents").

## Microservice_Namespace

- `packages/microservices/` is the Microservice_Namespace: the single filesystem location the Build_System scans to discover microservices.
- Each direct subdirectory of `packages/microservices/` is a candidate microservice.
- The directory name of a microservice package IS its Microservice_Identifier. This is the sole definition of the identifier — nothing else declares one, so there is no consistency rule to enforce.

## Microservice package conventions

A microservice package MUST:

- Live at `packages/microservices/<identifier>/`. The directory name IS its Microservice_Identifier; the identifier is not exported by the module, and the Build_System records it in the generated Microservice_Registry.
- Export a string constant equal to its Microservice_Path (the full HTTP path it serves; e.g., `/auth`, `/api/microservice2`).
- Export an Express router (`express.Router()`) whose route table is defined by the microservice; the Overseer mounts this router at the microservice's declared Microservice_Path so the microservice owns the entire subtree rooted at that path.
- Not import from any peer microservice package.
- Not import from the Overseer package.

## Build-time registry

- `packages/build-tools/` owns the registry generator. It reads the `MICROSERVICES` build variable (`*` for all discovered candidates, or a comma-separated list of identifiers), lists the subdirectories of `packages/microservices/` without inspecting their contents, and emits a generated TypeScript manifest that statically imports the selected microservices. A subdirectory that is not a usable microservice module fails the subsequent `tsc` build rather than being detected during discovery.
- The generated manifest is written to a well-known location consumed by the Overseer at build time.

## Framework_Singletons and `contracts`

- The four Framework_Singletons are known **by name**, excluded from every Consumer_Category's discovered set, and never subject to consumer-package discovery or barrel validation. A bin-only Framework_Singleton (`build-tools`) declaring neither `main` nor `types` is fine.
- `packages/contracts/` is a Framework_Singleton, not a discovered library. It is excluded from every Consumer_Category set and is **built and staged for every Selector**: always the first `tsc --build` root (ahead of every other Tsc_Project), and always staged as a real directory at `node_modules/@microservices/contracts`. A `@microservices/contracts` dependency specifier resolves to the Framework_Singleton, is not followed, and never becomes one of the Required_Dependencies.
- **Open question (deliberately deferred):** whether a types-only Framework_Singleton like `contracts` actually needs to ship into a runtime image at all. This feature does **not** change its staging behavior — `contracts` still ships, byte-identical to before (its `dist/`, including `dist/testing/`).

## Container image contents

- `packages/build-tools/` also owns the image-tree assembler, which stages everything a runtime image contains into a single tree that the Dockerfile's runtime stage copies once. Only the packages a Selector justifies are compiled and staged, so image minimality holds by construction.
- Inside an image, microservices ship as `node_modules/@microservices/<identifier>` (real directories, not workspace symlinks), because the generated registry imports them by package name. `packages/microservices/` is absent from images entirely.
- The Overseer ships at `packages/overseer/` because the entrypoint invokes it by path.
- A Common_Package and a Spa_Package ship the same way microservices do: inside an image a required consumer library is a real directory at `node_modules/@microservices/<name>` (its `package.json` + compiled `dist/`), not a workspace symlink into `packages/`. The assembler stages such a package **only when a selected microservice or the Overseer depends on it** (directly or transitively), so a Specific_Container never ships a library none of its selected microservices consume. Minimality holds by construction — only required, compiled packages are staged, never staged-then-pruned. `packages/common/config/`, for example, is staged whenever `microservice2` or `microservice3` is selected and omitted otherwise. A Spa_Package is built via its own `npm run build` before staging (never through `tsc --build`).
- `packages/contracts/` is always staged at `node_modules/@microservices/contracts`, for every Selector, on Framework_Singleton grounds rather than being a required dependency (see above).
- Per-microservice default toggles (`MICROSERVICE_<IDENTIFIER>_ENABLED=enabled`) are baked by building the generated `Dockerfile`, produced from the committed `Dockerfile.template` by `scripts/emit-effective-dockerfile.sh` for the current selector. The generated `Dockerfile` is generated output and gitignored; `Dockerfile.template` is the committed source.

## Runtime toggles

- Toggles are supplied to the Overseer via process environment variables named `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED`.

## Naming

- Package names use kebab-case and mirror the directory name. Common and spa package names must mirror their directory as `@microservices/<dirName>` exactly (a mismatch fails discovery).
- Microservice identifiers are the directory names under `packages/microservices/`, and MUST be lowercase and alphanumeric. Nothing in the toolchain validates this — the identifier is not a declared value anywhere, so the convention is enforced by review. A name that uppercases into an invalid shell variable would break its `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle.
- Microservice paths are HTTP paths starting with `/` and are declared by each microservice module.

## Where things go

- **New microservice:** `packages/microservices/<identifier>/`. No changes to existing microservices are required, and no change to `Dockerfile.template`; the Build_System picks it up on the next build if included in the `MICROSERVICES` selector.
- **New common package** (a leaf library consumed by name by a microservice and/or the Overseer): `packages/common/<name>/`, following the Common_Package guidance above. Add it to the root `workspaces` array in topological position — before every consumer — and add the `@microservices/<name>` dependency to each consuming microservice's `package.json`. No change to existing non-consuming microservices and no change to `Dockerfile.template`: the emit script's globs pick up the new manifest automatically, and the assembler stages it only when a consumer is selected.
- **New SPA package** (a bundler-built frontend): `packages/spa/<name>/`, with a `scripts.build` and a name mirroring its directory. Add it to `workspaces` in topological position. No Build_System, emit-script, or `Dockerfile.template` change is needed — `packages/spa/*` is already a workspace entry, discovery finds it by location, and it is built via its own `npm run build`.
- **Cross-cutting types** (request handler contract): `packages/contracts/` (a Framework_Singleton).
- **Build tooling that needs the TypeScript workspace** (registry generator, dependency resolver, image-tree assembler): `packages/build-tools/` (a Framework_Singleton).
- **Repo-level scripts** that must run before anything is installed, or that wrap npm lifecycle commands: `scripts/`.
- **Spec documents:** `.kiro/specs/<feature-name>/`.
- **Project-wide conventions like these:** `.kiro/steering/`.
- **New test-only package** (a package under `packages/` with no production code shipped in the Container image, e.g. a sibling of `integration-tests`): `scripts/emit-effective-dockerfile.sh` discovers workspace manifests by glob-style listing (`packages/*/package.json`, `packages/microservices/*/package.json`, `packages/common/*/package.json`, `packages/spa/*/package.json`) and emits a manifest `COPY` line for every workspace it finds. To keep a test-only top-level package out of the generated `Dockerfile`, add its directory name to the Exclusion_List (`EXCLUDE_TOPLEVEL`) in the emit script.

## The Exclusion_List

The emit script drops exactly **four** top-level `packages/<name>` entries from its top-level scan, so that no Namespace_Container and no test-only package contributes a `COPY` line: `integration-tests`, `microservices`, `common`, and `spa`. The three Namespace_Container names are excluded at the *top level* only — their *members* (each microservice, each common package, each spa package) are always emitted through the container globs, because those members ship.

A Common_Package and a Spa_Package are **never** added to the Exclusion_List: they ship into images, so they must contribute a `COPY` line. The list is only for the three Namespace_Container directory names and for genuinely test-only top-level packages (such as `integration-tests`) whose code must never ship in an image. Nothing auto-detects a test-only package — the exclusion is by name.

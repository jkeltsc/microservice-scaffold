# Repository Structure

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
   ├─ overseer/              # the routing frontend application
   ├─ contracts/             # shared package: shared TS types (request handler contract, exported shape)
   ├─ config/                # shared package: config data/shape/helper consumed by microservice2 + microservice3
   ├─ <future shared packages>/  # any leaf library consumed by name by >1 microservice and/or the Overseer
   ├─ build-tools/           # registry generator and container image-tree assembler
   ├─ integration-tests/     # cross-package integration test suite
   └─ microservices/         # Microservice_Namespace — every subdirectory is a microservice
      ├─ microservice1/      # reference microservice module
      ├─ microservice2/
      ├─ microservice3/
      └─ <future microservices>/
```

## Package conventions

Each package under `packages/` (and every subdirectory of `packages/microservices/`) is a standalone npm workspace and follows these rules:

- Own `package.json` with `"type": "module"`, `"main"` pointing at compiled JS under `dist/`, and a `"types"` field.
- Own `tsconfig.json` extending `../../tsconfig.base.json` (or `../../../tsconfig.base.json` for microservice subpackages).
- Own `src/` for TypeScript sources and `dist/` for build output (gitignored).
- Own `tests/` (or colocated `*.test.ts`) using vitest.
- Public API is limited to what `index.ts` re-exports. Nothing else is stable.
- **Exception — bin-only tooling packages.** A package whose entire interface is its CLI entry points may omit the barrel, and with it `main` and `types`; its `bin` block is the interface, and its modules are imported by path. `packages/build-tools/` is one: nothing imports it by package name, so a barrel would advertise an API no consumer has. A test that needs one of its functions deep-imports the compiled module (`@microservices/build-tools/dist/selector.js`).

## Shared packages

A **shared package** is a non-microservice workspace located directly under `packages/` (outside `packages/microservices/`) whose public API is imported *by package name* (`@microservices/<name>`) by one or more microservices and/or the Overseer. `packages/contracts/` is the original reference; `packages/config/` is a second reference (the config data/shape/helper consumed by `microservice2` and `microservice3`). A shared package is a leaf library: it is a normal package under the general "Package conventions" above and has no special manifest of its own.

A shared package MUST:

- Live directly under `packages/` (not under `packages/microservices/`), with a directory name in lowercase kebab-case that mirrors its `@microservices/<name>` package name.
- Follow the general "Package conventions" (own `package.json` with `"type": "module"`, `"main"`/`"types"` at `dist/`, `tsconfig.json` extending `../../tsconfig.base.json`, the four standard scripts, and a barrel `index.ts` that is the sole stable public API).
- Be listed in the root `workspaces` array **before every package that depends on it** — every consuming microservice, and the Overseer if it consumes the package. This keeps `npm run <script> --workspaces` topological on a fresh clone (see the workspace-order rule in `tech.md`). A shared package listed after a consumer breaks the fresh-clone build.
- **Not** import from any microservice package or from the Overseer. A shared package points downward only (third-party deps and other shared packages); it never depends upward. This is the invariant that keeps it a leaf.

A microservice that consumes a shared package MUST declare it in its own `package.json` `dependencies` by the `@microservices/<name>` package name, and import it only by that name — never by a relative path into the shared package's `src/` or `dist/`. This is the only sanctioned way for one microservice to reuse code another microservice also uses; microservices still never import each other.

Discovery is by exclusion, not registration: nothing enumerates shared packages by name. The registry generator scans only `packages/microservices/`, so a shared package is never discovered as a microservice and never appears in the generated Microservice_Registry (no entry, import, or route). The image pipeline treats a shared package as a normal `packages/*` workspace (see "Container image contents" below).

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

## Container image contents

- `packages/build-tools/` also owns the image-tree assembler, which stages everything a runtime image contains into a single tree that the Dockerfile's runtime stage copies once. Only the selected microservices are compiled and staged, so image minimality holds by construction.
- Inside an image, microservices ship as `node_modules/@microservices/<identifier>` (real directories, not workspace symlinks), because the generated registry imports them by package name. `packages/microservices/` is absent from images entirely.
- The Overseer ships at `packages/overseer/` because the entrypoint invokes it by path.
- Shared packages ship the same way microservices do: inside an image a required shared package is a real directory at `node_modules/@microservices/<name>` (its `package.json` + compiled `dist/`), not a workspace symlink into `packages/`. The image-tree assembler stages a shared package **only when a selected microservice or the Overseer depends on it** (directly or transitively), so a Specific_Container never ships a shared package none of its selected microservices consume. Minimality holds by construction — only required, compiled shared packages are staged, never staged-then-pruned. `packages/config/`, for example, is staged whenever `microservice2` or `microservice3` is selected and omitted otherwise.
- Per-microservice default toggles (`MICROSERVICE_<IDENTIFIER>_ENABLED=enabled`) are baked by building the generated `Dockerfile`, produced from the committed `Dockerfile.template` by `scripts/emit-effective-dockerfile.sh` for the current selector. The generated `Dockerfile` is generated output and gitignored; `Dockerfile.template` is the committed source.

## Runtime toggles

- Toggles are supplied to the Overseer via process environment variables named `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED`.

## Naming

- Package names use kebab-case and mirror the directory name.
- Microservice identifiers are the directory names under `packages/microservices/`, and MUST be lowercase and alphanumeric. Nothing in the toolchain validates this — the identifier is not a declared value anywhere, so the convention is enforced by review. A name that uppercases into an invalid shell variable would break its `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle.
- Microservice paths are HTTP paths starting with `/` and are declared by each microservice module.

## Where things go

- New microservice: `packages/microservices/<identifier>/`. No changes to existing microservices are required, and no change to `Dockerfile.template` either; the Build_System will pick it up on the next build if included in the `MICROSERVICES` selector.
- New shared package (a leaf library consumed by name by more than one microservice and/or the Overseer): `packages/<name>/`, following the "Shared packages" rules above. Add it to the root `workspaces` array in topological position — before every consumer — and add the `@microservices/<name>` dependency to each consuming microservice's `package.json`. No change to existing non-consuming microservices, and no change to `Dockerfile.template`: the emit script's `packages/*/package.json` glob picks up the new manifest automatically, and the image-tree assembler stages it only when a consumer is selected. Do NOT add it to `EXCLUDE_TOPLEVEL` — that list is for test-only packages whose code must never ship in an image; a shared package must ship.
- Cross-cutting types (request handler contract): `packages/contracts/`.
- Build tooling that needs the TypeScript workspace (registry generator, image-tree assembler): `packages/build-tools/`.
- Repo-level scripts that must run before anything is installed, or that wrap npm lifecycle commands: `scripts/`.
- Spec documents: `.kiro/specs/<feature-name>/`.
- Project-wide conventions like these: `.kiro/steering/`.
- **New test-only package** (a package under `packages/` with no production code shipped in the Container image, e.g. a sibling of `integration-tests`): `scripts/emit-effective-dockerfile.sh` discovers workspace manifests by glob-style listing (`packages/*/package.json` and `packages/microservices/*/package.json`) and automatically emits a manifest `COPY` line for every subdirectory it finds. A test-only package would therefore leak into the generated `Dockerfile`'s manifest COPY layer, so you MUST add its directory name to the `EXCLUDE_TOPLEVEL` exclusion list in `scripts/emit-effective-dockerfile.sh` (which already lists `integration-tests` and the `microservices` namespace container). Nothing else auto-detects test-only packages — the exclusion is by name.

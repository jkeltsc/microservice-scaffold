# Repository Structure

## Layout

```
/
├─ package.json              # root; declares workspaces, shared devDependencies, engines
├─ tsconfig.base.json        # shared TS config extended by every package
├─ Dockerfile                # two-stage, selector-parameterized image build
├─ .dockerignore             # keeps host node_modules/, dist/ and generated code out of the context
├─ scripts/                  # repo-level scripts not owned by any package
│  ├─ start.js               # npm start: generate microservice registry, build, run the Overseer
│  └─ emit-effective-dockerfile.sh   # writes Dockerfile.effective with the toggle-default ENV lines
├─ .kiro/                    # specs, steering, hooks
└─ packages/
   ├─ overseer/              # the routing frontend application
   ├─ contracts/             # shared TS types (request handler contract, exported shape)
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
- **Exception — bin-only tooling packages.** A package whose entire interface is its CLI entry points may omit the barrel, and with it `main` and `types`; its `bin` block is the interface, and its modules are imported by path. `packages/build-tools/` is one: nothing imports it by package name, so a barrel would advertise an API no consumer has. A test that needs one of its functions deep-imports the compiled module (`@scaffold/build-tools/dist/selector.js`).

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
- Inside an image, microservices ship as `node_modules/@scaffold/<identifier>` (real directories, not workspace symlinks), because the generated registry imports them by package name. `packages/microservices/` is absent from images entirely.
- The Overseer ships at `packages/overseer/` because the entrypoint invokes it by path.
- Per-microservice default toggles (`MICROSERVICE_<IDENTIFIER>_ENABLED=enabled`) are baked by building `Dockerfile.effective`, generated from the base `Dockerfile` by `scripts/emit-effective-dockerfile.sh` for the current selector. `Dockerfile.effective` is generated output and gitignored.

## Runtime toggles

- Toggles are supplied to the Overseer via process environment variables named `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED`.

## Naming

- Package names use kebab-case and mirror the directory name.
- Microservice identifiers are the directory names under `packages/microservices/`, and MUST be lowercase and alphanumeric. Nothing in the toolchain validates this — the identifier is not a declared value anywhere, so the convention is enforced by review. A name that uppercases into an invalid shell variable would break its `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle.
- Microservice paths are HTTP paths starting with `/` and are declared by each microservice module.

## Where things go

- New microservice: `packages/microservices/<identifier>/`. No changes to existing microservices are required, and no change to the `Dockerfile` either; the Build_System will pick it up on the next build if included in the `MICROSERVICES` selector.
- Cross-cutting types (request handler contract): `packages/contracts/`.
- Build tooling that needs the TypeScript workspace (registry generator, image-tree assembler): `packages/build-tools/`.
- Repo-level scripts that must run before anything is installed, or that wrap npm lifecycle commands: `scripts/`.
- Spec documents: `.kiro/specs/<feature-name>/`.
- Project-wide conventions like these: `.kiro/steering/`.

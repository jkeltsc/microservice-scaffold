# Repository Structure

## The framework/consumer taxonomy

Every workspace package under `packages/` belongs to exactly one **Package_Category**, and the category axis is **framework versus consumer** — not "shared versus not shared". The single rule to remember:

> **The framework knows its own parts by name; it discovers the consumer's parts by location.**

- **Framework_Singleton** — a package that is part of the scaffold itself. The Build_System knows each one **by name**; none is ever discovered. There are exactly four, all direct subdirectories of `packages/`:
  - `packages/contracts/` — shared TS types, and types only (request handler contract, exported shape)
  - `packages/overseer/` — the Overseer_Library: the routing frontend as a library, consumed by package name through its barrel
  - `packages/build-tools/` — registry generator, dependency resolver, image-tree assembler, and the shared `fast-check` arbitraries
  - `packages/integration-tests/` — cross-package integration test suite
- **Consumer_Category** — a kind of package a *user of this template* writes. The Build_System discovers these **by location**: **the members of a Consumer_Category are the direct subdirectories of that category's configured Discovery_Root** — the path declared for that category under `roots` in `scaffold.config.json` (see `tech.md`). A Discovery_Root is not itself a package and declares no `package.json`. There are exactly three categories, each with a **Root_Default** a project uses when it declares none:
  - **microservice** → default `packages/microservices/`
  - **common** → default `packages/common/`
  - **spa** → default `packages/spa/`

There is one package that is neither: the **Entry_Package**.

## The Entry_Package

The **Entry_Package** is this project's own process entrypoint, and it is the third kind of package in the repository — **in no Consumer_Category and no Framework_Singleton**. It lives at the **Entry_Root**, a directory *outside* `packages/` (the directory holding the Framework_Singletons), whose **Entry_Root_Default is `app`** and which a project may relocate through the `entry` key of `scaffold.config.json` (see `tech.md`). It is **discovered by no category's Discovery_Root**: the Build_System knows the Entry_Root from the Effective_Config, and no category scan can reach it, because an Entry_Root equal to, inside, or containing a Discovery_Root is rejected before any discovery runs.

What it holds is the division of ownership this scaffold is built around:

- **The committed Entry_Module** — `<Entry_Root>/src/index.ts`, consumer-owned source. It imports the Overseer_Library by package name, calls `boot` and `startServer`, and is the only module in the repository that writes to stderr, calls `process.exit`, or binds the HTTP socket. The Build_System reads none of its content.
- **The generated registry it receives** — `<Entry_Root>/src/generated/microservice-registry.ts`, written by the registry generator (see "Build-time registry"). It is **gitignored generated output**, and the Entry_Module is the **only** module that statically imports it. No Framework_Singleton imports a generated file.

Its manifest is named for the scope plus the last segment of the Entry_Root (`@microservices/app` at the default), declares `"type": "module"`, the four standard scripts, and a dependency on the scoped `overseer` and `contracts` only — never a Microservice_Package, since the selected set is Selector-dependent and the generated registry's imports resolve through the workspace symlinks instead. It declares **no `main` and no `types`**: nothing imports it by name, and both a local run and a container invoke it by path at `<Entry_Root>/dist/index.js`. It also owns `<Entry_Root>/scripts/generate-registry.mjs`, a dependency-free ESM shim its own `build` and `typecheck` scripts run before the compiler so that compiling in that directory never depends on some other command having generated the registry first.

Like every workspace package, the Entry_Package must appear in the root `workspaces` array, and it is a Tsc_Project built through `tsc`.

The layout below is the **result of those three category defaults and the Entry_Root_Default**, not a fixed path: a project that declares a different root for a category discovers that category's members under the declared directory instead. This repository declares no `scaffold.config.json`, so it takes every default, and the four Framework_Singleton directories plus the three default Discovery_Root directories are the only direct children of `packages/`, with nothing else. No Build_System check validates *that* set; it is a convention code review upholds. A direct subdirectory of `packages/` that is neither a Framework_Singleton nor a configured Discovery_Root has no category, and that is not an error — the build ignores it and exits zero.

## Layout

```
/
├─ package.json              # root; declares workspaces, shared devDependencies, engines
├─ tsconfig.base.json        # shared TS config extended by every package
├─ Dockerfile.template       # committed source: three-stage, selector-parameterized image build with COPY/ENV anchors
├─ .dockerignore             # keeps host node_modules/, dist/ and generated code out of the context
├─ scripts/                  # repo-level scripts not owned by any package
│  ├─ start.js               # npm start: build, generate the microservice registry, run the Entry_Package's compiled entrypoint
│  └─ emit-effective-dockerfile.sh   # reads Dockerfile.template, writes the generated Dockerfile with manifest COPY lines + toggle-default ENV lines + the CMD naming the entrypoint
├─ .kiro/                    # specs, steering, hooks
├─ fixtures/                 # the Fixture_Tier: test subjects the platform owns; not a workspace, not a package, not a Discovery_Root
│  ├─ README.md              # what the tier is + the partition criterion + where a new scenario of each kind goes
│  ├─ diagnostic-coverage.json   # the Diagnostic_Coverage_Record: every Build_System Diagnostic_Tag → its covering scenario or its not-expressible reason
│  ├─ trees/                 # Tree_Fixtures: inert manifest trees an npm clean install would reject — read, never installed, never built
│  │  └─ <scenario>/         # e.g. config--unparsable, discovery--duplicate; each holds fixture.json + the tree its diagnostic concerns
│  └─ projects/              # the Fixture_Projects_Root: a SEPARATE npm workspace root of installable-but-hostile projects
│     ├─ package.json        # its own workspaces array + devDependencies (private: true); matched by NO root workspaces entry
│     ├─ package-lock.json   # committed; one `fixtures:install` serves every member of every scenario
│     └─ <scenario>/         # Project_Fixture, e.g. barrel--invalid, imports--peer; its own workspaces + scaffold.config.json + fixture.json
├─ app/                      # Entry_Package at the Entry_Root_Default: in no Consumer_Category, discovered by no Discovery_Root
│  ├─ src/index.ts           # the committed Entry_Module — imports @microservices/overseer by name; the only static importer of the generated registry
│  ├─ src/generated/microservice-registry.ts   # the generated registry (gitignored)
│  └─ scripts/generate-registry.mjs            # dependency-free shim: generates the registry ahead of this package's own build/typecheck
└─ packages/
   ├─ contracts/             # Framework_Singleton: shared TS types only (request handler contract, exported shape)
   ├─ overseer/              # Framework_Singleton: the Overseer_Library — routing frontend as a library; src/index.ts is its whole public API
   ├─ build-tools/           # Framework_Singleton: registry generator, dependency resolver, image-tree assembler, shared test arbitraries (src/testing/)
   ├─ integration-tests/     # Framework_Singleton: cross-package integration test suite
   ├─ common/                # Namespace_Container for the common Consumer_Category (consumer-written shared libraries)
   │  ├─ config/             # Common_Package: config data/shape/helper consumed by microservice2 and by extended-config
   │  └─ extended-config/    # Common_Package: widens config's settings block; depends on @microservices/config, consumed by microservice3
   ├─ spa/                   # Namespace_Container for the spa Consumer_Category (bundler-built frontends)
   │  └─ demo/               # Spa_Package: the Demo_Spa, first member of the spa category; served by microservice1 at its Mount_Root `/`
   └─ microservices/         # Namespace_Container for the microservice Consumer_Category
      ├─ microservice1/      # reference microservice module
      ├─ microservice2/
      └─ microservice3/
```

The Entry_Root is a direct child of the Project_Directory, a sibling of `packages/` rather than a child of it. Under the default roots, the four Framework_Singletons and the three Discovery_Root directories are the only direct children of `packages/`. Category members live *inside* their category's configured Discovery_Root: at the defaults, a microservice at `packages/microservices/<identifier>/`, a common library at `packages/common/<name>/`, a SPA at `packages/spa/<name>/`. A directory two or more levels below a Discovery_Root (for example a SPA source folder kept inside a microservice) is private content of its nearest enclosing member, never a discovered package of its own.

### Relocating a Discovery_Root or the Entry_Root

A project may point a category's Discovery_Root elsewhere — say `microservice` at `packages/services` — by declaring it under `roots` in `scaffold.config.json`. **Relocating a root requires updating the root `package.json` `workspaces` array in the same change** so its globs cover the new location, because npm reads `workspaces` statically — before any repository code, and therefore before the Build_System reads the config — to discover the workspaces and create the scoped symlinks. If the `workspaces` array is not updated to match the configured roots, `check:invariants` reports the Workspace_Coverage mismatch. The `workspaces` array declares *membership* only; its order is load-bearing for nothing (see `tech.md`).

**Relocating the Entry_Root carries the same obligation.** Moving the Entry_Package — say from `app` to `entrypoint` — is a directory move plus the `entry` edit in `scaffold.config.json` plus, **in the same change**, the matching root `workspaces` entry, for exactly the reason a relocated Discovery_Root needs one: npm reads `workspaces` before any repository code runs. Everything else follows the config: the generated registry moves to `<Entry_Root>/src/generated/microservice-registry.ts`, and the path a local run, the Build_Sequence, the image tree, and the generated `Dockerfile`'s `CMD` each name moves with it. Nothing else in the repository spells the Entry_Root.

## The Fixture_Tier

The **Fixture_Tier** is the directory `fixtures/`, a direct child of the Project_Directory and a sibling of `packages/`. It holds **test subjects the platform owns**: a platform test points the Build_System at a fixture and asserts against a tree the platform controls, rather than against whatever payload happens to be checked in under `packages/`.

The tier is **neither a workspace nor a package nor a member of any Consumer_Category nor a Framework_Singleton nor a Discovery_Root of this project.** No `workspaces` entry in the root `package.json` matches any path under `fixtures/`, and no Build_System source spells `fixtures` as a path literal. A fixture becomes a subject only because a *test* passes the fixture's directory as the Project_Directory of a platform entry point (or spawns a platform bin with that directory as its working directory); the Build_System itself never learns the tier exists. It is genuinely additive — nothing under `packages/` moved to make room for it, and the Payload_Tree still sits exactly where it did (see below).

The tier carries Fixture_Scenarios in exactly two subdirectories — `fixtures/trees/` and `fixtures/projects/` — and nowhere else. A **Fixture_Scenario** is one directory holding one named fault and one declared diagnostic: its own manifest tree plus a `fixture.json` **Scenario_Manifest** recording the single Diagnostic_Tag the scenario is built to provoke, the platform entry point that produces it, a one-sentence statement of the fault, and the partition justification. `fixtures/README.md` is the tier's own guide.

### The partition criterion — can npm install this?

A single question decides which subdirectory a scenario lives in: **can an npm clean install install this tree?**

- **`fixtures/trees/` — a Tree_Fixture holds hostility an npm clean install rejects.** Malformed JSON, a manifest declaring no `name`, two packages declaring the same name — faults npm itself refuses. Such a tree can only live somewhere **nobody installs it**, so a Tree_Fixture is an **inert manifest tree**: a test *reads* it and does nothing else — never installs it, never builds it, never executes a module of it, never writes inside it. It is self-contained: every file its diagnostic depends on lies inside its own directory, it resolves no dependency from outside itself, and it holds no symlink.
- **`fixtures/projects/` — a Project_Fixture holds hostility npm does not care about.** A missing `main`, a peer import, a missing `scripts.build`, a name not mirroring its directory, a Selector naming nothing — faults npm installs happily while a platform entry point still reports a diagnostic over the installed tree. `fixtures/projects/` is the **Fixture_Projects_Root**: a **single npm workspace root** with its own `package.json` (`private: true`, its own `workspaces` array, its own `devDependencies`) and its own committed `package-lock.json`, so **one install serves every member of every scenario**.

That the Fixture_Projects_Root is a **separate workspace root** is not tidiness: it is what keeps the deliberately-broken fixture packages **out of the platform's own `--workspaces` lint and typecheck fan-out.** Those fan-outs enumerate the *root* `package.json`'s `workspaces` array; because that array matches nothing under `fixtures/`, the platform's `lint`, `typecheck`, and `test` are never asked to accept a package that is broken on purpose. The fixture projects are installed only through their own root, through the `fixtures:install` script (see `tech.md`), never by the repository's own `npm install` or `npm ci`.

`fixtures/projects/` is deliberately **hostile-only**: every Project_Fixture provokes at least one diagnostic, and there is **no happy-path project fixture**. The happy-path live subject is the `example/` project a later feature introduces; a happy-path fixture here would be a second thing to keep in step with it for no gain.

### What is committed and what is gitignored

Everything that *describes* a scenario is committed: every Tree_Fixture file, every Project_Fixture source and manifest, every `fixture.json` Scenario_Manifest, the Fixture_Projects_Root's `package.json` and `package-lock.json`, the Diagnostic_Coverage_Record at `fixtures/diagnostic-coverage.json`, and `fixtures/README.md`.

Build output and installed dependencies stay **gitignored**: any `node_modules/`, any `dist/`, and any `*.tsbuildinfo` under `fixtures/`. These need no new `.gitignore` pattern — the repository's existing unanchored patterns already cover every such path under the tier — and the whole tier is kept out of the container build context by a single `fixtures/` entry in `.dockerignore`.

### Mutating a fixture

A test that needs a *mutated* fixture **clones it** (a Fixture_Clone: a copy in an OS temp directory outside the Project_Directory) and mutates the clone; it never writes into a committed Fixture_Scenario. The only in-place writes permitted under `fixtures/` are the gitignored generated output — a fixture's `dist/`, a fixture's `*.tsbuildinfo` — and the Fixture_Projects_Root's `node_modules/`, which only `fixtures:install` writes. The detailed permitted-write list lives in `tech.md`.

## The Classification_Record

Every platform test is assigned exactly one **Test_Class** in the **Classification_Record**, the committed machine-readable file `packages/integration-tests/platform-test-classification.json`. It lives with the platform's own test package rather than under `fixtures/`, because its subject is the platform's *tests*, not a fixture. There are three classes:

- **Payload_Coupled_Test** — at least one assertion's subject is a fact about this repository's committed Payload_Tree (a checked-in package, its declared name, its exported path, its declared dependencies, or its position in a derived order or a staged tree). Each such entry names its Fixture_Equivalent — the test that asserts the same claim over a fixture or a synthesized tree.
- **Drift_Detector** — a Payload_Coupled_Test deliberately *retained* to catch a pure Build_System core disagreeing with the committed repository. `discovery-real-tree.test.ts` and `workspace-build-order-real-tree.test.ts` are the two named real-tree tests retained as Drift_Detectors; each entry records the reason it is kept.
- **Payload_Independent_Test** — every assertion's subject is a component's behaviour for any conforming layout, where payload-shaped names appear only as values of a Synthesized_Tree or a Fixture_Scenario.

The record's entries are ordered by **ascending code-point of the Project_Directory-relative POSIX path**, and a guard checks the record against the discovered platform test set.

## Package conventions

Each package under `packages/` (whether a Framework_Singleton or a Consumer_Package), and the Entry_Package at the Entry_Root, is a standalone npm workspace and follows these rules:

- Own `package.json` with `"type": "module"`, `"main"` pointing at compiled JS under `dist/`, and a `"types"` field.
- Own `tsconfig.json` extending `../../tsconfig.base.json` (add one `../` per extra directory level — `../../../tsconfig.base.json` for a package one level deeper, such as a microservice, common, or spa member).
- Own `src/` for TypeScript sources and `dist/` for build output (gitignored).
- Own `tests/` (or colocated `*.test.ts`) using vitest.
- Public API is limited to what `index.ts` re-exports. Nothing else is stable.
- **Exception — bin-only tooling packages.** A package whose entire interface is its CLI entry points may omit the barrel, and with it `main` and `types`; its `bin` block is the interface, and its modules are imported by path. `packages/build-tools/` is one: nothing imports it by package name, so a barrel would advertise an API no consumer has. A test that needs one of its functions deep-imports the compiled module (`@microservices/build-tools/dist/selector.js`).
- **Exception — the Entry_Package.** It omits `main` and `types` too, for the mirror-image reason: nothing imports it at all, by name or by path into its modules. It is invoked as a process, by path, at `<Entry_Root>/dist/index.js`. Sitting at the Entry_Root rather than under `packages/`, its `tsconfig.json` extends `../tsconfig.base.json` — one `../` fewer than a top-level package under `packages/`.

Membership in a category is decided by **location alone**. A package's `main`/`types` (or their absence) never decides *which* category it belongs to; those fields are a per-category *contract* a package must satisfy once its category is fixed, not what makes it a member. Adding `main`/`types` to a bin-only tooling package does not turn it into a shared library, and removing them from a common library does not make it vanish — it fails the build loudly instead.

### Shared test arbitraries live in `build-tools`

The shared `fast-check` arbitraries live under **`packages/build-tools/`**, at `src/testing/`, compiled to `dist/testing/`. `packages/contracts/` carries **types only** — no test helpers and no `fast-check` dependency.

A package whose tests import the arbitraries declares **`@microservices/build-tools` as a *development* dependency** — never a runtime one, since no shipped code path reaches them — and imports them the way every consumer of a bin-only tooling package does, by compiled path:

```ts
import { arbHttpMethod } from "@microservices/build-tools/dist/testing/index.js";
```

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
- **Dependency direction:** same leaf discipline as common (third-party, other consumer libraries, Framework_Singletons; never a peer or the Overseer). A Spa_Package MAY declare a Common_Package dependency by the package name `@microservices/<name>` — the same way a microservice does — while keeping that leaf discipline intact: it still names no Microservice_Package and never the Overseer. The Demo_Spa is the worked example: it declares `@microservices/extended-config` in its own `dependencies` and imports it by package name.
- **Ships into an image:** yes, **iff** it is in the Required_Dependencies.
- **Build_Kind:** **Bundler_Project** — built by invoking its own `npm run build`, **never** as a root of `tsc --build`. `packages/spa/demo/` is the category's first member (the Demo_Spa); the category and its tooling were built so that adding a SPA needs no Build_System change.
- **Why the bundler build is a trailing phase:** a Microservice_Package serving a Spa_Package **compiles with no Spa_Root present** — it reaches the Spa_Root only through the run-time module-resolution call below, never through a static import — so nothing a Tsc_Project compiles depends on a Spa_Package's bundle existing. That compile-time independence is precisely why a Spa_Package is never a root of `tsc --build` and why its bundler build is deferred to the last statement of the Build_Sequence (statement 7), run only after the single `tsc --build` pass over the Tsc_Project roots exits 0. The runtime half — a serving microservice must also **start** without the Spa_Root present, answering `503` at its Mount_Root while the bundle is absent and recovering on the next request with no restart — is already specified by the `scaffold-demo-samples` feature and is not restated here.
- **Locating the Spa_Root:** a microservice serving a Spa_Package locates the Spa_Root (the Spa_Package's built `dist/`) through a **run-time module-resolution call**, not through a static import. Two Spa_Resolution_Pairs are permitted, and they are mutually exclusive: an `exports` map in the Spa_Package's manifest paired with resolving the package by its bare `@microservices/<name>` name, or no `main`/`exports` paired with resolving the Spa_Package's `package.json`. The manifest half and the resolution half of the **chosen** pair must match — mixing halves fails to resolve — and the choice belongs to the microservice and the Spa_Package that form the pair, not to the framework. The Build_System constrains neither half: a Spa_Package's category contract is a non-empty `scripts.build` alone, and the Repo_Invariant_Checker does not inspect a specifier passed to a run-time module-resolution call. A user adding a second Spa_Package finds this convention here in steering rather than by reading the Demo_Spa's source.

## Common_Package guidance (replaces the former "Shared packages" section)

A **Common_Package** is a consumer-written leaf library whose public API is imported by package name (`@microservices/<name>`) by one or more microservices and/or the Overseer. It is discovered by **living under `packages/common/`** — location is the whole membership rule. A Common_Package MUST:

- Live at `packages/common/<name>/` (a common library is never placed directly under `packages/`).
- Declare a barrel: `package.json` with `"type": "module"`, `"main"`/`"types"` at `dist/`, the four standard scripts, and a barrel `index.ts` that is its sole stable public API. The barrel is a *contract the package must satisfy*, not what classifies it — a package placed under `packages/common/` that omits `main`/`types` is still a Common_Package, and it fails the build for a missing barrel rather than disappearing.
- Declare a `name` that mirrors its directory (`@microservices/<dirName>`).
- Be listed in the root `workspaces` array **before every package that depends on it** — every consuming microservice, and the Overseer if it consumes the package (see the workspace-order rule in `tech.md`). A consumer listed before its dependency breaks the fresh-clone build.
- Point **downward only**: depend on third-party packages, other Common_Packages, and Framework_Singletons, never on a Microservice_Package or the Overseer.

A microservice that consumes a Common_Package declares it in its own `package.json` `dependencies` by the `@microservices/<name>` package name and imports it only by that name.

Discovery is by location, not registration: the registry generator scans only the configured microservice Discovery_Root (the common root is a different configured location), so a Common_Package is never discovered as a microservice and never appears in the generated Microservice_Registry. The image pipeline stages it like any other consumer package (see "Container image contents").

## Microservice_Namespace

- The **configured microservice Discovery_Root** (default `packages/microservices/`) is the single filesystem location the Build_System scans to discover microservices.
- Each direct subdirectory of that root is a candidate microservice.
- The directory name of a microservice package IS its Microservice_Identifier. This is the sole definition of the identifier — nothing else declares one, so there is no consistency rule to enforce.

## Microservice package conventions

A microservice package MUST:

- Live at `packages/microservices/<identifier>/`. The directory name IS its Microservice_Identifier; the identifier is not exported by the module, and the Build_System records it in the generated Microservice_Registry.
- Export a string constant equal to its Microservice_Path (the full HTTP path it serves; e.g., `/auth`, `/api/microservice2`).
- Export an Express router (`express.Router()`) whose route table is defined by the microservice; the Overseer mounts this router at the microservice's declared Microservice_Path so the microservice owns the entire subtree rooted at that path.
- Not import from any peer microservice package.
- Not import from the Overseer package.

### Subtree ownership

A microservice owns the subtree rooted at its exported Microservice_Path and answers **every** request in that subtree from its own router — including the status it chooses for a path it does not serve and for a method it does not serve — leaving no such request unhandled for the Overseer to answer. The Overseer's responsibilities are exactly two: mount the enabled Selected_Microservices at their exported Microservice_Paths, and respond 404 where no mounted microservice matches the path. It is not a fallback handler for a path a microservice owns but chose not to answer.

The obligation fixes only *whether* a microservice answers; the status, the headers, and the body it answers with stay that microservice's own choice. The three reference microservices are worked examples that choose deliberately differently:

- **Microservice1** (mounted at `/`) answers a method it does not serve with `405 Allow: GET, HEAD`, and otherwise serves the Demo_Spa (200), a `503` at its Mount_Root while the Spa_Root is absent, and a `404` for a GET or HEAD naming no file inside the Spa_Root.
- **Microservice2** and **Microservice3** answer a method they do not serve with `405 Allow: GET`, serve their config payloads at `/config`, and answer `404` from their own routers for any other path in their subtrees.

As a consequence, a microservice mounted at `/` owns the whole origin, so the Overseer's catch-all is unreachable in a Container containing one. That is the principle's intended outcome, not a defect.

## Build-time registry

- `packages/build-tools/` owns the registry generator. It reads the `MICROSERVICES` build variable (`*` for all discovered candidates, or a comma-separated list of identifiers), lists the subdirectories of the configured microservice Discovery_Root (default `packages/microservices/`) without inspecting their contents, and emits a generated TypeScript manifest that statically imports the selected microservices by their scoped package names. A subdirectory that is not a usable microservice module fails the subsequent `tsc` build rather than being detected during discovery.
- **The generated registry is written into the Entry_Package, at `<Entry_Root>/src/generated/microservice-registry.ts`** (`app/src/generated/microservice-registry.ts` at the default). It is gitignored generated output: the generator is the only party that writes it, and every path that compiles the Entry_Package generates it first (see `tech.md`).
- **The Entry_Module is the only module that statically imports it.** No Framework_Singleton does — the Overseer_Library takes the registry as an argument to `boot`, so nothing under `packages/` imports a generated file. The import stays static rather than dynamic so the registry's shape is type-checked against the contract at compile time.

## Framework_Singletons, the Overseer_Library, and `contracts`

- The four Framework_Singletons are known **by name**, excluded from every Consumer_Category's discovered set, and never subject to consumer-package discovery or barrel validation. A bin-only Framework_Singleton (`build-tools`) declaring neither `main` nor `types` is fine.
- **`packages/overseer/` is a library, not a process.** Its **public API is its barrel**, `src/index.ts`, and nothing else: it exports `boot`, `startServer`, and the types those two name in their signatures (`BootOptions`, `BootResult`, `RegisteredMicroserviceInfo`, `AppConfig`). Everything else — config loading, app building, toggle parsing — is internal, and a module reached only by a relative path into `src/` is not stable. The library **imports no generated file**, holds no generated directory of its own, and performs no process effect: no stderr write, no `process.exit`, no socket bind. Those belong to the Entry_Module, which consumes the barrel by package name. A consumer of this scaffold replaces the Entry_Module; it does not edit the library.
- `packages/contracts/` is a Framework_Singleton, not a discovered library. It is excluded from every Consumer_Category set and is **built and staged for every Selector**: always the first `tsc --build` root (ahead of every other Tsc_Project), and always staged as a real directory at `node_modules/@microservices/contracts`. A `@microservices/contracts` dependency specifier resolves to the Framework_Singleton, is not followed, and never becomes one of the Required_Dependencies.
- **Open question (deliberately deferred):** whether a types-only Framework_Singleton like `contracts` actually needs to ship into a runtime image at all. Nothing has changed its staging — it is built and staged for every Selector, as stated above — and the question stays open.

## Container image contents

- `packages/build-tools/` also owns the image-tree assembler, which stages everything a runtime image contains into a single tree that the Dockerfile's runtime stage copies once. Only the packages a Selector justifies are compiled and staged, so image minimality holds by construction.
- Inside an image, microservices ship as `node_modules/@microservices/<identifier>` (real directories, not workspace symlinks), because the generated registry imports them by package name. `packages/microservices/` is absent from images entirely.
- **The Overseer ships as a library, at `node_modules/@microservices/overseer`** — under the scope like every other package consumed by name, because the Entry_Module imports it by name. It no longer occupies a package directory.
- **The Entry_Package is the one package staged at its package directory**, `<Entry_Root>/` (`app/` at the default): its `package.json` plus its compiled `dist/`, and no `src/`. It stays at a package directory for the reason it always was — the entrypoint is invoked **by path**, at `<Entry_Root>/dist/index.js`, which is what the generated `Dockerfile`'s `CMD` names.
- `build-tools` and `integration-tests` are never staged: nothing an image runs invokes either, and nothing imports either by name at run time.
- A Common_Package and a Spa_Package ship the same way microservices do: inside an image a required consumer library is a real directory at `node_modules/@microservices/<name>` (its `package.json` + compiled `dist/`), not a workspace symlink into `packages/`. The assembler stages such a package **only when a selected microservice or the Overseer depends on it** (directly or transitively), so a Specific_Container never ships a library none of its selected microservices consume. Minimality holds by construction — only required, compiled packages are staged, never staged-then-pruned. `packages/common/config/`, for example, is staged whenever `microservice2` or `microservice3` is selected and omitted otherwise. A Spa_Package is built via its own `npm run build` before staging (never through `tsc --build`).
- `packages/contracts/` is always staged at `node_modules/@microservices/contracts`, for every Selector, on Framework_Singleton grounds rather than being a required dependency (see above).
- Per-microservice default toggles (`MICROSERVICE_<IDENTIFIER>_ENABLED=enabled`) are baked by building the generated `Dockerfile`, produced from the committed `Dockerfile.template` by `scripts/emit-effective-dockerfile.sh` for the current selector. The generated `Dockerfile` is generated output and gitignored; `Dockerfile.template` is the committed source.

## Runtime toggles

- Toggles are supplied to the Overseer via process environment variables named `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED`.

## Naming

- **A Consumer_Package's package name is the Configured_Scope followed by `/` and its own directory name** — at the default scope, a package in directory `config` is named `@microservices/config`. Common and spa package names must mirror their directory this way exactly (a mismatch fails discovery); a project with a different Configured_Scope composes the same names under that scope instead.
- **The four Framework_Singleton directories stay fixed** — `contracts`, `overseer`, `build-tools`, `integration-tests`, always directly under `packages/` — **while their package names follow the Configured_Scope**, composed the same way as a Consumer_Package's: the scope followed by `/` and the fixed directory name.
- **The Entry_Package's name is composed the same way**, from the Configured_Scope and the **last path segment of the Entry_Root** — `@microservices/app` at both defaults. Nothing imports it by that name; the name exists so npm treats it as a workspace.
- Package names use kebab-case and mirror the directory name.
- Microservice identifiers are the directory names under `packages/microservices/`, and MUST be lowercase and alphanumeric. Nothing in the toolchain validates this — the identifier is not a declared value anywhere, so the convention is enforced by review. A name that uppercases into an invalid shell variable would break its `MICROSERVICE_<IDENTIFIER>_ENABLED` toggle.
- Microservice paths are HTTP paths starting with `/` and are declared by each microservice module.

## Where things go

- **New microservice:** `packages/microservices/<identifier>/`. No changes to existing microservices are required, and no change to `Dockerfile.template`; the Build_System picks it up on the next build if included in the `MICROSERVICES` selector.
- **New common package** (a leaf library consumed by name by a microservice and/or the Overseer): `packages/common/<name>/`, following the Common_Package guidance above. Add it to the root `workspaces` array in topological position — before every consumer — and add the `@microservices/<name>` dependency to each consuming microservice's `package.json`. No change to existing non-consuming microservices and no change to `Dockerfile.template`: the emit script's globs pick up the new manifest automatically, and the assembler stages it only when a consumer is selected.
- **New SPA package** (a bundler-built frontend): `packages/spa/<name>/`, with a `scripts.build` and a name mirroring its directory. Add it to `workspaces` in topological position. No Build_System, emit-script, or `Dockerfile.template` change is needed — `packages/spa/*` is already a workspace entry, discovery finds it by location, and it is built via its own `npm run build`.
- **Cross-cutting types** (request handler contract): `packages/contracts/` (a Framework_Singleton, types only).
- **Build tooling that needs the TypeScript workspace** (registry generator, dependency resolver, image-tree assembler): `packages/build-tools/` (a Framework_Singleton).
- **Shared `fast-check` arbitraries** used by more than one package's tests: `packages/build-tools/src/testing/`, imported from `@microservices/build-tools/dist/testing/index.js` by a package declaring `@microservices/build-tools` as a development dependency. Not in `packages/contracts/`, which stays types-only.
- **Process-entrypoint code** (composing the Overseer_Library and starting it): the Entry_Module at `<Entry_Root>/src/index.ts`. This is the file a consumer of the scaffold owns and edits; the routing library under `packages/overseer/` is not.
- **A generated registry consumer:** nowhere else. `<Entry_Root>/src/generated/microservice-registry.ts` is written by the generator and statically imported by the Entry_Module alone — do not add a second importer, and do not commit it.
- **Repo-level scripts** that must run before anything is installed, or that wrap npm lifecycle commands: `scripts/`.
- **Spec documents:** `.kiro/specs/<feature-name>/`.
- **Project-wide conventions like these:** `.kiro/steering/`.
- **New test-only package** (a package under `packages/` with no production code shipped in the Container image, e.g. a sibling of `integration-tests`): `scripts/emit-effective-dockerfile.sh` discovers workspace manifests by glob-style listing — the top-level `packages/*/package.json` plus one glob per configured Discovery_Root (`<microservice-root>/*/package.json`, `<common-root>/*/package.json`, `<spa-root>/*/package.json`) — and emits a manifest `COPY` line for every workspace it finds. To keep a test-only top-level package out of the generated `Dockerfile`, add its directory name to the by-name portion of the Exclusion_List in the emit script (the same portion that carries `integration-tests`).
- **New hostile fixture scenario** (a test subject the platform points itself at, provoking exactly one diagnostic): decide its partition by the single question **can an npm clean install install this tree?** (see "The Fixture_Tier"). A tree npm rejects goes in `fixtures/trees/<scenario>/`; a tree npm installs while a platform entry point still reports goes in `fixtures/projects/<scenario>/` — and its member packages must be matched by a `*/packages/*`-shaped glob in `fixtures/projects/package.json`'s `workspaces` array (which never matches the scenario's own directory). Name the directory by its **Scenario_Directory_Name** — the Expected_Diagnostic's text with the brackets dropped and the single `:` replaced by `--`, optionally followed by `.` and a lowercase-alphanumeric-and-hyphen qualifier (the doubled hyphen keeps the derivation reversible when the tag's category itself contains a hyphen, so `[build-order:cycle]` becomes `build-order--cycle`). Declare a **Scenario_Manifest** (`fixture.json`: the Expected_Diagnostic, the entry point that produces it, one sentence stating the fault, and the partition justification) at the scenario root, and add a **Diagnostic_Coverage_Record** entry in `fixtures/diagnostic-coverage.json` naming this scenario for the tag it covers.

## The Exclusion_List

**The emit script derives both its manifest `COPY` globs and its Exclusion_List from the configured Discovery_Roots** rather than from three hard-coded literals. It reads the three roots from `scaffold.config.json` (falling back to the defaults when none is declared) and emits a `COPY` line for every manifest under each configured root as well as for the top-level Framework_Singletons — so relocating a root moves the emitted globs with it, needing no edit to the emit script or to `Dockerfile.template`. It reads the configured `entry` value the same way, and emits the Entry_Package's own manifest `COPY` line plus the `CMD` naming `<Entry_Root>/dist/index.js` (see `tech.md`).

The Exclusion_List is the set of top-level `packages/<name>` entries that contribute no `COPY` line, and it too is derived from the configured roots: it is **the first path segment of each configured Discovery_Root that is itself a top-level `packages/<name>` entry** (at the defaults, `microservices`, `common`, and `spa`), **plus the by-name `integration-tests`**. A configured root's top-level container is excluded at the *top level* only — its *members* (each microservice, common package, and spa package) are always emitted through the per-root globs, because those members ship.

A genuinely test-only top-level package (such as `integration-tests`) is still excluded **by name**: nothing auto-detects a test-only package. A Common_Package and a Spa_Package are **never** added to the Exclusion_List — they ship into images, so they must contribute a `COPY` line.

The Entry_Root is **not** part of the Exclusion_List and has nothing to do with it: it is not a `packages/<name>` entry at all, and the Entry_Package ships.

**The Configured_Scope is not among the values the emit script reads.** The emit script reads the three `roots` and `entry` — never `scope` — and never carries the scope into the generated `Dockerfile`; the scope reaches a container build through the `WORKSPACE_SCOPE` build argument instead (see `tech.md`).

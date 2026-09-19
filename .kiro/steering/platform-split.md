---
inclusion: auto
name: platform-split
description: Decision record for splitting this repository into a publishable platform, a fixture tier, and one example consumer project. Use when creating or revising a spec for any part of that program - config-driven discovery, the project config, registry inversion, the two published packages, shipped tsconfig/eslint/prettier presets, the wiring generator, the fixture layout, the example project, or the CI/release split.
---

# Platform Split - Decision Record

## Status and how to read this file

**Status: Accepted, not yet implemented.** This file records **target state**. The
repository does not look like this yet.

`product.md`, `tech.md`, and `structure.md` describe **present state** and stay
truthful for the whole duration of this program, because task-execution chats
read them while looking at the actual tree. Each spec in this program updates the
parts of those three files it actually changed, as its final task.

### Lifecycle

This record is **append-only and permanent**. It is not deleted when the program
finishes, and it is never moved or renamed - specs cite its decisions by number
(`D5`, `D8`), and those citations must not dangle.

When the last spec lands:

- the status line above changes to **Implemented**, naming the specs that did it;
- the frontmatter flips from `inclusion: auto` to `inclusion: manual`, so it stops
  activating during ordinary work once it is history;
- anything here that merely restates what `tech.md` or `structure.md` now say may
  be trimmed to a pointer. **The rejected alternatives stay.** They are the part
  with no other home, and they are what stops a settled question from being
  re-opened.

### How specs cite this file

A spec must be **self-contained**: its design states the decision it implements in
its own terms and reads correctly with this file unloaded. A `D5` citation is
provenance - where the decision came from and what else was considered - never a
load-bearing premise. Every decision below is settled; the Open items section
holds the only thing that is not.

## Thesis

The platform currently assumes **it is the repository**: discovery paths are
relative to the repo root, the npm scope is baked into source, the generated
registry is written into the Overseer's own `src/`, and tests assert against
whatever payload happens to be checked in. Every problem this program addresses
is a consequence of that assumption. The platform becomes a **consumable pair of
npm packages**, and the payload becomes something the platform is pointed at.

## Decisions

### D1 - Platform-only namespace

`packages/` contains platform code only. No payload lives there and none appears
in published output. The scope is `@jkeltsc` (confirmed to match the GitHub
owner, which GitHub Packages requires).

### D2 - Three-way repository split

| Location | Contents | npm relationship |
| --- | --- | --- |
| `packages/` | platform packages only | the root npm workspace |
| `fixtures/` | test subjects for platform tests | see D4 |
| `example/` | one full consumer project | own manifest and lockfile, **not** a root workspace |

### D3 - The example is a real project, and platform tests stay outside it

One example suffices. It is a complete project with its own `package.json`,
lockfile, scripts, and tests, and it must look as if it had been produced by the
generator (D12). Its own tests mirror what a real adopter would write.

Platform tests that *use* the example live in the platform's own test package and
treat `example/` as a black box: run its build, assert the derived order, assert
the staged image tree, spawn a dev session, build its container, assert its own
`npm test` exits 0.

**Platform tests may read and execute the example. They must never write into
it.** No platform helper imported by example code, no fixture manifest parked in
it, no test-only microservice. Enforce this mechanically, in the spirit of the
existing `integration-scope-guard` and `worktree-safety-guard` tests.

The example has two jobs - documentation and test subject - and they pull in
opposite directions. Protecting rule: **the example grows only to demonstrate
something an adopter needs. Anything added purely to exercise the platform goes
to fixtures.**

### D4 - Fixtures are real directories, partitioned by whether npm cares

Hostile fixtures are checked-in directories, not dynamically mutated clones,
because legibility matters more than economy here.

- `fixtures/trees/<scenario>/` - inert manifest trees. Never installed, never
  built, only read. This is where hostility that **npm itself cannot install**
  lives: malformed JSON, an invalid package name.
- `fixtures/projects/` - a single npm workspace root with its own `workspaces`
  array and lockfile, so one `npm ci` serves every member. This is where
  hostility **npm does not care about** lives: a missing `main`/`types`, a peer
  import, a missing `scripts.build`, a name/directory mismatch, an unsatisfiable
  selector. A separate workspace root also keeps these out of the platform's own
  `--workspaces` lint and typecheck fan-out.

Two supporting rules:

- A test that runs a build against a fixture clears that fixture's `dist/` and
  `*.tsbuildinfo` first. A previously failed build leaves partial output that can
  make a later run pass spuriously. Clearing gitignored output in place stays
  within the worktree rules in `tech.md`.
- A test that mutates a tree copies the already-installed tree into a temp dir
  (`cp -Rc` on macOS, `cp -al` on Linux) and mutates the copy. `npm ci` runs
  once, not per suite. `pristineWorktree()`'s reason to exist - capturing
  uncommitted **platform** source, because test tree and platform tree were the
  same tree - disappears once they are different trees. The prohibition on
  mutating the checked-out tree does not.

### D5 - Discovery, scope, and layout become configuration

The platform reads a project config supplying the consumer's scope and its
discovery roots, rather than hard-coding `@microservices` and
`packages/microservices/*`:

    { scope: "@acme", roots: { microservice: "packages/services", common: "...", spa: "..." } }

`discoverPackagesFrom(root)` in `discovery.ts` already accepts a root, so this is
partly in place. The Repo_Invariant_Checker's scope-based rules (no peer import,
Common_Package direction) read the scope from config: the platform's scope is fixed
and published, and the consumer's scope is a config parameter, not a
search-and-replace.

This is also what decouples the tests. `discovery-real-tree.test.ts` and
`workspace-build-order-real-tree.test.ts` assert on checked-in payload only
because they have no other tree to point at.

### D6 - The generated registry inverts

The generated module moves into the **consumer's** repo. It statically imports
the selected microservices - inside the consumer's own `tsc` pass, so the
static-import guarantee survives - and hands the registry to the platform:

    import * as orders from "@acme/orders";
    export default createOverseer([{ identifier: "orders", module: orders, sourcePackage: "@acme/orders" }]);

Codegen into an installed `node_modules` package is impossible, so this is
forced, not preferred. The root `prepare` script that copies the empty registry
template retires with it.

### D7 - Three published packages

| Package | Role | Consumer declares it as |
| --- | --- | --- |
| `@jkeltsc/contracts` | the shared type surface: `MicroserviceModule`, `RegistryEntry`, `MicroserviceRegistry`, `ToggleMap`, the `Router` re-export | `dependencies` |
| `@jkeltsc/overseer` | runtime library: `createOverseer`, toggle evaluation, mounting | `dependencies` |
| `@jkeltsc/foreman` | dev tooling: bins, config presets, generator, programmatic API, test arbitraries | `devDependencies` |

Dependency direction: overseer depends on contracts, foreman depends on
contracts, and nothing depends on foreman. Foreman's public surface is three
things, not one - bins, presets, and the programmatic API - which its `exports`
map must reflect. The name is deliberate: the Overseer supervises services at
run time, the Foreman directs construction. `build-tools` undersold a package
that also ships config presets and a generator.

Two arrangements were rejected. The types **cannot** live in foreman:
after D6 they are `createOverseer`'s published signature, so the runtime
package's `.d.ts` would import from its own tooling - a dependency in the wrong
direction that works only while foreman happens to be installed, and that
`skipLibCheck: true` would hide. Folding them into `@jkeltsc/overseer` avoids
that too, and was the earlier decision, but a distinct package is the honest
graph and keeps a consumer's `import type { MicroserviceModule }` pointing at a
package whose whole purpose is that type.

The cost is three chances for version skew instead of two. It is paid by
**publishing all three in lockstep**: one version number, one tag, one release,
and exact or `~` ranges between them, so there is never a compatibility matrix to
reason about.

### D8 - What lives where, and why the arbitraries are not in `contracts`

`@jkeltsc/contracts` carries types only. It keeps `express` as a dependency for
the `Router` re-export, so a consumer can name the router type without depending
on express in its own type surface.

`testing/arbitraries.ts` moves to **foreman** rather than staying at
`@jkeltsc/contracts/testing` where it sits today. It emits values rather than
types and it needs `fast-check`; `contracts` is in the consumer's `dependencies`,
so a fast-check-bearing subpath there would either risk pulling fast-check into a
production install or force an optional peer dependency. Foreman is already a
devDependency, so it depends on `fast-check` outright, and on
`contracts` for the types the arbitraries generate. The direction stays correct.

**A simplification this unlocks.** Today `contracts` is a Framework_Singleton
that the image-tree assembler always stages at
`node_modules/@microservices/contracts` for every selector, on framework grounds
rather than because anything requires it. As a published package it is an
ordinary dependency of `@jkeltsc/overseer`, so it arrives through the
`prod-deps` stage's `npm ci --omit=dev` like any other dependency. The
always-staged special case disappears, and so does the question `tech.md` and
`structure.md` currently leave open about whether a types-only singleton needs to
ship at all.

### D9 - The platform has no bootstrap and does not self-host

A platform-only repo has no microservices, no common packages, and no SPAs, so it
has **nothing to order**. The Build_Sequence is consumer-facing tooling; the
platform's own build is `tsc --build` over a fixed set of projects.

`scripts/build.js`, the `runBootstrapBuild` step in `scripts/common-startup.js`,
and the plain-JS-because-compiled-output constraint all retire. Self-hosting was
considered and rejected: it reintroduces a chicken-and-egg that plain `tsc` does
not have.

Independently available if any repo-level script is still wanted in TypeScript:
Node strips types natively, on by default since 22.18.0, so bumping `engines` to
`>=22.18` removes the last reason for a `.js` script.

### D10 - Presets are shipped and verified, not generated

`@jkeltsc/foreman` ships a tsconfig base, an eslint flat config, and a
prettier config, exposed through its `exports` map (including the JSON file for
`extends`). All three are composable, so a consumer overrides any field, layers
their own base, or declines entirely.

Generated config is rejected for **content**: it is a snapshot the platform can
never improve, so better defaults and newly required settings would need
migration notes instead of a version bump.

But "fully overridable" is not honest for all of it. Some settings are
load-bearing and the tooling must **verify them and fail fast with a message
naming the setting and the reason**:

| Setting | Why it is load-bearing |
| --- | --- |
| `composite: true` | the build is a single `tsc --build` over project references |
| `declaration: true` | cross-package consumption by package name |
| `outDir: "./dist"` | the image-tree assembler stages `dist/` |
| `rootDir: "./src"` | pins the output layout; a stray file outside `src/` would reshape it |

`strict`, `target`, `esModuleInterop`, `skipLibCheck`, and arguably
`module`/`moduleResolution` are preference and stay freely overridable.

Verification must read the **resolved** config (`tsc --showConfig`, or the
compiler API), not raw JSON - a package inheriting a value from the base would
otherwise be reported as missing it. The check belongs in `check:invariants`,
already the cheap gate that runs before typecheck.

### D11 - `outDir`/`rootDir` stay per-package

They cannot move into the shipped base: relative paths in a tsconfig resolve
relative to the file that **declares** them, so `"outDir": "./dist"` in the
shipped base would resolve inside `node_modules/@jkeltsc/foreman/`. They stay
declared per package as convention, and D10 verifies them.

Note that `outDir` has no useful default - unset means emit lands beside the
sources - so it must be declared explicitly. `rootDir` is inferred from the
inputs, and is declared anyway to pin the layout.

### D12 - The generator generates wiring, never content

An `init`-style bin writes the thin files a consumer owns and will edit: a
tsconfig that extends the preset, an eslint config that spreads the preset, the
four standard scripts, the project config from D5, and the generated registry
entry module from D6. Per-category scaffolds (`init microservice <identifier>`
and the common/spa equivalents) write a manifest, tsconfig, and stub, which also
quietly enforces the naming conventions `structure.md` currently says code review
upholds.

The presets stay in the package, upgradeable. Only the wiring is generated.

**Drift alarm:** a platform test runs the generator into a temp dir and compares
the **wiring files only** against `example/` - tsconfig, eslint config, project
config, script names. Extra files in the example are expected; differing wiring
is a failure. This is what keeps the example trustworthy as documentation.

### D13 - Distribution and the local loop

- **During development:** GitHub Packages (`npm.pkg.github.com`). The scope must
  equal the owner, which `@jkeltsc` satisfies. The workflow-provided
  `GITHUB_TOKEN` with `packages: read` can install a package belonging to the
  same repository as the workflow, which covers the example.
- **Before going public:** npmjs.com. GitHub Packages requires a token to install
  even public packages, so a third party who clones this repo cannot `npm ci` the
  example without creating one. That is an unacceptable adoption tax for a
  scaffold. Publish from Actions with npm Trusted Publishing (OIDC) rather than a
  long-lived token.
- **Local fast loop:** link the platform into the example by `file:` dependency
  or by `overrides` applied through a script. Fast, but a symlink resolves
  through the **source tree**, so it can reach files that would never ship and
  can sidestep the `exports` map.
- **Therefore, mandatory in CI:** a job that runs `npm pack` on all three
  packages, installs the tarballs into the example, builds it, and builds its container.
  That job is the publish-surface test, and it catches a missing `files` entry or
  a wrong `exports` path on every PR instead of after a release.

Rejected: git dependencies (npm has no subdirectory support, awkward for a
monorepo), release tarballs (no semver resolution), and JSR (interesting for a
TS-native package, but a second registry to reason about). Staying a fork-only
template was considered and rejected - publishing is the point.

### D14 - CI and release split

Platform `ci.yml`, in order: build, `check:invariants`, typecheck, lint, platform
tests, `npm pack` all three packages, install the example against the tarballs, the
example's own `npm test`, then the example-as-subject tests from D3.

The example's install is a **prerequisite of part of the platform's suite**, not
an independent job. Accept that coupling deliberately. Locally it needs a root
`example:install` script, and any test that finds no installed example skips with
a reason - the `{ available, reason }` pattern `pristineWorktree()` already uses -
rather than failing.

`release.yml` publishes all three packages on a semver tag, in lockstep (D7),
and no longer builds containers. The container matrix currently in
`release.yml` moves to the example's own workflow.

## What no spec in this program may assume

- that discovery paths or the npm scope are hard-coded
- that the Overseer can import a generated file from its own `src/`
- that a test may point at checked-in payload under `packages/`
- that platform code may be built by anything other than plain `tsc --build`
- that a test may write into `example/`

## Open items

- **The npm scope claim.** Deferred on purpose: scopes are claimed on first
  publish, and until then the scope is a search-and-replace away from changing.
  Only decide when publishing to npmjs.com.

## Proposed sequencing

Not a decision - revisit as each spec is written. Roughly: config-driven
discovery and the project config first, because everything else depends on the
platform no longer assuming it is the repo; then registry inversion and the split of
`contracts` into its own published package; then the repository re-shape into `packages/`, `fixtures/`, and
`example/`; then packaging, presets, generator, and the CI/release split.

Prefer writing one spec at a time. This record pins the target, so later specs
*could* be drafted up front, but implementing the earlier ones will change them.

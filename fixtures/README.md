# The Fixture_Tier

This directory (`fixtures/`, directly inside the Project_Directory) holds **test
subjects the platform owns**. A platform test points the Build_System at a fixture
and asserts against a tree the platform controls, rather than against whatever
payload happens to be checked in under `packages/`.

The tier is **not** a workspace package, **not** a member of any Consumer_Category,
**not** a Framework_Singleton, and **not** a Discovery_Root of this project. No
`workspaces` entry in the root `package.json` matches any path under `fixtures/`,
and no Build_System source spells `fixtures` as a path literal. A fixture becomes a
subject only because a *test* passes the fixture's directory as the Project_Directory
of a platform entry point, or spawns a platform bin with that directory as its
working directory. The Build_System itself never learns the tier exists.

## The partition criterion — can npm install this?

Every Fixture_Scenario lives in exactly one of two subdirectories, and a single
question decides which: **can an npm clean install install this tree?**

### `trees/` — hostility an npm clean install rejects

A **Tree_Fixture** (a direct subdirectory of `fixtures/trees/`) holds hostility that
npm itself rejects: malformed JSON, a manifest declaring no `name`, two packages
declaring the same name. Such a tree can only live somewhere **nobody installs it** —
asking npm to install it would fail for the scenario's own reason.

A Tree_Fixture is therefore an **inert manifest tree**: a test reads it and does
nothing else. It is **never installed, never built, never executed, and never
written to**. It is self-contained — every file its diagnostic depends on lies inside
its own directory, it resolves no dependency from outside itself, and it contains no
symlink.

**A new Tree_Fixture goes in `fixtures/trees/<scenario>/`.**

### `projects/` — hostility npm does not care about

A **Project_Fixture** (a direct subdirectory of `fixtures/projects/`) holds hostility
npm does not care about: a missing `main`, a peer import, a missing `scripts.build`, a
name that does not mirror its directory, a Selector naming nothing. Such a fault needs
a **genuinely installed tree** to be observed the way the platform observes a real
project — the install succeeds while a platform entry point still reports a diagnostic
over it.

`fixtures/projects/` is a **single npm workspace root** with its own `package.json`
(its own `workspaces` array, its own `devDependencies`) and its own committed
`package-lock.json`, so **one install serves every member of every scenario**. That
install is run only through the root `fixtures:install` script — never by the
repository's own `npm install` or `npm ci`. The tier is installed **once** through the
Fixture_Projects_Root and nowhere else.

The projects tier is deliberately **hostile-only**: every Project_Fixture provokes at
least one diagnostic. There is no happy-path project fixture — the happy-path live
subject is the `example/` project a later feature introduces.

**A new Project_Fixture goes in `fixtures/projects/<scenario>/`, and its member
packages must be matched by a glob in `fixtures/projects/package.json`'s `workspaces`
array** (a `*/packages/*`-shaped glob that matches the members inside the scenario and
never the scenario's own directory).

## What is committed and what is not

Everything that describes a scenario is committed: every Tree_Fixture file, every
Project_Fixture source and manifest, every `fixture.json` Scenario_Manifest, the
Fixture_Projects_Root's `package.json` and `package-lock.json`, and this README.

Build output and installed dependencies stay untracked — the repository's existing
unanchored `.gitignore` patterns (`node_modules/`, `dist/`, `*.tsbuildinfo`) already
cover every such path under `fixtures/`, so no `.gitignore` change is needed. The
whole tier is kept out of the container build context by a single `fixtures/` entry in
`.dockerignore`, so a deliberately-broken manifest never reaches an image build.

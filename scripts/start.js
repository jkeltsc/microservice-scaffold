#!/usr/bin/env node
// Local development entry point wired to `npm start` (Requirement R10).
//
// Gives `npm start` the same registry-generation semantics a Container build
// uses (R10.1, R10.2): generate the registry for `MICROSERVICES` (unset means
// "*", R10.3), build every workspace, then run the Overseer. Each step must
// succeed before the next one runs, so a selector error (R10.4) or a build
// failure aborts before the Overseer starts and its exit code is propagated.
//
// RELATIONSHIP TO THE ROOT `prepare` SCRIPT. `prepare` copies an empty
// template into the generated-registry location after every install, so a fresh
// clone's Overseer has a valid (empty) registry to compile against. It does NOT
// build anything — the template is the source. The two steps below (bootstrap +
// generate) are still needed: `prepare`'s template is a zero-microservice
// placeholder, so `npm start` must regenerate the registry for its own
// `MICROSERVICES` selector before it builds.
//
// STEP ORDER — verified against a genuinely clean checkout (no node_modules, no
// dist/, no *.tsbuildinfo, no generated registry), because two orderings that
// look fine on a warm tree both fail there:
//
//   1. The generator runs as its COMPILED bin, which does not exist on a fresh
//      clone if `prepare` did not run or bailed out. So the first step is a
//      bootstrap build of exactly the two packages that bin needs — contracts
//      and build-tools — mirroring the Dockerfile's
//      `npx tsc --build packages/contracts packages/build-tools`.
//   2. Generating BEFORE the full build is what gives `npm start` parity with a
//      Container build (the Overseer compiles against the fresh registry, never
//      a stale one), and it is only sound because the root `workspaces` array is
//      in topological order. The generated registry statically imports
//      `@scaffold/microservice<N>`, so the microservices must be built before the
//      Overseer; with `overseer` listed ahead of them this step failed with
//      `TS2307: Cannot find module '@scaffold/microservice1'`.
//
// Paths are relative to cwd, which is the repo root for npm scripts.

import { spawnSync } from "node:child_process";

/** Run a command inheriting stdio; on failure, exit with its code. */
function runOrExit(command, args) {
  const { error, status } = spawnSync(command, args, {
    stdio: "inherit",
    // Resolve npm shims on Windows as well as POSIX.
    shell: process.platform === "win32",
  });

  if (error || status !== 0) {
    process.stderr.write(
      `[start] "${command} ${args.join(" ")}" failed (${error?.message ?? `exit ${status}`}); refusing to start the Overseer\n`,
    );
    process.exit(typeof status === "number" && status !== 0 ? status : 1);
  }
}

// Bootstrap: compile the two packages the generator bin is made of, so the next
// step exists even in a tree where `prepare` never ran or a `dist/` was cleaned.
// Incremental, so this is a near no-op on a warm tree, and the full build below
// rebuilds them anyway.
runOrExit("npm", [
  "run",
  "build",
  "--workspace",
  "@scaffold/contracts",
  "--workspace",
  "@scaffold/build-tools",
]);

// The same generator entry point the Dockerfile build stage uses, invoked as the
// compiled bin so `npm start` works without an npm bin-link pass. The selector
// comes from the inherited environment.
runOrExit(process.execPath, [
  "packages/build-tools/dist/bin/generate-registry.js",
]);

// Build every workspace; the Overseer compiles against the fresh registry.
runOrExit("npm", ["run", "build", "--workspaces"]);

const server = spawnSync(
  process.execPath,
  ["packages/overseer/dist/index.js"],
  {
    stdio: "inherit",
  },
);
process.exit(typeof server.status === "number" ? server.status : 1);

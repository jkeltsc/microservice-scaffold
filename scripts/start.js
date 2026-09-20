#!/usr/bin/env node
// Builds every workspace package in dependency order and runs the project's
// entrypoint once.
//
// This is what `npm start` invokes, and its four ordered steps are the ones
// `npm run dev` also performs: environment load (`dotenvx run --`, before Node
// starts), bootstrap build, registry generation, then server start. The two
// shared middle steps — the bootstrap build of the two packages the registry
// generator is built from, then generating the registry for `MICROSERVICES`
// (unset means "*") — come from scripts/common-startup.js, which is the sole
// owner of the reasoning about their order. A selector error or a failed build
// aborts before anything is spawned.
//
// Step 4 spawns the Entry_Point_Path, the Entry_Package's compiled entry module,
// and no Framework_Singleton's compiled path (registry-inversion R7.2, R10.6,
// R10.7). The path is not composed here: it is read off the compiled
// ProjectContext, which derives it in one module from the Effective_Config
// (R7.1).
//
// The full build goes through the compiled ordered `build-workspaces` bin — the
// same entry point scripts/build.js spawns — so its order comes from the
// Build_Sequence, not from npm's traversal of the `workspaces` array. That array
// declares workspace membership only; it is an order source for no path. The
// bootstrap in runCommonStartup compiles contracts and build-tools, so the bin
// exists by the time it is spawned here.
//
// This file owns the process effects around those steps: the full build, the
// one-shot Overseer run, and exit-status propagation. Paths are relative to cwd,
// the repo root for npm scripts.

import { spawnSync } from "node:child_process";

import { runCommonStartup } from "./common-startup.js";

// A failed startup step propagates its own status, and the Overseer never starts.
const startup = runCommonStartup({ tag: "start" });
if (!startup.ok) {
  process.stderr.write(
    `[start] ${startup.message}; refusing to start the Overseer\n`,
  );
  process.exit(startup.status);
}

// Build every workspace in dependency order via the ordered bin the bootstrap
// just produced; the Overseer compiles against the fresh registry.
const ordered = spawnSync(
  process.execPath,
  ["packages/build-tools/dist/bin/build-workspaces.js"],
  {
    stdio: "inherit",
  },
);
if (typeof ordered.status !== "number" || ordered.status !== 0) {
  const reason = ordered.error?.message ?? `exit ${ordered.status}`;
  process.stderr.write(
    `[start] ordered build failed (${reason}); refusing to start the Overseer\n`,
  );
  process.exit(
    typeof ordered.status === "number" && ordered.status !== 0
      ? ordered.status
      : 1,
  );
}

// Step 4 — the server start. The module spawned is `context.entryPointPath`, the
// single derivation every consumer reads (R7.1, R7.2, R10.6). The import is
// dynamic because the module being imported is compiled output the bootstrap
// build above produces: a static import would be evaluated on a clean checkout
// before that build had run. `requireProjectContext` reports any
// Config_Diagnostic and exits 1 itself, so a rejected config never reaches a
// spawn.
const { requireProjectContext } =
  await import("../packages/build-tools/dist/config-loader.js");
const context = requireProjectContext();

// One-shot: this process exits with the spawned process's status and watches for
// no change — that is the whole difference from `npm run dev` (R10.7).
const server = spawnSync(process.execPath, [context.entryPointPath], {
  stdio: "inherit",
});
process.exit(typeof server.status === "number" ? server.status : 1);

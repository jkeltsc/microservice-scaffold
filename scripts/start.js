#!/usr/bin/env node
// Builds every workspace package in dependency order and runs the Overseer once.
//
// This is what `npm start` invokes. Its two shared startup steps — the bootstrap
// build of the two packages the registry generator is built from, then generating
// the registry for `MICROSERVICES` (unset means "*") — come from
// scripts/common-startup.js, which is the sole owner of the reasoning about their
// order. A selector error or a failed build aborts before the Overseer starts.
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
  process.exit(typeof ordered.status === "number" && ordered.status !== 0 ? ordered.status : 1);
}

const server = spawnSync(
  process.execPath,
  ["packages/overseer/dist/index.js"],
  {
    stdio: "inherit",
  },
);
process.exit(typeof server.status === "number" ? server.status : 1);

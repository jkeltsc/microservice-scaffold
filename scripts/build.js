#!/usr/bin/env node
// Builds every workspace package in dependency order.
//
// This is what the root `build`, `pretest`, and the `ci` build step invoke. It
// bootstraps the two packages the order-deriving tool is made of, then spawns
// the compiled bin that runs the ordered pass over every workspace package.
//
// Plain uncompiled ESM under scripts/ because it must run on a clean checkout.
// The module that derives the order is compiled output, so the script that
// bootstraps it cannot itself require compiling first.
//
// The ordered pass reaches contracts and build-tools and builds them a second
// time. That is intended and near-free — each repeat is an incremental `tsc`
// over the output the bootstrap just produced — and it keeps the ordered pass
// independent of whatever the bootstrap happened to cover.
//
// This file owns its process effects: it writes to stderr and calls
// process.exit. Paths are relative to cwd, the repo root for npm scripts.

import { spawnSync } from "node:child_process";

import { runBootstrapBuild } from "./common-startup.js";

// Until this succeeds the ordered bin does not exist, so there is nothing
// further to attempt.
const bootstrap = runBootstrapBuild(process.env);
if (!bootstrap.ok) {
  process.stderr.write(`[build] ${bootstrap.message}\n`);
  process.exit(bootstrap.status);
}

const ordered = spawnSync(
  process.execPath,
  ["packages/build-tools/dist/bin/build-workspaces.js"],
  {
    stdio: "inherit",
  },
);
process.exit(typeof ordered.status === "number" ? ordered.status : 1);

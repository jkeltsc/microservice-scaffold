#!/usr/bin/env node
// Builds every workspace package and runs the Overseer once.
//
// This is what `npm start` invokes. Its two shared startup steps — the bootstrap
// build of the two packages the registry generator is built from, then generating
// the registry for `MICROSERVICES` (unset means "*") — come from
// scripts/common-startup.js, which is the sole owner of the reasoning about their
// order. A selector error or a failed build aborts before the Overseer starts.
//
// This file owns the process effects around those steps: the full build, the
// one-shot Overseer run, and exit-status propagation. Paths are relative to cwd,
// the repo root for npm scripts.

import { spawnSync } from "node:child_process";

import { runCommonStartup } from "./common-startup.js";

/** Runs one command with inherited stdio and exits with its code on failure. */
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

// A failed startup step propagates its own status, and the Overseer never starts.
const startup = runCommonStartup({ tag: "start" });
if (!startup.ok) {
  process.stderr.write(
    `[start] ${startup.message}; refusing to start the Overseer\n`,
  );
  process.exit(startup.status);
}

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

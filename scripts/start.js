#!/usr/bin/env node
// Local development entry point wired to `npm start` (Requirement R10).
//
// Gives `npm start` the same registry-generation semantics a Container build
// uses (R10.1, R10.2): generate the registry for `MICROSERVICES` (unset means
// "*", R10.3), build every workspace, then run the Overseer. Each step must
// succeed before the next one runs, so a selector error (R10.4) or a build
// failure aborts before the Overseer starts and its exit code is propagated.
//
// The two shared steps — the Bootstrap_Build and registry generation — live in
// scripts/common-startup.js, which both this Production_Start path and the
// Dev_Command consume so their startup behavior cannot drift (R11.1). That
// module is the sole owner of the clean-checkout ordering rationale (R11.2);
// this file only performs the process effects around it: the full build, the
// one-shot Overseer run, and exit-status propagation.
//
// Paths are relative to cwd, which is the repo root for npm scripts.

import { spawnSync } from "node:child_process";

import { runCommonStartup } from "./common-startup.js";

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

// The two Common_Startup steps (Bootstrap_Build, then registry generation) run
// in order and each must succeed before the next; on failure this path refuses
// to start the Overseer and propagates the failed step's status. The failure
// line is composed from the discriminated result so it stays byte-for-byte
// identical to the previous inline wording (R11.5, R11.6).
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

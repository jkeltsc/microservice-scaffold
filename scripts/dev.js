#!/usr/bin/env node
// The Dev_Command entry point wired to `npm run dev` (Requirement R1).
//
// Wired as `"dev": "dotenvx run -- node scripts/dev.js"` in the root
// package.json, so the local `.env` supplies Toggles and `PORT` while an inline
// assignment on the command line still wins — the same `dotenvx run --`
// mechanism `npm start` uses (R1.1, R1.2, R2.3, R8.3).
//
// This is a thin shell. The two shared Startup_Sequence steps — the
// Bootstrap_Build and registry generation — live in scripts/common-startup.js,
// which both this Dev_Command path and Production_Start consume so their startup
// behavior cannot drift (R11.1). The Startup_Sequence order is therefore: load
// the local environment (done by `dotenvx run --` before Node starts), perform
// the Bootstrap_Build, run the Registry_Generator, then start the Build_Watcher
// and the Overseer inside the supervisor (R1.3).
//
// The supervisor is spawned as a COMPILED bin rather than imported, for the same
// reason scripts/start.js invokes the compiled generate-registry bin: at this
// point in the sequence the Bootstrap_Build has just produced it, and a static
// import from an uncompiled script could not see it on a clean checkout.
//
// Paths are relative to cwd, which is the repo root for npm scripts.

import { spawn } from "node:child_process";

import { runCommonStartup } from "./common-startup.js";

// The two Common_Startup steps (Bootstrap_Build, then registry generation) run
// in order and each must succeed before the next; on failure this path refuses
// to start the Overseer and propagates the failed step's status. The failure
// line names the failed step on stderr and no Build_Watcher or Overseer is
// spawned, because the spawn below is downstream of this check (R1.4, R1.5).
const startup = runCommonStartup({ tag: "dev" });
if (!startup.ok) {
  process.stderr.write(
    `[dev] ${startup.message}; refusing to start the Overseer\n`,
  );
  process.exit(startup.status);
}

// Startup succeeded: hand off to the compiled supervisor bin, which starts the
// Build_Watcher and the Overseer and owns the watch loop. It inherits this
// process's environment unmodified (R8.1, R8.2) and its stdio, so its diagnostics
// and the Overseer's output reach the developer's terminal directly.
const supervisor = spawn(
  process.execPath,
  ["packages/build-tools/dist/bin/dev-supervisor.js"],
  {
    stdio: "inherit",
  },
);

// Signal handling has one owner: the Dev_Command forwards SIGINT / SIGTERM to the
// supervisor and waits for it to exit, so the supervisor can terminate the
// Build_Watcher and the Overseer and neither process outlives the Dev_Command
// (R1.6). The supervisor's `exit` handler below propagates the final status, so
// these handlers deliberately do not call process.exit themselves.
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill(signal);
    }
  });
}

// Exit with the supervisor's status once it has exited. A signal-terminated child
// reports no numeric status; propagate a non-zero code so the failure is visible.
supervisor.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }
  process.stderr.write(`[dev] build watcher terminated by ${signal}\n`);
  process.exit(1);
});

// A failure to even launch the supervisor bin (e.g. it was never compiled) is a
// Build_Watcher launch failure: report it on stderr and exit non-zero (R1.4, R1.5).
supervisor.on("error", (error) => {
  process.stderr.write(
    `[dev] failed to start the build watcher: ${error.message}\n`,
  );
  process.exit(1);
});

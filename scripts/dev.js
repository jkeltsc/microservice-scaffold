#!/usr/bin/env node
// Starts the watch-mode development session.
//
// This is what `npm run dev` invokes, wrapped in `dotenvx run --` so the local
// `.env` supplies Toggles and `PORT` while an inline assignment still wins. The
// two shared startup steps come from scripts/common-startup.js; once they succeed
// this script hands off to the compiled supervisor bin, which starts the build
// watcher and the Overseer and owns the watch loop.
//
// The supervisor is spawned rather than imported because the bootstrap build has
// only just produced it: a static import from an uncompiled script could not see
// it on a clean checkout.
//
// This file owns the process effects: stderr diagnostics, signal forwarding, and
// exit-status propagation. Paths are relative to cwd, the repo root for npm
// scripts.

import { spawn } from "node:child_process";

import { runCommonStartup } from "./common-startup.js";

// The spawn is downstream, so a failed step leaves no watcher and no Overseer.
const startup = runCommonStartup({ tag: "dev" });
if (!startup.ok) {
  process.stderr.write(
    `[dev] ${startup.message}; refusing to start the Overseer\n`,
  );
  process.exit(startup.status);
}

// The supervisor inherits this process's environment unmodified and its stdio, so
// its diagnostics and the Overseer's output reach the developer's terminal.
const supervisor = spawn(
  process.execPath,
  ["packages/build-tools/dist/bin/dev-supervisor.js"],
  {
    stdio: "inherit",
  },
);

// Forwarding lets the supervisor terminate the watcher and the Overseer itself, so
// neither outlives this process. The `exit` handler propagates the final status.
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(signal, () => {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill(signal);
    }
  });
}

// A signal-terminated child reports no numeric status, so exit non-zero instead.
supervisor.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }
  process.stderr.write(`[dev] build watcher terminated by ${signal}\n`);
  process.exit(1);
});

// Failing to launch the bin at all counts as a build watcher launch failure.
supervisor.on("error", (error) => {
  process.stderr.write(
    `[dev] failed to start the build watcher: ${error.message}\n`,
  );
  process.exit(1);
});

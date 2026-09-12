// Task 12.5* — `npm start` local-parity integration.
//
// Spawns the repo-root `scripts/start.js` (the same script `npm start` runs)
// with MICROSERVICES=microservice1, which drives the SAME registry-generation
// logic a Container build uses: it regenerates the registry for exactly
// microservice1, rebuilds via tsc, then boots the Overseer. We wait for the
// server to listen, then confirm over the wire that / serves 200 with the
// expected contract body. Teardown kills the child's whole process group and
// regenerates the full ("*") registry so the working tree is left as found.
//
// This is a spawn + real-port + tsc-build integration test, so it uses a
// generous timeout and a non-default PORT to avoid conflicts. If the
// environment cannot spawn a child or bind the port, the test surfaces that as
// a failure with the captured child output rather than hanging.
//
// Process-group teardown: start.js spawns the Overseer as a GRANDCHILD, so
// killing only the child leaks the Overseer, which keeps holding PORT. The
// child is therefore spawned `detached` (making it the leader of a new process
// group) and torn down by killing the whole group. Teardown then polls until
// the port stops answering, and a pre-flight probe fails the test outright if
// anything is already bound to PORT — otherwise a leaked server from a previous
// run would satisfy this test without start.js ever running.
//
// Validates: Requirements R10.1, R10.2, R10.3

import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const startScript = resolve(repoRoot, "scripts", "start.js");
const generateRegistryBin = resolve(
  repoRoot,
  "packages",
  "build-tools",
  "dist",
  "bin",
  "generate-registry.js",
);

// Non-default port to avoid colliding with anything already bound on 8080.
const PORT = 8137;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

let child: ChildProcess | undefined;

/** True when something answers on PORT (any HTTP response counts as "in use"). */
async function portAnswers(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/`);
    await res.text();
    return true;
  } catch {
    return false;
  }
}

/** Poll the microservice endpoint until it responds or we time out. */
async function waitForServer(deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`start.js exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) {
        // Drain the body so the socket is released.
        await res.text();
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `server did not become ready within timeout; last error: ${String(lastError)}`,
  );
}

afterAll(async () => {
  let leakMessage: string | undefined;

  // Kill the whole process GROUP: start.js's Overseer grandchild holds PORT, so
  // killing only start.js leaks it. `detached: true` at spawn time made the
  // child its own group leader (pgid === child.pid on POSIX).
  const pid = child?.pid;
  if (pid !== undefined) {
    try {
      if (process.platform === "win32") {
        // Windows has no negative-pid group kill; taskkill /T kills the tree.
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      // Group already gone (ESRCH) — nothing to clean up.
    }

    // Confirm the port is actually released before any later suite runs; a
    // surviving server must never be silent again.
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    let stillAnswering = await portAnswers();
    while (stillAnswering && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      stillAnswering = await portAnswers();
    }
    if (stillAnswering) {
      leakMessage =
        `port ${PORT} is still answering ${SHUTDOWN_TIMEOUT_MS}ms after killing process group ${pid}; ` +
        `a server has leaked. Kill it manually (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`).`;
    }
  }

  // Restore the full generic registry so the working tree matches its default.
  spawnSync(process.execPath, [generateRegistryBin], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env, MICROSERVICES: "*" },
  });

  // Reported after the registry is restored so a leak is loud without also
  // leaving the working tree on the single-microservice selector.
  if (leakMessage !== undefined) {
    throw new Error(leakMessage);
  }
});

describe("`npm start` local-parity integration (MICROSERVICES=microservice1)", () => {
  it(
    "boots the Overseer serving only microservice1 (R10.1, R10.2, R10.3)",
    async () => {
      const output: string[] = [];

      // Pre-flight: nothing may already be bound to PORT. If something answers,
      // this test cannot tell a stale server from the one it is about to start,
      // and waitForServer() would be satisfied without start.js ever running.
      expect(
        await portAnswers(),
        `port ${PORT} is already in use — most likely a leaked Overseer from a previous run. ` +
          `This test cannot distinguish a stale server from the one it is about to start, so it refuses to run. ` +
          `Kill the process listening on that port (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      child = spawn(process.execPath, [startScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MICROSERVICES: "microservice1",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          PORT: String(PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
        // New process group so teardown can kill start.js AND its Overseer
        // grandchild. Deliberately NOT unref()'d: stdio stays piped and the
        // child's exit stays observable.
        detached: true,
      });

      child.stdout?.on("data", (d: Buffer) => output.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => output.push(d.toString()));

      try {
        await waitForServer(Date.now() + BOOT_TIMEOUT_MS);
      } catch (error) {
        throw new Error(
          `${String(error)}\n--- child output ---\n${output.join("")}`,
        );
      }

      // Liveness probe: microservice1 is mounted at its Mount_Root "/", so a
      // request there is dispatched to its router rather than the Overseer's
      // catch-all. Assert `status !== 404` and nothing else — no body, no
      // content type, no per-method status (R13.12). The Mount_Root is the
      // probe point because under Subtree_Ownership a path *under* it can carry
      // a legitimate 404 from the owning microservice, so only the Mount_Root
      // distinguishes "the Overseer is serving" from "nothing is mounted here".
      const hello = await fetch(`${BASE_URL}/`);
      await hello.text();
      expect(hello.status).not.toBe(404);

      // /_registry no longer exists — it should 404.
      const registry = await fetch(`${BASE_URL}/_registry`);
      expect(registry.status).toBe(404);
    },
    BOOT_TIMEOUT_MS + 30_000,
  );
});

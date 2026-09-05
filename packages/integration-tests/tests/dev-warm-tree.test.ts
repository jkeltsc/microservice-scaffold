// Task 10.3 — the warm-tree end-to-end regression for the Dev_Server.
//
// Feature: api-dev-server, Property 8: One execution model, cold start included
//
// This is the warm-tree counterpart to the cold-start suite. It guards the
// defect movement 10 fixes: a Dev_Session begun on an ALREADY-BUILT tree — every
// Project_List package's `dist/` and `*.tsbuildinfo` up to date — whose FIRST
// Compile_Pass reports zero errors and EMITS NOTHING because there is nothing to
// rebuild, must still start exactly one Overseer and answer a request. The
// shipped rule gated the initial start on emit, so on a warm tree it left a
// Build_Watcher running and no server; task 10.1 corrected `decide` so a clean
// non-emitting first pass is the warm-tree initial start (R4.8, R5.1).
//
// The test warms the tree by running the workspace build (`npm run build
// --workspaces`) from the repo root before the session starts, so every
// Project_List package is up to date and the supervisor's first Compile_Pass has
// nothing to emit. It then drives the REAL Dev_Command (`scripts/dev.js`) via the
// session harness and asserts:
//   1. the session output carries the Overseer's existing readiness line
//      (`[boot] Overseer listening on port`), proving the Overseer started from
//      the warm tree even though the first pass emitted nothing (R4.8, R5.1);
//   2. the Overseer answers a request (an enabled microservice returns 200),
//      proving it is a working, consistent Compiled_Tree it is serving.
//
// This is a structural regression, not a behavioral variation, so a single
// example over `MICROSERVICES=*` is the right shape, matching the cold-start
// suite. It spawns processes and binds a real port, so it uses a generous
// timeout, a dedicated non-default port, and tears the whole group down in
// teardown.
//
// Validates: Requirements 4.8, 5.1

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  startDevSession,
  repoRoot,
  OVERSEER_READY_MARKER,
  type DevSession,
} from "./helpers.js";

// A dedicated port clear of 8080 and every other session suite
// (8137, 8142, 8143, 8151, 8152, 8241, 8242), so a leaked server from another
// suite cannot masquerade as this one's Overseer.
const PORT = 8144;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Warming the tree runs the full workspace build; on a cold tree that is the
// slow step, so budget generously. Once warm, the session's Common_Startup and
// non-emitting first pass are quick, and the Overseer binds shortly after.
const WARM_TIMEOUT_MS = 300_000;
const BOOT_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = WARM_TIMEOUT_MS + BOOT_TIMEOUT_MS + 60_000;

let session: DevSession | undefined;

/** Poll the Overseer's mount root until it answers 200 or the deadline passes. */
async function waitForServer(deadline: number): Promise<Response> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) {
        return res;
      }
      await res.text();
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Overseer did not answer 200 within timeout; last error: ${String(lastError)}`,
  );
}

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

afterAll(async () => {
  // Kill the whole session process tree so no child outlives the suite and PORT
  // is released.
  if (session !== undefined) {
    await session.stop();
    session = undefined;
  }
});

describe("Dev_Server warm-tree start (api-dev-server Property 8)", () => {
  it(
    "starts the Overseer and answers a request from a fully built tree whose first Compile_Pass emits nothing (R4.8, R5.1)",
    async () => {
      // Warm the tree: build every workspace so each Project_List package's
      // `dist/` and `tsconfig.tsbuildinfo` are up to date. The supervisor's
      // first Compile_Pass then reports zero errors and emits nothing — exactly
      // the warm-tree condition the defect mishandled. This runs the same
      // `npm run build --workspaces` the root `pretest` already runs, so on a
      // warm CI tree it is a no-op costing a few seconds.
      const build = spawnSync("npm", ["run", "build", "--workspaces"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: WARM_TIMEOUT_MS,
      });
      expect(
        build.status,
        `warming the tree failed:\n${build.stdout ?? ""}\n${build.stderr ?? ""}`,
      ).toBe(0);

      // Pre-flight: nothing may already own PORT, or a leaked Overseer would
      // satisfy the readiness probe without our session.
      expect(
        await portAnswers(),
        `port ${PORT} is already in use — likely a leaked Overseer from a previous run. ` +
          `Kill it (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      // Start the Dev_Command against the WARM tree, selecting every discovered
      // microservice and enabling each toggle so the Overseer boots the full
      // routing table.
      session = startDevSession({
        env: {
          MICROSERVICES: "*",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE2_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE3_ENABLED: "enabled",
          PORT: String(PORT),
        },
      });

      // R4.8, R5.1: the Overseer starts even though the first Compile_Pass
      // emitted nothing. The session output carries the Overseer's existing
      // readiness line, naming the inline port it bound.
      try {
        await session.waitForOutput(`${OVERSEER_READY_MARKER} ${PORT}`, {
          timeout: BOOT_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(
          `${String(error)}\n--- session output ---\n${session.output()}`,
        );
      }
      expect(session.output()).toContain(`${OVERSEER_READY_MARKER} ${PORT}`);

      // The Overseer answers a request from the warm Compiled_Tree: microservice1
      // mounts at "/" and returns its identifier body.
      const res = await waitForServer(Date.now() + 60_000);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ "microservice-name": "microservice1", path: "/" });
    },
    TEST_TIMEOUT_MS,
  );
});

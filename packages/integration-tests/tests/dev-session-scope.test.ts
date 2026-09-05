// Task 7.4 — session-scoped registration integration (api-dev-server spec).
//
// Feature: api-dev-server, Property 9: The registered microservice set is session-scoped
//
// The registered microservice set is determined ONCE per Dev_Session, at
// registry-generation time, and `packages/microservices/` is NOT re-scanned
// while a session runs (R7.1, R7.2, R7.3). So adding a directory under
// `packages/microservices/` mid-session — and then forcing a Compile_Pass and
// an Overseer_Restart with a real source edit — must leave the routing table
// UNCHANGED across the restart: the new microservice must NOT appear. Only a
// NEW Dev_Session, generating its registry with the new directory present,
// registers it (R7.4 covers that the restarted process serves the
// session-start registry).
//
// This test spawns the real Dev_Command (`scripts/dev.js`) via the session
// harness in helpers.ts, drives it over the wire, creates a temp microservice
// directory at runtime (deleted in teardown so the working tree is clean),
// touches an existing TRACKED source to force the restart (restored in
// teardown), and asserts both halves: unchanged mid-session, present after a
// fresh session.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4

import { describe, it, expect, afterAll } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  startDevSession,
  restoreWorktreeFile,
  repoRoot,
  OVERSEER_READY_MARKER,
  type DevSession,
} from "./helpers.js";

// A new port well away from 8080 and the start-parity suite's 8137, so a leaked
// server from another suite cannot masquerade as this one's Overseer.
const PORT = 8142;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Generous budget: each session bootstrap-builds, generates the registry, runs
// the Build_Watcher's first Compile_Pass, and binds the Overseer. Two sessions
// plus a mid-session recompile fit inside this.
const BOOT_TIMEOUT_MS = 180_000;

// The mutation added mid-session: a brand-new microservice directory. Its
// identifier is lowercase alphanumeric (a valid toggle var) and distinct from
// every existing microservice so its path cannot collide.
const NEW_ID = "devscopeprobe";
const NEW_PATH = "/devscopeprobe";
const newServiceDir = resolve(repoRoot, "packages", "microservices", NEW_ID);
// The workspace symlink `npm install` would create for the new package. The
// generated registry imports the microservice by its `@microservices/<id>`
// package name, so this link must exist for the Overseer to resolve it — we
// create it by hand rather than running a slow full `npm install`.
const newServiceLink = resolve(repoRoot, "node_modules", "@microservices", NEW_ID);

// The tracked source we touch to force a Compile_Pass + Overseer_Restart. We
// edit microservice1's mount-root response to carry an extra marker field, so
// the recompiled output is observably different from the last-good tree (a
// no-op pass would keep the process in place — R4.5) and the restarted process
// demonstrably serves the new output (R7.4). Restored in teardown.
const ms1Source = resolve(
  repoRoot,
  "packages",
  "microservices",
  "microservice1",
  "src",
  "index.ts",
);
const RESTART_MARKER = "session-scope-touch";

let session: DevSession | undefined;

/** Poll the Overseer's mount root until it answers or the deadline passes. */
async function waitForServer(deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) {
        await res.text();
        return;
      }
      await res.text();
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Overseer did not answer within timeout; last error: ${String(lastError)}`,
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

/**
 * Poll `predicate` until it is true or the deadline passes. Used to wait for a
 * NEW "[dev] Overseer restarted" record: the harness's string-based
 * `waitForOutput` cannot tell a fresh record from the one the initial Overseer
 * start already wrote, so this counts occurrences instead.
 */
async function waitForRestartRecord(
  predicate: () => boolean,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting for a new '[dev] Overseer restarted' record");
}

/** Wait until nothing answers on PORT, so the next session can bind it. */
async function waitForPortFree(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (!(await portAnswers())) {
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Write a minimal, VALID microservice module into `newServiceDir` so that IF it
 * were ever registered it would compile and route. Mirrors the structure of the
 * reference microservices: package.json, tsconfig.json extending the base, and
 * a src/index.ts exporting `path` + an Express `router`.
 */
function createNewMicroservice(): void {
  mkdirSync(resolve(newServiceDir, "src"), { recursive: true });

  writeFileSync(
    resolve(newServiceDir, "package.json"),
    JSON.stringify(
      {
        name: `@microservices/${NEW_ID}`,
        version: "0.0.0",
        private: true,
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        scripts: {
          build: "tsc",
          test: "vitest --run",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          "@microservices/contracts": "*",
          express: "^5.1.0",
        },
        devDependencies: {
          "@types/express": "^5.0.0",
        },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    resolve(newServiceDir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "../../../tsconfig.base.json",
        compilerOptions: { outDir: "./dist", rootDir: "./src" },
        include: ["src/**/*"],
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    resolve(newServiceDir, "src", "index.ts"),
    `import express, { type Router } from "express";
import type { MicroserviceModule } from "@microservices/contracts";

export const path = "${NEW_PATH}";

function createRouter(): Router {
  const router = express.Router();
  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({ "microservice-name": "${NEW_ID}", path });
  });
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });
  return router;
}

export const router: Router = createRouter();

const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;
`,
  );

  // Link the new workspace into node_modules exactly as `npm install` would, so
  // the registry's `import ... from "@microservices/devscopeprobe"` resolves.
  // The link target is relative to node_modules/@microservices/, mirroring the
  // existing workspace links (e.g. microservice1 -> ../../packages/...).
  // The link CONTENT must be a path relative to the link's own directory
  // (node_modules/@microservices/), exactly like the existing workspace links
  // (microservice1 -> ../../packages/microservices/microservice1). Passing an
  // absolute or cwd-resolved path here would produce a dangling link.
  symlinkSync(`../../packages/microservices/${NEW_ID}`, newServiceLink, "dir");
}

/**
 * Make an emitting edit to microservice1's mount-root handler so the next
 * Compile_Pass changes the Compiled_Tree and triggers an Overseer_Restart. The
 * edit adds a marker field; a comment-only edit would not change emitted JS and
 * so would be a no-op pass (R4.5).
 */
function touchExistingSource(): void {
  const original = readFileSync(ms1Source, "utf8");
  const edited = original.replace(
    `.json({ "microservice-name": "microservice1", path });`,
    `.json({ "microservice-name": "microservice1", path, marker: "${RESTART_MARKER}" });`,
  );
  if (edited === original) {
    throw new Error(
      "could not locate microservice1's response literal to force a recompile",
    );
  }
  writeFileSync(ms1Source, edited);
}

afterAll(async () => {
  // Stop any running session first so the port is released and no child
  // outlives the suite.
  if (session !== undefined) {
    await session.stop();
    session = undefined;
  }
  // Remove the temp microservice directory and its node_modules link (both
  // created at runtime, untracked).
  rmSync(newServiceLink, { recursive: true, force: true });
  rmSync(newServiceDir, { recursive: true, force: true });
  // Restore the tracked source we edited to force the restart.
  restoreWorktreeFile(ms1Source);
});

describe("Dev_Session registered microservice set is session-scoped (Property 9)", () => {
  it(
    "keeps the routing table unchanged when a microservice dir is added mid-session, and registers it only on a fresh session (R7.1, R7.2, R7.3, R7.4)",
    async () => {
      // Defensive: restore microservice1's source to its committed content in
      // case an earlier, crashed session test left it mutated on disk. Our own
      // touch/restore is balanced within this test, but a leaked edit from a
      // sibling suite would otherwise break session 1's first Compile_Pass.
      restoreWorktreeFile(ms1Source);

      // Pre-flight: nothing may already own PORT, or a stale server would
      // satisfy the readiness probe without our session running.
      expect(
        await portAnswers(),
        `port ${PORT} is already in use — likely a leaked server from a previous run. ` +
          `Kill it (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      // --- Session 1: microservice1 + microservice2 only ---------------------
      session = startDevSession({
        env: {
          MICROSERVICES: "microservice1,microservice2",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE2_ENABLED: "enabled",
          PORT: String(PORT),
        },
      });

      // Fail fast with captured output if the session dies before binding.
      await session.waitForOutput(OVERSEER_READY_MARKER, {
        timeout: BOOT_TIMEOUT_MS,
      });
      await waitForServer(Date.now() + 30_000);

      // Baseline routing table: the two selected microservices answer; the
      // not-yet-existing new path 404s.
      expect((await fetch(`${BASE_URL}/`)).status).toBe(200);
      expect((await fetch(`${BASE_URL}/microservice2`)).status).toBe(200);
      expect((await fetch(`${BASE_URL}${NEW_PATH}`)).status).toBe(404);

      // --- Mutation mid-session: add a new microservice directory -----------
      createNewMicroservice();

      // Force a Compile_Pass + Overseer_Restart with a real source edit. The
      // supervisor writes "[dev] Overseer restarted" every time a restarted
      // process binds its HTTP server — including the FIRST Overseer start of
      // the session (R4.6). So count occurrences and wait for one MORE than the
      // startup already produced, rather than matching the string (which is
      // already in the buffer).
      const RESTART_RECORD = "[dev] Overseer restarted";
      const countRecords = (text: string): number =>
        text.split(RESTART_RECORD).length - 1;
      const recordsBeforeTouch = countRecords(session.output());
      touchExistingSource();
      await waitForRestartRecord(
        () => countRecords(session!.output()) > recordsBeforeTouch,
        Date.now() + BOOT_TIMEOUT_MS,
      );

      // The restarted process serves the RECOMPILED output (proves a real
      // Overseer_Restart happened, not a stale answer): the marker field is
      // present on the mount-root body (R7.4).
      const afterRestart = await fetch(`${BASE_URL}/`);
      expect(afterRestart.status).toBe(200);
      const afterRestartBody = (await afterRestart.json()) as Record<
        string,
        unknown
      >;
      expect(afterRestartBody.marker).toBe(RESTART_MARKER);

      // The routing table is UNCHANGED across the restart: the mid-session
      // directory addition did NOT register (R7.1, R7.2, R7.3) — the new path
      // still 404s — while the session's original microservices still answer.
      expect((await fetch(`${BASE_URL}${NEW_PATH}`)).status).toBe(404);
      expect((await fetch(`${BASE_URL}/`)).status).toBe(200);
      expect((await fetch(`${BASE_URL}/microservice2`)).status).toBe(200);

      // --- Stop session 1, restore the touched source, start a fresh session -
      await session.stop();
      session = undefined;
      restoreWorktreeFile(ms1Source);
      await waitForPortFree(Date.now() + 15_000);

      // --- Session 2: MICROSERVICES=* now discovers the new directory --------
      // The new dir is present BEFORE this session's registry generation, so it
      // is discovered and registered. Enable its toggle so its router mounts.
      session = startDevSession({
        env: {
          MICROSERVICES: "*",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE2_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE3_ENABLED: "enabled",
          [`MICROSERVICE_${NEW_ID.toUpperCase()}_ENABLED`]: "enabled",
          PORT: String(PORT),
        },
      });

      await session.waitForOutput(OVERSEER_READY_MARKER, {
        timeout: BOOT_TIMEOUT_MS,
      });
      await waitForServer(Date.now() + 30_000);

      // The new microservice is registered in the fresh session: its path now
      // answers 200 with its identifier body (R7.4 — a new Dev_Session picks the
      // mutation up).
      const fresh = await fetch(`${BASE_URL}${NEW_PATH}`);
      expect(fresh.status).toBe(200);
      const freshBody = (await fresh.json()) as Record<string, unknown>;
      expect(freshBody).toEqual({ "microservice-name": NEW_ID, path: NEW_PATH });
    },
    BOOT_TIMEOUT_MS + 60_000,
  );
});

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
// --- This suite NEVER touches the real working tree -------------------------
// Every mutation this suite makes happens inside its OWN pristine copy of the
// tree, materialized by `pristineWorktree()` into an OS temp directory. The real
// working tree is read (to build that copy) and never written.
//
// That is a hard requirement, not a stylistic preference. An earlier version of
// this suite mutated the real tree in three ways, and each was destructive:
//
//   1. It edited the TRACKED source
//      `packages/microservices/microservice2/src/index.ts` and "restored" it
//      with `git checkout -- <path>`. That restore reverts the file to its
//      COMMITTED content, so it silently DESTROYS any uncommitted work in that
//      file — which it did, twice, in this repo. The fix is to keep the edit
//      inside the pristine copy and to restore it by writing back the exact
//      bytes captured from disk (`writeFileSync`), never through git.
//   2. It created a whole new microservice package directory under the real
//      `packages/microservices/`, polluting the working tree with an untracked
//      package that `git status`, discovery, and every workspace-wide script
//      then had to see.
//   3. It created a real `node_modules/@microservices/<id>` symlink, which
//      outlived a crashed run as a dangling link.
//
// `pristineWorktree()` lists `git ls-files --cached --others
// --exclude-standard`, i.e. tracked PLUS untracked-but-not-gitignored files,
// and tars them from disk — so the copy CAPTURES UNCOMMITTED EDITS exactly as
// they currently are, which is precisely what a git-based restore would have
// thrown away. It then runs `npm ci` there. When it is unavailable (no git, or
// the archive / `npm ci` failed for an environmental reason) this suite skips
// with that reason rather than failing, matching dev-cold-start.test.ts and
// dev-start-parity.test.ts.
//
// Inside that copy the suite spawns the real Dev_Command (`scripts/dev.js`) via
// the session harness in helpers.ts, drives it over the wire, creates a
// synthesised microservice directory at runtime, and touches microservice2's
// source to force the restart — then asserts both halves: unchanged
// mid-session, present after a fresh session. Teardown stops the session and
// deletes the temp copy; there is nothing in the real tree to clean up.
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  startDevSession,
  pristineWorktree,
  OVERSEER_READY_MARKER,
  type DevSession,
  type PristineWorktreeResult,
} from "./helpers.js";

// A port well away from 8080 and the other session suites (8137, 8143, 8151,
// 8152), so a leaked server from another suite cannot masquerade as this one's
// Overseer.
const PORT = 8142;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Generous budget: the pristine copy is COLD (no dist/, no tsbuildinfo), so
// each session bootstrap-builds, generates the registry, runs the
// Build_Watcher's first full Compile_Pass, and binds the Overseer. Two sessions
// plus a mid-session recompile fit inside this.
const BOOT_TIMEOUT_MS = 300_000;
// `pristineWorktree()` itself runs `npm ci` in a fresh temp tree before any of
// that, so materializing the copy gets its own generous budget.
const PRISTINE_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 900_000;

// The mutation added mid-session: a brand-new microservice directory. Its
// identifier is lowercase alphanumeric (a valid toggle var) and distinct from
// every existing microservice so its path cannot collide.
const NEW_ID = "devscopeprobe";
const NEW_PATH = "/devscopeprobe";

// The source we touch to force a Compile_Pass + Overseer_Restart. We edit
// microservice2's mount-root response to carry an extra marker field, so the
// recompiled output is observably different from the last-good tree (a no-op
// pass would keep the process in place — R4.5) and the restarted process
// demonstrably serves the new output (R7.4). Microservice2's Mount_Root is
// `/microservice2` — a dispatched response, not a path Microservice1 owns — so
// this suite reads the marker there rather than at `/` (R13.14, R13.15).
//
// The edit is made to the PRISTINE COPY of the file, and undone by writing the
// captured original bytes back. Never `git checkout`.
const MS2_MOUNT_ROOT = "/microservice2";
const MS2_ANCHOR = `.json({ "microservice-name": "microservice2", path });`;
const RESTART_MARKER = "session-scope-touch";

/** Absolute paths this suite mutates — all of them inside the pristine copy. */
interface TreePaths {
  /** Root of the pristine copy. Nothing outside this directory is written. */
  readonly root: string;
  /** `<root>/packages/microservices/devscopeprobe` — the synthesised package. */
  readonly newServiceDir: string;
  /** `<root>/node_modules/@microservices/devscopeprobe` — its workspace link. */
  readonly newServiceLink: string;
  /** `<root>/packages/microservices/microservice2/src/index.ts`. */
  readonly ms2Source: string;
}

/** Re-root every path this suite writes at the pristine copy. */
function treePaths(root: string): TreePaths {
  return {
    root,
    newServiceDir: resolve(root, "packages", "microservices", NEW_ID),
    newServiceLink: resolve(root, "node_modules", "@microservices", NEW_ID),
    ms2Source: resolve(
      root,
      "packages",
      "microservices",
      "microservice2",
      "src",
      "index.ts",
    ),
  };
}

let pristine: PristineWorktreeResult | undefined;
let paths: TreePaths | undefined;
/**
 * microservice2's source EXACTLY as the pristine copy received it (i.e. as it is
 * on disk in the real tree, uncommitted edits included). Captured once in
 * `beforeAll` and held in memory; restoring means writing these bytes back.
 */
let ms2Original: string | undefined;
let session: DevSession | undefined;

/**
 * Poll an enabled PEER's Mount_Root until it dispatches (200) or the deadline
 * passes. The readiness probe is `/microservice2`, NOT `/`: since step 6,
 * Microservice1 serves the Demo_Spa at `/`, and a `npm run dev` tree never
 * invokes a Spa build (design F9), so the Spa_Root is absent and `/` answers
 * 503, not 200. `/microservice2` is dispatched to Microservice2's router and
 * answers 200, so it is the reliable "the Overseer is serving" signal here.
 */
async function waitForServer(deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}${MS2_MOUNT_ROOT}`);
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
 * Write a minimal, VALID microservice module into the pristine copy's
 * `packages/microservices/devscopeprobe/` so that IF it were ever registered it
 * would compile and route. Mirrors the structure of the reference
 * microservices: package.json, tsconfig.json extending the base, and a
 * src/index.ts exporting `path` + an Express `router`.
 *
 * Every path written here is under `p.root`, so the real
 * `packages/microservices/` never gains a directory.
 */
function createNewMicroservice(p: TreePaths): void {
  mkdirSync(resolve(p.newServiceDir, "src"), { recursive: true });

  writeFileSync(
    resolve(p.newServiceDir, "package.json"),
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
    resolve(p.newServiceDir, "tsconfig.json"),
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
    resolve(p.newServiceDir, "src", "index.ts"),
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

  // Link the new workspace into the PRISTINE copy's node_modules exactly as
  // `npm install` would, so the generated registry's
  // `import ... from "@microservices/devscopeprobe"` resolves. We create it by
  // hand rather than running a slow second `npm install`.
  //
  // The link CONTENT must stay a path relative to the link's OWN directory
  // (`node_modules/@microservices/`), exactly like the existing workspace links
  // (microservice1 -> ../../packages/microservices/microservice1). Kept
  // relative, it resolves inside the pristine copy; an absolute or
  // cwd-resolved path here would point out of the copy or dangle.
  mkdirSync(dirname(p.newServiceLink), { recursive: true });
  symlinkSync(`../../packages/microservices/${NEW_ID}`, p.newServiceLink, "dir");
}

/**
 * Make an emitting edit to the pristine copy's microservice2 mount-root handler
 * so the next Compile_Pass changes the Compiled_Tree and triggers an
 * Overseer_Restart. The edit adds a marker field; a comment-only edit would not
 * change emitted JS and so would be a no-op pass (R4.5).
 *
 * The anchor guard is load-bearing: if microservice2's response literal ever
 * moves, this must raise an error naming the source file and the anchor rather
 * than quietly proceeding with an unmodified file (which would leave the test
 * waiting forever for a restart that can never happen).
 */
function touchExistingSource(p: TreePaths): void {
  const original = readFileSync(p.ms2Source, "utf8");
  const edited = original.replace(
    MS2_ANCHOR,
    `.json({ "microservice-name": "microservice2", path, marker: "${RESTART_MARKER}" });`,
  );
  if (edited === original) {
    throw new Error(
      `could not locate microservice2's response literal to force a recompile; ` +
        `anchor '${MS2_ANCHOR}' not found in ${p.ms2Source}`,
    );
  }
  writeFileSync(p.ms2Source, edited);
}

/**
 * Put microservice2's source back to the bytes the pristine copy started with,
 * by WRITING THE CAPTURED ORIGINAL CONTENT. Deliberately not a git operation:
 * `git checkout -- <path>` would restore COMMITTED content and destroy
 * uncommitted work, and this file lives in a temp copy that git does not track
 * at all.
 */
function restoreExistingSource(p: TreePaths, original: string): void {
  writeFileSync(p.ms2Source, original);
}

beforeAll(() => {
  // One pristine copy for the whole suite: both Dev_Sessions run inside it.
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    // No git (or archive / npm ci failed for an environmental reason). The test
    // body reports the reason and returns; nothing else to set up.
    return;
  }
  paths = treePaths(pristine.dir);
  // Capture microservice2's source AS THE COPY RECEIVED IT — uncommitted edits
  // included — so the restore between the two sessions is a byte-for-byte
  // rewrite rather than a git revert.
  ms2Original = readFileSync(paths.ms2Source, "utf8");
  // Fail fast (before spending minutes on two sessions) if the anchor the
  // restart-forcing edit depends on is gone.
  if (!ms2Original.includes(MS2_ANCHOR)) {
    throw new Error(
      `could not locate microservice2's response literal to force a recompile; ` +
        `anchor '${MS2_ANCHOR}' not found in ${paths.ms2Source}`,
    );
  }
}, PRISTINE_TIMEOUT_MS);

afterAll(async () => {
  // Stop any running session first so the port is released and no child
  // outlives the suite, then delete the pristine copy. There is nothing to undo
  // in the real working tree: the synthesised package, its node_modules link,
  // and the microservice2 edit only ever existed inside the copy.
  if (session !== undefined) {
    await session.stop();
    session = undefined;
  }
  if (pristine?.available === true) {
    pristine.cleanup();
    pristine = undefined;
  }
});

describe("Dev_Session registered microservice set is session-scoped (Property 9)", () => {
  it(
    "keeps the routing table unchanged when a microservice dir is added mid-session, and registers it only on a fresh session (R7.1, R7.2, R7.3, R7.4)",
    async () => {
      if (pristine === undefined || pristine.available !== true) {
        console.warn(
          `SKIP dev-session-scope: ${pristine?.reason ?? "pristine tree unavailable"}`,
        );
        return;
      }
      const p = paths as TreePaths;
      const ms2Source = ms2Original as string;

      // No defensive restore is needed here: the pristine copy was materialized
      // fresh in beforeAll, so no leaked edit from a crashed sibling suite can
      // be present in it.

      // Pre-flight: nothing may already own PORT, or a stale server would
      // satisfy the readiness probe without our session running.
      expect(
        await portAnswers(),
        `port ${PORT} is already in use — likely a leaked server from a previous run. ` +
          `Kill it (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      // --- Session 1: microservice1 + microservice2 only ---------------------
      // Spawned IN the pristine copy, so every artifact it writes (dist/,
      // tsbuildinfo, generated registry) lands there too.
      session = startDevSession({
        cwd: p.root,
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

      // Baseline routing table. `/` is Microservice1's Mount_Root — it serves
      // the Demo_Spa there, but a `npm run dev` tree has no built bundle (F9),
      // so `/` answers 503. The liveness rule (R13.12) is `status !== 404`: the
      // request is dispatched to Microservice1's router, never the Overseer's
      // catch-all. Microservice2's Mount_Root is a dispatched 200; the
      // not-yet-existing new path 404s.
      expect((await fetch(`${BASE_URL}/`)).status).not.toBe(404);
      expect((await fetch(`${BASE_URL}/microservice2`)).status).toBe(200);
      expect((await fetch(`${BASE_URL}${NEW_PATH}`)).status).toBe(404);

      // --- Mutation mid-session: add a new microservice directory -----------
      createNewMicroservice(p);

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
      touchExistingSource(p);
      await waitForRestartRecord(
        () => countRecords(session!.output()) > recordsBeforeTouch,
        Date.now() + BOOT_TIMEOUT_MS,
      );

      // The restarted process serves the RECOMPILED output (proves a real
      // Overseer_Restart happened, not a stale answer): the marker field is
      // present on microservice2's Mount_Root body (R7.4). The probe reads
      // `/microservice2` — a dispatched response — rather than `/`, which
      // Microservice1 owns (R13.14, R13.15).
      const afterRestart = await fetch(`${BASE_URL}${MS2_MOUNT_ROOT}`);
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
      // `/` stays dispatched to Microservice1 (503 with no bundle, never 404).
      expect((await fetch(`${BASE_URL}/`)).status).not.toBe(404);
      expect((await fetch(`${BASE_URL}/microservice2`)).status).toBe(200);

      // --- Stop session 1, restore the touched source, start a fresh session -
      // The restore writes the captured original bytes back into the pristine
      // copy (never `git checkout`), so session 2 compiles the unmarked source.
      await session.stop();
      session = undefined;
      restoreExistingSource(p, ms2Source);
      await waitForPortFree(Date.now() + 15_000);

      // --- Session 2: MICROSERVICES=* now discovers the new directory --------
      // The new dir is present BEFORE this session's registry generation, so it
      // is discovered and registered. Enable its toggle so its router mounts.
      session = startDevSession({
        cwd: p.root,
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
    TEST_TIMEOUT_MS,
  );
});

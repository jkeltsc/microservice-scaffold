// Feature: api-dev-server, Property 5: Error-then-fix round trip
//
// Task 7.2 — the error-then-fix round-trip integration suite. Two examples,
// each driving the REAL Dev_Command end to end via the session harness in
// helpers.ts (which spawns `scripts/dev.js` directly with a controlled
// environment). Behavior does not vary with the specific type error introduced,
// so two representative examples beat a generated battery here.
//
// Example one (a live session): start a Dev_Session, wait for the Overseer to
// answer, introduce a type error into microservice1's source, assert a
// diagnostic naming the file with a (line,character) position appears while the
// endpoint keeps answering from the Last_Good_Output, then rewrite the file to
// a NEW valid behavior and assert the Overseer serves that new behavior with no
// manual restart (R6.1, R6.3, R6.4).
//
// Example two (a poisoned cold start): start a session whose FIRST Compile_Pass
// errors, assert the compile diagnostic appears, that no Overseer binds, and
// that the Build_Watcher stays resident, then fix the file and assert the
// Overseer starts on its own with no re-invocation (R6.4, R6.7).
//
// These are OBSERVABLE assertions (a diagnostic in the output; the endpoint
// still answering; a port bound or not; the session process still alive),
// because those are the obligations Requirement 6 states. The supervisor's
// internal log wording is not asserted.
//
// The TypeScript watch diagnostic is rendered with ANSI color, so the file path
// and its `:line:character` suffix are separated by color-reset escapes in the
// raw stream. Assertions about the (line,character) position therefore run
// against an ANSI-stripped copy of the session output; the harness's
// `waitForOutput` only waits on a contiguous, un-styled substring (the file
// path, which tsc emits as one colored run).
//
// These tests MUTATE a tracked source file (microservice1/src/index.ts) and
// restore it with restoreWorktreeFile() in teardown so the working tree is left
// clean. `dist/` and the generated registry are gitignored and expected to
// churn, so they are not restored.
//
// Validates: Requirements 6.1, 6.3, 6.4, 6.7

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  startDevSession,
  restoreWorktreeFile,
  repoRoot,
  OVERSEER_READY_MARKER,
  type DevSession,
} from "./helpers.js";

// The tracked source file both examples mutate. microservice1 serves GET / with
// `{ "microservice-name": "microservice1", path: "/" }`.
const MICROSERVICE1_SRC = resolve(
  repoRoot,
  "packages",
  "microservices",
  "microservice1",
  "src",
  "index.ts",
);

// Compiled output and TypeScript incremental build state for microservice1 and
// the Overseer. These tests clear them before a session so the Build_Watcher's
// FIRST Compile_Pass actually EMITS: the supervisor starts the Overseer only on
// a clean, EMITTING pass, so against a fully warm tree (nothing to emit) it
// would never boot within a session. Clearing the Overseer's output guarantees
// a cold, emitting first pass; clearing microservice1's output additionally
// makes example two's poisoned first pass have no prior good output to fall back
// on (R6.7's "no Last_Good_Output" precondition). All of this is gitignored
// churn that the session itself rebuilds.
const MICROSERVICE1_DIR = resolve(repoRoot, "packages", "microservices", "microservice1");
const OVERSEER_DIR = resolve(repoRoot, "packages", "overseer");

/** Remove a package's `dist/` and its `tsconfig.tsbuildinfo` so its next compile emits. */
function clearBuildOutput(packageDir: string): void {
  rmSync(resolve(packageDir, "dist"), { recursive: true, force: true });
  rmSync(resolve(packageDir, "tsconfig.tsbuildinfo"), { force: true });
}

// The relative path tsc prints in its diagnostics (POSIX separators on the
// platforms this suite runs on). Used as the contiguous, un-styled substring
// `waitForOutput` waits on, and as the anchor for the (line,character) check.
const DIAG_PATH = "packages/microservices/microservice1/src/index.ts";

// Generous budget: each session bootstrap-builds, generates the registry, and
// starts a resident tsc build watcher plus the Overseer. Recompiles then follow.
const BOOT_TIMEOUT_MS = 120_000;
const RECOMPILE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 300_000;

/** The committed content of microservice1's source, captured once for rewriting. */
const ORIGINAL_SRC = readFileSync(MICROSERVICE1_SRC, "utf8");

/**
 * A version of microservice1's router with a genuine TypeScript type error: a
 * `number` assigned to a `string`-typed local. `tsc` reports a diagnostic
 * naming this file at a real (line,character) position. The error sits on a
 * known non-trivial line so the position in the diagnostic is meaningful.
 */
const WITH_TYPE_ERROR = ORIGINAL_SRC.replace(
  'export const path = "/";',
  ['export const path = "/";', "", "const _brokenTypeCheck: string = 42;", "void _brokenTypeCheck;"].join(
    "\n",
  ),
);

/**
 * A valid version that changes the observable response body: GET / now includes
 * an extra `revision` marker. This compiles cleanly, so the Compile_Pass emits
 * and the Dev_Server performs an Overseer_Restart with no developer action.
 */
const REVISION_MARKER = "error-then-fix-roundtrip";
function withNewBehavior(source: string): string {
  return source.replace(
    '.json({ "microservice-name": "microservice1", path });',
    `.json({ "microservice-name": "microservice1", path, revision: "${REVISION_MARKER}" });`,
  );
}

/** Sanity: the string substitutions above must actually change the source. */
if (WITH_TYPE_ERROR === ORIGINAL_SRC) {
  throw new Error("type-error mutation did not modify the source; anchor changed");
}
if (withNewBehavior(ORIGINAL_SRC) === ORIGINAL_SRC) {
  throw new Error("new-behavior mutation did not modify the source; anchor changed");
}

/** Strip ANSI color/style escape sequences so a styled diagnostic can be pattern-matched. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** GET <base>/ once and return the parsed JSON body. */
async function getRoot(baseUrl: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/`);
  return (await res.json()) as Record<string, unknown>;
}

/** Poll GET <base>/ until the predicate holds on its body, or reject at the deadline. */
async function waitForBody(
  baseUrl: string,
  predicate: (body: Record<string, unknown>) => boolean,
  deadline: number,
): Promise<Record<string, unknown>> {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const body = await getRoot(baseUrl);
      if (predicate(body)) {
        return body;
      }
      last = body;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`GET ${baseUrl}/ never satisfied predicate; last: ${JSON.stringify(last)}`);
}

/** True when anything answers an HTTP request on baseUrl (a bound Overseer). */
async function portAnswers(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/`);
    await res.text();
    return true;
  } catch {
    return false;
  }
}

let session: DevSession | undefined;

afterEach(async () => {
  // Kill the whole dev-session process tree first so no child is mid-recompile
  // when we restore the source, then restore the tracked file to its committed
  // content. dist/ and the generated registry are gitignored and left as-is.
  if (session !== undefined) {
    await session.stop();
    session = undefined;
  }
  restoreWorktreeFile(MICROSERVICE1_SRC);
});

describe("Dev_Server error-then-fix round trip (api-dev-server Property 5)", () => {
  it(
    "example one: a type error is reported while the last-good Overseer keeps serving, and fixing it restarts against the new behavior (R6.1, R6.3, R6.4)",
    async () => {
      // A dedicated non-default port so we never collide with 8080 or the other
      // session-level suites.
      const PORT = 8241;
      const baseUrl = `http://127.0.0.1:${PORT}`;

      // Start from the committed source so the first Compile_Pass is clean.
      restoreWorktreeFile(MICROSERVICE1_SRC);

      // Clear the Overseer's build output so the session's first Compile_Pass
      // emits and the supervisor starts the Overseer (a warm tree emits nothing,
      // so the Overseer would never boot within the session).
      clearBuildOutput(OVERSEER_DIR);

      // Pre-flight: nothing may already own PORT, or a leaked server from a
      // previous run would satisfy the readiness probe without our session.
      expect(
        await portAnswers(baseUrl),
        `port ${PORT} is already in use — likely a leaked Overseer from a previous run. ` +
          `Kill it (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      session = startDevSession({
        env: {
          MICROSERVICES: "microservice1",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          PORT: String(PORT),
        },
      });

      // The Overseer boots and answers with the original body.
      await session.waitForOutput(OVERSEER_READY_MARKER, { timeout: BOOT_TIMEOUT_MS });
      const original = await waitForBody(
        baseUrl,
        (body) => body["microservice-name"] === "microservice1",
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(original).toEqual({ "microservice-name": "microservice1", path: "/" });

      // Introduce a genuine type error.
      writeFileSync(MICROSERVICE1_SRC, WITH_TYPE_ERROR);

      // R6.1: a diagnostic naming the source file appears. The file path is a
      // single un-styled run in tsc's colored output, so we wait on it verbatim,
      // then check the (line,character) suffix against the ANSI-stripped output.
      await session.waitForOutput(DIAG_PATH, { timeout: RECOMPILE_TIMEOUT_MS });
      const diagnostics = stripAnsi(session.output());
      // The diagnostic names microservice1's source file WITH a line and
      // character position, i.e. `.../microservice1/src/index.ts:LINE:CHAR`.
      expect(diagnostics).toMatch(/microservice1\/src\/index\.ts:\d+:\d+/);

      // R6.3: the live Overseer keeps serving the Last_Good_Output — its body is
      // still the original, never the (never-emitted) errored output. Poll so a
      // brief restart-against-last-good window does not flake; the invariant is
      // that whenever it answers, the body is the ORIGINAL (no revision marker).
      const stillOriginal = await waitForBody(
        baseUrl,
        (body) => body["microservice-name"] === "microservice1",
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(stillOriginal).toEqual({ "microservice-name": "microservice1", path: "/" });

      // Fix the file to a NEW valid behavior. This clean, emitting pass triggers
      // an Overseer_Restart with no developer action (R6.4).
      writeFileSync(MICROSERVICE1_SRC, withNewBehavior(ORIGINAL_SRC));

      // The new behavior is served on the same port, with no manual restart.
      const revised = await waitForBody(
        baseUrl,
        (body) => body["revision"] === REVISION_MARKER,
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(revised).toEqual({
        "microservice-name": "microservice1",
        path: "/",
        revision: REVISION_MARKER,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "example two: a first-pass compile error binds no Overseer but keeps the watcher alive, and fixing it starts the Overseer (R6.4, R6.7)",
    async () => {
      const PORT = 8242;
      const baseUrl = `http://127.0.0.1:${PORT}`;

      // Pre-flight: nothing may already own PORT, or a leaked server would make
      // the "no Overseer binds" assertion below observe a stale server and flake.
      expect(
        await portAnswers(baseUrl),
        `port ${PORT} is already in use — likely a leaked Overseer from a previous run. ` +
          `Kill it (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      // Clear microservice1's AND the Overseer's build output so the poisoned
      // first pass has NO prior good output to boot against: with microservice1
      // failing to compile the Overseer (which imports it) cannot emit either, so
      // nothing valid exists for the supervisor to start against — R6.7's "no
      // Last_Good_Output" precondition. A stale-but-valid dist/ left by a prior
      // clean build would otherwise let the Overseer start.
      clearBuildOutput(MICROSERVICE1_DIR);
      clearBuildOutput(OVERSEER_DIR);

      // Poison the source BEFORE the session starts, so the FIRST Compile_Pass of
      // the Build_Watcher errors and no Last_Good_Output ever exists (R6.7).
      writeFileSync(MICROSERVICE1_SRC, WITH_TYPE_ERROR);

      session = startDevSession({
        env: {
          MICROSERVICES: "microservice1",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          PORT: String(PORT),
        },
      });

      // R6.1: the first pass reports a diagnostic naming the file with a
      // (line,character) position. Wait on the contiguous file path, then check
      // the position on the ANSI-stripped output.
      await session.waitForOutput(DIAG_PATH, { timeout: BOOT_TIMEOUT_MS });
      expect(stripAnsi(session.output())).toMatch(
        /microservice1\/src\/index\.ts:\d+:\d+/,
      );

      // R6.7: no Last_Good_Output exists, so no Overseer binds. Give a grace
      // window in case a (buggy) child were mid-bind, then confirm still unbound.
      const graceDeadline = Date.now() + 5_000;
      while (Date.now() < graceDeadline) {
        expect(
          await portAnswers(baseUrl),
          `port ${PORT} answered during the no-bind window; a first-pass compile ` +
            `error must not start the Overseer (R6.7).\n--- session output ---\n${session.output()}`,
        ).toBe(false);
        await new Promise((r) => setTimeout(r, 500));
      }

      // The Build_Watcher stays resident: the session process has not exited.
      expect(session.child.exitCode).toBeNull();
      expect(session.child.signalCode).toBeNull();

      // Fix the file. The next clean, emitting Compile_Pass starts the Overseer
      // on its own (R6.4) — no developer re-invocation.
      writeFileSync(MICROSERVICE1_SRC, ORIGINAL_SRC);

      await session.waitForOutput(OVERSEER_READY_MARKER, { timeout: RECOMPILE_TIMEOUT_MS });
      const body = await waitForBody(
        baseUrl,
        (b) => b["microservice-name"] === "microservice1",
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(body).toEqual({ "microservice-name": "microservice1", path: "/" });
    },
    TEST_TIMEOUT_MS,
  );
});

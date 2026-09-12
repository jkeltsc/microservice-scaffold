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
// --- Why this suite runs on a pristine COPY of the tree ---------------------
//
// This suite MUTATES two microservice source files — microservice1/src/index.ts
// (for the type error, whose diagnostic path it asserts) and
// microservice2/src/index.ts (for the observable-behaviour change, read at
// microservice2's Mount_Root /microservice2 rather than at `/`, which
// Microservice1 owns). Every one of those mutations happens inside the suite's
// OWN pristine copy of the tree, materialised by `pristineWorktree()` into an OS
// temp directory. The REAL working tree is NEVER written to, and no path under
// `repoRoot` is ever touched.
//
// This is not stylistic. An earlier revision of this suite edited the real
// tracked files and "restored" them with `git checkout -- <path>`, which reverts
// a file to its COMMITTED content — silently destroying any uncommitted work in
// those files. It did exactly that, twice. Restoration between the two examples
// is therefore done by WRITING BACK the original bytes captured from the
// pristine tree, never by invoking git. `pristineWorktree()` lists tracked plus
// untracked-but-not-gitignored files (`git ls-files --cached --others
// --exclude-standard`) and tars them from disk, so the copy reflects uncommitted
// edits as they currently are, while gitignored `dist/`, `*.tsbuildinfo`, and the
// generated registry are excluded and free to churn inside the copy.
//
// tsc prints diagnostic paths relative to its own cwd — the pristine directory
// here — so the relative path the diagnostic assertions match on is unchanged.
//
// Validates: Requirements 6.1, 6.3, 6.4, 6.7

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  startDevSession,
  pristineWorktree,
  OVERSEER_READY_MARKER,
  type DevSession,
  type PristineWorktreeResult,
} from "./helpers.js";

// Repo-relative locations, resolved against the PRISTINE tree (never repoRoot).
const MS1_SRC_REL = "packages/microservices/microservice1/src/index.ts";
const MS2_SRC_REL = "packages/microservices/microservice2/src/index.ts";
const MS1_PKG_REL = "packages/microservices/microservice1";
const OVERSEER_PKG_REL = "packages/overseer";

// microservice2's Mount_Root. The observable-behaviour change is read here — a
// path microservice2 owns — so the assertion is independent of whatever
// Microservice1 now serves at `/` (R13.14, R13.15).
const MS2_MOUNT_ROOT = "/microservice2";

// The relative path tsc prints in its diagnostics (POSIX separators on the
// platforms this suite runs on). tsc's cwd is the pristine dir, so this relative
// path is the same one it would print in the real tree. Used as the contiguous,
// un-styled substring `waitForOutput` waits on, and as the anchor for the
// (line,character) check.
const DIAG_PATH = MS1_SRC_REL;

// The Mutation_Anchors this suite string-replaces. The type-error anchor lives
// in Microservice1's source; the new-behavior anchor is Microservice2's
// identifier-response literal.
const TYPE_ERROR_ANCHOR = 'export const path = "/";';
const NEW_BEHAVIOR_ANCHOR = '.json({ "microservice-name": "microservice2", path });';

/** The extra `revision` marker example one asserts microservice2 starts serving. */
const REVISION_MARKER = "error-then-fix-roundtrip";

// Generous budget: materialising the pristine tree runs `npm ci`, and each
// session bootstrap-builds, generates the registry, and starts a resident tsc
// build watcher plus the Overseer. Recompiles then follow.
const PRISTINE_TIMEOUT_MS = 600_000;
const BOOT_TIMEOUT_MS = 120_000;
const RECOMPILE_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 300_000;

/** Remove a package's `dist/` and its `tsconfig.tsbuildinfo` so its next compile emits. */
function clearBuildOutput(packageDir: string): void {
  rmSync(resolve(packageDir, "dist"), { recursive: true, force: true });
  rmSync(resolve(packageDir, "tsconfig.tsbuildinfo"), { force: true });
}

/**
 * A valid version of microservice2 that changes its observable response body:
 * GET /microservice2 now includes an extra `revision` marker. This compiles
 * cleanly, so the Compile_Pass emits and the Dev_Server performs an
 * Overseer_Restart with no developer action.
 */
function withNewBehavior(source: string): string {
  return source.replace(
    NEW_BEHAVIOR_ANCHOR,
    `.json({ "microservice-name": "microservice2", path, revision: "${REVISION_MARKER}" });`,
  );
}

/**
 * A version of microservice1's router with a genuine TypeScript type error: a
 * `number` assigned to a `string`-typed local. `tsc` reports a diagnostic
 * naming this file at a real (line,character) position.
 */
function withTypeError(source: string): string {
  return source.replace(
    TYPE_ERROR_ANCHOR,
    [TYPE_ERROR_ANCHOR, "", "const _brokenTypeCheck: string = 42;", "void _brokenTypeCheck;"].join(
      "\n",
    ),
  );
}

/**
 * Everything the examples need, all of it rooted in the PRISTINE tree. The
 * original file contents are read from the pristine copy (not from repoRoot),
 * and the mutated variants are derived from those captured strings — so the
 * bytes written back on restore are exactly the bytes the copy started with.
 */
interface Fixture {
  /** The pristine tree root; the cwd every Dev_Session is spawned in. */
  readonly dir: string;
  readonly ms1Src: string;
  readonly ms2Src: string;
  readonly ms1PkgDir: string;
  readonly overseerPkgDir: string;
  readonly originalMs1: string;
  readonly originalMs2: string;
  readonly ms1WithTypeError: string;
  readonly ms2WithNewBehavior: string;
}

/**
 * Read the two source files from the pristine tree, derive the mutated variants,
 * and enforce the Mutation_Anchor guards against the pristine copy.
 *
 * The guards are real: if an anchor no longer appears, this throws naming the
 * source file and the anchor rather than letting an example proceed with an
 * unmodified file (R13.16).
 */
function makeFixture(dir: string): Fixture {
  const ms1Src = resolve(dir, MS1_SRC_REL);
  const ms2Src = resolve(dir, MS2_SRC_REL);
  const originalMs1 = readFileSync(ms1Src, "utf8");
  const originalMs2 = readFileSync(ms2Src, "utf8");

  const ms1WithTypeError = withTypeError(originalMs1);
  const ms2WithNewBehavior = withNewBehavior(originalMs2);

  if (ms1WithTypeError === originalMs1) {
    throw new Error(
      `type-error Mutation_Anchor '${TYPE_ERROR_ANCHOR}' not found in ${ms1Src}; ` +
        `the anchor is stale — refusing to proceed with an unmodified file`,
    );
  }
  if (ms2WithNewBehavior === originalMs2) {
    throw new Error(
      `new-behavior Mutation_Anchor '${NEW_BEHAVIOR_ANCHOR}' not found in ${ms2Src}; ` +
        `the anchor is stale — refusing to proceed with an unmodified file`,
    );
  }

  return {
    dir,
    ms1Src,
    ms2Src,
    ms1PkgDir: resolve(dir, MS1_PKG_REL),
    overseerPkgDir: resolve(dir, OVERSEER_PKG_REL),
    originalMs1,
    originalMs2,
    ms1WithTypeError,
    ms2WithNewBehavior,
  };
}

/** Strip ANSI color/style escape sequences so a styled diagnostic can be pattern-matched. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** GET the given absolute URL once and return the parsed JSON body. */
async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  return (await res.json()) as Record<string, unknown>;
}

/** Poll GET <url> until the predicate holds on its body, or reject at the deadline. */
async function waitForBody(
  url: string,
  predicate: (body: Record<string, unknown>) => boolean,
  deadline: number,
): Promise<Record<string, unknown>> {
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const body = await getJson(url);
      if (predicate(body)) {
        return body;
      }
      last = body;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`GET ${url} never satisfied predicate; last: ${JSON.stringify(last)}`);
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

let pristine: PristineWorktreeResult | undefined;
let fixture: Fixture | undefined;
let unavailableReason: string | undefined;
let session: DevSession | undefined;

beforeAll(() => {
  // ONE pristine tree for the whole suite: `npm ci` is the slow step, so it runs
  // once. Every mutation below happens inside `pristine.dir`.
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    unavailableReason = pristine.reason;
    return;
  }
  fixture = makeFixture(pristine.dir);
}, PRISTINE_TIMEOUT_MS);

afterEach(async () => {
  // Kill the whole dev-session process tree first so no child is mid-recompile
  // when we rewrite the sources, then restore both files by WRITING BACK the
  // bytes captured from the pristine tree. Never `git checkout` — that would
  // discard uncommitted work. `dist/`, `*.tsbuildinfo` and the generated
  // registry are gitignored churn inside the temp copy and are left as-is.
  if (session !== undefined) {
    await session.stop();
    session = undefined;
  }
  if (fixture !== undefined) {
    writeFileSync(fixture.ms1Src, fixture.originalMs1);
    writeFileSync(fixture.ms2Src, fixture.originalMs2);
  }
});

afterAll(() => {
  // Teardown is just removing the temp tree.
  if (pristine?.available === true) {
    pristine.cleanup();
  }
  pristine = undefined;
  fixture = undefined;
});

describe("Dev_Server error-then-fix round trip (api-dev-server Property 5)", () => {
  it(
    "example one: a type error is reported while the last-good Overseer keeps serving, and fixing it restarts against the new behavior (R6.1, R6.3, R6.4)",
    async () => {
      if (fixture === undefined) {
        // git (or tar / npm ci) unavailable — skip with a clear message.
        console.warn(
          `SKIP dev-error-recovery example one: ${unavailableReason ?? "pristine tree unavailable"}`,
        );
        return;
      }
      const fx = fixture;

      // A dedicated non-default port so we never collide with 8080 or the other
      // session-level suites.
      const PORT = 8241;
      const baseUrl = `http://127.0.0.1:${PORT}`;

      // The pristine tree starts from the captured sources, so the first
      // Compile_Pass is clean. (afterEach also restores them between examples.)
      writeFileSync(fx.ms1Src, fx.originalMs1);
      writeFileSync(fx.ms2Src, fx.originalMs2);

      // Clear the Overseer's build output so the session's first Compile_Pass
      // emits and the supervisor starts the Overseer (a warm tree emits nothing,
      // so the Overseer would never boot within the session). A freshly
      // materialised pristine tree has none anyway; this keeps the example
      // correct if it ever runs second against a warmed copy.
      clearBuildOutput(fx.overseerPkgDir);

      // Pre-flight: nothing may already own PORT, or a leaked server from a
      // previous run would satisfy the readiness probe without our session.
      expect(
        await portAnswers(baseUrl),
        `port ${PORT} is already in use — likely a leaked Overseer from a previous run. ` +
          `Kill it (e.g. \`lsof -ti tcp:${PORT} | xargs kill -9\`) and retry.`,
      ).toBe(false);

      // Widen the selector to microservice1,microservice2 so the probed peer
      // (microservice2, whose Mount_Root /microservice2 the observable-behaviour
      // assertion reads) is actually mounted alongside microservice1. The session
      // runs IN the pristine tree.
      session = startDevSession({
        cwd: fx.dir,
        env: {
          MICROSERVICES: "microservice1,microservice2",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE2_ENABLED: "enabled",
          PORT: String(PORT),
        },
      });

      // The Overseer boots and microservice2 answers with its original body at
      // its Mount_Root.
      await session.waitForOutput(OVERSEER_READY_MARKER, { timeout: BOOT_TIMEOUT_MS });
      const original = await waitForBody(
        `${baseUrl}${MS2_MOUNT_ROOT}`,
        (body) => body["microservice-name"] === "microservice2",
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(original).toEqual({ "microservice-name": "microservice2", path: MS2_MOUNT_ROOT });

      // Introduce a genuine type error into the pristine copy of microservice1's
      // source (its `export const path = "/";` line stays the anchor, so the
      // diagnostic still names microservice1's file).
      writeFileSync(fx.ms1Src, fx.ms1WithTypeError);

      // R6.1: a diagnostic naming the source file appears. The file path is a
      // single un-styled run in tsc's colored output, so we wait on it verbatim,
      // then check the (line,character) suffix against the ANSI-stripped output.
      await session.waitForOutput(DIAG_PATH, { timeout: RECOMPILE_TIMEOUT_MS });
      const diagnostics = stripAnsi(session.output());
      // The diagnostic names microservice1's source file WITH a line and
      // character position, i.e. `.../microservice1/src/index.ts:LINE:CHAR`.
      expect(diagnostics).toMatch(/microservice1\/src\/index\.ts:\d+:\d+/);

      // R6.3: the live Overseer keeps serving the Last_Good_Output — microservice2's
      // body at its Mount_Root is still the original, never the (never-emitted)
      // errored output. The type error is in microservice1, which the Overseer
      // imports, so the whole tree fails to emit and the last-good process keeps
      // answering everywhere. Poll so a brief restart-against-last-good window
      // does not flake; the invariant is that whenever it answers, the body is
      // the ORIGINAL (no revision marker).
      const stillOriginal = await waitForBody(
        `${baseUrl}${MS2_MOUNT_ROOT}`,
        (body) => body["microservice-name"] === "microservice2",
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(stillOriginal).toEqual({ "microservice-name": "microservice2", path: MS2_MOUNT_ROOT });

      // Fix microservice1 back to valid AND change microservice2 to a NEW valid
      // behavior. This clean, emitting pass triggers an Overseer_Restart with no
      // developer action (R6.4); the observable new behavior is microservice2's.
      writeFileSync(fx.ms1Src, fx.originalMs1);
      writeFileSync(fx.ms2Src, fx.ms2WithNewBehavior);

      // The new behavior is served at microservice2's Mount_Root on the same
      // port, with no manual restart.
      const revised = await waitForBody(
        `${baseUrl}${MS2_MOUNT_ROOT}`,
        (body) => body["revision"] === REVISION_MARKER,
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(revised).toEqual({
        "microservice-name": "microservice2",
        path: MS2_MOUNT_ROOT,
        revision: REVISION_MARKER,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "example two: a first-pass compile error binds no Overseer but keeps the watcher alive, and fixing it starts the Overseer (R6.4, R6.7)",
    async () => {
      if (fixture === undefined) {
        console.warn(
          `SKIP dev-error-recovery example two: ${unavailableReason ?? "pristine tree unavailable"}`,
        );
        return;
      }
      const fx = fixture;

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
      // Last_Good_Output" precondition. Example one leaves a warm copy behind, so
      // this clearing is load-bearing here.
      clearBuildOutput(fx.ms1PkgDir);
      clearBuildOutput(fx.overseerPkgDir);

      // Poison the pristine copy's source BEFORE the session starts, so the FIRST
      // Compile_Pass of the Build_Watcher errors and no Last_Good_Output ever
      // exists (R6.7).
      writeFileSync(fx.ms1Src, fx.ms1WithTypeError);

      // Widen the selector to microservice1,microservice2 so, once the poison is
      // fixed, the recovery probe can read a dispatched response at
      // microservice2's Mount_Root rather than a path Microservice1 owns.
      session = startDevSession({
        cwd: fx.dir,
        env: {
          MICROSERVICES: "microservice1,microservice2",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          MICROSERVICE_MICROSERVICE2_ENABLED: "enabled",
          PORT: String(PORT),
        },
      });

      // R6.1: the first pass reports a diagnostic naming the file with a
      // (line,character) position. Wait on the contiguous file path, then check
      // the position on the ANSI-stripped output.
      await session.waitForOutput(DIAG_PATH, { timeout: BOOT_TIMEOUT_MS });
      expect(stripAnsi(session.output())).toMatch(/microservice1\/src\/index\.ts:\d+:\d+/);

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
      writeFileSync(fx.ms1Src, fx.originalMs1);

      await session.waitForOutput(OVERSEER_READY_MARKER, { timeout: RECOMPILE_TIMEOUT_MS });
      // Probe microservice2's Mount_Root — a dispatched response — to confirm
      // the Overseer started, rather than `/`, which Microservice1 owns
      // (R13.14, R13.15).
      const body = await waitForBody(
        `${baseUrl}${MS2_MOUNT_ROOT}`,
        (b) => b["microservice-name"] === "microservice2",
        Date.now() + RECOMPILE_TIMEOUT_MS,
      );
      expect(body).toEqual({ "microservice-name": "microservice2", path: MS2_MOUNT_ROOT });
    },
    TEST_TIMEOUT_MS,
  );
});

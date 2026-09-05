// Shared helpers for the cross-package integration suites (tasks 12.2-12.7).
//
// These helpers build an in-process Overseer Express app from the REAL
// reference microservice modules, so the integration tests exercise the actual
// routing and 404/405 behavior end-to-end without depending on the gitignored
// generated registry file. The overseer's `buildApp` is imported via its
// compiled deep path because the overseer package's `main` entry auto-boots a
// live server on import.

import * as microservice1 from "@microservices/microservice1";
import * as microservice2 from "@microservices/microservice2";
import * as microservice3 from "@microservices/microservice3";
import type {
  MicroserviceModule,
  MicroserviceRegistry,
  RegistryEntry,
  ToggleMap,
} from "@microservices/contracts";

// The overseer package's `main` (dist/index.js) runs its boot pipeline on
// import, so we reach into its compiled leaf modules for the pure composition
// helpers used by the tests.
export { buildApp } from "@microservices/overseer/dist/router.js";

/** The three real reference microservice modules, keyed for convenience. */
export const modules = {
  microservice1: microservice1 as unknown as MicroserviceModule,
  microservice2: microservice2 as unknown as MicroserviceModule,
  microservice3: microservice3 as unknown as MicroserviceModule,
} as const;

/**
 * Build a synthetic {@link MicroserviceRegistry} from a set of real reference
 * microservice modules. This mirrors the shape the build-tools generator emits
 * (`{ identifier, module, sourcePackage }` rows) but is assembled in-process so
 * tests never depend on the generated `microservice-registry.ts`.
 */
export function makeRegistry(
  ids: ReadonlyArray<keyof typeof modules>,
): MicroserviceRegistry {
  return ids.map((id): RegistryEntry => ({
    // The key in `modules` is the microservice's directory name, which is the
    // authoritative identifier the real generator emits on each entry.
    identifier: id,
    module: modules[id],
    sourcePackage: `@microservices/${id}`,
  }));
}

/**
 * Build a {@link ToggleMap} from an explicit identifier -> enabled mapping.
 * Identifiers absent from the mapping are treated as disabled.
 */
export function makeToggleMap(
  entries: Readonly<Record<string, boolean>>,
): ToggleMap {
  return { enabled: new Map(Object.entries(entries)) };
}
// ---------------------------------------------------------------------------
// Dev_Server session harness (task 7.1, api-dev-server spec).
//
// The helpers below drive the real Dev_Command end to end for the process-level
// suites (tasks 7.2-7.6). They are deliberately additive: nothing above changes.
//
// The Dev_Command is `npm run dev` == `dotenvx run -- node scripts/dev.js`.
// A session test does NOT go through npm/dotenvx — it spawns `scripts/dev.js`
// directly with `node`, supplying the environment (Toggles, `PORT`,
// `MICROSERVICES`) itself, so a suite controls the whole environment rather than
// depending on the developer's local `.env`. That matches the way
// `start-parity.test.ts` spawns `scripts/start.js` directly.
//
// Process tree: `scripts/dev.js` spawns the compiled supervisor bin, which in
// turn spawns the Overseer as ITS child. Killing only the dev.js child would
// orphan the supervisor and the Overseer (which keeps holding `PORT`). So the
// session is spawned `detached` — making it the leader of a new process group —
// and torn down by killing the whole group, exactly as the start-parity suite
// does. On Windows the group has no negative-pid kill, so `taskkill /T` is used
// to kill the tree.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirnameHelpers = dirname(fileURLToPath(import.meta.url));
/** Repo root: tests/ -> integration-tests -> packages -> repo root. */
export const repoRoot = resolve(__dirnameHelpers, "..", "..", "..");

/** The Dev_Command entry script (`scripts/dev.js`), spawned directly. */
const devScript = resolve(repoRoot, "scripts", "dev.js");

/** The Overseer's existing boot marker, used as the default readiness signal. */
export const OVERSEER_READY_MARKER = "[boot] Overseer listening on port";

/** Options controlling how a Dev_Session is spawned. */
export interface StartDevSessionOptions {
  /**
   * Extra environment for the session, merged over `process.env`. Use this to
   * set `PORT`, `MICROSERVICES`, and `MICROSERVICE_<ID>_ENABLED` Toggles. Values
   * here are passed through to the Overseer by the supervisor unmodified, which
   * is exactly the pass-through the tests assert.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Working directory to spawn from. Defaults to {@link repoRoot}. A cold-start
   * test points this at a {@link pristineWorktree} directory instead.
   */
  readonly cwd?: string;
}

/** A live Dev_Session under test. Always tear it down with {@link DevSession.stop}. */
export interface DevSession {
  /** The spawned `scripts/dev.js` child (the process-group leader). */
  readonly child: ChildProcess;
  /**
   * Everything the session has written to stdout and stderr so far, in arrival
   * order, joined. Reading this is cheap; it is also the buffer
   * {@link DevSession.waitForOutput} scans.
   */
  output(): string;
  /**
   * Resolve when a line matching `pattern` has appeared on stdout or stderr, or
   * reject when `timeout` ms elapse first. The match is checked against output
   * already buffered before this call as well as output that arrives after, so
   * there is no race between a fast child and a late waiter. If the child exits
   * before a match, the promise rejects with the captured output.
   */
  waitForOutput(
    pattern: string | RegExp,
    options?: { readonly timeout?: number },
  ): Promise<string>;
  /**
   * Kill the whole process group (dev.js -> supervisor -> Overseer) and resolve
   * once it is gone. Idempotent and safe to call from an `afterEach`/`afterAll`
   * even if the session already exited. Guarantees no child outlives the test.
   */
  stop(): Promise<void>;
}

/** Default deadline for {@link DevSession.waitForOutput}. */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
/** How long {@link DevSession.stop} waits for the group to die before giving up. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Spawn the Dev_Command (`scripts/dev.js`) as a detached, output-captured
 * session and return a handle exposing a deadline-bounded `waitForOutput` and a
 * teardown that kills the whole process tree.
 *
 * The child is spawned with `node scripts/dev.js` (not via npm/dotenvx), so the
 * caller's {@link StartDevSessionOptions.env} is authoritative. It is NOT
 * `unref()`-ed: stdio stays piped and the exit stays observable so teardown can
 * confirm the group is gone.
 */
export function startDevSession(
  options: StartDevSessionOptions = {},
): DevSession {
  const chunks: string[] = [];
  // Waiters registered by waitForOutput; each is retried on every new chunk and
  // on child exit. Stored so a single data handler can serve all of them.
  const waiters = new Set<() => void>();

  const child = spawn(process.execPath, [devScript], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    // New process group so stop() can kill dev.js AND the supervisor/Overseer
    // it spawns. Deliberately not unref()'d — see the doc comment.
    detached: true,
  });

  const record = (buffer: Buffer): void => {
    chunks.push(buffer.toString());
    for (const notify of waiters) {
      notify();
    }
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  // Wake every waiter on exit so a child that dies without matching rejects
  // promptly rather than hanging until its own timeout.
  child.on("exit", () => {
    for (const notify of waiters) {
      notify();
    }
  });

  const output = (): string => chunks.join("");

  const waitForOutput = (
    pattern: string | RegExp,
    waitOptions: { readonly timeout?: number } = {},
  ): Promise<string> => {
    const timeout = waitOptions.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const matches = (text: string): boolean =>
      typeof pattern === "string"
        ? text.includes(pattern)
        : pattern.test(text);

    return new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        rejectPromise(
          new Error(
            `timed out after ${timeout}ms waiting for ${String(pattern)}\n` +
              `--- session output ---\n${output()}`,
          ),
        );
      }, timeout);
      // Do not keep the event loop alive solely for this timer.
      timer.unref?.();

      const finish = (): void => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      const check = (): void => {
        if (settled) {
          return;
        }
        const current = output();
        if (matches(current)) {
          settled = true;
          finish();
          resolvePromise(current);
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          settled = true;
          finish();
          rejectPromise(
            new Error(
              `dev session exited (code ${String(child.exitCode)}, signal ${String(
                child.signalCode,
              )}) before output matched ${String(pattern)}\n` +
                `--- session output ---\n${current}`,
            ),
          );
        }
      };

      waiters.add(check);
      // Check synchronously against already-buffered output first.
      check();
    });
  };

  const stop = (): Promise<void> => {
    const pid = child.pid;
    // Nothing to kill: never spawned, or already gone.
    if (pid === undefined) {
      return Promise.resolve();
    }

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          // Negative pid targets the whole process group led by the detached child.
          process.kill(-pid, signal);
        }
      } catch {
        // ESRCH: the group is already gone. Nothing to clean up.
      }
    };

    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolvePromise) => {
      let done = false;
      const settle = (): void => {
        if (done) {
          return;
        }
        done = true;
        resolvePromise();
      };

      child.once("exit", settle);
      killGroup("SIGTERM");

      // Escalate to SIGKILL, then give up (resolve) after the deadline so a
      // teardown never hangs a suite. A leaked port would surface as the next
      // test's own bind failure, which is louder than a silent hang here.
      const escalate = setTimeout(() => killGroup("SIGKILL"), STOP_TIMEOUT_MS / 2);
      const giveUp = setTimeout(settle, STOP_TIMEOUT_MS);
      escalate.unref?.();
      giveUp.unref?.();
    });
  };

  return { child, output, waitForOutput, stop };
}

/** Result of {@link pristineWorktree}: either a usable tree, or a skip reason. */
export type PristineWorktreeResult =
  | {
      readonly available: true;
      /** Absolute path to the materialized clean tree (with `npm ci` run). */
      readonly dir: string;
      /** Remove the temp tree. Idempotent. */
      cleanup(): void;
    }
  | {
      readonly available: false;
      /**
       * Human-readable reason the pristine tree could not be produced, suitable
       * for an `it.skip(reason)` message. Set when `git` is absent or the
       * archive/`npm ci` failed for an environmental reason.
       */
      readonly reason: string;
    };

/**
 * Materialize a clean checkout of `HEAD` into an OS temp directory and run
 * `npm ci` there, so a cold-start test can run the Dev_Command against a tree
 * with no `dist/`, no `*.tsbuildinfo`, and no generated registry.
 *
 * `git archive HEAD` emits only tracked files (respecting `.gitignore`), so the
 * materialized tree is pristine by construction — build output and the generated
 * registry are simply absent. The archive is piped straight into `tar -x` in the
 * temp dir.
 *
 * When `git` (or `tar`, or `npm ci`) is unavailable or fails for an
 * environmental reason, this returns `{ available: false, reason }` so a
 * consuming test can `it.skip(reason)` with a clear message instead of failing.
 * A caller MUST check `available` before using `dir`.
 */
export function pristineWorktree(): PristineWorktreeResult {
  // `git` present at all?
  const gitVersion = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (gitVersion.error !== undefined || (gitVersion.status ?? 1) !== 0) {
    return {
      available: false,
      reason: "git is not available; skipping pristine-worktree test",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "dev-pristine-"));
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };

  // `git archive HEAD | tar -x -C <dir>`: pipe the archive into tar so only
  // tracked files land in the clean tree. Run through a shell so the pipe is
  // one atomic step; the command is fixed text with only the temp dir path
  // interpolated (a mkdtemp path, not user input).
  const archive = spawnSync(
    "sh",
    ["-c", `git archive HEAD | tar -x -C ${JSON.stringify(dir)}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (archive.error !== undefined || (archive.status ?? 1) !== 0) {
    cleanup();
    return {
      available: false,
      reason:
        "git archive/tar failed; skipping pristine-worktree test " +
        `(${archive.error?.message ?? archive.stderr ?? "non-zero exit"})`,
    };
  }

  // Install dependencies in the clean tree. `npm ci` needs the committed
  // package-lock.json, which the archive includes. This is the slow step; the
  // consuming suites budget for it with a generous timeout.
  const install = spawnSync("npm", ["ci"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (install.error !== undefined || (install.status ?? 1) !== 0) {
    cleanup();
    return {
      available: false,
      reason:
        "npm ci failed in the pristine tree; skipping pristine-worktree test " +
        `(${install.error?.message ?? install.stderr ?? "non-zero exit"})`,
    };
  }

  return { available: true, dir, cleanup };
}

/**
 * Restore a working-tree source file a session test mutated, back to its
 * committed content, via `git checkout -- <path>`. Call this in a test's
 * teardown for any tracked source file the test edited.
 *
 * `dist/` and the generated registry
 * (`packages/overseer/src/generated/microservice-registry.ts`) are gitignored
 * and expected to churn during a session, so they are intentionally NOT
 * restored — only tracked source files a test deliberately edits need this.
 *
 * `filePath` may be absolute or relative to {@link repoRoot}. Best-effort: a
 * failure (e.g. `git` absent) is swallowed so it never masks a test's real
 * assertion, mirroring the restore step in the existing start-parity suite.
 */
export function restoreWorktreeFile(filePath: string): void {
  const relative = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length).replace(/^[/\\]+/, "")
    : filePath;
  spawnSync("git", ["checkout", "--", relative], {
    cwd: repoRoot,
    stdio: "ignore",
  });
}

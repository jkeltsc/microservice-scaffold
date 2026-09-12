// Feature: api-dev-server, Property 10: Common_Startup yields one registry for both entry points
//   (single-sourcing and step-sequence halves)
// Feature: api-dev-server, Property 11: Common_Startup is single-sourced and Production_Start is unchanged
//
// This suite discharges the parts of Property 10 and all of Property 11 that
// are NOT the determinism half (that half lives in
// packages/build-tools/tests/dev-common-startup.property.test.ts). It has three
// parts, matching the design's "Properties 10 and 11" testing strategy:
//
//   1. Single-sourcing (static). Read scripts/*.js as text and assert exactly
//      one module exports `runCommonStartup`, that both scripts/start.js and
//      scripts/dev.js import it, that neither entry point performs a
//      bootstrap-build or registry-generation invocation of its own, and that
//      the clean-checkout ordering constraints are documented in
//      scripts/common-startup.js and in no other entry point (R11.1, R11.2).
//
//   2. Step-sequence agreement (1 example). Import `runCommonStartup` and call
//      it for the "start" and "dev" tags against the real warm tree; assert the
//      `steps` arrays are equal — the two paths agree up to the watch-or-not
//      divergence (R11.4). This runs the real bootstrap build + registry
//      generator, which is idempotent on a warm tree; the generated registry is
//      captured and restored so the working tree is left as found.
//
//   3. Production_Start unchanged (1 example, execution half). On a
//      pristineWorktree(), spawn `node scripts/start.js` and assert its step
//      order (bootstrap build -> registry generation -> full build -> Overseer
//      boot marker), that the Overseer answers, that Production_Start is
//      one-shot (it terminates with the Overseer's exit status and never
//      restarts or watches), and — with an invalid MICROSERVICES selector — that
//      it exits non-zero with the `[start] ... refusing to start the Overseer`
//      stderr line and never boots the Overseer (R11.5, R11.6). Skips with a
//      clear message when `git` is unavailable.
//
// Validates: Requirements 11.1, 11.2, 11.4, 11.5, 11.6

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  repoRoot,
  pristineWorktree,
  type PristineWorktreeResult,
} from "./helpers.js";

// The three entry-point scripts, read as text for the static half.
const scriptsDir = resolve(repoRoot, "scripts");
const commonStartupPath = resolve(scriptsDir, "common-startup.js");
const startPath = resolve(scriptsDir, "start.js");
const devPath = resolve(scriptsDir, "dev.js");

const commonStartupSrc = readFileSync(commonStartupPath, "utf8");
const startSrc = readFileSync(startPath, "utf8");
const devSrc = readFileSync(devPath, "utf8");

// The generated registry path, captured/restored around the step-sequence
// example, which runs the real generator (it is gitignored and expected to
// churn, so restoring it keeps the working tree exactly as found).
const REGISTRY_PATH = resolve(
  repoRoot,
  "packages",
  "overseer",
  "src",
  "generated",
  "microservice-registry.ts",
);

// ---------------------------------------------------------------------------
// Part 1 — single-sourcing (static checks). Property 11 (R11.1, R11.2), and
// the single-sourcing clause of Property 10.
// ---------------------------------------------------------------------------

describe("Property 11: Common_Startup is single-sourced (static)", () => {
  it("has exactly one module exporting `runCommonStartup`, and it is common-startup.js (R11.1)", () => {
    // The export declaration only appears in the single implementation module.
    const exportRe = /export\s+function\s+runCommonStartup\b/;

    expect(exportRe.test(commonStartupSrc)).toBe(true);
    // Neither entry point re-declares/re-exports it — they consume it.
    expect(exportRe.test(startSrc)).toBe(false);
    expect(exportRe.test(devSrc)).toBe(false);
  });

  it("imports `runCommonStartup` into both start.js and dev.js from ./common-startup.js (R11.1)", () => {
    const importRe =
      /import\s+\{\s*runCommonStartup\s*\}\s+from\s+["']\.\/common-startup\.js["']/;

    expect(importRe.test(startSrc)).toBe(true);
    expect(importRe.test(devSrc)).toBe(true);
  });

  it("keeps the bootstrap-build invocation only in common-startup.js (R11.1)", () => {
    // The Bootstrap_Build compiles exactly contracts + build-tools via the
    // scoped `npm run build --workspace ...` incantation. It must appear in the
    // single implementation and in neither entry point.
    const bootstrapRe = /--workspace["'\s,]+@microservices\/contracts/;

    expect(bootstrapRe.test(commonStartupSrc)).toBe(true);
    expect(bootstrapRe.test(startSrc)).toBe(false);
    expect(bootstrapRe.test(devSrc)).toBe(false);
  });

  it("keeps the registry-generation invocation only in common-startup.js (R11.1)", () => {
    // The Registry_Generator is invoked as the compiled bin. Neither entry
    // point may invoke it itself; both obtain it through runCommonStartup.
    const generatorRe = /bin\/generate-registry\.js/;

    expect(generatorRe.test(commonStartupSrc)).toBe(true);
    expect(generatorRe.test(startSrc)).toBe(false);
    expect(generatorRe.test(devSrc)).toBe(false);
  });

  it("documents the clean-checkout ordering constraints in common-startup.js and no other entry point (R11.2)", () => {
    // The three ordering constraints — Bootstrap_Build before the generator
    // bin, registry generation before the full build, both relying on the
    // topological root `workspaces` array — are documented in one place. The
    // module names each; assert the distinctive phrases live there and nowhere
    // else among the entry points.
    const phrases = [
      /clean-checkout ordering/i,
      /topological/i,
      /Bootstrap_Build/,
    ];

    for (const phrase of phrases) {
      expect(
        phrase.test(commonStartupSrc),
        `common-startup.js should document ${phrase}`,
      ).toBe(true);
    }

    // The ordering rationale is single-sourced. An entry point MAY point at
    // common-startup.js as the owner (start.js does: "the sole owner of the
    // clean-checkout ordering rationale"), but must not RE-DOCUMENT the
    // constraints themselves. The distinctive constraint reasoning — the
    // topological-workspaces argument — therefore appears only in
    // common-startup.js and in neither entry point.
    expect(/topological/i.test(commonStartupSrc)).toBe(true);
    expect(/topological/i.test(startSrc)).toBe(false);
    expect(/topological/i.test(devSrc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — step-sequence agreement (1 example). Property 10 (R11.4).
// ---------------------------------------------------------------------------

describe("Property 10: Common_Startup yields one registry for both entry points (step sequence)", () => {
  let originalRegistry: string | undefined;

  beforeAll(() => {
    // The step-sequence example runs the real generator, which rewrites the
    // gitignored registry. Capture it (if present) so we restore it after.
    originalRegistry = existsSync(REGISTRY_PATH)
      ? readFileSync(REGISTRY_PATH, "utf8")
      : undefined;
  });

  afterAll(() => {
    if (originalRegistry !== undefined) {
      writeFileSync(REGISTRY_PATH, originalRegistry, "utf8");
    }
  });

  it(
    "returns equal `steps` arrays for the start and dev entry points (R11.4)",
    async () => {
      // Import the single implementation the same way the entry points do. It
      // is plain ESM JavaScript under scripts/ (outside this package's rootDir),
      // so it is imported dynamically by file:// URL and typed locally rather
      // than via `typeof import(...)`, which would require allowJs.
      const mod = (await import(pathToScriptUrl(commonStartupPath))) as {
        runCommonStartup: (options: {
          tag: string;
          selector?: string;
          env?: NodeJS.ProcessEnv;
        }) =>
          | { ok: true; selector: string | undefined; steps: string[] }
          | {
              ok: false;
              step: string;
              message: string;
              status: number;
              steps: string[];
            };
      };
      const { runCommonStartup } = mod;

      // Run for both tags against the warm tree. runCommonStartup performs real
      // process effects (the bootstrap build + generator), but both are
      // idempotent on a warm tree, so running once per tag is bounded and safe.
      const startResult = runCommonStartup({ tag: "start" });
      const devResult = runCommonStartup({ tag: "dev" });

      // Both must succeed on a warm tree; if not, surface why.
      expect(startResult.ok, JSON.stringify(startResult)).toBe(true);
      expect(devResult.ok, JSON.stringify(devResult)).toBe(true);

      // The paths agree up to the watch-or-not divergence: identical shared
      // step sequence, in order.
      expect(devResult.steps).toEqual(startResult.steps);
      expect(startResult.steps).toEqual(["bootstrap-build", "generate-registry"]);
    },
    120_000,
  );
});

/** Convert an absolute filesystem path to a file:// URL string for import(). */
function pathToScriptUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

// ---------------------------------------------------------------------------
// Part 3 — Production_Start unchanged (execution half, pristine tree).
// Property 11 (R11.5, R11.6).
// ---------------------------------------------------------------------------

// Distinct, non-default ports so this never collides with 8080 or the
// start-parity suite's 8137. The happy-path example and the invalid-selector
// example use different ports so they are fully independent.
const PORT = 8151;
const FAIL_PORT = 8152;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** The Overseer's existing boot marker — the readiness signal Production_Start prints. */
const OVERSEER_READY_MARKER = "[boot] Overseer listening on port";

/** True when something answers on `port` (any HTTP response counts as "in use"). */
async function portAnswers(port: number = PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    await res.text();
    return true;
  } catch {
    return false;
  }
}

/** Kill the whole process group led by `pid` (start.js -> Overseer grandchild). */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // ESRCH: the group is already gone.
  }
}

describe("Property 11: Production_Start is unchanged (execution, pristine tree)", () => {
  let pristine: PristineWorktreeResult;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    pristine = pristineWorktree();
  }, 300_000);

  afterAll(async () => {
    // Kill any surviving spawned Production_Start tree, then cleanup the tree.
    const pid = child?.pid;
    if (pid !== undefined && child?.exitCode === null) {
      killGroup(pid, "SIGKILL");
      const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
      while ((await portAnswers()) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (pristine?.available) {
      pristine.cleanup();
    }
  });

  it(
    "runs the ordered Startup_Sequence, serves requests, and is one-shot (R11.5, R11.6)",
    async () => {
      if (!pristine.available) {
        // git (or tar / npm ci) unavailable — skip with a clear message.
        console.warn(`SKIP dev-start-parity execution half: ${pristine.reason}`);
        return;
      }

      const startScript = resolve(pristine.dir, "scripts", "start.js");
      const output: string[] = [];

      // Pre-flight: nothing may already be bound to PORT, or this test cannot
      // tell a stale server from the one it is about to start.
      expect(
        await portAnswers(PORT),
        `port ${PORT} is already in use — a leaked server would satisfy this test without start.js running`,
      ).toBe(false);

      child = spawn(process.execPath, [startScript], {
        cwd: pristine.dir,
        env: {
          ...process.env,
          MICROSERVICES: "microservice1",
          MICROSERVICE_MICROSERVICE1_ENABLED: "enabled",
          PORT: String(PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
        // New process group so teardown can kill start.js AND its Overseer
        // grandchild. Not unref()'d: stdio piped, exit observable.
        detached: true,
      });
      const startPid = child.pid as number;
      child.stdout?.on("data", (d: Buffer) => output.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => output.push(d.toString()));

      try {
      // Wait for the Overseer boot marker (the last Startup_Sequence step),
      // failing loudly with the captured output if start.js dies first.
      await waitForMarker(child, () => output.join(""), OVERSEER_READY_MARKER);

      const combined = output.join("");

      // Step order: bootstrap build (@microservices/contracts) -> registry
      // generation -> full workspace build -> Overseer boot marker. Assert the
      // observable landmarks appear in that order in the captured stream.
      const idxBootstrap = combined.indexOf("@microservices/contracts");
      const idxRegistered = combined.indexOf("[boot] registered microservices:");
      const idxReady = combined.indexOf(OVERSEER_READY_MARKER);
      expect(idxBootstrap, `bootstrap step not seen:\n${combined}`).toBeGreaterThanOrEqual(0);
      expect(idxReady, `overseer boot marker not seen:\n${combined}`).toBeGreaterThanOrEqual(0);
      expect(idxRegistered).toBeGreaterThan(idxBootstrap);
      expect(idxReady).toBeGreaterThan(idxRegistered);

      // The Overseer answers over the wire from the compiled artifacts.
      // Liveness probe (R13.12): microservice1 is mounted at its Mount_Root "/",
      // so a request there is dispatched to its router. Assert `status !== 404`
      // and nothing else — no body, no content type, no per-method status.
      const res = await fetch(`${BASE_URL}/`);
      await res.text();
      expect(res.status).not.toBe(404);

      // One-shot: Production_Start terminates when its Overseer exits, exiting
      // with the Overseer's status, and never restarts or watches (R11.6).
      // Kill only the Overseer grandchild; start.js must then exit on its own
      // and NOT boot a replacement.
      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolvePromise) => {
          child?.once("exit", (code, signal) =>
            resolvePromise({ code, signal }),
          );
        },
      );

      const overseerPid = await findOverseerPid(startPid);
      expect(overseerPid, "could not locate the Overseer child process").not.toBeNull();
      // SIGKILL the Overseer so start.js's spawnSync returns and it exits.
      process.kill(overseerPid as number, "SIGKILL");

      const exited = await Promise.race([
        exitPromise,
        new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
      ]);
      expect(
        exited,
        `start.js did not exit after the Overseer was killed (it may be watching/restarting):\n${output.join("")}`,
      ).not.toBeNull();

      // It terminated (one-shot). The port must not still be answering — no
      // replacement Overseer was started.
      const stillUp = await portAnswers();
      expect(
        stillUp,
        "an Overseer is still answering after start.js exited — Production_Start restarted (it must be one-shot)",
      ).toBe(false);

      // And it never printed a restart record — Production_Start does not watch.
      expect(output.join("")).not.toMatch(/restarted/i);
      } finally {
        // Guarantee the whole spawned tree is gone before the next example runs,
        // even if an assertion above threw with the Overseer still alive.
        killGroup(startPid, "SIGKILL");
        const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
        while ((await portAnswers(PORT)) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    },
    BOOT_TIMEOUT_MS + 60_000,
  );

  it(
    "exits non-zero with the refusal line and never boots the Overseer on an invalid selector (R11.5)",
    async () => {
      if (!pristine.available) {
        console.warn(`SKIP dev-start-parity failed-step half: ${pristine.reason}`);
        return;
      }

      const startScript = resolve(pristine.dir, "scripts", "start.js");
      const output: string[] = [];

      const failing = spawn(process.execPath, [startScript], {
        cwd: pristine.dir,
        env: {
          ...process.env,
          // An identifier that is not a discovered candidate microservice:
          // the Registry_Generator step fails, and start.js refuses to start.
          MICROSERVICES: "does-not-exist",
          // A distinct port so this example is independent of the happy-path
          // one even if that one's Overseer has not been reaped yet.
          PORT: String(FAIL_PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      failing.stdout?.on("data", (d: Buffer) => output.push(d.toString()));
      failing.stderr?.on("data", (d: Buffer) => output.push(d.toString()));

      const { code } = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolvePromise) => {
        failing.once("exit", (c, s) => resolvePromise({ code: c, signal: s }));
      });

      const combined = output.join("");

      // Exit-status propagation for a failed step: non-zero (R11.5).
      expect(code, `expected non-zero exit; output:\n${combined}`).not.toBe(0);
      expect(code).not.toBeNull();

      // The failure line stays on stderr, byte-for-byte in shape: the `[start]`
      // tag, the failed command, and the trailing refusal clause (R11.5).
      expect(combined).toContain("[start]");
      expect(combined).toContain("refusing to start the Overseer");

      // The underlying selector error names the offending identifier, and it
      // came from the registry-generation step (not the Overseer).
      expect(combined).toMatch(/does-not-exist/);

      // The Overseer never booted: no boot marker, and nothing answers on the
      // port this example used.
      expect(combined).not.toContain(OVERSEER_READY_MARKER);
      expect(await portAnswers(FAIL_PORT)).toBe(false);
    },
    BOOT_TIMEOUT_MS + 60_000,
  );
});

/**
 * Resolve when `marker` appears in `getOutput()` or reject when the child exits
 * first or the boot deadline elapses.
 */
function waitForMarker(
  child: ChildProcess,
  getOutput: () => string,
  marker: string,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    const poll = setInterval(() => {
      if (getOutput().includes(marker)) {
        clearInterval(poll);
        resolvePromise();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(poll);
        rejectPromise(
          new Error(
            `start.js exited (code ${String(child.exitCode)}) before "${marker}"\n` +
              `--- child output ---\n${getOutput()}`,
          ),
        );
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        rejectPromise(
          new Error(
            `timed out waiting for "${marker}"\n--- child output ---\n${getOutput()}`,
          ),
        );
      }
    }, 300);
    poll.unref?.();
  });
}

/**
 * Locate the pid of the Overseer process spawned by Production_Start, so the
 * test can kill just that grandchild and observe start.js terminate.
 *
 * start.js spawns the Overseer as its own child with the RELATIVE entrypoint
 * `packages/overseer/dist/index.js` (cwd is the pristine dir, which is not part
 * of the argv). The reliable discriminator is therefore the Overseer's parent
 * pid: it is a direct child of the spawned start.js process. Matching on
 * (ppid === startPid) ∧ (argv contains the entrypoint) uniquely identifies it
 * and cannot collide with any other node process on the machine.
 */
async function findOverseerPid(startPid: number): Promise<number | null> {
  const needle = "packages/overseer/dist/index.js";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.platform === "win32") {
      // Best-effort on Windows via wmic; match on parent pid + entrypoint.
      const out = spawnSync(
        "wmic",
        [
          "process",
          "where",
          `ParentProcessId=${startPid}`,
          "get",
          "ProcessId,CommandLine",
        ],
        { encoding: "utf8" },
      );
      const line = (out.stdout ?? "")
        .split(/\r?\n/)
        .find((l) => l.includes(needle));
      const m = line?.match(/(\d+)\s*$/);
      if (m) return Number(m[1]);
    } else {
      const out = spawnSync("ps", ["-Ao", "pid=,ppid=,args="], {
        encoding: "utf8",
      });
      const line = (out.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => {
          const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/);
          return m !== null && Number(m[2]) === startPid && m[3].includes(needle);
        });
      const m = line?.match(/^(\d+)\s/);
      if (m) return Number(m[1]);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Task 12.6* — Toggle-abort integration.
//
// Spawns the compiled Overseer against its generated registry with NO
// MICROSERVICE_*_ENABLED environment variables set. The Overseer must abort
// startup before binding the HTTP server: exit non-zero and emit an error to
// stderr naming every missing MICROSERVICE_<X>_ENABLED variable — including
// MICROSERVICE_MICROSERVICE1_ENABLED (R4.3).
//
// The suite first ensures the generated registry contains microservice1 (the
// default Generic "*" registry does) and that the Overseer is compiled, using
// the shared build-tools generate-registry bin and the workspace-local tsc.
// It intentionally does NOT depend on a single-microservice registry: R4.3
// requires the abort message to name EVERY missing toggle, so the default
// registry (which includes microservice1) is sufficient and avoids mutating /
// racing on the shared generated registry with other spawn-based suites.
//
// Validates: Requirement R4.3

import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const generateRegistryBin = resolve(
  repoRoot,
  "packages",
  "build-tools",
  "dist",
  "bin",
  "generate-registry.js",
);
const tscBin = resolve(repoRoot, "node_modules", "typescript", "bin", "tsc");
const overseerEntry = resolve(repoRoot, "packages", "overseer", "dist", "index.js");

const BUILD_TIMEOUT_MS = 120_000;

/** Run a command to completion, returning its status and combined output. */
function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; output: string } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("toggle-abort integration (missing MICROSERVICE_MICROSERVICE1_ENABLED)", () => {
  beforeAll(() => {
    // Ensure the generated registry exists and includes microservice1. The
    // default Generic ("*") registry does; regenerating "*" is idempotent and
    // leaves the working tree in its default state.
    const gen = run(process.execPath, [generateRegistryBin], { MICROSERVICES: "*" });
    expect(gen.status, `generate-registry failed:\n${gen.output}`).toBe(0);

    // Ensure the Overseer is compiled so its dist entrypoint exists.
    const build = run(process.execPath, [
      tscBin,
      "--build",
      "packages/overseer",
      "packages/microservices/microservice1",
      "packages/microservices/microservice2",
      "packages/microservices/microservice3",
    ]);
    expect(build.status, `tsc --build failed:\n${build.output}`).toBe(0);
    expect(existsSync(overseerEntry), "overseer entrypoint missing after build").toBe(true);
  }, BUILD_TIMEOUT_MS);

  it(
    "aborts startup with non-zero exit and names the missing toggle variable (R4.3)",
    async () => {
      // Spawn the compiled Overseer with every MICROSERVICE_*_ENABLED var
      // stripped, so the missing-toggle abort is deterministic regardless of
      // the ambient environment.
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(childEnv)) {
        if (/^MICROSERVICE_.*_ENABLED$/.test(key)) {
          delete childEnv[key];
        }
      }

      const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(
        (resolvePromise, rejectPromise) => {
          const child = spawn(process.execPath, [overseerEntry], {
            cwd: repoRoot,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });

          let err = "";
          child.stderr?.on("data", (d: Buffer) => (err += d.toString()));

          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            rejectPromise(new Error(`Overseer did not exit within timeout; stderr:\n${err}`));
          }, 30_000);

          child.on("error", (e) => {
            clearTimeout(timer);
            rejectPromise(e);
          });
          child.on("exit", (exitCode) => {
            clearTimeout(timer);
            resolvePromise({ code: exitCode, stderr: err });
          });
        },
      );

      // Aborted before accepting requests: non-zero exit code (R4.3).
      expect(code).not.toBe(0);
      // The error output names the missing microservice1 toggle variable (R4.3).
      expect(stderr).toContain("MICROSERVICE_MICROSERVICE1_ENABLED");
    },
    BUILD_TIMEOUT_MS,
  );
});

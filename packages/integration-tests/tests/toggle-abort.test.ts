// Task 12.6* — Toggle-abort integration.
//
// Spawns the compiled Entry_Module against its generated registry with NO
// MICROSERVICE_*_ENABLED environment variables set. Startup must abort before the
// HTTP server binds: exit non-zero and emit an error to stderr naming every
// missing MICROSERVICE_<X>_ENABLED variable — including
// MICROSERVICE_MICROSERVICE1_ENABLED (R4.3).
//
// Since the registry inversion the aborting process is the ENTRY_MODULE, not a
// Framework_Singleton: the Overseer is a library exporting `boot`/`startServer`
// and writes no stderr and calls no `process.exit` of its own, while the
// Entry_Module owns the process effects around the boot failure
// (registry-inversion R2.4, R3.2). So the module spawned here is the
// Entry_Point_Path, read off the ProjectContext (R7.1).
//
// The suite first ensures the generated registry contains microservice1 (the
// default Generic "*" registry does) and that the Entry_Package and its
// prerequisites are compiled, using the shared build-tools generate-registry bin
// and the workspace-local tsc. It intentionally does NOT depend on a
// single-microservice registry: R4.3 requires the abort message to name EVERY
// missing toggle, so the default registry (which includes microservice1) is
// sufficient.
//
// WORKTREE SAFETY. The Generated_Registry is one of the three in-place writes the
// worktree rule permits, and the discipline applies: its bytes are captured before
// the generation, written back with `writeFileSync` afterward whether the
// assertions passed or failed, and the file is REMOVED when it was absent before
// the run. No git command is used for any of it.
//
// Validates: Requirement R4.3

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { generatedRegistryPath } from "@microservices/build-tools/dist/generate-registry.js";

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

/** This repository's unconfigured ProjectContext — Entry_Root_Default `app`. */
const context = projectContext(defaultEffectiveConfig());
/** The module a local run and a container run each execute (R7.1, R7.2). */
const entryPoint = resolve(repoRoot, context.entryPointPath);
/** The Generated_Registry's single derived path (registry-inversion R4.1, R5.8). */
const registryPath = resolve(repoRoot, generatedRegistryPath(context));

const BUILD_TIMEOUT_MS = 120_000;

/** The Generated_Registry's bytes, or `undefined` when the file is absent. */
function captureRegistry(): string | undefined {
  try {
    return readFileSync(registryPath, "utf8");
  } catch {
    return undefined;
  }
}

let capturedRegistry: string | undefined;
let registryWasPresent = false;

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
    // Capture the Generated_Registry's bytes (or its absence) before the first
    // write, so `afterAll` can restore exactly what was there.
    capturedRegistry = captureRegistry();
    registryWasPresent = capturedRegistry !== undefined;

    // Ensure the generated registry exists and includes microservice1. The
    // default Generic ("*") registry does; regenerating "*" is idempotent.
    const gen = run(process.execPath, [generateRegistryBin], { MICROSERVICES: "*" });
    expect(gen.status, `generate-registry failed:\n${gen.output}`).toBe(0);

    // Ensure the Entry_Package and everything its registry imports are compiled,
    // so the Entry_Point_Path exists. The microservices are listed first: the
    // Entry_Package's own `tsconfig.json` references only `contracts` and
    // `overseer` — the microservice prerequisites are synthetic Prerequisite_Edges
    // the Build_Sequence supplies, not declared project references
    // (registry-inversion R8.5).
    const build = run(process.execPath, [
      tscBin,
      "--build",
      "packages/microservices/microservice1",
      "packages/microservices/microservice2",
      "packages/microservices/microservice3",
      "packages/overseer",
      context.entryRoot,
    ]);
    expect(build.status, `tsc --build failed:\n${build.output}`).toBe(0);
    expect(
      existsSync(entryPoint),
      `Entry_Point_Path missing after build: ${context.entryPointPath}`,
    ).toBe(true);
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    // Restore the permitted in-place write: the captured bytes back, or the file
    // removed when it was absent before the run. Never through git.
    if (registryWasPresent && capturedRegistry !== undefined) {
      writeFileSync(registryPath, capturedRegistry, "utf8");
    } else {
      rmSync(registryPath, { force: true });
    }
  });

  it(
    "aborts startup with non-zero exit and names the missing toggle variable (R4.3)",
    async () => {
      // Spawn the compiled Entry_Module with every MICROSERVICE_*_ENABLED var
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
          const child = spawn(process.execPath, [entryPoint], {
            cwd: repoRoot,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });

          let err = "";
          child.stderr?.on("data", (d: Buffer) => (err += d.toString()));

          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            rejectPromise(
              new Error(
                `Entry_Module did not exit within timeout; stderr:\n${err}`,
              ),
            );
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

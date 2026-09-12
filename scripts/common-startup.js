// Performs the two startup steps `npm start` and `npm run dev` share.
//
// Step 1 is the Bootstrap_Build: compile contracts and build-tools only, so the
// compiled registry generator bin exists. Step 2 runs that bin. The two entry
// points diverge after this, on whether the build and the Overseer watch.
//
// Plain uncompiled ESM under scripts/ because it must run on a clean checkout: a
// module that performs the Bootstrap_Build cannot itself require compiling first.
//
// This module is the only place the clean-checkout ordering is recorded. The
// generator runs as a compiled bin a fresh clone does not have, so the bootstrap
// comes first. Generating the registry before the full build is what gives
// `npm start` the same behaviour as a container build — the Overseer compiles
// against a fresh registry rather than a stale one — and it is sound only because
// the root `workspaces` array is in topological order, the generated registry
// statically importing each selected microservice.
//
// Nothing here calls process.exit or writes to a stream: it returns a discriminated
// result plus the steps it ran, and the caller owns the process effects. Paths are
// relative to cwd, the repo root for npm scripts.

import { spawnSync } from "node:child_process";

/**
 * @typedef {object} CommonStartupOptions
 * @property {string} tag  Message prefix owned by the caller: "start" or "dev".
 * @property {string|undefined} [selector]  MICROSERVICES; defaults to the environment.
 * @property {NodeJS.ProcessEnv} [env]  Defaults to `process.env`.
 */

/**
 * @typedef {{ ok: true, selector: string|undefined, steps: string[] }
 *         | { ok: false, step: string, message: string, status: number, steps: string[] }}
 *   CommonStartupResult
 */

/**
 * Runs one command with inherited stdio and reports whether it succeeded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true } | { ok: false, message: string, status: number }}
 */
function runStep(command, args, env) {
  const { error, status } = spawnSync(command, args, {
    stdio: "inherit",
    env,
    // Resolve npm shims on Windows as well as POSIX.
    shell: process.platform === "win32",
  });

  if (error || status !== 0) {
    const reason = error?.message ?? `exit ${status}`;
    return {
      ok: false,
      message: `"${command} ${args.join(" ")}" failed (${reason})`,
      status: typeof status === "number" && status !== 0 ? status : 1,
    };
  }

  return { ok: true };
}

/**
 * Compiles contracts and build-tools, and nothing else.
 *
 * This is the Bootstrap_Build, called by `runCommonStartup` and by
 * `scripts/build.js`. It yields the compiled bins those two packages provide even
 * in a tree where `prepare` never ran or a `dist/` was cleaned, and the compile is
 * incremental, so on a warm tree it is a near no-op.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: true } | { ok: false, message: string, status: number }}
 */
export function runBootstrapBuild(env) {
  return runStep(
    "npm",
    [
      "run",
      "build",
      "--workspace",
      "@microservices/contracts",
      "--workspace",
      "@microservices/build-tools",
    ],
    env,
  );
}

/**
 * Runs the bootstrap build and then generates the microservice registry.
 *
 * Each step must succeed before the next one runs, and the returned `steps` names
 * them in the order they ran, so the two entry points' sequences can be compared
 * directly. Loading the environment is not a step here: `dotenvx run --` wraps
 * both npm scripts before Node starts.
 *
 * @param {CommonStartupOptions} options
 * @returns {CommonStartupResult}
 */
export function runCommonStartup(options) {
  const baseEnv = options.env ?? process.env;
  const selector =
    "selector" in options ? options.selector : baseEnv.MICROSERVICES;

  // The generator reads the selector from the environment, so an explicit
  // `selector` option is reflected there to reach it by that same channel.
  const env =
    selector === undefined ? baseEnv : { ...baseEnv, MICROSERVICES: selector };

  /** @type {string[]} */
  const steps = [];

  const bootstrapStep = "bootstrap-build";
  steps.push(bootstrapStep);
  const bootstrap = runBootstrapBuild(env);
  if (!bootstrap.ok) {
    return {
      ok: false,
      step: bootstrapStep,
      message: bootstrap.message,
      status: bootstrap.status,
      steps,
    };
  }

  // The same generator entry point a container build uses, invoked as a compiled
  // bin so both entry points work without an npm bin-link pass.
  const registryStep = "generate-registry";
  steps.push(registryStep);
  const registry = runStep(
    process.execPath,
    ["packages/build-tools/dist/bin/generate-registry.js"],
    env,
  );
  if (!registry.ok) {
    return {
      ok: false,
      step: registryStep,
      message: registry.message,
      status: registry.status,
      steps,
    };
  }

  return { ok: true, selector, steps };
}

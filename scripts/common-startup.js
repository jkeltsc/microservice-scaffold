// The single implementation of the Common_Startup steps (Requirement R11.1).
//
// Both entry points obtain their startup behavior from this module: Production_Start
// (`scripts/start.js`) and the Dev_Command (`scripts/dev.js`). It performs the two
// steps both paths share before they diverge on whether the TypeScript build and the
// Overseer process watch for changes:
//
//   1. Bootstrap_Build — compile @microservices/contracts and @microservices/build-tools
//      only, so the compiled registry generator bin exists.
//   2. Registry generation — run the compiled bin
//      packages/build-tools/dist/bin/generate-registry.js with the inherited environment.
//
// WHY THIS MODULE IS PLAIN, UNCOMPILED ESM JAVASCRIPT UNDER scripts/ (R11.2).
// This is a constraint, not a preference. Common_Startup *performs* the Bootstrap_Build
// of packages/contracts and packages/build-tools; if it lived inside a package that must
// be compiled before it can run, it would have to compile itself. Living under scripts/ —
// the documented home for repo-level scripts that must run before anything is built —
// keeps it executable on a clean checkout with no dist/ and no build state. A maintainer
// tempted to move it into packages/build-tools/ for tidiness would reintroduce that cycle,
// so the constraint is recorded here rather than left as folklore.
//
// THIS MODULE IS THE SOLE OWNER OF THE CLEAN-CHECKOUT ORDERING RATIONALE (R11.2).
//
// STEP ORDER — verified against a genuinely clean checkout (no node_modules, no
// dist/, no *.tsbuildinfo, no generated registry), because two orderings that
// look fine on a warm tree both fail there:
//
//   1. The generator runs as its COMPILED bin, which does not exist on a fresh
//      clone if `prepare` did not run or bailed out. So the first step is a
//      bootstrap build of exactly the two packages that bin needs — contracts
//      and build-tools — mirroring the Dockerfile's
//      `npx tsc --build packages/contracts packages/build-tools`.
//   2. Generating BEFORE the full build is what gives `npm start` parity with a
//      Container build (the Overseer compiles against the fresh registry, never
//      a stale one), and it is only sound because the root `workspaces` array is
//      in topological order. The generated registry statically imports
//      `@microservices/microservice<N>`, so the microservices must be built before the
//      Overseer; with `overseer` listed ahead of them this step failed with
//      `TS2307: Cannot find module '@microservices/microservice1'`.
//
// Paths are relative to cwd, which is the repo root for npm scripts.
//
// This module never calls process.exit and never writes to a stream: it returns a
// discriminated result and the ordered list of steps it performed, and the caller owns
// every process effect. Same split as the Overseer's pure `boot()` versus its
// `index.ts` shell.

import { spawnSync } from "node:child_process";

/**
 * @typedef {object} CommonStartupOptions
 * @property {string} tag            Message prefix owned by the caller: "start" or "dev".
 * @property {string|undefined} [selector]
 *   The MICROSERVICES value. Defaults to `process.env.MICROSERVICES`; passed through
 *   to the Registry_Generator unmodified (R2.2).
 * @property {NodeJS.ProcessEnv} [env]  Defaults to `process.env`.
 */

/**
 * @typedef {{ ok: true, selector: string|undefined, steps: string[] }
 *         | { ok: false, step: string, message: string, status: number, steps: string[] }}
 *   CommonStartupResult
 */

/**
 * Run a command inheriting stdio.
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
 * Perform the Common_Startup steps in order:
 *   1. Bootstrap_Build — compile @microservices/contracts and @microservices/build-tools only.
 *   2. Registry generation — run the compiled bin
 *      packages/build-tools/dist/bin/generate-registry.js with the inherited env.
 *
 * Never calls process.exit and never writes to a stream: it returns a
 * discriminated result and the ordered list of steps it performed, and the
 * caller owns the process effects. Same split as the Overseer's pure `boot()`
 * versus its `index.ts` shell.
 *
 * Environment loading is NOT a step of this function: it happens one level up,
 * because `dotenvx run --` wraps both npm scripts before Node starts (R1.2, R8.3).
 * `steps` records the step names in the order they ran so the two entry points'
 * sequences can be compared directly (R11.4).
 *
 * @param {CommonStartupOptions} options
 * @returns {CommonStartupResult}
 */
export function runCommonStartup(options) {
  const baseEnv = options.env ?? process.env;
  const selector =
    "selector" in options ? options.selector : baseEnv.MICROSERVICES;

  // The Registry_Generator reads the selector from `process.env.MICROSERVICES`
  // (generate-registry.ts). The inherited environment already carries it, so it
  // is passed through unmodified (R2.2); an explicit `selector` option — used by
  // tests and callers that resolve it themselves — is reflected into the child's
  // environment here so it reaches the generator by the same channel.
  const env =
    selector === undefined ? baseEnv : { ...baseEnv, MICROSERVICES: selector };

  /** @type {string[]} */
  const steps = [];

  // Bootstrap: compile the two packages the generator bin is made of, so the next
  // step exists even in a tree where `prepare` never ran or a `dist/` was cleaned.
  // Incremental, so this is a near no-op on a warm tree, and the full build the
  // Production_Start caller runs afterwards rebuilds them anyway.
  const bootstrapStep = "bootstrap-build";
  steps.push(bootstrapStep);
  const bootstrap = runStep(
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
  if (!bootstrap.ok) {
    return {
      ok: false,
      step: bootstrapStep,
      message: bootstrap.message,
      status: bootstrap.status,
      steps,
    };
  }

  // The same generator entry point the Dockerfile build stage uses, invoked as the
  // compiled bin so both entry points work without an npm bin-link pass. The selector
  // comes from the inherited environment and is passed through unmodified (R2.2).
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

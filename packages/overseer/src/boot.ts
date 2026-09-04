// @scaffold/overseer — boot pipeline composition.
//
// Implements the design's "Overseer Startup Sequence". `boot` runs the ordered
// validation-and-composition steps (module paths → path collisions → toggles →
// build app) against an INJECTED microservice registry, environment, and config,
// and returns a discriminated result. It performs NO process.exit and NO stderr
// writes — that side-effecting shell lives in `src/index.ts`, which also owns
// the static import of the generated microservice registry and the final
// `startServer` call. Keeping `boot` pure of process effects makes the whole
// pipeline unit-testable with a synthetic registry and environment.
//
// Note the deliberate absence of a static top-level import of
// `./generated/microservice-registry.js`: that file is gitignored and emitted
// by build-tools, so it may be absent at typecheck time. `index.ts` imports it
// and passes the `microserviceRegistry` array in through `boot`'s options, so
// `boot.ts` depends only on types from `@scaffold/contracts`.
//
// Ordered composition (design "Overseer Startup Sequence"):
//   1. load generated registry            — done by the caller (index.ts)
//   2. validate module paths (R8.5)       — inline startsWith("/") check
//   3. reject duplicate paths (R9.4)      — inline exact-equality check
//   4. validate toggles (R4.3, R7.1, R7.3)— validateToggles (batched errors)
//   5. build router (R3.1)                — buildApp
//   6. bind server (R3.1)                 — startServer, done by index.ts
//
// Every failure surfaces one specific, identifier-naming message per offender
// (design "Error Handling" message shapes); the caller writes them to stderr
// and exits non-zero BEFORE `listen` is ever called.

import type { Express } from "express";
import type { AppConfig } from "./config.js";
import type { MicroserviceRegistry } from "@scaffold/contracts";

import { loadConfig } from "./config.js";
import { validateToggles, toggleVarName } from "./toggles.js";
import { buildApp } from "./router.js";

/** Options for {@link boot}; every dependency is injectable for testing. */
export interface BootOptions {
  /**
   * The loaded microservice registry. In production this is the statically
   * imported `microserviceRegistry` from `./generated/microservice-registry.js`;
   * in tests it is a synthetic array.
   */
  readonly microserviceRegistry: MicroserviceRegistry;
  /** The environment to read toggles and config from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The resolved runtime config. Defaults to `loadConfig(env)`; injectable so
   * tests can pin the port.
   */
  readonly config?: AppConfig;
}

/** One line of the boot-time registered-microservice table. */
export interface RegisteredMicroserviceInfo {
  readonly identifier: string;
  readonly path: string;
  readonly enabled: boolean;
}

/**
 * The outcome of the boot pipeline.
 *
 * On success, the caller has a fully composed Express app plus the resolved
 * config and can proceed to bind the HTTP server. On failure, `messages`
 * carries one human-readable, offender-naming line per problem (design "Error
 * Handling"); the caller writes them to stderr and exits non-zero without ever
 * binding a socket.
 */
export type BootResult =
  | {
      readonly ok: true;
      readonly app: Express;
      readonly config: AppConfig;
      /** Identifiers whose evaluated toggle is enabled, for the startup log. */
      readonly enabledIdentifiers: readonly string[];
      /** Every registered microservice with path and toggle state, for the boot log. */
      readonly registeredMicroservices: readonly RegisteredMicroserviceInfo[];
    }
  | { readonly ok: false; readonly messages: readonly string[] };

/**
 * Run the Overseer boot pipeline (steps 2–5 of the startup sequence) against an
 * injected registry, environment, and config.
 *
 * Steps abort at the FIRST failing stage: module path defects, then path
 * collisions, then toggle problems. Each stage that fails returns every one of its own
 * offenders (batched), so the operator sees all problems within that stage in a
 * single attempt. This mirrors the design's per-step "abort with an error
 * identifying every X" phrasing while preserving the ordering guarantee that no
 * later stage runs on a registry an earlier stage already rejected.
 *
 * This function never throws for a validation failure and never touches the
 * process (no `exit`, no stderr). Success yields a ready-to-listen app.
 *
 * @param options - The injected registry and optional env/config overrides.
 */
export function boot(options: BootOptions): BootResult {
  const { microserviceRegistry } = options;
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);

  // Step 2 — validate each module's declared path (R8.5). A single
  // `startsWith("/")` check: empty strings return false, so the non-empty
  // guard is already covered. Export shape is proven by `tsc` when the
  // generated registry compiles; only the path value is left at runtime.
  const moduleMessages: string[] = [];
  for (const entry of microserviceRegistry) {
    if (!entry.module.path.startsWith("/")) {
      moduleMessages.push(
        `[module] ${entry.sourcePackage}: path "${entry.module.path}" does not start with "/"`,
      );
    }
  }
  if (moduleMessages.length > 0) {
    return { ok: false, messages: moduleMessages };
  }

  // Step 3 — reject duplicate paths (R9.4). Parent/child overlaps (e.g.
  // /bla + /bla/blu) are a valid Express topology: buildApp sorts mounts by
  // path length descending, so the longer mount always wins for its subtree.
  // Only exact duplicates are ambiguous.
  const pathCounts = new Map<string, string[]>();
  for (const entry of microserviceRegistry) {
    const arr = pathCounts.get(entry.module.path);
    if (arr) arr.push(entry.identifier);
    else pathCounts.set(entry.module.path, [entry.identifier]);
  }
  const collisionMessages: string[] = [];
  for (const [path, ids] of pathCounts) {
    if (ids.length >= 2) {
      collisionMessages.push(
        `[collision:path] path "${path}" declared by ${ids.join(" and ")}`,
      );
    }
  }
  if (collisionMessages.length > 0) {
    return { ok: false, messages: collisionMessages };
  }

  // Step 4 — validate toggles (R4.3, R4.5, R7.1, R7.3), batching every offender.
  const toggleResult = validateToggles(microserviceRegistry, env);
  if (!toggleResult.ok) {
    return { ok: false, messages: formatToggleErrors(toggleResult) };
  }

  // Step 5 — build the Express mount table from the enabled entries.
  const app = buildApp(microserviceRegistry, toggleResult.toggleMap);

  const enabledIdentifiers = microserviceRegistry
    .map((entry) => entry.identifier)
    .filter((identifier) => toggleResult.toggleMap.enabled.get(identifier) === true);

  // Build the full registered-microservice table for the boot log.
  const registeredMicroservices: RegisteredMicroserviceInfo[] = microserviceRegistry.map(
    (entry) => ({
      identifier: entry.identifier,
      path: entry.module.path,
      enabled: toggleResult.toggleMap.enabled.get(entry.identifier) === true,
    }),
  );

  return { ok: true, app, config, enabledIdentifiers, registeredMicroservices };
}

// ---------------------------------------------------------------------------
// Error message formatting (design "Error Handling" message shapes).
//
// Each formatter renders one offender per line. The boot pipeline collects the
// lines; the caller (index.ts) writes them to stderr and exits non-zero.
// ---------------------------------------------------------------------------

/**
 * Render the batched toggle errors (missing, invalid, unknown-enabled) into one
 * line per offender, in the design's fixed-prefix message shapes.
 */
function formatToggleErrors(result: {
  readonly missing: readonly string[];
  readonly invalid: readonly { identifier: string; rawValue: string }[];
  readonly unknownEnabled: readonly string[];
}): string[] {
  const lines: string[] = [];

  for (const identifier of result.missing) {
    lines.push(
      `[toggle:missing] ${toggleVarName(identifier)} must be set for microservice ${identifier}`,
    );
  }

  for (const { identifier, rawValue } of result.invalid) {
    lines.push(
      `[toggle:invalid] ${toggleVarName(identifier)} has invalid value "${rawValue}"; ` +
        `accepted: enabled|disabled|true|false|1|0`,
    );
  }

  for (const identifier of result.unknownEnabled) {
    lines.push(
      `[toggle:unknown] ${toggleVarName(identifier)} is enabled for identifier ${identifier} ` +
        `which is not in the current Container`,
    );
  }

  return lines;
}

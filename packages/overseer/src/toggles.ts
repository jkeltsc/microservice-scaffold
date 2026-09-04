// @microservices/overseer — runtime toggle parsing and validation.
//
// Implements Property 7 (Toggle-token parsing) and Property 8 (Boot toggle
// validation) from the design's Correctness Properties section, satisfying
// Requirements R4.1, R4.3, R4.5, R7.1, R7.2, R7.3.
//
// Two exported functions:
//
//  1. `parseToggle(raw)` — maps a raw environment-variable value to an enabled
//     boolean using the accepted case-insensitive token set
//     (`enabled|disabled|true|false|1|0`, trimmed). Returns a discriminated
//     result carrying the original, unmodified value on rejection so the boot
//     pipeline can quote it verbatim in the R4.5 error message (Property 7).
//
//  2. `validateToggles(registry, env)` — evaluates the per-identifier toggle
//     environment variables against the registered identifier set and collects,
//     in a single pass, the four categories from Property 8:
//       - Missing:        registered identifier with no env var present
//       - Invalid:        registered identifier whose env var fails parseToggle
//       - PhantomEnabled: unregistered identifier whose env var parses to enabled
//       - PhantomDisabled: unregistered identifier whose env var parses to
//                          disabled — IGNORED entirely (R7.2).
//     Boot succeeds iff Missing, Invalid, and PhantomEnabled are all empty; on
//     success a `ToggleMap` is produced for the registered identifiers. Nothing
//     is thrown: the boot pipeline formats the discriminated failure into the
//     [toggle:missing]/[toggle:invalid]/[toggle:unknown] messages and aborts.

import type { MicroserviceRegistry, ToggleMap } from "@microservices/contracts";

/** Accepted tokens (case-insensitive, trimmed) that map to enabled. */
const ENABLED_TOKENS = new Set(["enabled", "true", "1"]);

/** Accepted tokens (case-insensitive, trimmed) that map to disabled. */
const DISABLED_TOKENS = new Set(["disabled", "false", "0"]);

/**
 * Matches a `MICROSERVICE_<X>_ENABLED` env-var name and captures the `<X>`
 * portion. The captured group is lowercased to derive the candidate identifier.
 * `.+` is greedy but anchored by the fixed `_ENABLED` suffix, so a name like
 * `MICROSERVICE_MICROSERVICE1_ENABLED` yields the group `MICROSERVICE1`.
 */
const TOGGLE_VAR_PATTERN = /^MICROSERVICE_(.+)_ENABLED$/;

/**
 * The result of parsing a single raw toggle value (Property 7).
 *
 * On acceptance, `enabled` reflects the mapped boolean. On rejection,
 * `rawValue` carries the original, unmodified token so diagnostics can quote it
 * exactly as the operator supplied it (R4.5).
 */
export type ParseToggleResult =
  | { readonly ok: true; readonly enabled: boolean }
  | { readonly ok: false; readonly rawValue: string };

/**
 * Parse a raw `MICROSERVICE_<X>_ENABLED` value into an enabled boolean.
 *
 * Matching is case-insensitive after trimming leading/trailing whitespace:
 * - `enabled` / `true` / `1`   → `{ ok: true, enabled: true }`
 * - `disabled` / `false` / `0` → `{ ok: true, enabled: false }`
 * - anything else              → `{ ok: false, rawValue: raw }` (original token)
 *
 * @param raw - The raw environment-variable value.
 */
export function parseToggle(raw: string): ParseToggleResult {
  const norm = raw.trim().toLowerCase();
  if (ENABLED_TOKENS.has(norm)) {
    return { ok: true, enabled: true };
  }
  if (DISABLED_TOKENS.has(norm)) {
    return { ok: true, enabled: false };
  }
  return { ok: false, rawValue: raw };
}

/** The env-var name for a microservice identifier: `MICROSERVICE_<X>_ENABLED`. */
export function toggleVarName(identifier: string): string {
  return `MICROSERVICE_${identifier.toUpperCase()}_ENABLED`;
}

/** A registered identifier whose toggle env var is present but not parseable. */
export interface InvalidToggle {
  /** The registered microservice identifier. */
  readonly identifier: string;
  /** The rejected raw value, unmodified, for the R4.5 diagnostic. */
  readonly rawValue: string;
}

/**
 * Aggregated outcome of validating every toggle against the registry (Property
 * 8). A discriminated union so the boot pipeline can pattern-match on `ok`.
 *
 * On success, `toggleMap.enabled` maps each registered identifier to its
 * evaluated boolean. On failure, all three offending categories are reported
 * together so an operator sees every problem in one startup attempt:
 * - `missing`        — registered identifiers with no env var set (R4.3).
 * - `invalid`        — registered identifiers whose value failed parsing (R4.5).
 * - `unknownEnabled` — unregistered identifiers enabled by a stray var (R7.1).
 */
export type ValidateTogglesResult =
  | { readonly ok: true; readonly toggleMap: ToggleMap }
  | {
      readonly ok: false;
      readonly missing: readonly string[];
      readonly invalid: readonly InvalidToggle[];
      readonly unknownEnabled: readonly string[];
    };

/**
 * Validate the `MICROSERVICE_*_ENABLED` environment against a registry.
 *
 * For every registered identifier, reads its `MICROSERVICE_<X>_ENABLED` variable
 * and classifies it as missing, invalid, or a valid enabled/disabled value. It
 * then scans the environment for any `MICROSERVICE_*_ENABLED` variable whose
 * derived identifier is not registered: a phantom that parses to enabled is an
 * unknown-enabled error (R7.1), while a phantom that parses to disabled — or one
 * whose value fails to parse — is ignored (R7.2).
 *
 * The function never throws; it returns a {@link ValidateTogglesResult}. Boot
 * succeeds iff there are no missing, no invalid, and no unknown-enabled toggles.
 *
 * @param microserviceRegistry - The loaded microservice registry.
 * @param env - The environment to read from (injectable; defaults to
 *   `process.env`).
 */
export function validateToggles(
  microserviceRegistry: MicroserviceRegistry,
  env: NodeJS.ProcessEnv = process.env,
): ValidateTogglesResult {
  // Microservice identifiers from the registry, in order, deduplicated for a stable scan.
  // (Duplicate identifiers are a separate collision concern handled elsewhere.)
  const microservices = new Set<string>();
  const microservicesOrdered: string[] = [];
  for (const entry of microserviceRegistry) {
    const id = entry.identifier;
    if (!microservices.has(id)) {
      microservices.add(id);
      microservicesOrdered.push(id);
    }
  }

  const missing: string[] = [];
  const invalid: InvalidToggle[] = [];
  const enabledMap = new Map<string, boolean>();

  // 1. Evaluate each registered identifier's toggle.
  for (const identifier of microservicesOrdered) {
    const raw = env[toggleVarName(identifier)];
    if (raw === undefined) {
      missing.push(identifier);
      continue;
    }
    const parsed = parseToggle(raw);
    if (!parsed.ok) {
      invalid.push({ identifier, rawValue: parsed.rawValue });
      continue;
    }
    enabledMap.set(identifier, parsed.enabled);
  }

  // 2. Scan for phantom toggles: env vars whose derived identifier is not
  //    registered. Enabled phantoms are errors (R7.1); disabled phantoms and
  //    unparseable phantoms are ignored (R7.2).
  const unknownEnabled: string[] = [];
  const seenPhantom = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const match = TOGGLE_VAR_PATTERN.exec(name);
    if (match === null) continue;
    const identifier = match[1]!.toLowerCase();
    if (microservices.has(identifier)) continue;
    const parsed = parseToggle(value);
    if (parsed.ok && parsed.enabled && !seenPhantom.has(identifier)) {
      seenPhantom.add(identifier);
      unknownEnabled.push(identifier);
    }
  }

  if (missing.length > 0 || invalid.length > 0 || unknownEnabled.length > 0) {
    return { ok: false, missing, invalid, unknownEnabled };
  }

  return { ok: true, toggleMap: { enabled: enabledMap } };
}

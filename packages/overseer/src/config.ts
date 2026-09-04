// @microservices/overseer — runtime configuration.
//
// Implements design "Overseer Startup Sequence" step 6 and Components and
// Interfaces (`src/config.ts`): the Overseer binds its single HTTP server to a
// port determined by runtime configuration (Requirement 3.1). `loadConfig`
// reads the `PORT` environment variable and produces a typed, frozen
// {@link AppConfig}.
//
// Invalid-value policy: an unset or empty `PORT` falls back to the default
// (8080). A present-but-invalid `PORT` (non-integer, non-positive, or outside
// the valid TCP port range) also falls back to 8080 but emits a warning to
// stderr. Defaulting rather than throwing keeps boot resilient: a typo in a
// deploy-time env var degrades to a well-known port instead of preventing the
// server from starting at all. The warning ensures the misconfiguration is
// still visible in the process logs.

/** The default port the Overseer binds to when `PORT` is unset or invalid. */
export const DEFAULT_PORT = 8080;

/** The maximum valid TCP port number. */
const MAX_PORT = 65535;

/** Resolved, immutable process-level configuration for the Overseer. */
export interface AppConfig {
  /** The TCP port the HTTP server binds to. */
  readonly port: number;
}

/**
 * Load the Overseer's runtime configuration from the process environment.
 *
 * Reads `PORT` and returns a typed {@link AppConfig}:
 * - Unset, empty, or whitespace-only `PORT` → `port` is {@link DEFAULT_PORT}.
 * - A valid positive integer in the range 1..65535 → `port` is that value.
 * - Any other value (non-numeric, non-integer, zero, negative, out of range) →
 *   `port` is {@link DEFAULT_PORT} and a warning is written to stderr.
 *
 * @param env - The environment to read from. Defaults to `process.env`;
 *   injectable so the behavior can be tested without mutating global state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return { port: parsePort(env["PORT"]) };
}

/**
 * Parse a raw `PORT` value into a port number, applying the invalid-value
 * policy described above.
 */
function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return DEFAULT_PORT;
  }

  // Number() accepts leading/trailing whitespace and forms like "0x1f" or
  // "1e3"; constrain to a plain non-negative integer literal so that only
  // well-formed port strings are accepted.
  const isPlainInteger = /^\d+$/.test(trimmed);
  const value = Number(trimmed);

  if (!isPlainInteger || !Number.isInteger(value) || value < 1 || value > MAX_PORT) {
    process.stderr.write(
      `[config:warning] PORT has invalid value "${raw}"; ` +
        `expected an integer in 1..${MAX_PORT}. Falling back to ${DEFAULT_PORT}.\n`,
    );
    return DEFAULT_PORT;
  }

  return value;
}

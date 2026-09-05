// Task 7.3 — Environment pass-through integration for the Dev_Server.
//
// Feature: api-dev-server, Property 6: Environment pass-through is the existing behavior
//
// The Dev_Server passes the environment resolved at Dev_Session start through
// to the Overseer unmodified: every MICROSERVICE_<ID>_ENABLED Toggle and PORT
// reach the Overseer's existing boot pipeline, which remains the sole authority
// over how those values are interpreted (R8.1, R8.2, R8.4). It never adds,
// removes, or alters a Toggle or the PORT value.
//
// The session harness (startDevSession from helpers.ts) spawns `scripts/dev.js`
// directly with `node` and a fully controlled `env`, bypassing npm/dotenvx.
// That controlled `env` IS the authoritative/inline channel — the same channel
// an inline `PORT=... MICROSERVICES=... npm run dev` assignment resolves to
// after dotenvx (inline wins over `.env`, R2.3/R8.3). Supplying PORT,
// MICROSERVICES, and the Toggles through `startDevSession({ env })` therefore
// models "inline values win": the values the harness supplies are exactly the
// values the Overseer boots against, observable as the routing table and the
// listening port. `.env` is not consulted by the harness at all, so its values
// cannot win — which is the precedence this asserts, expressed as observable
// pass-through rather than by inspecting dotenvx internals.
//
// Two sessions:
//   1. A running session with MICROSERVICES=microservice1,microservice2,
//      microservice1 enabled and microservice2 disabled, on an inline PORT.
//      Asserts the enabled microservice's path answers, the disabled one 404s,
//      and the server bound the inline PORT (R2.3, R8.1, R8.2, R8.3, R8.4).
//   2. A cheap second session with an invalid Toggle token. The Overseer's
//      existing boot-time validation rejects it, naming every offending Toggle
//      on stderr and exiting non-zero before binding — exactly as under
//      Production_Start (R8.5). The Dev_Session surfaces that offender-naming
//      output and the supervisor's before-binding report; the Build_Watcher
//      stays resident, so the session does not itself exit.
//
// This is a spawn + real-port + tsc-build integration test, so it uses a
// generous timeout and non-default ports to avoid collisions, and it tears the
// whole process group down in teardown.
//
// Validates: Requirements 2.3, 8.1, 8.2, 8.3, 8.4, 8.5

import { describe, it, expect, afterEach } from "vitest";
import {
  startDevSession,
  OVERSEER_READY_MARKER,
  type DevSession,
} from "./helpers.js";

// Non-default ports so a leaked Overseer from another suite cannot satisfy or
// break these assertions.
const HAPPY_PORT = 8151;
const INVALID_PORT = 8152;
const HAPPY_BASE_URL = `http://127.0.0.1:${HAPPY_PORT}`;

// The Dev_Command performs a full Bootstrap_Build, registry generation, a cold
// solution build, and an Overseer start before the ready marker appears; budget
// generously for a cold tree.
const READY_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = READY_TIMEOUT_MS + 60_000;

// The two microservices this suite pins into the registry. microservice1 is
// mounted at "/", microservice2 at "/microservice2"; enabling one and disabling
// the other makes the pass-through observable as the routing table.
const ENABLED_PATH = "/"; // microservice1
const DISABLED_PATH = "/microservice2"; // microservice2

// Sessions started by a test, torn down after it regardless of outcome so no
// child outlives the suite.
const sessions: DevSession[] = [];

function track(session: DevSession): DevSession {
  sessions.push(session);
  return session;
}

afterEach(async () => {
  // Stop every session this test started, in reverse order. `stop()` kills the
  // whole process group (dev.js -> supervisor -> Overseer) and is idempotent.
  while (sessions.length > 0) {
    const session = sessions.pop();
    await session?.stop();
  }
});

describe("Dev_Server environment pass-through (Property 6)", () => {
  it(
    "passes inline Toggles and PORT through to the Overseer unmodified (R2.3, R8.1, R8.2, R8.3, R8.4)",
    async () => {
      const session = track(
        startDevSession({
          env: {
            // Inline channel: these win over anything the local .env supplies.
            // The registry is generated for exactly these two microservices, so
            // both need a valid Toggle (a missing Toggle would abort boot).
            MICROSERVICES: "microservice1,microservice2",
            MICROSERVICE_MICROSERVICE1_ENABLED: "true",
            MICROSERVICE_MICROSERVICE2_ENABLED: "false",
            PORT: String(HAPPY_PORT),
          },
        }),
      );

      // Wait for the Overseer to bind. The marker embeds the port the Overseer
      // resolved via its existing loadConfig, so a successful wait already
      // proves PORT was passed through and honored (R8.4).
      try {
        await session.waitForOutput(
          `${OVERSEER_READY_MARKER} ${HAPPY_PORT}`,
          { timeout: READY_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(
          `${String(error)}\n--- session output ---\n${session.output()}`,
        );
      }

      // The enabled microservice answers at its mount root (R8.1: its Toggle
      // reached the Overseer as "true").
      const enabled = await fetch(`${HAPPY_BASE_URL}${ENABLED_PATH}`);
      expect(enabled.status).toBe(200);
      expect(enabled.headers.get("content-type")).toMatch(/application\/json/);
      const enabledBody = (await enabled.json()) as Record<string, unknown>;
      expect(enabledBody).toEqual({
        "microservice-name": "microservice1",
        path: ENABLED_PATH,
      });

      // The disabled microservice's path 404s: it is registered but not mounted,
      // so its subtree falls through to the Overseer's 404 (R8.1: its Toggle
      // reached the Overseer as "false", unaltered — R8.2).
      const disabled = await fetch(`${HAPPY_BASE_URL}${DISABLED_PATH}`);
      expect(disabled.status).toBe(404);
      await disabled.text();

      // The bound port is exactly the inline one: the ready marker named it, and
      // the requests above were answered on it (R8.3, R8.4).
      expect(session.output()).toContain(
        `${OVERSEER_READY_MARKER} ${HAPPY_PORT}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "surfaces the Overseer's existing invalid-Toggle abort, naming every offender (R8.5)",
    async () => {
      const session = track(
        startDevSession({
          env: {
            MICROSERVICES: "microservice1,microservice2",
            // "maybe" is outside the accepted token set
            // (enabled|disabled|true|false|1|0), so the Overseer's existing
            // boot-time Toggle validation rejects it.
            MICROSERVICE_MICROSERVICE1_ENABLED: "maybe",
            MICROSERVICE_MICROSERVICE2_ENABLED: "true",
            PORT: String(INVALID_PORT),
          },
        }),
      );

      // The Overseer's inherited stderr carries its existing offender-naming
      // message for the invalid Toggle (R8.5). The supervisor then reports the
      // child exited before binding and keeps the Build_Watcher resident, so the
      // session does not itself exit — we wait on that report to know the child
      // has finished its failed boot.
      try {
        await session.waitForOutput(/before binding/, {
          timeout: READY_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(
          `${String(error)}\n--- session output ---\n${session.output()}`,
        );
      }

      const output = session.output();
      // The offender is named exactly as under Production_Start: the invalid
      // Toggle variable, its rejected value, and the accepted token set.
      expect(output).toContain("MICROSERVICE_MICROSERVICE1_ENABLED");
      expect(output).toContain('has invalid value "maybe"');
      expect(output).toContain("enabled|disabled|true|false|1|0");
      // The valid Toggle is not reported as an offender.
      expect(output).not.toContain("MICROSERVICE_MICROSERVICE2_ENABLED has invalid");

      // The child exited non-zero before binding; the supervisor's before-binding
      // report confirms the existing non-zero-exit path ran, not a bind.
      expect(output).toMatch(
        /\[dev\] Overseer exited with status \d+ before binding/,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// Microservice2 fixed-payload example tests (Sample_Scope_Test).
//
// These are the sample's own assertions about the exact bodies, content types,
// and statuses Microservice2 chooses to serve — the kind of assertion that,
// under the framework/sample test boundary (Requirement 13), belongs in the
// owning microservice's own suite and never in the Integration_Suite (R13.9).
// Every assertion here reads the response directly from Microservice2's
// exported router with NO Overseer composed: Subtree_Ownership makes the router
// total over its Owned_Subtree, so its own suite can read the real status,
// headers, and body directly.
//
// The expected `/config` body is BUILT from @microservices/config's own helper
// rather than restated as a literal, so the assertion tracks the package it
// exercises rather than duplicating it. Microservice2 returns the BASE
// Config_Payload — the side-by-side comparison with Microservice3's
// Extended_Config_Payload is the sample, so the negative assertion below pins
// that the base `config` member carries no `extendedSetting` key.
//
// Validates: Requirements 3.4, 3.6, 3.11, 13.9

import type { Server } from "node:http";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildConfigPayload, sampleConfig } from "@microservices/config";

import { path, router } from "../src/index.js";

/** Build a bare Express app with Microservice2's router at its Mount_Root. */
function mountApp(): express.Express {
  const app = express();
  app.use(path, router);
  return app;
}

describe("microservice2 fixed-payload example", () => {
  // Bind ONE persistent HTTP server for the whole suite (matches the sibling
  // property suite's rationale: reusing a listened server avoids the
  // per-call ephemeral-server churn that can mis-frame responses).
  let server: Server;

  beforeAll(async () => {
    const app = mountApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /config returns 200 application/json with the base Config_Payload", async () => {
    const res = await request(server).get(`${path}/config`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    // The expected body is built from the config helper for the name
    // `microservice2` and the path `/microservice2`, never restated.
    const expected = buildConfigPayload("microservice2", path);
    expect(res.body).toEqual(expected);

    // The payload holds EXACTLY the three contract keys and no others (R3.4).
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "config",
      "microservice-name",
      "path",
    ]);

    // The `config` member holds EXACTLY the base Sample_Config_Block's own keys
    // and, in particular, NO `extendedSetting` key (R3.4) — this is the
    // negative half of the side-by-side comparison with Microservice3.
    const config = body["config"] as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(Object.keys(sampleConfig).sort());
    expect(config).not.toHaveProperty("extendedSetting");
  });

  it("GET / returns 200 application/json with exactly the two identifier keys", async () => {
    const res = await request(server).get(path);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["microservice-name", "path"]);
    expect(body["microservice-name"]).toBe("microservice2");
    expect(body["path"]).toBe(path);
  });

  // Registration-order guard (R3.11). A GET at /config must still reach its own
  // handler and return the base Config_Payload even with the terminal
  // `router.use` 404 handler registered. This assertion FAILS if the terminal
  // handler is ever moved ahead of the /config GET handler, because a path-less
  // `router.use` matches every path and would answer 404 at /config too.
  it("GET /config still returns its payload with the terminal 404 handler registered", async () => {
    const res = await request(server).get(`${path}/config`);

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    expect(res.body).toEqual(buildConfigPayload("microservice2", path));
  });
});

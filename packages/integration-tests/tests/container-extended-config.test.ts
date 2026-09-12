// Task 12.7 — Container end-to-end for the Extended_Config_Payload (R5.7).
//
// This is the end-to-end confirmation that Microservice3, reached THROUGH the
// Overseer, serves the Extended_Config_Payload built from the
// Extended_Config_Package it consumes transitively. It composes one in-process
// Overseer for the Specific_Container Selector `microservice3` — the design's
// stated option ("one Overseer composition (or one image run where the suite
// already builds images)"), and the same in-process composition the sibling
// suites (specific-container-404, mount-dispatch) use — and asserts the single
// observable that criterion names: a GET at `/microservice3/config` answered
// with 200, `application/json`, and a body equal to the payload.
//
// The expected body is BUILT from @microservices/extended-config's own helper
// (imported by package name) rather than restated as a literal, so the
// assertion tracks the package the Container actually ships and consumes.
//
// Validates: Requirements 5.7

import type { Server } from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { buildExtendedConfigPayload } from "@microservices/extended-config";

import { buildApp, makeRegistry, makeToggleMap } from "./helpers.js";

describe("Specific_Container (Selector microservice3) serves the Extended_Config_Payload end-to-end", () => {
  // Bind ONE persistent listened server and reuse it across every request,
  // matching the sibling suites: calling `request(app)` on a non-listening app
  // spins up a fresh ephemeral server per call, and reusing repeated
  // short-lived servers on a hot-reused port can mis-frame HTTP responses.
  let server: Server;

  beforeAll(async () => {
    server = buildApp(
      makeRegistry(["microservice3"]),
      makeToggleMap({ microservice3: true }),
    ).listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /microservice3/config -> 200 application/json with the Extended_Config_Payload (R5.7)", async () => {
    const res = await request(server).get("/microservice3/config");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    // Built from the extended-config helper for the name `microservice3` and
    // the path `/microservice3`, never restated as a literal.
    const expected = buildExtendedConfigPayload("microservice3", "/microservice3");
    expect(res.body).toEqual(expected);
  });
});

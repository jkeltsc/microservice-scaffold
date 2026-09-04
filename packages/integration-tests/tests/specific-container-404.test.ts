// Task 12.3* — Specific_Container 404 behavior for absent + disabled microservices.
//
// Boots the Overseer in-process with a registry containing ONLY microservice1
// and microservice2, with microservice2 DISABLED. Confirms that:
//   - an absent microservice's subtree 404s (microservice3 is not in the registry),
//   - a disabled microservice's mount path 404s (microservice2 is not mounted),
//   - an enabled microservice still serves 200.
// Absent and disabled paths share the single app-level 404 fallback.
//
// Validates: Requirements R3.3, R4.2, R6.2

import type { Server } from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { buildApp, makeRegistry, makeToggleMap, modules } from "./helpers.js";

describe("Specific_Container 404 behavior (microservice1 + microservice2, microservice2 disabled)", () => {
  // Bind ONE persistent HTTP server and reuse it across every request, avoiding
  // the reused-port HTTP parse race caused by repeated short-lived ephemeral
  // servers when calling `request(app)` on a non-listening app.
  let server: Server;

  beforeAll(async () => {
    const microserviceRegistry = makeRegistry(["microservice1", "microservice2"]);
    const toggleMap = makeToggleMap({
      microservice1: true,
      microservice2: false,
    });
    server = buildApp(microserviceRegistry, toggleMap).listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("GET /microservice3/anything -> 404 (absent from the Container) (R3.3, R6.2)", async () => {
    const res = await request(server).get("/microservice3/anything");
    expect(res.status).toBe(404);
  });

  it("GET /microservice2 -> 404 (present but disabled, not mounted) (R4.2)", async () => {
    const res = await request(server).get(modules.microservice2.path);
    expect(res.status).toBe(404);
  });

  it("GET / -> 200 (microservice1 enabled) (R3.2)", async () => {
    const res = await request(server).get(modules.microservice1.path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      "microservice-name": "microservice1",
      path: modules.microservice1.path,
    });
  });
});

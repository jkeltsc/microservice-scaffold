// Task 12.2* — End-to-end request contract for all three reference microservices.
//
// Boots the Overseer in-process (via buildApp) with a Generic_Container-
// equivalent registry (all three real modules) and all three toggles enabled,
// then exercises each microservice's on-the-wire contract through supertest.
//
// Validates: Requirements R2.1, R2.2, R2.3, R2.4, R2.5, R2.6, R3.1, R3.2

import type { Server } from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { buildApp, makeRegistry, makeToggleMap, modules } from "./helpers.js";

describe("end-to-end microservice endpoint contract (Generic_Container)", () => {
  // Bind ONE persistent HTTP server and reuse it across every request. Calling
  // `request(app)` on a non-listening app spins up a fresh ephemeral server per
  // call; reusing a single listened server avoids the reused-port HTTP parse
  // race seen under repeated short-lived servers.
  let server: Server;

  beforeAll(async () => {
    const microserviceRegistry = makeRegistry(["microservice1", "microservice2", "microservice3"]);
    const toggleMap = makeToggleMap({
      microservice1: true,
      microservice2: true,
      microservice3: true,
    });
    server = buildApp(microserviceRegistry, toggleMap).listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  for (const id of ["microservice1", "microservice2", "microservice3"] as const) {
    const mod = modules[id];

    describe(`${id} at ${mod.path}`, () => {
      it("GET <path> -> 200 application/json with exactly {microservice-name, path} (R2.1-R2.3, R3.2)", async () => {
        const res = await request(server).get(mod.path);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        // Body is exactly the two required keys, no more. The expected name is
        // the module's key in the helper's id -> module map, i.e. its directory
        // name — the authoritative identifier the registry carries.
        expect(res.body).toEqual({ "microservice-name": id, path: mod.path });
        expect(Object.keys(res.body).sort()).toEqual(["microservice-name", "path"]);
      });

      it("POST <path> -> 405 with Allow: GET (R2.4)", async () => {
        const res = await request(server).post(mod.path);

        expect(res.status).toBe(405);
        expect(res.headers["allow"]).toBe("GET");
      });
    });
  }

  // The shared Config_Payload block, byte-equivalent to the pre-relocation
  // inline literal. Hardcoded here (matching this suite's style of asserting
  // literal expected bodies) rather than imported, so the test pins the exact
  // on-the-wire contract independently of the shared helper. This mirrors
  // buildConfigPayload(name, path) = { "microservice-name": name, path, config }.
  const sharedConfig = {
    sampleSetting: "example-value",
    description: "demonstration sub-endpoint",
  } as const;

  it("microservice2 GET <path>/config -> 200 application/json with the exact Config_Payload (R2.5, R2.6, 12.3, 12.5)", async () => {
    const res = await request(server).get(`${modules.microservice2.path}/config`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    // Deep-equal the known Config_Payload for microservice2:
    // buildConfigPayload("microservice2", "/microservice2").
    expect(res.body).toEqual({
      "microservice-name": "microservice2",
      path: modules.microservice2.path,
      config: sharedConfig,
    });
  });

  it("microservice3 GET <path>/config -> 200 application/json with the exact Config_Payload (13.3, 13.4)", async () => {
    const res = await request(server).get(`${modules.microservice3.path}/config`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    // Deep-equal the known Config_Payload for microservice3:
    // buildConfigPayload("microservice3", "/microservice3").
    expect(res.body).toEqual({
      "microservice-name": "microservice3",
      path: modules.microservice3.path,
      config: sharedConfig,
    });
  });
});

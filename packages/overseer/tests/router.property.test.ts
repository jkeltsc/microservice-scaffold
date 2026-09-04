// Feature: microservice-scaffold, Property 9: Routing decision.
//
// For any set M of enabled MicroserviceModule values whose paths pass the
// collision check, the app built by mounting each m at m.path (plus the
// app-level 404 fallback), and any request r with path p = extractPath(r.url),
// EXACTLY ONE of two branches holds:
//   1. exactly one enabled module m with p === m.path OR p startsWith m.path+"/"
//      -> dispatched into m.router (GET at m.path -> 200 with the microservice body).
//   2. otherwise -> 404 from the app-level fallback.
//
// A disabled module is absent from the mount table, so requests to its path take
// branch 2 (404) — this is what makes R3.3 (unknown) and R4.2 (disabled) share
// one code path.
//
// Test design: modules are generated with DISTINCT identifiers and DISTINCT,
// NON-COLLIDING paths of the form `/svc<N>`, so no two subtrees overlap.
// Each module is independently enabled/disabled via the toggle map. numRuns is
// kept modest because every run boots an Express app and issues several requests
// through supertest.
//
// Validates: Requirements R3.2, R3.3, R4.2

import type { Server } from "node:http";

import request from "supertest";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type {
  MicroserviceRegistry,
  RegistryEntry,
  ToggleMap,
} from "@scaffold/contracts";
import { buildExpressRouter } from "@scaffold/contracts/testing";

import { buildApp } from "../src/router.js";

/** One generated microservice: distinct identifier + distinct `/svcN` path + toggle. */
interface GeneratedService {
  readonly identifier: string;
  readonly path: string;
  readonly enabled: boolean;
}

/**
 * A set of services with guaranteed-distinct, non-colliding paths and
 * identifiers. We index each service by a unique integer N and derive both its
 * identifier (`svcN`) and its path (`/svcN`); `/svcN` and `/svcM` never collide
 * for N != M (neither is a segment-prefix of the other and none equals `/`).
 * Each service is independently enabled.
 */
const arbServices: fc.Arbitrary<GeneratedService[]> = fc
  .uniqueArray(fc.integer({ min: 0, max: 40 }), {
    minLength: 0,
    maxLength: 5,
  })
  .chain((indices) =>
    fc
      .array(fc.boolean(), {
        minLength: indices.length,
        maxLength: indices.length,
      })
      .map((enabledFlags) =>
        indices.map((n, i) => ({
          identifier: `svc${n}`,
          path: `/svc${n}`,
          enabled: enabledFlags[i]!,
        })),
      ),
  );

function toRegistry(services: readonly GeneratedService[]): MicroserviceRegistry {
  return services.map(
    (s): RegistryEntry => ({
      identifier: s.identifier,
      sourcePackage: `@scaffold/${s.identifier}`,
      module: {
        path: s.path,
        router: buildExpressRouter(s.identifier, s.path),
      },
    }),
  );
}

function toToggleMap(services: readonly GeneratedService[]): ToggleMap {
  const enabled = new Map<string, boolean>();
  for (const s of services) enabled.set(s.identifier, s.enabled);
  return { enabled };
}

describe("Property 9: routing decision (exactly one of two branches)", () => {
  it("dispatches enabled paths to their router, 404s disabled/unknown paths", async () => {
    await fc.assert(
      fc.asyncProperty(arbServices, async (services) => {
        // Each iteration builds a distinct app from the generated services, so a
        // single hoisted server cannot be reused. Instead, explicitly listen a
        // server ONCE per iteration, reuse `request(server)` for every request
        // in this iteration, and AWAIT its close before returning — so no
        // ephemeral server is ever left for supertest to tear down implicitly
        // under the tight loop (which triggers the reused-port HTTP parse race).
        const app = buildApp(toRegistry(services), toToggleMap(services));
        const server: Server = app.listen(0);
        await new Promise<void>((resolve) => server.on("listening", resolve));

        try {
          // Branch 1 (enabled) and Branch 2 (disabled) — one request per service.
          for (const s of services) {
            const res = await request(server).get(s.path);
            if (s.enabled) {
              // Dispatched into the microservice router: 200 + the microservice body.
              expect(res.status).toBe(200);
              expect(res.headers["content-type"]).toMatch(/application\/json/);
              expect(res.body).toEqual({
                "microservice-name": s.identifier,
                path: s.path,
              });
            } else {
              // Disabled -> not mounted -> app-level 404 fallback (R4.2).
              expect(res.status).toBe(404);
            }
          }

          // Branch 2 (unknown) — a path under no module at all (R3.3).
          const absent = await request(server).get("/definitely-absent-path-xyz");
          expect(absent.status).toBe(404);

          // /_registry is no longer a reserved endpoint; it now 404s like any
          // other unmapped path.
          const registryReq = await request(server).get("/_registry");
          expect(registryReq.status).toBe(404);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
          );
        }
      }),
      { numRuns: 60 },
    );
  });

  it("forwards to a sub-path under an enabled module's subtree (R3.2 subtree ownership)", async () => {
    // A single enabled module whose router also answers GET /config; requesting
    // the sub-path must be dispatched INTO the router (not 404'd by the app).
    const registry: MicroserviceRegistry = [
      {
        identifier: "svc7",
        sourcePackage: "@scaffold/svc7",
        module: {
          path: "/svc7",
          router: buildExpressRouter("svc7", "/svc7", /* withConfigRoute */ true),
        },
      },
    ];
    const toggleMap: ToggleMap = { enabled: new Map([["svc7", true]]) };
    const app = buildApp(registry, toggleMap);

    const server: Server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
    try {
      const sub = await request(server).get("/svc7/config");
      expect(sub.status).toBe(200);
      expect(sub.headers["content-type"]).toMatch(/application\/json/);
      expect(typeof sub.body).toBe("object");
      expect(sub.body).not.toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

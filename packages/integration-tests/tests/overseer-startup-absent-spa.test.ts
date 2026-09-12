// Integration test: Overseer startup does not depend on the Spa_Root (R8.4).
//
// Requirement 8 criterion 4 states that WHILE the Spa_Root is absent, the
// Overseer SHALL complete startup without exiting, SHALL answer 200 at the
// Mount_Root of every enabled microservice OTHER than Microservice1, and SHALL
// answer the 503 of criterion 1 at Microservice1's Mount_Root "/". This suite
// asserts exactly that composition-level outcome — which mounted router
// answered and the status it carried — and nothing else (R11.11).
//
// --- Why the composition is assembled by hand ----------------------------
// `buildApp(registry, toggleMap)` mounts each enabled entry's `module.router`
// at its `module.path`. The REAL microservice1 module (`@microservices/
// microservice1`) resolves its Spa_Root ONCE at import time (R7.3, resolution
// happens in src/index.ts), pointing at the real bundle — which may be present
// on the machine running the suite. To observe the absent-Spa_Root behaviour
// deterministically we must compose microservice1 with an ABSENT Spa_Root
// EXPLICITLY: we build the microservice1 registry row's `module` as
// `{ path: "/", router: createSpaRouter(<emptyTempDir>) }`, where the temp dir
// is an `mkdtemp` directory holding no `index.html` — the definition of an
// absent Spa_Root (R8.1). `createSpaRouter` is imported from microservice1's
// compiled leaf module (`@microservices/microservice1/dist/static-router.js`);
// that module only builds a router and does NOT boot a server on import, so the
// import is side-effect-free. The other two rows carry the REAL microservice2
// and microservice3 modules from `modules`.
//
// We therefore assemble the registry rows by hand (mirroring `makeRegistry`'s
// `{ identifier, module, sourcePackage }` shape) rather than calling
// `makeRegistry`, because we are substituting microservice1's module.
//
// --- Why the Mount_Root is the probe point -------------------------------
// A request dispatched to a mounted router at its Mount_Root never yields 404:
// the router itself answers (200 for microservice2/microservice3's identifier
// response, 503 for microservice1's absent-bundle response). A path UNDER a
// Mount_Root may legitimately carry 404 from the OWNING microservice (that is
// the microservice answering under Subtree_Ownership, not the Overseer's
// catch-all), so only at the Mount_Root does the status distinguish dispatch
// from the catch-all. Every probe below is at a Mount_Root for that reason.
//
// Validates: Requirements 8.4, 11.11

import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type {
  MicroserviceModule,
  MicroserviceRegistry,
  RegistryEntry,
} from "@microservices/contracts";
// microservice1's package `main` (dist/index.js) resolves the Spa_Root at
// import but does NOT auto-boot a server; this leaf module only exports the
// router factory, so importing it is safe and side-effect-free.
import { createSpaRouter } from "@microservices/microservice1/dist/static-router.js";

import { buildApp, modules } from "./helpers.js";

describe("Overseer startup with an absent Spa_Root (R8.4)", () => {
  // An mkdtemp directory holding NO index.html — an absent Spa_Root (R8.1).
  // Created in the OS temp dir, never under the repository worktree, so the
  // worktree-safety guard is respected (only mkdtemp, no write under repoRoot).
  let emptySpaRoot: string;
  let server: Server;

  beforeAll(async () => {
    emptySpaRoot = mkdtempSync(join(tmpdir(), "absent-spa-root-"));

    // The microservice1 registry row, composed with an ABSENT Spa_Root. Its
    // module.path is "/" (microservice1's real Mount_Root) and its router is
    // built over the empty temp dir, so a GET at "/" answers 503 (R8.1).
    const microservice1AbsentSpa: RegistryEntry = {
      identifier: "microservice1",
      module: {
        path: "/",
        router: createSpaRouter(emptySpaRoot),
      },
      sourcePackage: "@microservices/microservice1",
    };

    // microservice2 and microservice3 carry their REAL modules from `modules`.
    const microservice2Row: RegistryEntry = {
      identifier: "microservice2",
      module: modules.microservice2 as MicroserviceModule,
      sourcePackage: "@microservices/microservice2",
    };
    const microservice3Row: RegistryEntry = {
      identifier: "microservice3",
      module: modules.microservice3 as MicroserviceModule,
      sourcePackage: "@microservices/microservice3",
    };

    const registry: MicroserviceRegistry = [
      microservice1AbsentSpa,
      microservice2Row,
      microservice3Row,
    ];

    // All three toggles enabled: the Overseer must complete startup and mount
    // every one of them (R8.4).
    const toggleMap = {
      enabled: new Map([
        ["microservice1", true],
        ["microservice2", true],
        ["microservice3", true],
      ]),
    };

    // buildApp returning a live app and listen() succeeding IS the startup
    // signal: the app is built and bound with the Spa_Root absent, so startup
    // does not depend on it. Bind ONE persistent listened server reused across
    // every probe below.
    server = buildApp(registry, toggleMap).listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
  });

  afterAll(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
    // Remove the temp Spa_Root. Nothing was written under the worktree.
    if (emptySpaRoot !== undefined) {
      rmSync(emptySpaRoot, { recursive: true, force: true });
    }
  });

  // R8.4: every enabled microservice OTHER than Microservice1 answers 200 at
  // its Mount_Root — its identifier response, dispatched by the Overseer. That
  // the Overseer answers these at all is the evidence startup completed with
  // the Spa_Root absent.
  it.each([
    { id: "microservice2", path: "/microservice2" },
    { id: "microservice3", path: "/microservice3" },
  ])(
    "$id answers 200 at its Mount_Root $path (startup does not depend on the Spa_Root)",
    async ({ path }) => {
      const res = await request(server).get(path);
      expect(res.status).toBe(200);
    },
  );

  // R8.4 + R8.1: Microservice1's Mount_Root "/" answers 503 — the absent-bundle
  // response — rather than 404 or a startup failure. The Overseer dispatched to
  // microservice1's router (never the catch-all: 503, not 404), and that router
  // answered 503 because its injected Spa_Root holds no index.html.
  it("Microservice1's Mount_Root / answers 503 (the absent-Spa_Root response)", async () => {
    const res = await request(server).get("/");
    expect(res.status).toBe(503);
  });
});

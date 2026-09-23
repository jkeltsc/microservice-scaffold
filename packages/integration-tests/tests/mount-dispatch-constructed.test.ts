// Constructed-module equivalent of `mount-dispatch.test.ts` (task 7.5, R13.4).
//
// WHY THIS SUITE EXISTS
// ---------------------------------------------------------------------------
// `mount-dispatch.test.ts` is a Payload_Coupled_Test: it drives the Overseer's
// `buildApp` composition over the REAL reference microservice modules
// (`@microservices/microservice1`, `2`, `3`) and asserts the framework-scope
// mount-dispatch distinction — a request at a mounted microservice's Mount_Root
// is dispatched to that microservice's own router (any status other than 404),
// while a path belonging to no mounted microservice falls through to the
// Overseer's catch-all (404).
//
// R13.4 requires that claim to survive the payload's departure: where a
// payload-coupled claim concerns mounting or routing over real microservice
// modules, the Fixture_Equivalent asserts the SAME claim over microservice
// modules the test itself CONSTRUCTS — so no fixture has to ship an executable
// HTTP handler. This suite is that equivalent for mount-dispatch.
//
// WHAT IS CONSTRUCTED, AND WHAT IS NOT READ
// ---------------------------------------------------------------------------
// Every microservice module below is built IN THIS FILE: a real
// `express.Router()` carrying the routes the dispatch claim needs, paired with a
// Microservice_Path string constant, assembled into MicroserviceRegistry entries
// and handed to the Overseer's `buildApp` (reached through the same in-process
// composition `mount-dispatch.test.ts` uses). Nothing is read from disk, nothing
// is imported from the payload, and no `modules` reference microservice is used.
// The identifiers and paths here are this suite's own inventions — they name no
// committed payload package, so this equivalent asserts no fact about the
// Payload_Tree (R13.7).
//
// Validates: Requirements 13.1, 13.2, 13.4, 13.7

import type { Server } from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import type {
  MicroserviceModule,
  MicroserviceRegistry,
  RegistryEntry,
} from "@microservices/contracts";
import { buildApp, makeToggleMap } from "./helpers.js";

// ---------------------------------------------------------------------------
// Constructed microservice modules — built here, read from nowhere.
// ---------------------------------------------------------------------------

/**
 * Construct a microservice module: a real `express.Router()` answering GET at
 * its Mount_Root with 200, and answering every other method at the Mount_Root
 * with 405 (so a dispatched non-GET is still `status !== 404`), paired with the
 * given Microservice_Path constant. This is exactly the module contract the
 * framework declares about a microservice — a path plus a router — with no
 * behaviour promoted into a framework law.
 */
function constructModule(path: string): MicroserviceModule {
  const router = express.Router();
  router.get("/", (_req, res) => {
    res.status(200).type("application/json").json({ path });
  });
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });
  return { path, router };
}

/** Assemble a MicroserviceRegistry from constructed `{ identifier, path }` mounts. */
function constructedRegistry(
  mounts: ReadonlyArray<{ readonly identifier: string; readonly path: string }>,
): MicroserviceRegistry {
  return mounts.map(
    ({ identifier, path }): RegistryEntry => ({
      identifier,
      module: constructModule(path),
      // `sourcePackage` is used only in diagnostics; compose one under a scope
      // that is this suite's own invention, naming no payload package.
      sourcePackage: `@constructed/${identifier}`,
    }),
  );
}

// The constructed mounts. `svcRoot` owns the whole origin ("/"); `svcA` and
// `svcB` own distinct non-"/" subtrees. All names and paths are invented here.
const MOUNT_ROOT = { identifier: "svcroot", path: "/" } as const;
const MOUNT_A = { identifier: "svca", path: "/a" } as const;
const MOUNT_B = { identifier: "svcb", path: "/b" } as const;

describe("framework-scope mount dispatch over CONSTRUCTED modules (R13.4)", () => {
  // Composition A: svcA at "/a" and svcB at "/b", both enabled; no "/" mount.
  // Used to prove each Mount_Root is dispatched and an unmounted path 404s.
  let twoServer: Server;

  // Composition B: svcRoot at "/", enabled; the others disabled. Used to prove
  // a microservice owning "/" makes the catch-all unreachable at its Mount_Root.
  let rootServer: Server;

  const listen = (server: Server): Promise<void> =>
    new Promise<void>((resolve) => server.on("listening", resolve));
  const close = (server: Server): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );

  beforeAll(async () => {
    twoServer = buildApp(
      constructedRegistry([MOUNT_A, MOUNT_B]),
      makeToggleMap({ [MOUNT_A.identifier]: true, [MOUNT_B.identifier]: true }),
    ).listen(0);

    rootServer = buildApp(
      constructedRegistry([MOUNT_ROOT, MOUNT_A, MOUNT_B]),
      makeToggleMap({
        [MOUNT_ROOT.identifier]: true,
        [MOUNT_A.identifier]: false,
        [MOUNT_B.identifier]: false,
      }),
    ).listen(0);

    await Promise.all([listen(twoServer), listen(rootServer)]);
  });

  afterAll(async () => {
    await Promise.all([close(twoServer), close(rootServer)]);
  });

  // R13.1/R13.4: each enabled constructed microservice probed at its own
  // Mount_Root is dispatched to its own router — a status other than 404.
  it.each([MOUNT_A, MOUNT_B])(
    "$identifier at its Mount_Root $path is dispatched to its own router (status !== 404)",
    async ({ path }) => {
      const res = await request(twoServer).get(path);
      expect(res.status).not.toBe(404);
    },
  );

  // The Overseer routes a request into the RIGHT subtree: a request at "/a" is
  // answered by svcA's router (its 200 body names "/a"), not svcB's.
  it("routes a Mount_Root request into the owning microservice's router", async () => {
    const resA = await request(twoServer).get(MOUNT_A.path);
    expect(resA.status).toBe(200);
    expect(resA.body).toEqual({ path: MOUNT_A.path });

    const resB = await request(twoServer).get(MOUNT_B.path);
    expect(resB.status).toBe(200);
    expect(resB.body).toEqual({ path: MOUNT_B.path });
  });

  // R13.2: a path matching no mounted microservice — and a path under it — is
  // answered by the Overseer's catch-all 404. In composition A no microservice
  // is mounted at "/", so both "/" and an arbitrary unmounted path 404.
  it("answers 404 from the Overseer's catch-all where no constructed microservice matches", async () => {
    expect((await request(twoServer).get("/")).status).toBe(404);
    expect((await request(twoServer).get("/unmounted")).status).toBe(404);
    expect((await request(twoServer).get("/unmounted/deeper")).status).toBe(404);
  });

  // R13.4: with a constructed microservice mounted at "/", it owns the whole
  // origin under Subtree_Ownership, so the catch-all 404 is unreachable at the
  // Mount_Root — `status !== 404` at "/".
  it("makes the catch-all unreachable at the Mount_Root when a constructed microservice owns /", async () => {
    const res = await request(rootServer).get("/");
    expect(res.status).not.toBe(404);
  });
});

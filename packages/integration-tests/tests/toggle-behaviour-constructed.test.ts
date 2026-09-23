// Constructed-module equivalent of the payload-coupled toggle-behaviour claim
// (task 7.5, R13.4).
//
// WHY THIS SUITE EXISTS
// ---------------------------------------------------------------------------
// The payload-coupled toggle claim — asserted over the REAL reference
// microservices by suites such as `dev-environment-passthrough.test.ts` (an
// enabled microservice's path answers, a disabled one 404s) and encoded at the
// composition level in `mount-dispatch.test.ts` (a toggled-off microservice's
// subtree falls through to the catch-all) — is that a microservice's
// MICROSERVICE_<ID>_ENABLED toggle decides whether its subtree is served: an
// enabled microservice's router is mounted and dispatched, a disabled one's is
// not mounted and its whole subtree answers 404.
//
// R13.4 requires that claim to survive the payload's departure by asserting it
// over microservice modules the test itself CONSTRUCTS. This suite is that
// equivalent for toggle behaviour.
//
// WHAT IS CONSTRUCTED, AND WHAT IS NOT READ
// ---------------------------------------------------------------------------
// The modules below are built here: a real `express.Router()` plus a
// Microservice_Path constant, assembled into MicroserviceRegistry entries and
// composed through the Overseer's in-process `buildApp` with a ToggleMap built
// by `makeToggleMap`. The toggle classification the framework applies is
// exercised end-to-end via the routing table `buildApp` produces from that map.
// Nothing is read from disk; no payload `modules` microservice is used; the
// identifiers and paths are this suite's own inventions, naming no committed
// payload package (R13.7).
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
 * Construct a microservice module owning the subtree at `path`: its router
 * answers GET at the Mount_Root with 200 and every other Mount_Root method with
 * 405. A path plus a router — the whole framework-scope module contract.
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
      sourcePackage: `@constructed/${identifier}`,
    }),
  );
}

// Two constructed mounts on distinct non-"/" subtrees, so each subtree is
// answered only by its own microservice or the Overseer's catch-all. Names and
// paths are invented here.
const MOUNT_ON = { identifier: "toggledon", path: "/on" } as const;
const MOUNT_OFF = { identifier: "toggledoff", path: "/off" } as const;

describe("toggle behaviour over CONSTRUCTED modules (R13.4)", () => {
  // Both microservices are SELECTED (present in the registry) but only one is
  // toggled ENABLED. The disabled one is therefore not mounted, so its whole
  // subtree falls through to the Overseer's catch-all 404.
  let server: Server;

  const listen = (s: Server): Promise<void> =>
    new Promise<void>((resolve) => s.on("listening", resolve));
  const close = (s: Server): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      s.close((err) => (err ? reject(err) : resolve())),
    );

  beforeAll(async () => {
    server = buildApp(
      constructedRegistry([MOUNT_ON, MOUNT_OFF]),
      makeToggleMap({
        [MOUNT_ON.identifier]: true,
        [MOUNT_OFF.identifier]: false,
      }),
    ).listen(0);
    await listen(server);
  });

  afterAll(async () => {
    await close(server);
  });

  // The ENABLED microservice's Mount_Root is served — dispatched to its own
  // router, evidenced by a status other than 404 (here its 200).
  it("serves the enabled microservice's subtree (status !== 404 at its Mount_Root)", async () => {
    const res = await request(server).get(MOUNT_ON.path);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: MOUNT_ON.path });
  });

  // The DISABLED microservice is not mounted, so its Mount_Root — and any path
  // under it — is answered only by the Overseer's catch-all 404.
  it("does not serve the disabled microservice's subtree (its Mount_Root and paths under it 404)", async () => {
    expect((await request(server).get(MOUNT_OFF.path)).status).toBe(404);
    expect((await request(server).get(`${MOUNT_OFF.path}/anything`)).status).toBe(404);
  });

  // Re-toggling: with the disabled microservice ENABLED and the other DISABLED,
  // the served/unserved subtrees swap — the toggle alone decides which subtree
  // is served, over the same constructed modules.
  it("swaps which subtree is served when the toggles are inverted", async () => {
    const swapped = buildApp(
      constructedRegistry([MOUNT_ON, MOUNT_OFF]),
      makeToggleMap({
        [MOUNT_ON.identifier]: false,
        [MOUNT_OFF.identifier]: true,
      }),
    ).listen(0);
    await listen(swapped);
    try {
      expect((await request(swapped).get(MOUNT_ON.path)).status).toBe(404);
      const res = await request(swapped).get(MOUNT_OFF.path);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
    } finally {
      await close(swapped);
    }
  });
});

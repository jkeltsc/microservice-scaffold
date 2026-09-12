// Framework-scope mount-dispatch suite (Requirement 13).
//
// This file replaces the former `endpoint-contract.test.ts`. That name
// described a contract that no longer exists at framework scope: it looped over
// all three reference microservices asserting an identical `{microservice-name,
// path}` body and an identical `405 Allow: GET`, and asserted two `/config`
// bodies. Each of those promoted ONE sample's choice — a body shape, a method
// policy, a sub-endpoint payload — into a framework-wide law the framework never
// declared (R13.5, R13.6). All of them are gone.
//
// What the framework actually declares about a microservice is exactly two
// things: the Microservice_Path it exports and the Express router it exports.
// The only framework-scope observable is therefore whether a request at a
// mounted microservice's Mount_Root is DISPATCHED to that microservice's router
// (any status other than 404) or falls through to the Overseer's catch-all
// (404). This suite asserts that dispatched-versus-catch-all distinction and
// nothing else (R13.4, R13.8).
//
// The three mounts below are an EXPLICIT enumeration of `{id, path}` pairs
// written out here — derived from neither filesystem discovery nor the
// generated Microservice_Registry (R13.8). The Overseer is exercised through
// the REAL reference microservice modules and the existing in-process
// `buildApp` composition, with no change to the Overseer package (R13.17).
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.8, 13.17

import type { Server } from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { buildApp, makeRegistry, makeToggleMap } from "./helpers.js";

// Explicit enumeration of the reference microservices' `{id, path}` mounts.
// Written out by hand on purpose: the framework/sample boundary (R13.8) forbids
// deriving a per-microservice assertion set from discovery or from the
// generated registry, so this table names each mount it covers.
const MOUNTS = [
  { id: "microservice1", path: "/" },
  { id: "microservice2", path: "/microservice2" },
  { id: "microservice3", path: "/microservice3" },
] as const;

// Microservices whose Microservice_Path belongs to NOBODY in composition B
// below. In composition B microservice3 is selected but has its runtime toggle
// disabled, so it is not mounted and "/microservice3" is answered only by the
// Overseer's catch-all. microservice1's own path is "/", which can never be a
// catch-all path, so R13.2 is exercised through a microservice that has a
// non-"/" path.
const PEERS = [
  { id: "microservice3", path: "/microservice3" },
] as const;

describe("framework-scope mount dispatch (Overseer routing)", () => {
  // Bind ONE persistent HTTP server per composition and reuse it across every
  // request. Calling `request(app)` on a non-listening app spins up a fresh
  // ephemeral server per call; reusing a single listened server avoids the
  // reused-port HTTP parse race seen under repeated short-lived servers.

  // Composition A: all three microservices selected and toggled on. Used to
  // prove each Mount_Root is dispatched.
  let allEnabledServer: Server;

  // Composition B: microservice1 absent from the selection and microservice3
  // toggled off, so only microservice2 is mounted (at "/microservice2") and NO
  // enabled microservice is mounted at "/". Used to prove the Overseer's
  // catch-all answers a path belonging to nobody.
  let noRootMountServer: Server;

  // Composition C: microservice1 enabled and mounted at "/". Used to prove the
  // catch-all is unreachable when a microservice owns the whole origin.
  let rootMountServer: Server;

  const listen = async (server: Server): Promise<void> => {
    await new Promise<void>((resolve) => server.on("listening", resolve));
  };
  const close = (server: Server): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );

  beforeAll(async () => {
    allEnabledServer = buildApp(
      makeRegistry(["microservice1", "microservice2", "microservice3"]),
      makeToggleMap({ microservice1: true, microservice2: true, microservice3: true }),
    ).listen(0);

    // No "/" mount: microservice1 is absent from the selection entirely, and
    // microservice3 is selected but toggled OFF. Only microservice2 is mounted
    // (at "/microservice2"), so "/microservice3" belongs to nobody and can only
    // be answered by the Overseer's catch-all.
    noRootMountServer = buildApp(
      makeRegistry(["microservice2", "microservice3"]),
      makeToggleMap({ microservice2: true, microservice3: false }),
    ).listen(0);

    // microservice1 mounted at "/". The other two are selected but toggled off,
    // so "/" is the only mounted path and microservice1 owns the whole origin.
    rootMountServer = buildApp(
      makeRegistry(["microservice1", "microservice2", "microservice3"]),
      makeToggleMap({ microservice1: true, microservice2: false, microservice3: false }),
    ).listen(0);

    await Promise.all([
      listen(allEnabledServer),
      listen(noRootMountServer),
      listen(rootMountServer),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      close(allEnabledServer),
      close(noRootMountServer),
      close(rootMountServer),
    ]);
  });

  // R13.1: an enabled microservice probed at its Mount_Root ITSELF — never a
  // path under it — is dispatched to its own router, evidenced by a status
  // other than 404.
  //
  // The probe is the Mount_Root and never a path under it on purpose: under
  // Subtree_Ownership a path UNDER a Mount_Root may legitimately carry 404 from
  // the OWNING microservice (that is the microservice answering, not the
  // Overseer's catch-all). Only at the Mount_Root itself does `status !== 404`
  // reliably distinguish "the router answered" from "the catch-all answered" —
  // a dispatched request at the Mount_Root cannot yield 404. Probing under the
  // Mount_Root would read a legitimate microservice 404 as a missing mount.
  it.each(MOUNTS)(
    "$id at its Mount_Root $path is dispatched to its own router (status !== 404)",
    async ({ path }) => {
      const res = await request(allEnabledServer).get(path);
      expect(res.status).not.toBe(404);
    },
  );

  // R13.2: in a composition where no enabled microservice is mounted at "/", an
  // unselected or toggled-off microservice's path — and a path under it —
  // belongs to nobody, so the Overseer's catch-all is the only thing that can
  // answer, and it answers 404. Here microservice1 (the "/" mount) is absent.
  it.each(PEERS)(
    "$id at $path and a path under it each receive the Overseer's catch-all 404",
    async ({ path }) => {
      expect((await request(noRootMountServer).get(path)).status).toBe(404);
      expect((await request(noRootMountServer).get(`${path}/anything`)).status).toBe(404);
    },
  );

  // R13.3: where microservice1 (Microservice_Path "/") is enabled, it owns the
  // whole origin under Subtree_Ownership and the Overseer's catch-all 404 is
  // UNREACHABLE. That unreachability is the intended consequence of
  // Subtree_Ownership rather than a defect: microservice1 owns "/" and
  // everything below it, so no request can reach a handler registered after its
  // mount, and the catch-all's only remaining job is a Container that holds no
  // root-mounted microservice (the R13.2 case above).
  //
  // The probe point is the Mount_Root "/" itself, and deliberately not a path
  // under it, for the reason recorded on the R13.1 assertion above: under
  // Subtree_Ownership a path UNDER the Mount_Root may legitimately carry 404
  // from the owning microservice, so only at the Mount_Root does `status !==
  // 404` distinguish dispatch from the catch-all. That makes this assertion
  // robust across microservice1's behaviour: it holds against microservice1's
  // CURRENT identifier response (200 at "/") and equally against its FUTURE
  // Demo_Page behaviour (200 with the page present, 503 with the Spa_Root
  // absent) — because `status !== 404` at the Mount_Root holds in every one of
  // those cases, which is exactly the framework-scope fact this suite asserts.
  it("with microservice1 mounted at / the catch-all 404 is unreachable at the Mount_Root — the intended consequence of Subtree_Ownership, not a defect", async () => {
    const res = await request(rootMountServer).get("/");
    expect(res.status).not.toBe(404);
  });
});

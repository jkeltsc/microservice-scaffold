// Framework-scope peer-shadowing suite (Requirement 7 criterion 13; Requirement
// 11 criterion 11).
//
// The one mount-ordering fact this suite asserts: WHILE an enabled peer
// microservice is mounted, the Overseer dispatches a request at that peer's
// Mount_Root — and at a path under it — to THAT peer's router, so Microservice1's
// static serving (mounted at "/") shadows none of it (R7.13).
//
// This holds with the Overseer EXACTLY as it stands, no Overseer change: its
// `buildApp` sorts the enabled entries by Microservice_Path length descending and
// registers one `app.use(path, router)` per entry in that order, so the peers'
// longer paths (`/microservice2`, `/microservice3`) are registered BEFORE
// Microservice1's `/` mount. Microservice1's `/` mount is therefore registered
// LAST, and a request in an enabled peer's subtree matches the peer's mount
// before Microservice1's `/` mount is ever reached.
//
// SCOPE — what this suite asserts and what it does not:
//   - It asserts ONLY which mounted router answered and the status that response
//     carried. No body, no content type, no per-method status beyond what
//     identifies the dispatch. Which router answered is read off the peer's own
//     behaviour: the peer answers 200 at its Mount_Root (its identifier
//     response) and 200 at `/config` (its config sub-endpoint). Microservice1's
//     SPA router, were it the one answering these peer paths, would never produce
//     those 200s — it would 404 (no such file in the bundle) or 503 (Spa_Root
//     absent). So a 200 at `/microservice2` and `/microservice2/config` is proof
//     the PEER answered, not Microservice1.
//   - The COMPLEMENT — what Microservice1 answers at these same paths when the
//     peer is ABSENT (unselected or toggled off) — is deliberately NOT asserted
//     here. That is a statement about ONE router (Microservice1's), and it lives
//     in Microservice1's OWN suite (spa-serving.test.ts, the peer-subtree cases
//     under R7.14). Asserting it here would drag a sample-scope, single-router
//     fact into a framework-scope, composed-Overseer suite.
//
// Validates: Requirements 7.13, 11.11

import type { Server } from "node:http";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { buildApp, makeRegistry, makeToggleMap } from "./helpers.js";

// The enabled peers whose subtrees must NOT be shadowed by Microservice1's "/"
// mount, and the peer-produced 200 that proves the peer — not Microservice1's
// SPA router — answered. `/config` is the peer's own config sub-endpoint; the
// Mount_Root is the peer's own identifier response. Both are 200 from the peer;
// Microservice1's static router serving either would 404 or 503, never 200.
const PEER_200_PATHS = [
  { id: "microservice2", path: "/microservice2" },
  { id: "microservice2", path: "/microservice2/config" },
  { id: "microservice3", path: "/microservice3" },
  { id: "microservice3", path: "/microservice3/config" },
] as const;

// A path under an enabled peer's Mount_Root that the peer serves from neither
// its identifier handler nor its `/config` handler: the peer's own terminal
// catch-all answers it 404. The point of probing it is that the request is still
// DISPATCHED to the peer (its subtree, matched before Microservice1's "/" mount)
// rather than falling through to Microservice1's static serving. The status is
// asserted; whether the 404 comes from the peer's terminal handler is exactly
// what "dispatched to the peer" means under longest-path-first mounting.
const PEER_UNDER_ROOT_PATHS = [
  { id: "microservice2", path: "/microservice2/anything" },
  { id: "microservice3", path: "/microservice3/anything" },
] as const;

describe("framework-scope peer shadowing (Microservice1 '/' mount never shadows an enabled peer)", () => {
  // Bind ONE persistent listened HTTP server and reuse it across every request,
  // per the sibling suites' rationale (mount-dispatch.test.ts): `request(app)`
  // on a non-listening app spins up a fresh ephemeral server per call, and
  // reusing a single listened server avoids the reused-port HTTP parse race seen
  // under repeated short-lived servers.
  //
  // Composition: ALL THREE reference microservices selected and toggled on, so
  // Microservice1 is mounted at "/" alongside the two peers at "/microservice2"
  // and "/microservice3". This is the composition in which shadowing WOULD occur
  // if the mount order were wrong.
  let allEnabledServer: Server;

  const listen = (server: Server): Promise<void> =>
    new Promise<void>((resolve) => server.on("listening", resolve));
  const close = (server: Server): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );

  beforeAll(async () => {
    allEnabledServer = buildApp(
      makeRegistry(["microservice1", "microservice2", "microservice3"]),
      makeToggleMap({
        microservice1: true,
        microservice2: true,
        microservice3: true,
      }),
    ).listen(0);
    await listen(allEnabledServer);
  });

  afterAll(async () => {
    await close(allEnabledServer);
  });

  // R7.13: at an enabled peer's Mount_Root and at its `/config` sub-endpoint the
  // Overseer dispatches to the peer's router, evidenced by the peer's own 200.
  // Microservice1's static serving cannot produce a 200 here (it would 404 on a
  // missing bundle file or 503 on an absent Spa_Root), so a 200 is proof the
  // peer answered and Microservice1's "/" mount shadowed nothing.
  it.each(PEER_200_PATHS)(
    "GET $path is dispatched to $id's router (peer answers 200, not Microservice1's SPA router)",
    async ({ path }) => {
      const res = await request(allEnabledServer).get(path);
      expect(res.status).toBe(200);
    },
  );

  // R7.13: a path UNDER an enabled peer's Mount_Root that the peer does not serve
  // is still DISPATCHED to that peer (its subtree matches before Microservice1's
  // "/" mount is reached); the peer's own terminal catch-all answers it 404. The
  // request never reaches Microservice1's static serving.
  it.each(PEER_UNDER_ROOT_PATHS)(
    "GET $path stays inside $id's subtree (dispatched to the peer, never Microservice1's '/' mount)",
    async ({ path }) => {
      const res = await request(allEnabledServer).get(path);
      expect(res.status).toBe(404);
    },
  );
});

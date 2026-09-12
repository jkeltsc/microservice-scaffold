// Feature: scaffold-demo-samples, Property 13: Every method other than GET and HEAD is answered 405 with `Allow: GET, HEAD`, whatever the path and whether or not the Spa_Root is present
// Feature: scaffold-demo-samples, Property 23: Microservice1's router is total over its Owned_Subtree
//
// Microservice1 serves the Demo_Spa at its Mount_Root `/` and owns the entire
// subtree rooted there (Requirement 7). These two properties are the method-axis
// and totality halves of that ownership, and both are asserted against
// Microservice1's own router with NO Overseer composed (R11.10, R11.11): the
// router is total over its Owned_Subtree, so its status and headers are read
// directly.
//
// WHY ONE PROPERTY COVERS THE WHOLE METHOD AXIS. The handler decides on method
// admissibility BEFORE touching the filesystem (static-router.ts, step 1): a
// method other than GET or HEAD is answered `405 Allow: GET, HEAD` before the
// Spa_Root is consulted at all. Because that decision precedes every filesystem
// branch, the 405 is identical whether the path names a file, a directory,
// nothing, an escaping path, the Mount_Root itself, or a path inside an absent
// peer's subtree — and identical whether the Spa_Root is populated or empty
// (R8.2). So a SINGLE generator over path shapes, run twice (populated and
// empty Spa_Root), covers the whole axis. Were the order reversed — filesystem
// first, method second — this would need one property per path shape, because
// the 405 would then be reached by a different code path for each.
//
// COMPOSITION. `createSpaRouter` is imported by RELATIVE path from within the
// package and handed a `mkdtemp` directory as its Spa_Root, so no test touches
// the real `packages/spa/demo/dist/` bundle and the suite passes whether or not
// that bundle has been built. The temp directories are the ONLY thing these
// tests write — nothing under the checked-out tree is mutated (the repo's
// worktree-safety guard forbids it) — and they are removed in afterAll.
//
// Validates: Requirements 7.11, 7.12, 8.2, 11.10, 13.11

import type { Server } from "node:http";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { arbHttpMethod, arbHttpMethodNonGet } from "@microservices/contracts/testing";

// Import the static router by RELATIVE path — NOT via the `@microservices/demo`
// bundle or any resolved Spa_Root. The router under test is Microservice1's own.
import { createSpaRouter } from "../src/static-router.js";

/**
 * The status the sentinel handler answers with if it is ever reached. It is an
 * out-of-band value none of Microservice1's own handlers ever produce (its
 * router answers 200, 404, 405, or 503), so observing it anywhere — or the
 * sentinel flag flipping — is a totality violation (Property 23).
 */
const SENTINEL_STATUS = 599;

/**
 * Path shapes at or under Microservice1's Mount_Root, enumerating every case
 * Requirement 7 criterion 11 and design Property 13 call out:
 *
 * - the Mount_Root `/` itself;
 * - a path naming a regular file inside the populated Spa_Root (`/index.html`,
 *   `/assets/app.js`);
 * - a path naming a directory inside it (`/assets`);
 * - a path naming nothing (`/does-not-exist`, `/assets/missing.js`);
 * - an escaping path — a plain `..`, a percent-encoded `..` (`%2e%2e`), and an
 *   absolute segment;
 * - a path inside an absent microservice's subtree (`/microservice2`,
 *   `/microservice3/config`) — in a Container holding no such microservice these
 *   are simply paths Microservice1 owns (R7.14).
 *
 * The same generator is used by BOTH properties and against BOTH Spa_Root states
 * (populated and empty), which is the point: the method decision, and totality,
 * hold across every one of these shapes regardless of what the filesystem holds.
 */
const arbPathShape: fc.Arbitrary<string> = fc.constantFrom(
  // The Mount_Root itself.
  "/",
  // Files present in the populated Spa_Root.
  "/index.html",
  "/assets/app.js",
  // A directory in the populated Spa_Root.
  "/assets",
  // Paths naming nothing.
  "/does-not-exist",
  "/assets/missing.js",
  "/nested/deeper/nope.css",
  // Escaping paths: plain `..`, percent-encoded `..`, and an absolute segment.
  "/../secret",
  "/..%2f..%2fsecret",
  "/%2e%2e/secret",
  "/%2e%2e%2fsecret",
  // A path inside an absent microservice's subtree.
  "/microservice2",
  "/microservice3/config",
  "/microservice2/anything/deeper",
);

/**
 * supertest exposes lowercase method helpers (get, head, post, ...). Narrow the
 * generated method string to the helper name.
 */
type SupertestVerb =
  | "get"
  | "head"
  | "post"
  | "put"
  | "delete"
  | "patch"
  | "options";

function verbOf(method: string): SupertestVerb {
  return method.toLowerCase() as SupertestVerb;
}

/** Tracks whether the sentinel handler mounted after the router ever ran. */
let populatedSentinelReached = false;
let emptySentinelReached = false;

/**
 * Build a bare Express app with `createSpaRouter(spaRoot)` mounted at
 * Microservice1's Mount_Root `/`, followed by a sentinel handler. The sentinel
 * is registered AFTER the router; it can only run for a request the router
 * leaves unhandled. Because the router is total over its Owned_Subtree, the
 * sentinel never runs for any request at or under `/` (Property 23).
 */
function mountApp(spaRoot: string, onSentinel: () => void): express.Express {
  const app = express();
  app.use("/", createSpaRouter(spaRoot));
  app.use((_req, res) => {
    onSentinel();
    res.status(SENTINEL_STATUS).end();
  });
  return app;
}

// Two temp Spa_Roots and two persistent servers — one populated, one empty.
//
// Bind ONE persistent HTTP server per app and reuse it across every fast-check
// iteration. Calling `request(app)` on a non-listening app spins up (and tears
// down) a fresh ephemeral server per call; under a tight property loop that
// churn causes the Node HTTP parser to occasionally read a mis-framed response
// from a stale socket on a reused ephemeral port (surfacing as "Parse Error:
// Expected HTTP/, RTSP/ or ICE/"). Reusing a single listened server per app
// removes the churn entirely.
let populatedRoot: string;
let emptyRoot: string;
let populatedServer: Server;
let emptyServer: Server;

async function listen(app: express.Express): Promise<Server> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

beforeAll(async () => {
  // Populated Spa_Root: an index.html, at least one asset file, and a
  // subdirectory. This is what makes `/`, `/index.html`, and `/assets/app.js`
  // name real files and `/assets` name a directory.
  populatedRoot = mkdtempSync(join(tmpdir(), "ms1-spa-populated-"));
  writeFileSync(join(populatedRoot, "index.html"), "<!doctype html><title>demo</title>");
  mkdirSync(join(populatedRoot, "assets"));
  writeFileSync(join(populatedRoot, "assets", "app.js"), "export const x = 1;\n");

  // Empty Spa_Root: an empty directory holding no index.html, so the Spa_Root
  // is "absent" per R8.1's definition. Method handling must be unchanged (R8.2).
  emptyRoot = mkdtempSync(join(tmpdir(), "ms1-spa-empty-"));

  populatedServer = await listen(
    mountApp(populatedRoot, () => {
      populatedSentinelReached = true;
    }),
  );
  emptyServer = await listen(
    mountApp(emptyRoot, () => {
      emptySentinelReached = true;
    }),
  );
});

afterAll(async () => {
  await close(populatedServer);
  await close(emptyServer);
  rmSync(populatedRoot, { recursive: true, force: true });
  rmSync(emptyRoot, { recursive: true, force: true });
});

describe("Property 13: every non-GET/HEAD method is answered 405 Allow: GET, HEAD at any path, Spa_Root present or absent", () => {
  // Feature: scaffold-demo-samples, Property 13: Every method other than GET and HEAD is answered 405 with `Allow: GET, HEAD`, whatever the path and whether or not the Spa_Root is present
  it("with a POPULATED Spa_Root, any non-GET/HEAD method at any path returns 405 Allow: GET, HEAD", async () => {
    await fc.assert(
      fc.asyncProperty(arbHttpMethodNonGet, arbPathShape, async (method, path) => {
        populatedSentinelReached = false;
        const res = await request(populatedServer)[verbOf(method)](path);

        expect(res.status).toBe(405);
        expect(res.headers["allow"]).toBe("GET, HEAD");
        // The router answered it itself — the request never reached the sentinel.
        expect(populatedSentinelReached).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("with an EMPTY Spa_Root, any non-GET/HEAD method at any path returns 405 Allow: GET, HEAD (R8.2: absence changes no method handling)", async () => {
    await fc.assert(
      fc.asyncProperty(arbHttpMethodNonGet, arbPathShape, async (method, path) => {
        emptySentinelReached = false;
        const res = await request(emptyServer)[verbOf(method)](path);

        // Identical to the populated case: the method decision precedes the
        // Spa_Root check, so an absent Spa_Root changes nothing here (R8.2).
        expect(res.status).toBe(405);
        expect(res.headers["allow"]).toBe("GET, HEAD");
        expect(emptySentinelReached).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Property 23: Microservice1's router is total over its Owned_Subtree", () => {
  // Feature: scaffold-demo-samples, Property 23: Microservice1's router is total over its Owned_Subtree
  it("with a POPULATED Spa_Root, any method at any path is answered by the router; the sentinel after it is never reached", async () => {
    await fc.assert(
      fc.asyncProperty(arbHttpMethod, arbPathShape, async (method, path) => {
        populatedSentinelReached = false;
        const res = await request(populatedServer)[verbOf(method)](path);

        // The router produced a response of its own (never the sentinel's
        // out-of-band status), so the sentinel mounted after it never ran —
        // the router is total over its Owned_Subtree (R7.12).
        expect(res.status).not.toBe(SENTINEL_STATUS);
        expect(populatedSentinelReached).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("with an EMPTY Spa_Root, any method at any path is answered by the router; the sentinel after it is never reached", async () => {
    await fc.assert(
      fc.asyncProperty(arbHttpMethod, arbPathShape, async (method, path) => {
        emptySentinelReached = false;
        const res = await request(emptyServer)[verbOf(method)](path);

        // Totality holds equally with the Spa_Root absent: every request in the
        // Owned_Subtree still gets a response from the router (503 at `/`, 404
        // elsewhere for GET/HEAD, 405 for other methods), never the sentinel.
        expect(res.status).not.toBe(SENTINEL_STATUS);
        expect(emptySentinelReached).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

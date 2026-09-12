// Feature: scaffold-demo-samples, Property 4: Microservice3 answers 405 with `Allow: GET` for every non-GET method at both routes
// Feature: scaffold-demo-samples, Property 6: Microservice3 answers 404 itself at every sub-path other than `/config`
// Feature: scaffold-demo-samples, Property 25: Microservice3's router is total over its Owned_Subtree
//
// Every assertion below exercises Microservice3's exported router in isolation
// with NO Overseer composed. Microservice3 owns the subtree rooted at its
// Mount_Root and answers every request in that subtree from its own router
// (Subtree_Ownership, R3.10, R3.12), so the router's status, headers, and body
// are read directly and assertable without an Overseer.
//
// The router is mounted at its exported Mount_Root so that a request path such
// as `/microservice3/config` matches the same routes it would under a real
// Overseer mount. A single sentinel handler is registered AFTER the router; it
// exists only so Property 25 can assert it is never reached — because the router
// is total, the sentinel never runs and its 599 status never surfaces.
//
// Validates: Requirements 3.7, 3.8, 3.10, 3.12, 13.10

import type { Server } from "node:http";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { arbHttpMethod, arbHttpMethodNonGet } from "@microservices/contracts/testing";

import { path, router } from "../src/index.js";

/**
 * The status the sentinel handler answers with if it is ever reached. It is an
 * out-of-band value that none of Microservice3's own handlers ever produce (its
 * router answers 200, 404, or 405), so observing it anywhere is a totality
 * violation.
 */
const SENTINEL_STATUS = 599;

/** Tracks whether the sentinel handler mounted after the router ever ran. */
let sentinelReached = false;

/**
 * Build a bare Express app with Microservice3's router mounted at its exported
 * Mount_Root, followed by a sentinel handler. The sentinel is registered AFTER
 * the router; it can only run for a request the router leaves unhandled. Because
 * the router is total over its Owned_Subtree, the sentinel never runs for any
 * request at or under the Mount_Root.
 */
function mountApp(): express.Express {
  const app = express();
  app.use(path, router);
  app.use((_req, res) => {
    sentinelReached = true;
    res.status(SENTINEL_STATUS).end();
  });
  return app;
}

// Bind ONE persistent HTTP server for the whole file and reuse it across every
// fast-check iteration. Calling `request(app)` on a non-listening app spins up
// (and tears down) a fresh ephemeral server per call; under a tight property
// loop that churn causes the Node HTTP parser to occasionally read a mis-framed
// response from a stale socket on a reused ephemeral port (surfacing as
// "Parse Error: Expected HTTP/, RTSP/ or ICE/"). Reusing a single listened
// server removes the churn entirely.
let server: Server;

beforeAll(async () => {
  const app = mountApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

/**
 * supertest exposes lowercase method helpers (get, post, put, ...). Narrow the
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

describe("Property 4: microservice3 answers 405 with Allow: GET for every non-GET method at both routes", () => {
  // Feature: scaffold-demo-samples, Property 4: Microservice3 answers 405 with `Allow: GET` for every non-GET method at both routes
  it("any non-GET method at the Mount_Root and at /config returns 405 with Allow: GET, and /config carries no Extended_Config_Payload", async () => {
    await fc.assert(
      fc.asyncProperty(arbHttpMethodNonGet, async (method) => {
        const verb = verbOf(method);

        // Mount_Root (R3.7).
        const rootRes = await request(server)[verb](path);
        expect(rootRes.status).toBe(405);
        expect(rootRes.headers["allow"]).toBe("GET");

        // /config (R3.8) — 405 with Allow: GET and a body that carries no
        // Extended_Config_Payload. The payload's distinguishing member is
        // `config` (which holds the Extended_Config_Block); the 405 body must
        // hold no such structure.
        const configRes = await request(server)[verb](`${path}/config`);
        expect(configRes.status).toBe(405);
        expect(configRes.headers["allow"]).toBe("GET");

        // No Extended_Config_Payload: the body has none of the payload's keys.
        const body = configRes.body as unknown;
        const hasPayloadShape =
          typeof body === "object" &&
          body !== null &&
          ("config" in body ||
            "microservice-name" in body ||
            "path" in body);
        expect(hasPayloadShape).toBe(false);
        // And the raw text is empty (the handler ends the response with no body).
        expect(configRes.text).toBe("");
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 6: microservice3 answers 404 itself at every sub-path other than /config", () => {
  // Feature: scaffold-demo-samples, Property 6: Microservice3 answers 404 itself at every sub-path other than `/config`
  it("any method at any sub-path other than the empty sub-path and /config returns 404 from the router itself", async () => {
    // A sub-path under the Mount_Root that is neither the empty sub-path (the
    // Mount_Root itself) nor `/config`. Each segment is a non-empty token of
    // URL-safe characters; the whole path is at least one segment deep and is
    // never exactly `/config`.
    //
    // `.` and `..` segments are excluded: HTTP path normalization collapses
    // them (`/microservice3/.` resolves to the Mount_Root, `/microservice3/x/..`
    // resolves to the Mount_Root too), which would move the request out of this
    // property's input space — a dot segment names the empty sub-path, not a
    // distinct sub-path. The property ranges over genuinely distinct sub-paths.
    const arbSegment = fc
      .stringMatching(/^[A-Za-z0-9._~-]+$/)
      .filter((s) => s.length > 0 && s.length <= 32 && s !== "." && s !== "..");
    const arbSubPath = fc
      .array(arbSegment, { minLength: 1, maxLength: 4 })
      .map((segs) => `/${segs.join("/")}`)
      .filter((sub) => sub !== "/config");

    await fc.assert(
      fc.asyncProperty(arbHttpMethod, arbSubPath, async (method, subPath) => {
        sentinelReached = false;
        const verb = verbOf(method);
        const res = await request(server)[verb](`${path}${subPath}`);

        // The router answers 404 itself for every unserved sub-path, whatever
        // the method — the request never reaches the sentinel registered after
        // the router (R3.10).
        expect(res.status).toBe(404);
        expect(sentinelReached).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Property 25: microservice3's router is total over its Owned_Subtree", () => {
  // Feature: scaffold-demo-samples, Property 25: Microservice3's router is total over its Owned_Subtree
  it("any method at any path at or under the Mount_Root is answered by the router; the sentinel after it is never reached", async () => {
    // Any path at or under the Mount_Root: the empty sub-path (the Mount_Root
    // itself) plus zero-or-more further segments. Zero segments yields the
    // Mount_Root; one or more yields a path strictly under it — `/config`
    // included, since totality covers the served paths too.
    //
    // `.` and `..` segments are excluded for the same reason the terminal-404
    // generator above excludes them: HTTP path normalization collapses a dot
    // segment, and a `..` segment resolves ABOVE the Mount_Root
    // (`/microservice2/..` normalizes to `/`), which is NOT a path "at or under
    // the Mount_Root" at all — it escapes the Owned_Subtree, so the request
    // legitimately reaches the sentinel mounted after the router. Such a path
    // is outside this totality property's input space (the property quantifies
    // over paths that genuinely sit within the Owned_Subtree), so the generator
    // excludes it rather than the assertion special-casing it.
    const arbSegment = fc
      .stringMatching(/^[A-Za-z0-9._~-]+$/)
      .filter((s) => s.length > 0 && s.length <= 32 && s !== "." && s !== "..");
    const arbAnyPath = fc
      .array(arbSegment, { minLength: 0, maxLength: 4 })
      .map((segs) => (segs.length === 0 ? path : `${path}/${segs.join("/")}`));

    await fc.assert(
      fc.asyncProperty(arbHttpMethod, arbAnyPath, async (method, fullPath) => {
        sentinelReached = false;
        const verb = verbOf(method);
        const res = await request(server)[verb](fullPath);

        // The router produced a response of its own (never the sentinel's
        // out-of-band status), so the sentinel handler mounted after it is
        // never reached — the router is total over its Owned_Subtree (R3.12).
        expect(res.status).not.toBe(SENTINEL_STATUS);
        expect(sentinelReached).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: scaffold-demo-samples, Property 14: While the Spa_Root is absent, every non-root path is answered without a 503
//
// Microservice1 serves the Demo_Spa at its Mount_Root `/` and owns the whole
// subtree rooted there (Requirement 7). This suite is the ABSENT-Spa_Root half of
// that ownership: while the Spa_Root holds no `index.html`, the Mount_Root `/`
// answers 503 (naming the resolved path and the build command), and EVERY OTHER
// path is answered by Microservice1's own router — 404 for a GET or HEAD (an
// absent Spa_Root holds no file that could be served) and 405 with
// `Allow: GET, HEAD` for any other method — with NO response carrying 503. So the
// Mount_Root is the only path that reports the unbuilt bundle (R8.1, R8.2, R8.3).
//
// COMPOSITION. `createSpaRouter` is imported by RELATIVE path and handed a
// `mkdtemp` directory as its Spa_Root, so no test touches the real
// `packages/spa/demo/dist/` bundle and the suite passes whether or not that bundle
// has been built. The temp directories are the ONLY thing these tests write —
// nothing under the checked-out tree is mutated (the repo's worktree-safety guard
// forbids it) — and they are removed in afterAll. There is NO Overseer; the router
// is total over its Owned_Subtree, so its status, headers, and body are read
// directly (R11.10).
//
// The two recovery transitions (R8.5, R8.6) run on ONE persistent listened server
// bound to ONE router instance over ONE `mkdtemp` directory: writing and deleting
// `index.html` in that directory, with no restart and no intervening request,
// proves the per-request presence check — the very next GET `/` observes the new
// state. That is only observable with a single long-lived router, which is why the
// recovery server is separate from the property server.
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.5, 8.6, 11.10, 13.11

import type { Server } from "node:http";

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { arbHttpMethod } from "@microservices/contracts/testing";

// Import the static router by RELATIVE path — NOT via the `@microservices/demo`
// bundle or any resolved Spa_Root. The router under test is Microservice1's own.
import { createSpaRouter } from "../src/static-router.js";

/** The literal build command R8.1 requires the 503 body to name. */
const BUILD_COMMAND = "npm run build --workspace @microservices/demo";

/** The index.html bytes written when a Spa_Root is made present. */
const INDEX_HTML = "<!doctype html><title>demo</title>";

/**
 * Path shapes at or under Microservice1's Mount_Root, EXCLUDING the Mount_Root
 * `/` itself — Property 14 quantifies over every path OTHER than the Mount_Root.
 * With the Spa_Root absent none of these names a servable file, so each must be
 * answered by Microservice1's own router: 404 for GET/HEAD, 405 for any other
 * method, and never 503.
 *
 * The shapes cover: a would-be index/asset path, a path naming nothing, a nested
 * path, escaping paths (plain `..`, percent-encoded `..`, an absolute segment),
 * and paths inside an absent peer microservice's subtree — which in a Container
 * holding no such microservice are simply paths Microservice1 owns (R7.14).
 */
const arbNonRootPath: fc.Arbitrary<string> = fc.constantFrom(
  "/index.html",
  "/assets/app.js",
  "/does-not-exist",
  "/assets/missing.js",
  "/nested/deeper/nope.css",
  "/../secret",
  "/..%2f..%2fsecret",
  "/%2e%2e/secret",
  "/%2e%2e%2fsecret",
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

// ---------------------------------------------------------------------------
// The property + fixed-example server: an EMPTY Spa_Root, never mutated. Bind ONE
// persistent listened server and reuse it across every fast-check iteration —
// calling `request(app)` on a non-listening app spins up (and tears down) a fresh
// ephemeral server per call, and under a tight property loop that churn makes the
// Node HTTP parser occasionally mis-frame a response on a reused ephemeral port.
// ---------------------------------------------------------------------------
let absentRoot: string;
let absentServer: Server;

// ---------------------------------------------------------------------------
// The recovery-transition server: ONE router over ONE `mkdtemp` directory whose
// index.html is written and deleted mid-run. Separate from the property server so
// the property server's Spa_Root stays absent throughout.
// ---------------------------------------------------------------------------
let recoveryRoot: string;
let recoveryServer: Server;

beforeAll(async () => {
  absentRoot = mkdtempSync(join(tmpdir(), "ms1-spa-absent-"));
  absentServer = await listen(mountAt(absentRoot));

  recoveryRoot = mkdtempSync(join(tmpdir(), "ms1-spa-recovery-"));
  recoveryServer = await listen(mountAt(recoveryRoot));
});

afterAll(async () => {
  await close(absentServer);
  await close(recoveryServer);
  rmSync(absentRoot, { recursive: true, force: true });
  rmSync(recoveryRoot, { recursive: true, force: true });
});

/** Mount `createSpaRouter(spaRoot)` at the Mount_Root `/` on a bare app. */
function mountAt(spaRoot: string): express.Express {
  const app = express();
  app.use("/", createSpaRouter(spaRoot));
  return app;
}

describe("Property 14: while the Spa_Root is absent, every non-root path is answered without a 503", () => {
  // Feature: scaffold-demo-samples, Property 14: While the Spa_Root is absent, every non-root path is answered without a 503
  it("answers every non-root path from Microservice1's own router — 404 for GET/HEAD, 405 for others — and never 503", async () => {
    await fc.assert(
      fc.asyncProperty(arbNonRootPath, arbHttpMethod, async (path, method) => {
        const res = await request(absentServer)[verbOf(method)](path);

        if (method === "GET" || method === "HEAD") {
          // An absent Spa_Root holds no file that could be served, so a GET or
          // HEAD at any non-root path is 404 (R8.3).
          expect(res.status).toBe(404);
        } else {
          // The method decision precedes the Spa_Root check, so a non-GET/HEAD
          // method is 405 with `Allow: GET, HEAD` (R8.2, R8.3).
          expect(res.status).toBe(405);
          expect(res.headers["allow"]).toBe("GET, HEAD");
        }

        // The load-bearing negative: no non-root path reports the unbuilt bundle,
        // so the Mount_Root `/` is the ONLY path that answers 503 (R8.3).
        expect(res.status).not.toBe(503);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Fixed examples: the Mount_Root 503 shape while the Spa_Root is absent", () => {
  it("GET / with an absent Spa_Root → 503, text/plain, body naming both the resolved Spa_Root path and the build command", async () => {
    const res = await request(absentServer).get("/");

    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    // R8.1: the body names BOTH the resolved Spa_Root path (the temp dir passed
    // to createSpaRouter) AND the literal build command.
    expect(res.text).toContain(absentRoot);
    expect(res.text).toContain(BUILD_COMMAND);
  });

  it("HEAD / with an absent Spa_Root → the same status (503) and content type (text/plain) as GET, with NO body", async () => {
    const res = await request(absentServer).head("/");

    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    // R7.9: HEAD carries the same status and content type as GET but no body.
    expect(res.text).toBeFalsy();
  });
});

describe("Recovery transitions on one router instance, no restart, no intervening request (R8.5, R8.6)", () => {
  it("absent → present: GET / is 503, then writing index.html makes the very next GET / a 200 text/html serving those bytes", async () => {
    // Start with the recovery Spa_Root empty (no index.html): the Mount_Root
    // reports the unbuilt bundle.
    expect(existsSync(join(recoveryRoot, "index.html"))).toBe(false);
    const before = await request(recoveryServer).get("/");
    expect(before.status).toBe(503);

    // Make the Spa_Root present by writing index.html into the SAME directory the
    // running server's router points at. No restart, no intervening request.
    writeFileSync(join(recoveryRoot, "index.html"), INDEX_HTML);

    // The very next GET / observes the new state per the per-request presence
    // check (R8.5).
    const after = await request(recoveryServer).get("/");
    expect(after.status).toBe(200);
    expect(after.headers["content-type"]).toMatch(/^text\/html/);
    expect(after.text).toBe(INDEX_HTML);
  });

  it("present → absent: GET / is 200, then deleting index.html makes the very next GET / a 503", async () => {
    // The previous transition left index.html present; confirm the served state.
    expect(existsSync(join(recoveryRoot, "index.html"))).toBe(true);
    const before = await request(recoveryServer).get("/");
    expect(before.status).toBe(200);
    expect(before.text).toBe(INDEX_HTML);

    // Make the Spa_Root absent again by deleting index.html from the same
    // directory. No restart, no intervening request.
    rmSync(join(recoveryRoot, "index.html"), { force: true });

    // The very next GET / reports the unbuilt bundle again (R8.6).
    const after = await request(recoveryServer).get("/");
    expect(after.status).toBe(503);
    expect(after.headers["content-type"]).toMatch(/^text\/plain/);
    expect(after.text).toContain(recoveryRoot);
    expect(after.text).toContain(BUILD_COMMAND);
  });
});

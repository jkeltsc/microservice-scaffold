// Feature: microservice-scaffold, Property 1: Microservice endpoint contract at
// the mount path.
//
// A router built to report name N at path P returns, for a GET at P, 200 with
// Content-Type: application/json and a JSON object with EXACTLY the keys
// {"microservice-name", "path"} equal to N and P (no additional keys); any
// non-GET method at P returns 405 with header Allow: GET.
//
// Here the router under test is microservice1's: P is its exported `path` and N
// is "microservice1". The module exports no identifier (the directory name is
// the authoritative one and the registry carries it), so the expected name is
// pinned as a literal here — this assertion is the only pin on this sample's
// reported name.
//
// Validates: Requirements R2.1, R2.2, R2.3, R2.4

import type { Server } from "node:http";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { arbHttpMethodNonGet } from "@microservices/contracts/testing";

import { path, router } from "../src/index.js";

/** The name this microservice's root response is expected to report. */
const EXPECTED_NAME = "microservice1";

/** Build a bare Express app with the microservice router mounted at its path. */
function mountApp(): express.Express {
  const app = express();
  app.use(path, router);
  return app;
}

describe("Property 1: microservice1 endpoint contract at the mount path", () => {
  // Bind ONE persistent HTTP server for the whole suite and reuse it across
  // every fast-check iteration. Calling `request(app)` on a non-listening app
  // spins up (and tears down) a fresh ephemeral server per call; under a tight
  // property loop that churn causes the Node HTTP parser to occasionally read a
  // mis-framed response from a stale socket on a reused ephemeral port
  // (surfacing as "Parse Error: Expected HTTP/, RTSP/ or ICE/"). Reusing a
  // single listened server removes the churn entirely.
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

  it("GET at the mount path returns 200 application/json with exactly the two contract keys", async () => {
    const res = await request(server).get(path);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    // Body must be a JSON object with EXACTLY the two contract keys.
    const body: unknown = res.body;
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    const obj = body as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual(["microservice-name", "path"]);
    expect(obj["microservice-name"]).toBe(EXPECTED_NAME);
    expect(obj["path"]).toBe(path);
  });

  it("any non-GET method at the mount path returns 405 with Allow: GET", async () => {
    await fc.assert(
      fc.asyncProperty(arbHttpMethodNonGet, async (method) => {
        // supertest exposes lowercase method helpers (post, put, delete, ...).
        const verb = method.toLowerCase() as
          | "post"
          | "put"
          | "delete"
          | "patch"
          | "head"
          | "options";
        const res = await request(server)[verb](path);

        expect(res.status).toBe(405);
        expect(res.headers["allow"]).toBe("GET");
      }),
      { numRuns: 100 },
    );
  });
});

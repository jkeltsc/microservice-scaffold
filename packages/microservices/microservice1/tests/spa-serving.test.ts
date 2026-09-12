// Feature: scaffold-demo-samples, Property 8: A file inside the Spa_Root is served byte-identically with the content type its extension alone determines
// Feature: scaffold-demo-samples, Property 9: A path naming no file inside the Spa_Root is answered 404 by Microservice1
// Feature: scaffold-demo-samples, Property 10: A path resolving outside the Spa_Root is answered 404 and leaks nothing
// Feature: scaffold-demo-samples, Property 11: HEAD mirrors GET's status and content type with an empty body
// Feature: scaffold-demo-samples, Property 12: A query string does not affect the response
//
// Microservice1 serves the Demo_Spa's bundled output at its Mount_Root `/` and
// owns the entire subtree rooted there (Requirement 7). This suite is the
// content-serving half of that ownership: what Microservice1 answers for a
// GET or HEAD once the method is admitted — the file it selects, the bytes it
// returns, the content type it stamps, and the 404s it gives for anything that
// names no regular file or that escapes the Spa_Root.
//
// COMPOSITION. `createSpaRouter` is imported by RELATIVE path from within the
// package and handed a `mkdtemp` directory as its Spa_Root, so no test touches
// the real `packages/spa/demo/dist/` bundle and the suite passes whether or not
// that bundle has been built. NO Overseer is composed: the router is total over
// its Owned_Subtree, so every status, header, and body is read directly from
// Microservice1's own router (R7.14, R11.10). One populated Spa_Root and one
// persistent listened server are built up front and reused across every case;
// the escape/directory/peer-subtree shapes all live inside that same tree. A
// sentinel file is planted OUTSIDE the Spa_Root (its own mkdtemp) as the target
// of a planted symlink, and its bytes must never appear in any response. The
// temp directories are the ONLY thing these tests write — nothing under the
// checked-out tree is mutated (the repo's worktree-safety guard forbids it) —
// and they are removed in afterAll.
//
// Validates: Requirements 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.14, 11.10

import type { Server } from "node:http";

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

// Import the static router by RELATIVE path — NOT via the `@microservices/demo`
// bundle or any resolved Spa_Root. The router under test is Microservice1's own.
import { createSpaRouter } from "../src/static-router.js";

// ---------------------------------------------------------------------------
// The content-type-by-extension contract, mirrored from static-router.ts.
//
// The router maps the LOWER-CASED extension to a BARE media type (no charset)
// and answers `application/octet-stream` for anything unmapped. This table is
// the oracle the properties assert against; it is written out here rather than
// imported so the test would catch a silent change to the router's map.
// ---------------------------------------------------------------------------
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain",
};

/**
 * The expected content type for a filename, from its extension alone: the last
 * dot-segment lower-cased, looked up in the map, defaulting to
 * `application/octet-stream`. A filename with no dot has no extension and gets
 * the default.
 *
 * This deliberately mirrors what `node:path`'s `extname` + the router's
 * `toLowerCase()` lookup produce, computed independently of the router so the
 * property has a real oracle rather than echoing the implementation.
 */
function expectedContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  // No dot, or a leading dot with nothing before it (a dotfile like `.foo` has
  // no extension per `extname`): default type.
  if (dot <= 0) {
    return DEFAULT_CONTENT_TYPE;
  }
  const ext = filename.slice(dot).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? DEFAULT_CONTENT_TYPE;
}

// ---------------------------------------------------------------------------
// supertest body capture as raw bytes.
//
// supertest/superagent's default parsers coerce a body to a string or a parsed
// object; to assert BYTE-identity we install a binary buffering parser that
// concatenates the raw response bytes into a Buffer, so `res.body` is exactly
// what the server wrote.
// ---------------------------------------------------------------------------
type BinaryResponse = { status: number; headers: Record<string, string>; body: Buffer };

async function getBytes(
  server: Server,
  verb: "get" | "head",
  path: string,
): Promise<BinaryResponse> {
  // Capture the raw response bytes into a closure Buffer rather than relying on
  // `res.body`: superagent leaves `res.body` an empty object `{}` for a body-less
  // response (a HEAD, a 404 with no content), and its custom-parse result is not
  // reliably a Buffer across every status. Reading the raw stream ourselves makes
  // `body` ALWAYS a Buffer — empty when the server wrote nothing.
  let captured = Buffer.alloc(0);
  const res = await request(server)
    [verb](path)
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        captured = Buffer.concat(chunks);
        callback(null, captured);
      });
    });
  return {
    status: res.status,
    headers: res.headers as Record<string, string>,
    body: captured,
  };
}

/** The `Content-Type` header with any parameters (e.g. `; charset=`) stripped. */
function bareContentType(headers: Record<string, string>): string | undefined {
  const raw = headers["content-type"];
  return raw === undefined ? undefined : raw.split(";")[0].trim();
}

// ---------------------------------------------------------------------------
// Fixture tree. Built once in beforeAll and reused across every case.
// ---------------------------------------------------------------------------

/**
 * The mapped extensions the router recognises, plus deliberately UNMAPPED ones,
 * so "content type from the extension alone" and the `application/octet-stream`
 * default are exercised rather than sampled:
 *
 * - `.qqq`         — a plain unmapped extension;
 * - `.tar.zst`     — a compound suffix whose LAST segment (`.zst`) is unmapped;
 * - `""`           — no extension at all;
 * - `.HTML`        — upper-cased, to prove the lookup is case-insensitive
 *                    (maps to `text/html`).
 */
const MAPPED_EXTENSIONS = Object.keys(CONTENT_TYPE_BY_EXTENSION);
const UNMAPPED_EXTENSIONS = [".qqq", ".tar.zst", "", ".HTML"];
const ALL_EXTENSIONS = [...MAPPED_EXTENSIONS, ...UNMAPPED_EXTENSIONS];

/** A generator over filenames drawing from BOTH the mapped and unmapped sets. */
const arbFilename: fc.Arbitrary<string> = fc
  .tuple(
    // A safe base name: alphanumerics/dash/underscore, non-empty, no dots so the
    // only extension is the one we append.
    fc
      .stringMatching(/^[a-zA-Z0-9_-]+$/)
      .filter((s) => s.length > 0 && s.length <= 24),
    fc.constantFrom(...ALL_EXTENSIONS),
  )
  .map(([base, ext]) => `${base}${ext}`);

/** Arbitrary file contents, including the empty body and binary bytes. */
const arbContents: fc.Arbitrary<Buffer> = fc
  .uint8Array({ maxLength: 512 })
  .map((u) => Buffer.from(u));

let spaRoot: string;
let sentinelRoot: string;
let sentinelBytes: Buffer;
let indexBytes: Buffer;
let server: Server;

// A known, unusual byte sequence for the sentinel outside the Spa_Root. If any
// response body contains this, a traversal/symlink escape leaked it.
const SENTINEL_MARKER = "SENTINEL-OUTSIDE-SPA-ROOT-e5f1c7a9-DO-NOT-LEAK";

async function listen(app: express.Express): Promise<Server> {
  const s = app.listen(0);
  await new Promise<void>((resolve) => s.on("listening", resolve));
  return s;
}

async function close(s: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    s.close((err) => (err ? reject(err) : resolve())),
  );
}

beforeAll(async () => {
  // Sentinel lives in its OWN temp dir, outside the Spa_Root entirely.
  sentinelRoot = mkdtempSync(join(tmpdir(), "ms1-sentinel-"));
  sentinelBytes = Buffer.from(`${SENTINEL_MARKER}\nsecret line two\n`);
  const sentinelFile = join(sentinelRoot, "secret.txt");
  writeFileSync(sentinelFile, sentinelBytes);

  // The populated Spa_Root.
  spaRoot = mkdtempSync(join(tmpdir(), "ms1-spa-serving-"));

  // index.html with distinctive bytes so we can assert it is NEITHER returned as
  // a fallback (Property 9) NOR mistaken for the served file elsewhere.
  indexBytes = Buffer.from("<!doctype html><title>demo-index</title><body>INDEX_HTML_BODY</body>");
  writeFileSync(join(spaRoot, "index.html"), indexBytes);

  // A directory inside the Spa_Root (names no regular file — Property 9).
  mkdirSync(join(spaRoot, "assets"));
  writeFileSync(join(spaRoot, "assets", "app.js"), "export const x = 1;\n");

  // A file to serve for the peer-subtree 200 case: plant a real file at the
  // path an absent microservice's subtree names (R7.14). `/microservice2` names
  // a file ONLY because we plant one here.
  writeFileSync(join(spaRoot, "microservice2"), "planted-at-peer-path");
  // And a nested one under /microservice3/ so `/microservice3/config` names a
  // file too.
  mkdirSync(join(spaRoot, "microservice3"));
  writeFileSync(join(spaRoot, "microservice3", "config"), "planted-nested-peer");

  // A symlink INSIDE the Spa_Root whose target is the sentinel OUTSIDE it.
  // Following it and serving the target would leak the sentinel (Property 10).
  symlinkSync(sentinelFile, join(spaRoot, "escape-link"));
  // A symlink to the sentinel's directory, so a path THROUGH the link
  // (`/dir-link/secret.txt`) also escapes.
  symlinkSync(sentinelRoot, join(spaRoot, "dir-link"));

  const app = express();
  app.use("/", createSpaRouter(spaRoot));
  server = await listen(app);
});

afterAll(async () => {
  await close(server);
  rmSync(spaRoot, { recursive: true, force: true });
  rmSync(sentinelRoot, { recursive: true, force: true });
});

// ===========================================================================
// Property 8 — byte-identical serving, content type from the extension alone.
// ===========================================================================
describe("Property 8: a file is served byte-identically with the content type its extension alone determines", () => {
  // Feature: scaffold-demo-samples, Property 8: A file inside the Spa_Root is served byte-identically with the content type its extension alone determines
  it("serves any file (mapped or unmapped extension) 200, right content type, byte-identical body", async () => {
    await fc.assert(
      fc.asyncProperty(arbFilename, arbContents, async (filename, contents) => {
        // Re-root every write inside the Spa_Root. The file name is safe (no
        // dots except the extension, no separators), so it lands directly.
        const abs = join(spaRoot, filename);
        writeFileSync(abs, contents);

        const res = await getBytes(server, "get", `/${filename}`);

        expect(res.status).toBe(200);
        expect(bareContentType(res.headers)).toBe(expectedContentType(filename));
        expect(Buffer.compare(res.body, contents)).toBe(0);
      }),
      { numRuns: 150 },
    );
  });

  // Feature: scaffold-demo-samples, Property 8: A file inside the Spa_Root is served byte-identically with the content type its extension alone determines
  it("two different files sharing an extension get the identical content type", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_EXTENSIONS),
        arbContents,
        arbContents,
        async (ext, contentsA, contentsB) => {
          const nameA = `two-eq-a${ext}`;
          const nameB = `two-eq-b${ext}`;
          writeFileSync(join(spaRoot, nameA), contentsA);
          writeFileSync(join(spaRoot, nameB), contentsB);

          const resA = await getBytes(server, "get", `/${nameA}`);
          const resB = await getBytes(server, "get", `/${nameB}`);

          expect(resA.status).toBe(200);
          expect(resB.status).toBe(200);
          // Same extension → identical content type, regardless of contents.
          expect(bareContentType(resA.headers)).toBe(bareContentType(resB.headers));
          expect(bareContentType(resA.headers)).toBe(expectedContentType(nameA));
          // And each body is still its own file's bytes.
          expect(Buffer.compare(resA.body, contentsA)).toBe(0);
          expect(Buffer.compare(resB.body, contentsB)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("GET / → 200, text/html, body byte-identical to the Spa_Root's index.html (R7.5)", async () => {
    const res = await getBytes(server, "get", "/");
    expect(res.status).toBe(200);
    expect(bareContentType(res.headers)).toBe("text/html");
    expect(Buffer.compare(res.body, indexBytes)).toBe(0);
  });
});

// ===========================================================================
// Property 9 — a path naming no regular file is 404, no listing, no index bytes.
// ===========================================================================
describe("Property 9: a path naming no regular file is answered 404 with neither a listing nor index.html", () => {
  /**
   * Shapes that name no regular file inside the Spa_Root: a missing name, a
   * nested missing name, and an existing DIRECTORY (which names no regular
   * file).
   */
  const arbNoFilePath: fc.Arbitrary<string> = fc.oneof(
    fc
      .stringMatching(/^[a-zA-Z0-9_-]+$/)
      .filter((s) => s.length > 0 && s.length <= 20)
      .map((s) => `/missing-${s}`),
    fc
      .stringMatching(/^[a-zA-Z0-9_-]+$/)
      .filter((s) => s.length > 0 && s.length <= 20)
      .map((s) => `/nested/${s}/none.css`),
    // Existing directories name no regular file.
    fc.constantFrom("/assets", "/microservice3"),
  );

  // Feature: scaffold-demo-samples, Property 9: A path naming no file inside the Spa_Root is answered 404 by Microservice1
  it("GET/HEAD at a path naming no regular file → 404, body neither a listing nor index.html", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"get" | "head">("get", "head"),
        arbNoFilePath,
        async (verb, path) => {
          const res = await getBytes(server, verb, path);

          expect(res.status).toBe(404);
          // Body is not the Demo_Page's index.html bytes (no SPA-history
          // fallback — R7.7).
          expect(res.body.equals(indexBytes)).toBe(false);
          // Nor does it contain index.html's distinctive marker anywhere.
          expect(res.body.includes("INDEX_HTML_BODY")).toBe(false);
          // Nor is it a directory listing: for the directory cases, the body
          // must not enumerate the directory's real entries.
          const text = res.body.toString("utf8");
          expect(text.includes("app.js")).toBe(false);
          expect(text.includes("config")).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 10 — traversal / symlink escape is 404 and leaks nothing.
// ===========================================================================
describe("Property 10: a path resolving outside the Spa_Root is answered 404 and leaks no sentinel bytes", () => {
  /**
   * Escape mechanisms crossed with depth. Each mechanism, repeated `depth`
   * times where meaningful, must resolve outside the Spa_Root (or name a
   * symlink whose target is outside), and every one must answer 404 with a body
   * that never contains the sentinel's contents.
   */
  const arbEscape: fc.Arbitrary<string> = fc
    .tuple(
      fc.constantFrom<"dotdot" | "pct-full" | "pct-slash" | "absolute" | "symlink-file" | "symlink-dir">(
        "dotdot",
        "pct-full",
        "pct-slash",
        "absolute",
        "symlink-file",
        "symlink-dir",
      ),
      fc.integer({ min: 1, max: 5 }),
    )
    .map(([mechanism, depth]) => {
      switch (mechanism) {
        case "dotdot":
          // /../../../secret.txt
          return "/" + "../".repeat(depth) + "secret.txt";
        case "pct-full":
          // percent-encoded `..` segments: %2e%2e
          return "/" + "%2e%2e/".repeat(depth) + "secret.txt";
        case "pct-slash":
          // `..` with a percent-encoded slash: ..%2f
          return "/" + "..%2f".repeat(depth) + "secret.txt";
        case "absolute":
          // An absolute path segment naming the sentinel file directly.
          return join(sentinelRoot, "secret.txt");
        case "symlink-file":
          // A planted symlink whose target is the sentinel file itself.
          return "/escape-link";
        case "symlink-dir":
          // A planted symlink to the sentinel DIRECTORY, walked into.
          return "/dir-link/" + "sub/".repeat(depth - 1) + "secret.txt";
      }
    });

  // Feature: scaffold-demo-samples, Property 10: A path resolving outside the Spa_Root is answered 404 and leaks nothing
  it("every escape shape at depth 1–5 → 404, body never contains the sentinel contents", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"get" | "head">("get", "head"),
        arbEscape,
        async (verb, path) => {
          const res = await getBytes(server, verb, path);

          expect(res.status).toBe(404);
          // The sentinel's bytes never appear in the body.
          expect(res.body.includes(SENTINEL_MARKER)).toBe(false);
          expect(res.body.includes(sentinelBytes)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ===========================================================================
// Property 11 — HEAD mirrors GET's status and content type with an empty body.
// ===========================================================================
describe("Property 11: HEAD mirrors GET's status and content type with an empty body", () => {
  /**
   * A path shape drawing the Mount_Root, existing files (various extensions), a
   * directory, and missing paths — so the mirror is asserted across the whole
   * status range (200, 404).
   */
  // A distinctive prefix marks the generated-file shape, so the "ensure the file
  // exists" step below writes ONLY that shape's file and never collides with a
  // fixed fixture path or an existing directory.
  const MIRROR_FILE_PREFIX = "mirror-file-";
  const arbMirrorPath: fc.Arbitrary<string> = fc.oneof(
    fc.constantFrom("/", "/index.html", "/assets/app.js", "/microservice2"),
    fc.constantFrom("/assets", "/does-not-exist", "/nested/missing.js"),
    arbFilename.map((f) => `/${MIRROR_FILE_PREFIX}${f}`),
  );

  // Feature: scaffold-demo-samples, Property 11: HEAD mirrors GET's status and content type with an empty body
  it("HEAD returns GET's status and content type with an empty body", async () => {
    await fc.assert(
      fc.asyncProperty(arbMirrorPath, arbContents, async (path, contents) => {
        // For the generated-file shape ONLY, create the file with known bytes so a
        // 200 is possible. Every other shape is a fixed fixture and left untouched.
        const name = path.slice(1);
        if (name.startsWith(MIRROR_FILE_PREFIX)) {
          writeFileSync(join(spaRoot, name), contents);
        }

        const getRes = await getBytes(server, "get", path);
        const headRes = await getBytes(server, "head", path);

        expect(headRes.status).toBe(getRes.status);
        expect(bareContentType(headRes.headers)).toBe(bareContentType(getRes.headers));
        // HEAD carries no body.
        expect(headRes.body.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Property 12 — a query string changes nothing.
// ===========================================================================
describe("Property 12: a query string does not affect the response", () => {
  const arbQueryPath: fc.Arbitrary<string> = fc.constantFrom(
    "/",
    "/index.html",
    "/assets/app.js",
    "/microservice2",
    "/assets",
    "/does-not-exist",
    "/escape-link",
    "/../secret.txt",
  );

  const arbQueryString: fc.Arbitrary<string> = fc.oneof(
    fc.constant(""),
    fc.constant("?"),
    fc.constant("?a=1"),
    fc.constant("?a=1&b=two&c=%20"),
    fc
      .stringMatching(/^[a-zA-Z0-9=&_%-]*$/)
      .filter((s) => s.length <= 40)
      .map((s) => (s.length === 0 ? "?x=1" : `?${s}`)),
  );

  // Feature: scaffold-demo-samples, Property 12: A query string does not affect the response
  it("GET with any query string returns the same status, content type, and body as without it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"get" | "head">("get", "head"),
        arbQueryPath,
        arbQueryString,
        async (verb, path, query) => {
          const plain = await getBytes(server, verb, path);
          const withQuery = await getBytes(server, verb, `${path}${query}`);

          expect(withQuery.status).toBe(plain.status);
          expect(bareContentType(withQuery.headers)).toBe(bareContentType(plain.headers));
          expect(Buffer.compare(withQuery.body, plain.body)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ===========================================================================
// Peer-subtree cases (R7.14). No Overseer and no toggle is involved: in a
// Container holding no Microservice2/Microservice3, the paths `/microservice2`
// and `/microservice3/config` are simply paths Microservice1 owns, answered by
// its own router. Method decides first (405), then a GET/HEAD naming a real
// file inside the Spa_Root is 200, and a GET/HEAD naming no file is 404 — never
// 200-with-index.html.
// ===========================================================================
describe("Peer-subtree ownership (R7.14): paths under an absent microservice are Microservice1's own", () => {
  it("a non-GET/HEAD method at a peer path → 405 Allow: GET, HEAD", async () => {
    for (const path of ["/microservice2", "/microservice3/config", "/microservice3"]) {
      const res = await request(server).post(path);
      expect(res.status).toBe(405);
      expect(res.headers["allow"]).toBe("GET, HEAD");
    }
  });

  it("a GET/HEAD at a peer path naming a planted file inside the Spa_Root → 200", async () => {
    // `/microservice2` and `/microservice3/config` name real files ONLY because
    // beforeAll planted them there.
    const get2 = await getBytes(server, "get", "/microservice2");
    expect(get2.status).toBe(200);
    expect(get2.body.toString("utf8")).toBe("planted-at-peer-path");

    const head3 = await getBytes(server, "head", "/microservice3/config");
    expect(head3.status).toBe(200);
    expect(head3.body.length).toBe(0);

    const get3 = await getBytes(server, "get", "/microservice3/config");
    expect(get3.status).toBe(200);
    expect(get3.body.toString("utf8")).toBe("planted-nested-peer");
  });

  it("a GET/HEAD at a peer path naming no file → 404, never 200-with-index.html", async () => {
    // `/microservice3` is a directory (no regular file); an unplanted peer path
    // names nothing. Neither may answer 200 nor return index.html's bytes.
    for (const path of ["/microservice3", "/microservice2/nope", "/microservice4"]) {
      const res = await getBytes(server, "get", path);
      expect(res.status).toBe(404);
      expect(res.body.equals(indexBytes)).toBe(false);
      expect(res.body.includes("INDEX_HTML_BODY")).toBe(false);
    }
  });
});

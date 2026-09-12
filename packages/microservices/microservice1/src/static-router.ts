// @microservices/microservice1 — static content serving for the Demo_Spa.
//
// `createSpaRouter(spaRoot)` builds the Express router that serves the Demo_Spa's
// bundled output at Microservice1's Mount_Root `/` and owns every path under it
// (R7.5–R7.14, R8.1–R8.6). The Spa_Root is INJECTED rather than resolved here:
// `src/index.ts` is the single place resolution happens (R7.3, "exactly once"),
// and injection lets Microservice1's own test suite point a router at a temp
// directory it creates and deletes — the only practical way to drive R8.5 and
// R8.6 (the Spa_Root appearing and disappearing with no Overseer restart).
//
// SCAFFOLD-SAMPLE CHOICE — synchronous node:fs. The handler must reach a status
// before anything is written and every branch commits to one, so the reads are
// synchronous (`existsSync`, `realpathSync`, `statSync`, `readFileSync`). Blocking
// I/O per request is acceptable in a scaffold sample and is the FIRST thing a
// production adopter would replace. A two-argument handler additionally has no
// `next(err)` escape, so keeping I/O synchronous keeps the module free of the
// async error-forwarding path entirely.
//
// WHY NOT express.static. Three of its behaviours cannot be configured away and
// each is wrong here: it answers 403 (not 404) for a path that escapes the root;
// it follows symlinks and serves their target (no `denySymlinks` option); and it
// answers everything it does not serve with `next()` — which Subtree_Ownership
// forbids, because nothing may fall through to the Overseer. Hand-writing the
// handler needs no dependency beyond node:fs/node:path and keeps the traversal
// defence auditable in one place.

import express, { type Request, type Response } from "express";
import type { Router } from "@microservices/contracts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";


// R7.6: extension → content type. A frozen record keyed on the LOWER-CASED
// extension (as `extname` returns it, e.g. ".HTML" is lower-cased before lookup),
// with `application/octet-stream` as the default. Because the lookup reads the
// extension and nothing else, "the same content type for every request naming a
// file with the same extension" holds by construction. The mapped media types are
// BARE — no `; charset=...` — because R7.5 and R7.6 name bare media types; the
// Demo_Page carries its own `<meta charset="utf-8">`, so browser decoding is
// unaffected.
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
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
});

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function contentTypeOf(extension: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extension.toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

// Lexical containment: `p` is `root` itself or lies below it. Used twice — once on
// the resolved candidate path and once on the realpath — because the resolved
// Spa_Root may itself be a symlinked path in the workspace layout, so a realpath
// test alone would reject legitimate files while a lexical test alone would miss a
// symlink pointing out of the tree (design F5).
function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

// Serve one existing regular file for both the `/` case (step 4) and the general
// case (step 8): status 200, an explicit `Content-Type` from the extension with NO
// charset (`res.type(...)` would append `; charset=utf-8`), and — for HEAD — the
// same status and content type as GET with an empty body (R7.6, R7.9).
function serveFile(req: Request, res: Response, file: string): void {
  res.setHeader("Content-Type", contentTypeOf(extname(file)));
  res.status(200);
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(readFileSync(file));
  }
}

/**
 * Build the router that serves the Demo_Spa from `spaRoot` at Microservice1's
 * Mount_Root and owns every path under it.
 *
 * A SINGLE path-less `router.use(handler)` is registered. That form matches every
 * method and every path in the subtree, which mirrors the handler's totality
 * exactly. The handler takes only `(req, res)` and NO `next`: Subtree_Ownership
 * (R7.12) is then a structural property of the signature rather than a convention —
 * a two-argument handler has no way to defer, so a later edit cannot erode totality
 * by adding a fall-through, and a `next()` call is a COMPILE error rather than a
 * review finding.
 */
export function createSpaRouter(spaRoot: string): Router {
  const router = express.Router();

  router.use((req: Request, res: Response): void => {
    // STEP 1 — method admissibility, BEFORE any filesystem access (R7.11, R8.2).
    // Deciding the method first is what makes R7.11 one criterion rather than a
    // path-dependent split: the 405 is identical whether the path names a file, a
    // directory, nothing, an escaping path, or arrives while the Spa_Root is
    // absent. R8.2 is therefore the same step, not a separate branch.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.status(405).end();
      return;
    }

    // STEP 2 — the pathname comes from `req.path`, which excludes the query string
    // (R7.10), so a query string changes nothing about which file is selected.
    const pathname = req.path;

    // STEP 3 — evaluate the Spa_Root's `index.html` presence PER REQUEST (R7.3).
    // A single `existsSync` covers both halves of R8.1's definition of absence —
    // the directory does not exist, or exists but holds no `index.html`. Evaluating
    // it per request is what lets recovery work in both directions with no restart
    // and no intervening request (R8.5, R8.6): absent→present and present→absent
    // are observed on the very next request.
    const indexFile = join(spaRoot, "index.html");
    if (!existsSync(indexFile)) {
      if (pathname === "/") {
        // R8.1: 503 text/plain naming BOTH the resolved Spa_Root and the exact
        // build command. HEAD takes the same status and content type with an empty
        // body (R7.9 governs over R8.1's "GET or HEAD ... a body naming").
        res.setHeader("Content-Type", "text/plain");
        res.status(503);
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(
            `The Demo_Spa has not been built. Its Spa_Root ${spaRoot} holds no ` +
              `index.html. Build it with: npm run build --workspace @microservices/demo`,
          );
        }
        return;
      }
      // R8.3: any other path while the Spa_Root is absent → 404. The Spa_Root holds
      // no file that could be served, so the Mount_Root is the only path that
      // answers 503.
      res.status(404).end();
      return;
    }

    // STEP 4 — the Mount_Root with `index.html` present → serve it as text/html,
    // 200 (R7.5).
    if (pathname === "/") {
      serveFile(req, res, indexFile);
      return;
    }

    // STEP 5 — decode THEN normalise, THEN test lexical containment (R7.8).
    // `req.path` is not percent-decoded, so a `%2e%2e` segment would survive lexical
    // normalisation undetected; decoding first puts a percent-encoded `..` in the
    // SAME branch as a plain `..`. A malformed escape sequence (decodeURIComponent
    // throws) names no file, so it answers 404 here — Microservice1's own answer.
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.status(404).end();
      return;
    }
    const candidate = resolve(spaRoot, decoded.replace(/^\/+/, ""));
    if (!isInside(spaRoot, candidate)) {
      // Lexical escape (`..`, an absolute segment) → 404, empty body (R7.8).
      res.status(404).end();
      return;
    }

    // STEP 6 — realpath the candidate and test containment against the realpath of
    // the Spa_Root (R7.8, symlink escape). Two containment tests are needed because
    // the resolved Spa_Root may itself be a symlinked path (workspace layout), so a
    // lexical test on the resolved path AND a realpath test are both required. An
    // ENOENT here (the candidate names nothing) answers 404 (R7.7). A filesystem
    // error OTHER than "does not exist" is DELIBERATELY not caught, so it propagates
    // to Express's error handler as Microservice1's own 500 rather than being hidden
    // as a 404.
    let real: string;
    let realRoot: string;
    try {
      real = realpathSync(candidate);
      realRoot = realpathSync(spaRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The candidate names no file inside the Spa_Root (R7.7) → 404. Two codes
      // both mean exactly that: ENOENT (a segment does not exist) and ENOTDIR (a
      // path segment names a regular file used as if it were a directory, e.g.
      // `/microservice2/nope` where `microservice2` is a file). Both are "names
      // no file", so both answer 404 rather than propagating as a 500. Any OTHER
      // filesystem error is left uncaught, surfacing as Microservice1's own 500.
      if (code === "ENOENT" || code === "ENOTDIR") {
        res.status(404).end();
        return;
      }
      throw error;
    }
    if (!isInside(realRoot, real)) {
      // A symlink whose target lies outside the Spa_Root → 404, empty body (R7.8).
      res.status(404).end();
      return;
    }

    // STEP 7 — not a regular file (e.g. a directory) → 404, emitting NEITHER a
    // directory listing NOR index.html (R7.7). No SPA-history fallback: that is
    // what keeps a path naming no file a 404 rather than a 200 carrying the
    // Demo_Page.
    if (!statSync(real).isFile()) {
      res.status(404).end();
      return;
    }

    // STEP 8 — serve the file: 200, explicit Content-Type from the extension with no
    // charset, empty body for HEAD with the same status and content type as GET
    // (R7.6, R7.9).
    serveFile(req, res, real);
  });

  return router;
}

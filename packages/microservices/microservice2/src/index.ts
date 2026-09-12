import express from "express";
import type { MicroserviceModule } from "@microservices/contracts";
import { buildConfigPayload } from "@microservices/config";

// The full HTTP path at which the Overseer mounts this microservice's router.
// No identifier is exported: the directory name is the authoritative
// Microservice_Identifier (R1.1) and the generated registry carries it.
export const path = "/microservice2";

/**
 * Builds the Express router for microservice2.
 *
 * --- Registration order (Subtree_Ownership, R3.11, R3.12) -----------------
 * The handlers below are registered in this exact order (Express walks
 * handlers in registration order):
 *   1. root GET        — identifier response at the Mount_Root (R2.1-2.3, R3.6)
 *   2. /config GET      — base Config_Payload (R3.4)
 *   3. /config ALL      — 405 Allow: GET for non-GET methods at /config (R3.9)
 *   4. root ALL         — 405 Allow: GET for non-GET methods at the Mount_Root
 *   5. terminal USE     — 404 for every other path in the Owned_Subtree (R3.11)
 *
 * The terminal `router.use` MUST be registered LAST. A path-less `router.use`
 * matches EVERY path and EVERY method, so registering it any earlier would
 * shadow the handlers above it — it would answer 404 at `/config` and at the
 * Mount_Root too, before the real handlers were reached. Placed last, it
 * catches only what none of the four handlers above served.
 *
 * The terminal handler is deliberately method-agnostic: the `Allow: GET`
 * policy attaches to the two paths this microservice actually serves (the
 * Mount_Root and `/config`), while any other path in the Owned_Subtree answers
 * 404 whatever the method (R3.12).
 *
 * Microservice2 keeps returning the base Config_Payload (R3.4) — the side-by-
 * side comparison with Microservice3's Extended_Config_Payload is the sample.
 */
function createRouter(): express.Router {
  const router = express.Router();

  // 1. R2.1/R2.2/R2.3: GET at the mount root returns the identifier response.
  // The object literal carries EXACTLY the two required keys — no additional
  // fields — so R2.2's "no additional fields" clause is structurally enforced.
  // The name is a literal (no identifier export exists); `path` references the
  // exported constant the Overseer mounts at, so the body agrees with the mount
  // point by construction.
  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({ "microservice-name": "microservice2", path });
  });

  // 2. R3.4: a microservice-owned sub-endpoint under the mount subtree. The
  // base Config_Payload comes from the shared @microservices/config helper
  // (imported by package name only); the body is byte-equivalent to the prior
  // inline literal by construction. Registered AFTER the root GET and BEFORE
  // the ALL / 405 fallbacks so route matching order is preserved.
  router.get("/config", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json(buildConfigPayload("microservice2", path));
  });

  // 3. R3.9: 405 fallback for non-GET methods at /config. Registered AFTER the
  // /config GET so Express dispatches GET (and HEAD, which Express routes
  // through the registered GET handler) to the handler above and every other
  // method here. The empty body carries no Config_Payload.
  router.all("/config", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  // 4. R2.4: 405 fallback for non-GET methods at the mount root. Registered
  // AFTER the root GET so GET/HEAD reach the identifier handler above and every
  // other method reaches this one.
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  // 5. Terminal catch-all: every path in microservice2's Owned_Subtree that the
  // four handlers above do not serve is answered 404 by microservice2 itself,
  // for any method, instead of reaching the Overseer's catch-all (R3.11,
  // R3.12 — Subtree_Ownership). MUST be registered LAST (see the note above).
  router.use((_req, res) => {
    res.status(404).end();
  });

  return router;
}

// The Express router owning the entire subtree rooted at `path`.
export const router: express.Router = createRouter();

// Compile-time assertion that this module conforms to MicroserviceModule (R8.1).
const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;

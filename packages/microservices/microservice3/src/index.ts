// @microservices/microservice3 — reference microservice.
// Exports the two required MicroserviceModule values (R8.1): `path` and an
// Express `router` satisfying the R2 contract. The identifier is not exported —
// the directory name is the authoritative Microservice_Identifier and the
// generated registry carries it.
import express from "express";
import type { MicroserviceModule, Router } from "@microservices/contracts";
import { buildExtendedConfigPayload } from "@microservices/extended-config";

export const path: string = "/microservice3";

function createRouter(): Router {
  const router = express.Router();

  // --- Registration order (Subtree_Ownership, R3.10, R3.12) ---------------
  // The handlers below are registered in this exact order:
  //   1. root GET        — identifier response at the Mount_Root
  //   2. /config GET      — Extended_Config_Payload
  //   3. /config ALL      — 405 Allow: GET for non-GET methods at /config
  //   4. root ALL         — 405 Allow: GET for non-GET methods at the Mount_Root
  //   5. terminal USE     — 404 for every other path in the Owned_Subtree
  //
  // The terminal `router.use` MUST be registered LAST. A path-less
  // `router.use` matches EVERY path and EVERY method, so registering it any
  // earlier would shadow the handlers above it — it would answer 404 at
  // `/config` and at the Mount_Root too, before the real handlers were
  // reached. Placed last, it catches only what none of the four handlers
  // above served.
  //
  // The terminal handler is deliberately method-agnostic: the `Allow: GET`
  // policy attaches to the two paths this microservice actually serves (the
  // Mount_Root and `/config`), while any other path in the Owned_Subtree
  // answers 404 whatever the method (R3.12).

  // 1. Root identifier response for a GET at the mount point (R2.1, R2.2, R2.3,
  // R3.6). The body is constructed with exactly the two required keys so R2.2's
  // "no additional fields" clause is structurally enforced. The name is a
  // literal; `path` references the exported constant the Overseer mounts at.
  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({ "microservice-name": "microservice3", path });
  });

  // 2. A microservice-owned sub-endpoint under the mount subtree (R3.3). The
  // payload is built by the @microservices/extended-config helper (imported by
  // package name only), making microservice3 a consumer of the layered config
  // concern — it reaches @microservices/config transitively, never directly.
  // Registered AFTER the root GET and BEFORE the ALL / 405 fallbacks so route
  // matching order is preserved.
  router.get("/config", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json(buildExtendedConfigPayload("microservice3", path));
  });

  // 3. 405 fallback for non-GET methods at /config (R3.8). Registered AFTER the
  // /config GET so Express dispatches GET (and HEAD, which Express routes
  // through the registered GET handler) to the handler above and every other
  // method here. The empty body carries no Extended_Config_Payload.
  router.all("/config", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  // 4. 405 fallback for non-GET methods at the mount root (R3.7). Registered
  // AFTER the root GET so GET/HEAD reach the identifier handler above and every
  // other method reaches this one.
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  // 5. Terminal catch-all: every path in microservice3's Owned_Subtree that the
  // four handlers above do not serve is answered 404 by microservice3 itself,
  // for any method, instead of reaching the Overseer's catch-all (R3.10,
  // R3.12 — Subtree_Ownership). MUST be registered LAST (see the note above).
  router.use((_req, res) => {
    res.status(404).end();
  });

  return router;
}

export const router: Router = createRouter();

// Compile-time confirmation that the exports satisfy the module contract.
const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;

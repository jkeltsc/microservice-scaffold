// @microservices/microservice3 — reference microservice.
// Exports the two required MicroserviceModule values (R8.1): `path` and an
// Express `router` satisfying the R2 contract. The identifier is not exported —
// the directory name is the authoritative Microservice_Identifier and the
// generated registry carries it.
import express from "express";
import type { MicroserviceModule, Router } from "@microservices/contracts";
import { buildConfigPayload } from "@microservices/config";

export const path: string = "/microservice3";

function createRouter(): Router {
  const router = express.Router();

  // Root identifier response for a GET at the mount point (R2.1, R2.2, R2.3).
  // The body is constructed with exactly the two required keys so R2.2's
  // "no additional fields" clause is structurally enforced. The name is a
  // literal; `path` references the exported constant the Overseer mounts at.
  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({ "microservice-name": "microservice3", path });
  });

  // A microservice-owned sub-endpoint under the mount subtree (R13). The
  // payload is built by the shared @microservices/config helper (imported by
  // package name only), making microservice3 a second consumer of the shared
  // config concern. Registered AFTER the root GET and BEFORE the ALL / 405
  // fallback so route matching order is preserved: the mount-root fallback is
  // mount-root only and does not shadow /config.
  router.get("/config", (_req, res) => {
    res.status(200).type("application/json").json(buildConfigPayload("microservice3", path));
  });

  // 405 fallback for non-GET methods at the mount root (R2.4). Registered
  // AFTER the GET so Express dispatches GETs to the handler above and every
  // other method to this handler.
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  return router;
}

export const router: Router = createRouter();

// Compile-time confirmation that the exports satisfy the module contract.
const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;

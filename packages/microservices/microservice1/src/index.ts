// @microservices/microservice1 — reference microservice module.
//
// Exports the two values required by the MicroserviceModule contract (R8.1): a
// Microservice_Path string and an Express router. The identifier is NOT exported:
// the directory name is the authoritative Microservice_Identifier, and the
// generated registry carries it. The router satisfies Requirement 2 for this
// microservice: a GET at the mount root returns the identifier response (R2.1,
// R2.2, R2.3), and any non-GET method at the mount root returns 405 with
// `Allow: GET` (R2.4).

import express, { type Router } from "express";
import type { MicroserviceModule } from "@microservices/contracts";

export const path = "/";

/**
 * Build this microservice's Express router.
 *
 * The `router.all("/", ...)` 405 fallback is registered AFTER the
 * `router.get("/", ...)` handler so Express dispatches GETs to the identifier
 * handler and every other method to the 405 fallback (Express walks handlers
 * in registration order and the GET handler has already responded for GET
 * requests).
 */
function createRouter(): Router {
  const router = express.Router();

  // R2.1, R2.2, R2.3: GET at the mount root returns 200 application/json with
  // a body containing EXACTLY the two keys "microservice-name" and "path".
  // The object literal is constructed with only those two keys (no spread) so
  // R2.2's "no additional fields" clause is structurally enforced.
  //
  // The name is a literal because the module no longer exports an identifier;
  // `path` stays a reference to the exported constant, because that constant is
  // the contract the Overseer mounts at, so the body agrees with it by
  // construction.
  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({ "microservice-name": "microservice1", path });
  });

  // R2.4: any non-GET method at the mount root returns 405 with Allow: GET.
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  return router;
}

export const router: Router = createRouter();

// Compile-time confirmation that the exports satisfy the module contract.
const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;

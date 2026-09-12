// @microservices/microservice1 — reference microservice module.
//
// Exports the two values required by the MicroserviceModule contract (R7.2): a
// Microservice_Path string and an Express router. The identifier is NOT exported:
// the directory name is the authoritative Microservice_Identifier, and the
// generated registry carries it.
//
// Microservice1 serves the Demo_Spa's bundled output at its Mount_Root `/` and
// owns the entire subtree rooted there (Requirement 7). This module is the SINGLE
// place the Spa_Root is resolved — `resolveSpaRoot()` runs exactly once, here, at
// module init (R7.3, "determine the Spa_Root exactly once") — while the router it
// injects into evaluates the Spa_Root's presence and each requested file PER
// REQUEST inside its handler. Resolution happens once; presence is checked every
// time.
//
// METHOD POLICY — Microservice1 answers a method it does not serve with
// `405 Allow: GET, HEAD` (the policy lives entirely inside createSpaRouter's
// handler). This DELIBERATELY differs from Microservice2's and Microservice3's
// `405 Allow: GET`: a method policy is the owning microservice's own choice, not a
// framework rule. A template reader should read the difference as intentional — the
// framework obligation (Subtree_Ownership) is that the microservice answers rather
// than defers; which status and Allow header it answers with is its own.

import type { MicroserviceModule, Router } from "@microservices/contracts";
import { resolveSpaRoot } from "./spa-root.js";
import { createSpaRouter } from "./static-router.js";

export const path = "/";

// Resolve the Spa_Root exactly once at module init, then build the router around
// it. The router owns per-request presence and file evaluation (R7.3, R7.5–R7.14).
export const router: Router = createSpaRouter(resolveSpaRoot());

// Compile-time confirmation that the exports satisfy the module contract.
const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;

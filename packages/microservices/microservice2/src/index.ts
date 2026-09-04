import express from "express";
import type { MicroserviceModule } from "@scaffold/contracts";

// The full HTTP path at which the Overseer mounts this microservice's router.
// No identifier is exported: the directory name is the authoritative
// Microservice_Identifier (R1.1) and the generated registry carries it.
export const path = "/microservice2";

/**
 * Builds the Express router for microservice2.
 *
 * Registration order matters (Express walks handlers in registration order):
 *   1. `GET /`        -> identifier response (R2.1, R2.2, R2.3)
 *   2. `GET /config`  -> microservice-owned sub-endpoint (R2.6)
 *   3. `ALL /`        -> 405 fallback for non-GET methods at the mount root (R2.4)
 *
 * The `all("/")` fallback is mount-root only, so it does not shadow `/config`.
 */
function createRouter(): express.Router {
  const router = express.Router();

  // R2.1/R2.2/R2.3: GET at the mount root returns the identifier response.
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

  // R2.6: a microservice-owned sub-endpoint under the mount subtree. The exact
  // payload shape is illustrative; the contract only requires a JSON object.
  router.get("/config", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({
        "microservice-name": "microservice2",
        path,
        config: {
          sampleSetting: "example-value",
          description: "demonstration sub-endpoint",
        },
      });
  });

  // R2.4: non-GET methods at the mount root get 405 with `Allow: GET`.
  // Registered AFTER the root GET, so GET requests are already handled above.
  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  return router;
}

// The Express router owning the entire subtree rooted at `path`.
export const router: express.Router = createRouter();

// Compile-time assertion that this module conforms to MicroserviceModule (R8.1).
const _moduleShapeCheck: MicroserviceModule = { path, router };
void _moduleShapeCheck;

// @scaffold/overseer — Express mount table construction.
//
// Implements design "Overseer Startup Sequence" step 5 and "Request Routing",
// satisfying Requirements R3.1 (single HTTP server / app), R3.2 (forward to the
// matching enabled microservice's router), R3.3 (404 for uncovered paths), R4.2
// (disabled microservices are not mounted, so their subtree 404s via the same
// fallback), and R4.4 (toggles are evaluated once at boot; this function only
// mounts the already-enabled entries).
//
// Express conventions (jk-express):
//   - x-powered-by disabled (information-leakage prevention).
//   - X-Clacks-Overhead header on every response.
//   - JSON pretty-printing (json spaces = 2).
//
// `buildApp` constructs an `express()` application and, for each ENABLED
// `RegistryEntry`, mounts its router at its declared path via
// `app.use(entry.module.path, entry.module.router)`. Mounts are applied in a
// deterministic order — by path length descending — purely for debuggability.
// Parent/child path overlaps (e.g. `/api` and `/api/v2`) are a valid Express
// topology because `buildApp` sorts mounts by path length descending, so the
// longer mount always wins for its subtree. Only exact duplicates are rejected
// (by boot step 3).
//
// The mount stack is: Express defaults → enabled mounts (longest first) → 404
// fallback.

import express from "express";
import type { MicroserviceRegistry, ToggleMap } from "@scaffold/contracts";

/**
 * Build the Overseer's Express application from the loaded microservice
 * registry and the evaluated toggle map.
 *
 * Only microservices whose evaluated toggle is enabled
 * (`toggleMap.enabled.get(identifier) === true`) are mounted. Enabled entries
 * are mounted in path-length-descending order (ties broken lexicographically
 * for determinism). Parent/child path overlaps (e.g. `/api` and `/api/v2`) are
 * a valid Express topology because the longer mount always wins for its subtree.
 *
 * The resulting mount stack, in registration order, is:
 *   0. Express defaults (x-powered-by off, X-Clacks-Overhead, json spaces),
 *   1. one `app.use(path, router)` per enabled microservice (longest path first),
 *   2. `app.use(...)` app-level 404 catch-all.
 *
 * @param microserviceRegistry - The generated microservice registry for this Container.
 * @param toggleMap - The evaluated toggle map produced during boot.
 * @returns The configured Express application, ready to be handed to `app.listen`.
 */
export function buildApp(
  microserviceRegistry: MicroserviceRegistry,
  toggleMap: ToggleMap,
): express.Express {
  const app = express();

  // Express conventions (jk-express): suppress the X-Powered-By header, add
  // the X-Clacks-Overhead header to every response, and pretty-print JSON.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Clacks-Overhead", "GNU Terry Pratchett");
    next();
  });
  app.set("json spaces", 2);

  // Select only the enabled entries, then mount them in a deterministic order:
  // path length descending, with lexicographic ordering as a stable tiebreak.
  // Parent/child overlaps (e.g. /api and /api/v2) are safe: the longer mount
  // is registered first and wins for its subtree.
  const enabledEntries = microserviceRegistry
    .filter((entry) => toggleMap.enabled.get(entry.identifier) === true)
    .slice()
    .sort((a, b) => {
      const byLength = b.module.path.length - a.module.path.length;
      if (byLength !== 0) return byLength;
      return a.module.path.localeCompare(b.module.path);
    });

  for (const entry of enabledEntries) {
    app.use(entry.module.path, entry.module.router);
  }

  // App-level 404 catch-all: any path not covered by an enabled mount (unknown
  // path R3.3, or disabled-microservice subtree R4.2) receives an empty-body
  // 404.
  app.use((_req, res) => {
    res.status(404).end();
  });

  return app;
}

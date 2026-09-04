// Task 12.7* — Collision-abort integration.
//
// Builds a synthetic registry with two DISTINCT-identifier modules that share
// the SAME Microservice_Path, then runs the Overseer boot pipeline and asserts
// the pipeline REFUSES to start: the result is a failure whose messages name the
// colliding path and both declaring identifiers (R9.4). Because a path collision
// aborts startup before the HTTP server binds, this validates R9.3 (abort before
// accepting requests, non-zero outcome) and R9.5 (the prefix-collision rule, of
// which "p1 === p2" is the simplest case).
//
// Approach — IN-PROCESS boot pipeline (primary):
//   The Overseer's boot() is a pure function of an injected registry + env; it
//   performs no process.exit and no stderr writes, returning a discriminated
//   BootResult ({ ok: false, messages } on failure). Driving boot() directly
//   with a hand-built colliding registry is deterministic and needs no
//   regenerated registry file or child-process spawn. index.ts is the thin shell
//   that turns { ok: false } into a non-zero exit + stderr; boot()'s failure
//   result faithfully captures that abort condition.
//
//   The synthetic modules are built with buildExpressRouter (real Express
//   routers) and paths starting with "/", so they pass boot's module-shape
//   validation (step 2), letting the pipeline reach the collision step (step 3)
//   with a genuine PATH collision. Each entry carries its identifier the same
//   way the generator emits it.
//
// Validates: Requirements R9.3, R9.4, R9.5

import { describe, it, expect } from "vitest";
import { buildExpressRouter } from "@microservices/contracts/testing";
import type { MicroserviceRegistry } from "@microservices/contracts";

// boot() is a pure composition helper on the Overseer; reach into its compiled
// leaf module (the package `main` auto-boots a live server on import, so we
// import the deep dist path instead, mirroring tests/helpers.ts).
import { boot } from "@microservices/overseer/dist/boot.js";

const SHARED_PATH = "/collide";

/**
 * Two microservices with DISTINCT identifiers but the SAME path — a path
 * collision under R9.5's `p1 === p2` case. Both are otherwise valid so the boot
 * pipeline reaches the collision-detection step.
 */
function collidingRegistry(): MicroserviceRegistry {
  return [
    {
      identifier: "servicea",
      sourcePackage: "@microservices/servicea",
      module: {
        path: SHARED_PATH,
        router: buildExpressRouter("servicea", SHARED_PATH),
      },
    },
    {
      identifier: "serviceb",
      sourcePackage: "@microservices/serviceb",
      module: {
        path: SHARED_PATH,
        router: buildExpressRouter("serviceb", SHARED_PATH),
      },
    },
  ];
}

describe("collision-abort integration (two modules share a path)", () => {
  it("refuses to boot and reports the path collision naming both paths and identifiers (R9.3, R9.4, R9.5)", () => {
    // A minimal, complete environment so the toggle step (which would run only
    // if collision detection passed) is never the cause of failure. Collision
    // detection runs BEFORE toggle validation, so these are belt-and-braces.
    const env: NodeJS.ProcessEnv = {
      MICROSERVICE_SERVICEA_ENABLED: "enabled",
      MICROSERVICE_SERVICEB_ENABLED: "enabled",
    };

    const result = boot({ microserviceRegistry: collidingRegistry(), env });

    // The pipeline aborts: no app is produced (the HTTP server never binds).
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrows the union for TypeScript

    // A path-collision line is present (R9.4).
    const pathLines = result.messages.filter((m) =>
      m.includes("[collision:path]"),
    );
    expect(pathLines.length).toBeGreaterThanOrEqual(1);

    // The collision message names the shared path and BOTH declaring identifiers
    // (R9.4 requires identifying every colliding path and the modules that
    // declared it).
    const joined = result.messages.join("\n");
    expect(joined).toContain(SHARED_PATH);
    expect(joined).toContain("servicea");
    expect(joined).toContain("serviceb");
  });

  it("boots successfully when the two modules use distinct, non-colliding paths (control)", () => {
    // Control case: same modules but distinct paths -> the collision step passes
    // and, with complete valid toggles, the pipeline produces a bound-ready app.
    const microserviceRegistry: MicroserviceRegistry = [
      {
        identifier: "servicea",
        sourcePackage: "@microservices/servicea",
        module: {
          path: "/servicea",
          router: buildExpressRouter("servicea", "/servicea"),
        },
      },
      {
        identifier: "serviceb",
        sourcePackage: "@microservices/serviceb",
        module: {
          path: "/serviceb",
          router: buildExpressRouter("serviceb", "/serviceb"),
        },
      },
    ];
    const env: NodeJS.ProcessEnv = {
      MICROSERVICE_SERVICEA_ENABLED: "enabled",
      MICROSERVICE_SERVICEB_ENABLED: "enabled",
    };

    const result = boot({ microserviceRegistry, env });
    expect(result.ok).toBe(true);
  });
});

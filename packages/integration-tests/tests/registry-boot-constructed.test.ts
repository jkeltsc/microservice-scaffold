// Constructed-module equivalent of `registry-boot-equivalence.property.test.ts`
// and `registry-mounted-paths.property.test.ts` (task 7.5, R13.4).
//
// WHY THIS SUITE EXISTS
// ---------------------------------------------------------------------------
// The payload-coupled registry-boot claim — that the Overseer's `boot` pipeline,
// run over a registry, reports a RegisteredMicroserviceInfo table reflecting
// that registry (every entry's identifier and declared path, and whether its
// toggle evaluated enabled), and that only the enabled entries are mounted — is
// asserted by the registry properties over registries whose entries are paired
// with the REAL reference microservices' scoped source packages and paths.
//
// R13.4 requires that mounting/routing/toggle claim to survive the payload's
// departure by asserting it over microservice modules the test itself
// CONSTRUCTS. This suite is that equivalent for registry-boot: it constructs
// registry entries and asserts `boot`'s BootResult reflects the constructed
// registry.
//
// WHAT IS CONSTRUCTED, AND WHAT IS NOT READ
// ---------------------------------------------------------------------------
// Every RegistryEntry below is built here from an invented identifier, an
// invented Microservice_Path constant, and a real `express.Router()`. The
// registry is passed to `boot` as its `microserviceRegistry` argument, with a
// constructed `env` supplying each entry's MICROSERVICE_<ID>_ENABLED toggle.
// Nothing is read from disk, no Generated_Registry is generated or parsed, and
// no payload `modules` microservice is used. `boot` is the pure pipeline — it
// binds no socket and `startServer` is never called — so this suite spawns
// nothing and occupies no port. The identifiers and paths name no committed
// payload package (R13.7).
//
// Validates: Requirements 13.1, 13.2, 13.4, 13.7

import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import type {
  MicroserviceRegistry,
  RegistryEntry,
} from "@microservices/contracts";
import { boot } from "@microservices/overseer";

// ---------------------------------------------------------------------------
// Constructed registry entries — built here, read from nowhere.
// ---------------------------------------------------------------------------

/** Construct a RegistryEntry: an invented identifier, path, and a real router. */
function constructedEntry(identifier: string, path: string): RegistryEntry {
  const router = express.Router();
  router.get("/", (_req, res) => {
    res.status(200).type("application/json").json({ path });
  });
  return {
    identifier,
    module: { path, router },
    sourcePackage: `@constructed/${identifier}`,
  };
}

/** The toggle variable name for an identifier: `MICROSERVICE_<UPPER>_ENABLED`. */
function toggleVar(identifier: string): string {
  return `MICROSERVICE_${identifier.toUpperCase()}_ENABLED`;
}

/**
 * An environment enabling exactly the given identifiers and disabling the rest,
 * built here from the fixed accepted toggle tokens.
 */
function envFor(
  all: ReadonlyArray<string>,
  enabled: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    all.map((identifier) => [
      toggleVar(identifier),
      enabled.includes(identifier) ? "enabled" : "disabled",
    ]),
  );
}

// The constructed registry: three entries on distinct paths, invented here.
const ENTRIES = [
  { identifier: "alpha", path: "/alpha" },
  { identifier: "bravo", path: "/bravo" },
  { identifier: "charlie", path: "/charlie" },
] as const;

const ALL_IDS = ENTRIES.map((e) => e.identifier);

function registry(): MicroserviceRegistry {
  return ENTRIES.map((e) => constructedEntry(e.identifier, e.path));
}

describe("registry-boot over a CONSTRUCTED registry (R13.4)", () => {
  // boot's result reflects the constructed registry: one RegisteredMicroserviceInfo
  // per entry, in registry order, each naming that entry's identifier and its
  // constructed Microservice_Path, with `enabled` reflecting the toggle env.
  it("reports a RegisteredMicroserviceInfo table reflecting the constructed registry", () => {
    const enabled = ["alpha", "charlie"];
    const result = boot({
      microserviceRegistry: registry(),
      env: envFor(ALL_IDS, enabled),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every constructed entry appears, in registry order, with its identifier,
    // its constructed path, and the toggle state the env supplied.
    expect(result.registeredMicroservices).toEqual(
      ENTRIES.map((e) => ({
        identifier: e.identifier,
        path: e.path,
        enabled: enabled.includes(e.identifier),
      })),
    );

    // The enabled-identifier list is exactly the enabled subset, in registry
    // order.
    expect(result.enabledIdentifiers).toEqual(
      ALL_IDS.filter((id) => enabled.includes(id)),
    );
  });

  // The mounted set is a function of the toggles: only enabled entries are
  // served, evidenced through the app boot builds. A disabled entry's subtree
  // 404s; an enabled one's Mount_Root is dispatched.
  it("mounts only the enabled constructed entries in the app boot builds", async () => {
    const enabled = ["bravo"];
    const result = boot({
      microserviceRegistry: registry(),
      env: envFor(ALL_IDS, enabled),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // `boot` returns a composed but unbound Express app; supertest binds an
    // ephemeral server per call, so no socket is held across the suite.
    expect((await request(result.app).get("/bravo")).status).not.toBe(404);
    expect((await request(result.app).get("/alpha")).status).toBe(404);
    expect((await request(result.app).get("/charlie")).status).toBe(404);
  });

  // A registry with two entries declaring the SAME path is an ambiguous mount
  // table: boot reports the collision naming both identifiers and does not
  // succeed — asserted here over CONSTRUCTED entries.
  it("refuses to boot a constructed registry with a colliding path, naming both entries", () => {
    const colliding: MicroserviceRegistry = [
      constructedEntry("dupa", "/same"),
      constructedEntry("dupb", "/same"),
    ];
    const result = boot({
      microserviceRegistry: colliding,
      env: envFor(["dupa", "dupb"], ["dupa", "dupb"]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.messages.join("\n");
    expect(joined).toContain("/same");
    expect(joined).toContain("dupa");
    expect(joined).toContain("dupb");
  });
});

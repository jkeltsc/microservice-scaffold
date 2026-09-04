// Shared helpers for the cross-package integration suites (tasks 12.2-12.7).
//
// These helpers build an in-process Overseer Express app from the REAL
// reference microservice modules, so the integration tests exercise the actual
// routing and 404/405 behavior end-to-end without depending on the gitignored
// generated registry file. The overseer's `buildApp` is imported via its
// compiled deep path because the overseer package's `main` entry auto-boots a
// live server on import.

import * as microservice1 from "@microservices/microservice1";
import * as microservice2 from "@microservices/microservice2";
import * as microservice3 from "@microservices/microservice3";
import type {
  MicroserviceModule,
  MicroserviceRegistry,
  RegistryEntry,
  ToggleMap,
} from "@microservices/contracts";

// The overseer package's `main` (dist/index.js) runs its boot pipeline on
// import, so we reach into its compiled leaf modules for the pure composition
// helpers used by the tests.
export { buildApp } from "@microservices/overseer/dist/router.js";

/** The three real reference microservice modules, keyed for convenience. */
export const modules = {
  microservice1: microservice1 as unknown as MicroserviceModule,
  microservice2: microservice2 as unknown as MicroserviceModule,
  microservice3: microservice3 as unknown as MicroserviceModule,
} as const;

/**
 * Build a synthetic {@link MicroserviceRegistry} from a set of real reference
 * microservice modules. This mirrors the shape the build-tools generator emits
 * (`{ identifier, module, sourcePackage }` rows) but is assembled in-process so
 * tests never depend on the generated `microservice-registry.ts`.
 */
export function makeRegistry(
  ids: ReadonlyArray<keyof typeof modules>,
): MicroserviceRegistry {
  return ids.map((id): RegistryEntry => ({
    // The key in `modules` is the microservice's directory name, which is the
    // authoritative identifier the real generator emits on each entry.
    identifier: id,
    module: modules[id],
    sourcePackage: `@microservices/${id}`,
  }));
}

/**
 * Build a {@link ToggleMap} from an explicit identifier -> enabled mapping.
 * Identifiers absent from the mapping are treated as disabled.
 */
export function makeToggleMap(
  entries: Readonly<Record<string, boolean>>,
): ToggleMap {
  return { enabled: new Map(Object.entries(entries)) };
}

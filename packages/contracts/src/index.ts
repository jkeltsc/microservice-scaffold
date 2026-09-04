// @microservices/contracts — shared TypeScript types.
// Public API is limited to what this module re-exports.

import type { Router } from "express";

// Re-export the Express Router type so consumers can reference it without a
// direct dependency on express in their own type surface.
export type { Router } from "express";

// The shape every microservice module MUST export (R8.1, R8.5).
//
// A microservice does NOT declare its own identifier: the directory name under
// packages/microservices/ is the authoritative identifier, and the registry
// generator emits it on the RegistryEntry below. The module surface is limited
// to the two values only the microservice itself can decide.
export interface MicroserviceModule {
  readonly path: string; // starts with "/"
  readonly router: Router; // Express router owning the subtree at `path`
}

// One entry in the generated registry
export interface RegistryEntry {
  readonly identifier: string; // the microservice's directory name, emitted by the generator
  readonly module: MicroserviceModule;
  readonly sourcePackage: string; // e.g. "@microservices/microservice1"; used only in diagnostics
}

// The generated registry type
export type MicroserviceRegistry = ReadonlyArray<RegistryEntry>;

// The parsed selector type used to live here. It moved to
// packages/build-tools/src/selector.ts as a local, non-exported declaration:
// once `parseSelector` stopped being exported, the only consumer of the parsed
// shape was the one function that produces it, and a cross-package contract
// type with a single module-internal consumer is not a contract.

// The parsed toggle map used by the Overseer at runtime
export interface ToggleMap {
  // key: microservice identifier; value: evaluated boolean
  readonly enabled: ReadonlyMap<string, boolean>;
}


// @microservices/config — the Sample_Shared_Package.
//
// A shared package is a leaf library: it points downward only (third-party deps
// and other shared packages) and never imports from any microservice or from
// the Overseer (R3.4, R11.4). Its public API is limited to what this barrel
// re-exports (R11.3) — nothing else in the package is stable.

import type { MicroserviceModule } from "@microservices/contracts";

// A real config→contracts shared-package dependency edge (R11 note): the
// Config_Payload's `path` reuses the microservice module's `path` type, so the
// payload shape is anchored to the same contract a microservice mounts at.
type MicroservicePath = MicroserviceModule["path"];

/** The illustrative settings block shared by config consumers. */
export interface SampleConfig {
  readonly sampleSetting: string;
  readonly description: string;
}

/** The full Config_Payload body a consumer returns from GET /config. */
export interface ConfigPayload {
  readonly "microservice-name": string;
  readonly path: MicroservicePath;
  readonly config: SampleConfig;
}

/** The shared sample settings — the single source of truth. */
export const sampleConfig: SampleConfig = {
  sampleSetting: "example-value",
  description: "demonstration sub-endpoint",
};

/**
 * Build the Config_Payload for a consuming microservice. The `name`/`path`
 * come from the caller (each microservice owns its own identity); the `config`
 * block is the shared `sampleConfig`.
 */
export function buildConfigPayload(name: string, path: string): ConfigPayload {
  return { "microservice-name": name, path, config: sampleConfig };
}

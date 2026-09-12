// @microservices/extended-config — the Extended_Config_Package barrel.
//
// This package is a leaf Common_Package that points downward only: it depends on
// @microservices/config by package name and never imports from a microservice or
// the Overseer (R1.5, R1.6). Its public API is limited to what this barrel
// exports (R1.4).
//
// Every type this package needs arrives through @microservices/config's barrel,
// which already anchors ConfigPayload["path"] to MicroserviceModule["path"], so
// no @microservices/contracts dependency is declared.
//
// This barrel DEFINES its four exports and re-exports NOTHING from
// @microservices/config: a consumer wanting the base surface declares the base
// package. Re-exporting would make the extended barrel a second, competing entry
// point to the base API.

import {
  buildConfigPayload,
  sampleConfig,
  type ConfigPayload,
  type SampleConfig,
} from "@microservices/config";

/** The Sample_Config_Block widened by exactly one property (R2.2, R2.4). */
export interface ExtendedConfig extends SampleConfig {
  readonly extendedSetting: string;
}

/** The Config_Payload with its `config` member widened (R2.7). */
export interface ExtendedConfigPayload extends Omit<ConfigPayload, "config"> {
  readonly config: ExtendedConfig;
}

/**
 * The base values are SPREAD from the imported `sampleConfig`, never restated as
 * literals (R2.1). The spread copies exactly the base's own enumerable keys, so
 * the own-key count is the base's plus one (R2.3), and it mutates nothing (R2.9).
 */
export const extendedConfig: ExtendedConfig = {
  ...sampleConfig,
  extendedSetting: "extended-example-value",
};

/**
 * Delegates identity to `buildConfigPayload` and overrides only `config`, which
 * is what makes the metamorphic relation of R2.6 true by construction rather
 * than by coincidence: `microservice-name` and `path` ARE the base payload's,
 * and `config` differs from the base's by exactly `extendedSetting`. Delegation
 * also inherits the base's verbatim echo of `name`/`path` — including for empty
 * strings — with no trimming or defaulting (R2.5, R2.8).
 */
export function buildExtendedConfigPayload(
  name: string,
  path: string,
): ExtendedConfigPayload {
  return { ...buildConfigPayload(name, path), config: extendedConfig };
}

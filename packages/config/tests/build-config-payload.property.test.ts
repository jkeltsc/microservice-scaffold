// Feature: shared-packages, Property 7: The config helper echoes identity and carries the shared config block
//
// For any microservice `name` and mount `path` strings,
// `buildConfigPayload(name, path)` returns a payload whose `microservice-name`
// equals `name`, whose `path` equals `path`, and whose `config` block
// deep-equals the shared `sampleConfig` constant. This anchors the shared
// helper as the single source of the Config_Payload identity/config split:
// the caller owns identity (`name`/`path`), the package owns the shared
// `config` block.
//
// Validates: Requirements 12.4

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildConfigPayload, sampleConfig } from "../src/index.js";

describe("Property 7: the config helper echoes identity and carries the shared config block", () => {
  it("echoes name and path and carries the shared sampleConfig block", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (name, path) => {
        const payload = buildConfigPayload(name, path);

        // Identity is echoed verbatim from the caller.
        expect(payload["microservice-name"]).toBe(name);
        expect(payload.path).toBe(path);

        // The config block deep-equals the shared constant.
        expect(payload.config).toEqual(sampleConfig);
      }),
      { numRuns: 100 },
    );
  });
});

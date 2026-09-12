// The Extended_Config_Payload property suite. Three properties, each a single
// fast-check property at numRuns 100+, over the Extended_Config_Package barrel.
//
// The generators put the empty string inside the input space in either
// position (name of 0 to 64 characters, path of 0 to 128 characters), so the
// "raises no error for the empty string" case is exercised by the generator
// rather than asserted beside it.
//
// Validates: Requirements 2.1, 2.5, 2.6, 2.7, 2.8, 2.9, 11.7

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildConfigPayload, sampleConfig } from "@microservices/config";

import {
  buildExtendedConfigPayload,
  extendedConfig,
} from "../src/index.js";

// Names of 0 to 64 characters and paths of 0 to 128 characters, the empty
// string included in either position (Property 1's bounds).
const arbName = fc.string({ minLength: 0, maxLength: 64 });
const arbPath = fc.string({ minLength: 0, maxLength: 128 });

describe("Property 1: The Extended_Config_Payload echoes identity and carries exactly the extended block", () => {
  // Feature: scaffold-demo-samples, Property 1: The Extended_Config_Payload echoes identity and carries exactly the extended block
  it("echoes name and path verbatim and carries exactly the extended block", () => {
    fc.assert(
      fc.property(arbName, arbPath, (name, path) => {
        const payload = buildExtendedConfigPayload(name, path);

        // Identity is echoed character for character with no trimming,
        // normalisation, or defaulting.
        expect(payload["microservice-name"]).toBe(name);
        expect(payload.path).toBe(path);

        // The config member deep-equals the Extended_Config_Block.
        expect(payload.config).toEqual(extendedConfig);

        // The payload's own keys are exactly microservice-name, path, config.
        expect(Object.keys(payload).sort()).toEqual(
          ["config", "microservice-name", "path"],
        );

        // The config member's own keys are exactly the Extended_Config_Block's.
        expect(Object.keys(payload.config).sort()).toEqual(
          Object.keys(extendedConfig).sort(),
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 2: The extended payload differs from the base payload by exactly `extendedSetting`", () => {
  // Feature: scaffold-demo-samples, Property 2: The extended payload differs from the base payload by exactly `extendedSetting`
  it("deleting extendedSetting yields the base config deep-equal, identity matching character for character", () => {
    fc.assert(
      fc.property(arbName, arbPath, (name, path) => {
        const extended = buildExtendedConfigPayload(name, path);
        const base = buildConfigPayload(name, path);

        // Removing extendedSetting from the extended config yields an object
        // that deep-equals the base config. Copy then delete rather than
        // destructure-and-discard, so no unused binding is introduced (the
        // repo's no-unused-vars rule does not exempt _-prefixed names); the
        // copy keeps `extended.config` unmutated.
        const withoutExtended: Record<string, unknown> = {
          ...extended.config,
        };
        delete withoutExtended.extendedSetting;
        expect(withoutExtended).toEqual(base.config);

        // The two payloads' identity members match character for character.
        expect(extended["microservice-name"]).toBe(base["microservice-name"]);
        expect(extended.path).toBe(base.path);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 3: Repeated payload construction is pure and leaves the shared block untouched", () => {
  // Feature: scaffold-demo-samples, Property 3: Repeated payload construction is pure and leaves the shared block untouched
  it("successive calls return pairwise deep-equal payloads and leave sampleConfig untouched", () => {
    fc.assert(
      fc.property(
        arbName,
        arbPath,
        fc.integer({ min: 2, max: 100 }),
        (name, path, repeats) => {
          // Snapshot the shared block before the first call.
          const snapshot = structuredClone(sampleConfig);

          const payloads = Array.from({ length: repeats }, () =>
            buildExtendedConfigPayload(name, path),
          );

          // The payloads are pairwise deep-equal.
          for (const payload of payloads) {
            expect(payload).toEqual(payloads[0]);
          }

          // sampleConfig deep-equals the snapshot taken before the first call.
          expect(sampleConfig).toEqual(snapshot);
        },
      ),
      { numRuns: 100 },
    );
  });
});

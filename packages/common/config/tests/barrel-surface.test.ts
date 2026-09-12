// Feature: package-categories — barrel export-equality (runtime surface),
// Task 7.20.
//
// R8.7: the relocated `@microservices/config` barrel exports EXACTLY
// `sampleConfig`, `buildConfigPayload`, `SampleConfig`, `ConfigPayload` and
// nothing else. `SampleConfig` and `ConfigPayload` are types, so they carry no
// runtime binding; this runtime test therefore pins the *value* surface — the
// set of runtime exports is exactly `sampleConfig` and `buildConfigPayload`,
// with `sampleConfig` a value and `buildConfigPayload` a function. The
// type-only members are pinned by `barrel-surface.test-d.ts` under
// `npm run test:types`.
//
// The barrel is imported by package name (`@microservices/config`), never by a
// relative path into `src/`, matching how every consumer reaches it (R8.6).
//
// Validates: Requirements 8.7

import { describe, expect, it } from "vitest";

import * as barrel from "@microservices/config";

describe("R8.7: @microservices/config barrel runtime surface", () => {
  it("exposes exactly the two runtime exports and nothing else", () => {
    // Own enumerable keys of the module namespace object are exactly the two
    // value exports. `SampleConfig`/`ConfigPayload` are type-only and leave no
    // runtime trace, so they must not appear here.
    expect(Object.keys(barrel).sort()).toEqual(
      ["buildConfigPayload", "sampleConfig"].sort(),
    );
  });

  it("sampleConfig is the shared settings value", () => {
    expect(barrel.sampleConfig).toEqual({
      sampleSetting: "example-value",
      description: "demonstration sub-endpoint",
    });
  });

  it("buildConfigPayload is a function that builds the payload", () => {
    expect(typeof barrel.buildConfigPayload).toBe("function");

    const payload = barrel.buildConfigPayload("svc", "/svc");
    expect(payload).toEqual({
      "microservice-name": "svc",
      path: "/svc",
      config: barrel.sampleConfig,
    });
  });
});

// Feature: scaffold-demo-samples — barrel export-equality (runtime surface),
// Task 2.3.
//
// R1.4: the `@microservices/extended-config` barrel's public API is limited to
// what it re-exports. This package DEFINES exactly four exports —
// `ExtendedConfig`, `ExtendedConfigPayload` (both type-only), `extendedConfig`
// (a value), and `buildExtendedConfigPayload` (a function) — and re-exports
// NOTHING from `@microservices/config` (R2.4): a consumer wanting the base
// surface declares the base package. `ExtendedConfig` and
// `ExtendedConfigPayload` are types and carry no runtime binding, so this
// runtime test pins the *value* surface: the set of runtime exports is exactly
// `extendedConfig` and `buildExtendedConfigPayload`. The type-only members are
// pinned by `barrel-surface.test-d.ts` under `npm run test:types`.
//
// This mirrors the pair in `packages/common/config/tests/`.
//
// The barrel is imported by package name (`@microservices/extended-config`),
// never by a relative path into `src/`, matching how every consumer reaches it.
//
// Validates: Requirements 1.4, 2.4, 11.15

import { describe, expect, it } from "vitest";

import * as barrel from "@microservices/extended-config";

describe("R1.4/R2.4: @microservices/extended-config barrel runtime surface", () => {
  it("exposes exactly the two runtime exports this package defines and nothing else", () => {
    // Own enumerable keys of the module namespace object are exactly the two
    // value exports this package defines. `ExtendedConfig`/`ExtendedConfigPayload`
    // are type-only and leave no runtime trace, so they must not appear here.
    expect(Object.keys(barrel).sort()).toEqual(
      ["buildExtendedConfigPayload", "extendedConfig"].sort(),
    );
  });

  it("re-exports none of @microservices/config's runtime names", () => {
    // The base package's runtime surface is exactly `sampleConfig` and
    // `buildConfigPayload`. Neither may leak through the extended barrel: a
    // consumer wanting the base surface declares the base package (R2.4).
    const keys = Object.keys(barrel);
    expect(keys).not.toContain("sampleConfig");
    expect(keys).not.toContain("buildConfigPayload");
  });

  it("extendedConfig is the base settings spread plus extendedSetting", () => {
    expect(barrel.extendedConfig).toEqual({
      sampleSetting: "example-value",
      description: "demonstration sub-endpoint",
      extendedSetting: "extended-example-value",
    });
  });

  it("buildExtendedConfigPayload is a function that builds the extended payload", () => {
    expect(typeof barrel.buildExtendedConfigPayload).toBe("function");

    const payload = barrel.buildExtendedConfigPayload("svc", "/svc");
    expect(payload).toEqual({
      "microservice-name": "svc",
      path: "/svc",
      config: barrel.extendedConfig,
    });
  });
});

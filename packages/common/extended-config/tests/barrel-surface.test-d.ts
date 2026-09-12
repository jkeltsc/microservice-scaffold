// Feature: scaffold-demo-samples — barrel export-equality (type surface),
// Task 2.3.
//
// R1.4/R2.4: the `@microservices/extended-config` barrel exports exactly the
// four names this package defines — `ExtendedConfig`, `ExtendedConfigPayload`,
// `extendedConfig`, `buildExtendedConfigPayload` — and re-exports nothing from
// `@microservices/config`. This file pins the type-level relationships as
// compile-time assertions checked by Vitest in `--typecheck` mode
// (`npm run test:types`, which routes through this package's
// `tsconfig.test.json`, NOT plain `npm test`). The assertions never execute;
// their value is entirely in whether the type checker accepts them.
//
// This mirrors the pair in `packages/common/config/tests/`.
//
// The barrel is imported by package name (`@microservices/extended-config`),
// never by a relative path into `src/`, matching how every consumer reaches it.
//
// Validates: Requirements 1.4, 2.4, 11.15

import { describe, test, expectTypeOf } from "vitest";

import {
  extendedConfig,
  buildExtendedConfigPayload,
  type ExtendedConfig,
  type ExtendedConfigPayload,
} from "@microservices/extended-config";
// Imported from the base package by name to anchor the assignability and
// resolution relationships the extended surface must preserve.
import type { SampleConfig, ConfigPayload } from "@microservices/config";

describe("R1.4/R2.4: @microservices/extended-config barrel type surface", () => {
  test("every ExtendedConfig value is assignable to SampleConfig", () => {
    // ExtendedConfig extends SampleConfig, so an ExtendedConfig is a SampleConfig.
    expectTypeOf<ExtendedConfig>().toMatchTypeOf<SampleConfig>();
    expectTypeOf(extendedConfig).toMatchTypeOf<SampleConfig>();
  });

  test("ExtendedConfig widens SampleConfig by exactly extendedSetting", () => {
    expectTypeOf<keyof ExtendedConfig>().toEqualTypeOf<
      keyof SampleConfig | "extendedSetting"
    >();
    expectTypeOf<ExtendedConfig["extendedSetting"]>().toEqualTypeOf<string>();
  });

  test("ExtendedConfigPayload['path'] still resolves through ConfigPayload['path']", () => {
    expectTypeOf<ExtendedConfigPayload["path"]>().toEqualTypeOf<
      ConfigPayload["path"]
    >();
  });

  test("ExtendedConfigPayload widens ConfigPayload's config to ExtendedConfig", () => {
    expectTypeOf<ExtendedConfigPayload["config"]>().toEqualTypeOf<ExtendedConfig>();
    expectTypeOf<
      ExtendedConfigPayload["microservice-name"]
    >().toEqualTypeOf<string>();
  });

  test("buildExtendedConfigPayload has the (name, path) => ExtendedConfigPayload signature", () => {
    expectTypeOf(buildExtendedConfigPayload).toEqualTypeOf<
      (name: string, path: string) => ExtendedConfigPayload
    >();
  });

  test("an object lacking extendedSetting is rejected as an ExtendedConfig", () => {
    // @ts-expect-error — a SampleConfig-shaped object is missing `extendedSetting`,
    // so it is not an ExtendedConfig. This assertion is dead weight unless
    // executed by `npm run test:types`.
    const _rejected: ExtendedConfig = {
      sampleSetting: "example-value",
      description: "demonstration sub-endpoint",
    };
    void _rejected;
  });
});

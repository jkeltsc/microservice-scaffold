// Feature: package-categories — barrel export-equality (type surface),
// Task 7.20.
//
// R8.7: the relocated `@microservices/config` barrel exports EXACTLY
// `sampleConfig`, `buildConfigPayload`, `SampleConfig`, `ConfigPayload` and
// nothing else, with the identical signatures the pre-relocation barrel had.
// This file pins those signatures as compile-time assertions checked by Vitest
// in `--typecheck` mode (`npm run test:types`, which routes through this
// package's `tsconfig.test.json`). The assertions never execute; their value is
// entirely in whether the type checker accepts them.
//
// The barrel is imported by package name (`@microservices/config`), never by a
// relative path into `src/`, matching how every consumer reaches it (R8.6).
//
// Validates: Requirement 8.7

import { describe, test, expectTypeOf } from "vitest";

import {
  sampleConfig,
  buildConfigPayload,
  type SampleConfig,
  type ConfigPayload,
} from "@microservices/config";

describe("R8.7: @microservices/config barrel type surface", () => {
  test("SampleConfig has exactly the two readonly string fields", () => {
    expectTypeOf<keyof SampleConfig>().toEqualTypeOf<
      "sampleSetting" | "description"
    >();
    expectTypeOf<SampleConfig["sampleSetting"]>().toEqualTypeOf<string>();
    expectTypeOf<SampleConfig["description"]>().toEqualTypeOf<string>();
  });

  test("ConfigPayload has exactly its three declared fields", () => {
    expectTypeOf<keyof ConfigPayload>().toEqualTypeOf<
      "microservice-name" | "path" | "config"
    >();
    expectTypeOf<ConfigPayload["microservice-name"]>().toEqualTypeOf<string>();
    expectTypeOf<ConfigPayload["path"]>().toEqualTypeOf<string>();
    expectTypeOf<ConfigPayload["config"]>().toEqualTypeOf<SampleConfig>();
  });

  test("sampleConfig is a SampleConfig", () => {
    expectTypeOf(sampleConfig).toEqualTypeOf<SampleConfig>();
  });

  test("buildConfigPayload has the exact (name, path) => ConfigPayload signature", () => {
    expectTypeOf(buildConfigPayload).toEqualTypeOf<
      (name: string, path: string) => ConfigPayload
    >();
    expectTypeOf(buildConfigPayload).parameters.toEqualTypeOf<
      [name: string, path: string]
    >();
    expectTypeOf(buildConfigPayload).returns.toEqualTypeOf<ConfigPayload>();
  });
});

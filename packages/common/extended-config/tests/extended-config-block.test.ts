// Feature: scaffold-demo-samples — Extended_Config_Block content and manifest
// example tests (Task 2.5).
//
// This suite pins the sample-visible facts of the Extended_Config_Package that
// are stated as fixed examples rather than as universal properties (those live
// in extended-config-payload.property.test.ts). It has three parts:
//
//   1. Content — `extendedSetting` is exactly "extended-example-value", and the
//      block's own-key set is the Sample_Config_Block's plus that one key and
//      nothing else (R2.1, R2.2, R2.3).
//   2. "Not restated" (structural) — no source file under `src/` contains the
//      string "example-value" other than inside "extended-example-value", so the
//      only occurrence of a base value in this package is by the identifier
//      `sampleConfig` (spread from the imported value), never a literal (R2.1).
//   3. Manifest facts — the name mirrors the directory, `main`/`types` are
//      non-empty and resolve inside `dist/`, the four scripts are present and
//      non-empty, and the only `@microservices`-scoped dependency across
//      `dependencies`, `devDependencies`, and `peerDependencies` is
//      `@microservices/config` (R1.1, R1.2, R1.3, R1.7, R4.7).
//
// The barrel is imported from `../src/index.js` (its own source), mirroring how
// the base package's own suites import their barrel.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.7, 2.1, 2.2, 2.3, 4.7

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { sampleConfig } from "@microservices/config";
import { extendedConfig } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// tests/ -> extended-config (the package root)
const packageDir = resolve(__dirname, "..");
const srcDir = resolve(packageDir, "src");

type Manifest = {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly types?: unknown;
  readonly scripts?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
};

const manifest = JSON.parse(
  readFileSync(resolve(packageDir, "package.json"), "utf8"),
) as Manifest;

/** Every `*.ts` file under `src/`, recursively, as { path, text } pairs. */
function readSourceFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

describe("Extended_Config_Block content (R2.1, R2.2, R2.3)", () => {
  it("holds extendedSetting exactly 'extended-example-value' character for character", () => {
    expect(extendedConfig.extendedSetting).toBe("extended-example-value");
  });

  it("has an own-key set of the Sample_Config_Block's keys plus extendedSetting and nothing else", () => {
    const baseKeys = Object.keys(sampleConfig).sort();
    const extendedKeys = Object.keys(extendedConfig).sort();

    // Exactly one key more than the base, and that key is `extendedSetting`.
    expect(extendedKeys).toEqual([...baseKeys, "extendedSetting"].sort());
    expect(extendedKeys.length).toBe(baseKeys.length + 1);
  });

  it("carries every base own key with the base's own value (obtained from the imported block, not restated)", () => {
    for (const key of Object.keys(sampleConfig)) {
      expect(extendedConfig[key as keyof typeof extendedConfig]).toBe(
        sampleConfig[key as keyof typeof sampleConfig],
      );
    }
  });
});

describe("Extended_Config_Block base values are not restated as literals (R2.1, structural)", () => {
  it("has no source file containing 'example-value' other than inside 'extended-example-value'", () => {
    const sources = readSourceFiles(srcDir);
    expect(sources.length).toBeGreaterThan(0);

    for (const { path, text } of sources) {
      // Remove every occurrence of the extended literal, then assert the base
      // value string no longer appears anywhere. If a base value were restated
      // (e.g. `"example-value"` copied by hand), it would survive this removal.
      const withoutExtended = text.split("extended-example-value").join("");
      expect(
        withoutExtended.includes("example-value"),
        `${path} restates the base value string 'example-value' instead of spreading it from @microservices/config`,
      ).toBe(false);
    }
  });

  it("reaches the base block only through the sampleConfig identifier", () => {
    const sources = readSourceFiles(srcDir);
    const combined = sources.map(({ text }) => text).join("\n");

    // The base surface is reached by identifier (`sampleConfig`), imported from
    // the base package by name — the sole sanctioned access to the base values.
    expect(combined).toContain("sampleConfig");
  });
});

describe("Extended_Config_Package manifest facts (R1.1, R1.2, R1.3, R1.7, R4.7)", () => {
  it("declares a name mirroring its directory exactly", () => {
    // The package directory is `extended-config`; the scoped name mirrors it.
    expect(manifest.name).toBe("@microservices/extended-config");
  });

  it("declares main and types as non-empty strings that resolve inside dist/", () => {
    for (const field of ["main", "types"] as const) {
      const value = manifest[field];
      expect(typeof value, `${field} must be a string`).toBe("string");
      expect((value as string).length, `${field} must be non-empty`).toBeGreaterThan(0);
      expect(value as string).toMatch(/^\.\/dist\//);
    }
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
  });

  it("declares the four standard scripts, each a non-empty string", () => {
    const scripts = manifest.scripts ?? {};
    for (const name of ["build", "test", "lint", "typecheck"] as const) {
      expect(scripts, `missing script '${name}'`).toHaveProperty(name);
      expect(typeof scripts[name], `script '${name}' must be a string`).toBe(
        "string",
      );
      expect(
        (scripts[name] as string).length,
        `script '${name}' must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("declares @microservices/config as its only @microservices-scoped dependency across all dependency fields", () => {
    const scopedDeps = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((dep) => dep.startsWith("@microservices/"));

    // Deduplicated: the same scoped name could in principle appear in more than
    // one field; the *set* must be exactly { @microservices/config }.
    expect([...new Set(scopedDeps)].sort()).toEqual(["@microservices/config"]);
  });
});

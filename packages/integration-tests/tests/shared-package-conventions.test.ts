// Shared-package conventions test for the Sample_Shared_Package (packages/config).
//
// This suite asserts the structural contract of a shared package (R2, R11) at
// the source-of-truth level — the committed manifests and the compiled barrel —
// rather than through the build pipeline:
//
//   1. `packages/config/package.json` follows the general package conventions:
//      ES module, an `@microservices`-scoped name that mirrors its directory,
//      `main`/`types` under `dist/`, the four standard scripts, and a
//      dependency set that points downward only (no microservice, no Overseer).
//   2. The barrel (`@microservices/config`) is the sole stable public API and
//      exports the two runtime symbols (`sampleConfig`, `buildConfigPayload`)
//      and the two types (`SampleConfig`, `ConfigPayload`).
//   3. Both consumers (`microservice2`, `microservice3`) declare the dependency
//      by package name (R12.1, R13.1).
//   4. The root `workspaces` array places `packages/config` in topological
//      position: after `packages/contracts` (its own dependency) and before
//      every consumer — the microservices glob and the Overseer (R4.1, R11.5).
//
// Validates: Requirements R2.1, R2.2, R2.3, R2.4, R2.5, R4.1, R11.2, R11.5, R12.1, R13.1

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The compiled barrel imported by package name only — never a relative path
// into the package's src/ or dist/. This is the sole sanctioned public API
// surface, so asserting against it is asserting against the real contract.
import {
  sampleConfig,
  buildConfigPayload,
  type SampleConfig,
  type ConfigPayload,
} from "@microservices/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

interface Manifest {
  readonly name?: string;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[];
}

function readManifest(relativePath: string): Manifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
  ) as Manifest;
}

describe("packages/config manifest follows shared-package conventions", () => {
  const manifest = readManifest("packages/config/package.json");

  it("is an ES module", () => {
    expect(manifest.type).toBe("module");
  });

  it("has an @microservices-scoped name that mirrors the directory", () => {
    // Directory name is `config`; the scoped name must mirror it (R2.1, R11.2).
    expect(manifest.name).toBe("@microservices/config");
  });

  it("points main and types at compiled output under dist/", () => {
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.main).toMatch(/^\.\/dist\//);
    expect(manifest.types).toMatch(/^\.\/dist\//);
  });

  it("exposes the four standard scripts", () => {
    const scripts = manifest.scripts ?? {};
    for (const name of ["build", "test", "lint", "typecheck"] as const) {
      expect(scripts, `missing script '${name}'`).toHaveProperty(name);
      expect(typeof scripts[name]).toBe("string");
    }
  });

  it("declares no microservice or Overseer dependency (points downward only)", () => {
    // A shared package is a leaf library: it depends on third-party packages
    // and other shared packages only, never upward on a microservice or the
    // Overseer (R3.4).
    const deps = Object.keys(manifest.dependencies ?? {});
    expect(deps).not.toContain("@microservices/overseer");
    for (const dep of deps) {
      expect(
        /^@microservices\/microservice/.test(dep),
        `config must not depend on microservice package '${dep}'`,
      ).toBe(false);
    }
  });
});

describe("the @microservices/config barrel is the stable public API", () => {
  it("exports the sampleConfig constant", () => {
    expect(sampleConfig).toEqual({
      sampleSetting: "example-value",
      description: "demonstration sub-endpoint",
    });
  });

  it("exports the buildConfigPayload helper", () => {
    expect(typeof buildConfigPayload).toBe("function");
    expect(buildConfigPayload("microservice3", "/microservice3")).toEqual({
      "microservice-name": "microservice3",
      path: "/microservice3",
      config: sampleConfig,
    });
  });

  it("exports the SampleConfig and ConfigPayload types", () => {
    // The two types are export-asserted at compile time: referencing them here
    // fails `tsc`/`test:types` if the barrel stops exporting either. The
    // runtime assertions keep the type usages live so they are not elided.
    const config: SampleConfig = sampleConfig;
    const payload: ConfigPayload = buildConfigPayload("microservice2", "/api/microservice2");
    expect(config.sampleSetting).toBe("example-value");
    expect(payload["microservice-name"]).toBe("microservice2");
    expect(payload.config).toEqual(sampleConfig);
  });
});

describe("both consumers declare @microservices/config by package name", () => {
  it.each(["microservice2", "microservice3"] as const)(
    "%s declares the dependency in package.json",
    (id) => {
      const manifest = readManifest(`packages/microservices/${id}/package.json`);
      const deps = manifest.dependencies ?? {};
      expect(deps, `${id} must depend on @microservices/config`).toHaveProperty(
        "@microservices/config",
      );
    },
  );
});

describe("the root workspaces array places packages/config topologically", () => {
  const workspaces = readManifest("package.json").workspaces ?? [];

  const indexOf = (entry: string): number => {
    const at = workspaces.indexOf(entry);
    expect(at, `workspaces array must contain '${entry}'`).toBeGreaterThanOrEqual(0);
    return at;
  };

  it("lists packages/config after packages/contracts (its own dependency)", () => {
    expect(indexOf("packages/config")).toBeGreaterThan(indexOf("packages/contracts"));
  });

  it("lists packages/config before the microservices namespace glob", () => {
    expect(indexOf("packages/config")).toBeLessThan(
      indexOf("packages/microservices/*"),
    );
  });

  it("lists packages/config before the Overseer", () => {
    expect(indexOf("packages/config")).toBeLessThan(indexOf("packages/overseer"));
  });
});

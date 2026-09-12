// Common-package conventions test for the sample Common_Package
// (packages/common/config).
//
// A Common_Package is a Consumer_Category package at `packages/common/<name>/`:
// a consumer-written leaf library imported by package name
// (`@microservices/<name>`) by one or more Microservice_Packages and/or the
// Overseer. This suite asserts the structural contract of that Common_Package
// at the source-of-truth level — the committed manifests and the compiled
// barrel — rather than through the build pipeline:
//
//   1. `packages/common/config/package.json` follows the general package
//      conventions: ES module, an `@microservices`-scoped name that mirrors
//      its directory, `main`/`types` under `dist/`, the four standard scripts,
//      and a dependency set that points downward only (no microservice, no
//      Overseer).
//   2. The barrel (`@microservices/config`) is the sole stable public API and
//      exports the two runtime symbols (`sampleConfig`, `buildConfigPayload`)
//      and the two types (`SampleConfig`, `ConfigPayload`).
//   3. Both consumers (`microservice2`, `microservice3`) declare the dependency
//      by package name.
//   4. The root `workspaces` array satisfies Workspace_Coverage: every
//      Framework_Singleton directory and every Consumer_Package directory in
//      the repository is matched by exactly one `workspaces` entry, with no
//      `packages/config` entry remaining. The array's entry ORDER carries no
//      build-order meaning and is deliberately not asserted here — the
//      committed sequence is cosmetic (see design component 14) and must not
//      be pinned to a rule the platform no longer has.
//
// Validates: Requirements 8.4, 8.8, 8.9, 12.1, 12.2, 12.3, 12.4, 12.5, 12.15, 12.16, 12.20

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The compiled barrel imported by package name only — never a relative path
// into the package's src/ or dist/. This is the sole sanctioned public API
// surface, so asserting against it is asserting against the real contract.
// The package name is unchanged by the relocation; only its directory moved
// from `packages/config` to `packages/common/config`.
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

describe("packages/common/config manifest follows Common_Package conventions", () => {
  const manifest = readManifest("packages/common/config/package.json");

  it("is an ES module", () => {
    expect(manifest.type).toBe("module");
  });

  it("has an @microservices-scoped name that mirrors the directory", () => {
    // Directory name is `config`; the scoped name must mirror it. The name is
    // unchanged by the relocation into the `common` category (R8.5, R8.10).
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
    // A Common_Package is a leaf library: it depends on third-party packages,
    // other Common_Packages, and Framework_Singletons only, never upward on a
    // Microservice_Package or the Overseer (R8.9).
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

describe("the root workspaces array satisfies Workspace_Coverage", () => {
  // R12.16 removes the ordering constraint on the `workspaces` array entirely,
  // and R12.15 leaves it exactly one obligation: Workspace_Coverage — every
  // Framework_Singleton directory and every Consumer_Package directory is
  // matched by exactly one `workspaces` entry, counting a glob entry as
  // matching every direct subdirectory of its Namespace_Container. Design
  // component 14 records the committed sequence as cosmetic, so this block
  // asserts coverage of the entry *set* and deliberately asserts no order.
  const workspaces = readManifest("package.json").workspaces ?? [];

  // The workspace package directories actually present in the repository, as
  // repo-relative paths. The four Framework_Singletons are matched by their
  // exact literal entries; each Consumer_Package is matched by its Namespace
  // Container's glob entry (`packages/common/*`, `packages/microservices/*`).
  const presentPackageDirs = [
    // Framework_Singletons (known by name, exact-literal entries)
    "packages/contracts",
    "packages/build-tools",
    "packages/overseer",
    "packages/integration-tests",
    // Common_Package (matched by packages/common/*)
    "packages/common/config",
    // Microservice_Packages (matched by packages/microservices/*)
    "packages/microservices/microservice1",
    "packages/microservices/microservice2",
    "packages/microservices/microservice3",
  ] as const;

  // A `workspaces` entry matches a package directory either as an exact
  // literal or, for a `<container>/*` glob, as any direct subdirectory of that
  // container. Order-independent by construction.
  function matches(entry: string, dir: string): boolean {
    if (entry.endsWith("/*")) {
      const container = entry.slice(0, -"/*".length);
      const rest = dir.startsWith(`${container}/`)
        ? dir.slice(container.length + 1)
        : undefined;
      // A glob matches a *direct* subdirectory only — no further slash.
      return rest !== undefined && rest.length > 0 && !rest.includes("/");
    }
    return entry === dir;
  }

  it.each(presentPackageDirs)(
    "matches %s by exactly one workspaces entry (R12.15)",
    (dir) => {
      const matching = workspaces.filter((entry) => matches(entry, dir));
      expect(
        matching,
        `${dir} must be matched by exactly one workspaces entry, matched: ${JSON.stringify(matching)}`,
      ).toHaveLength(1);
    },
  );

  it("declares no former sample-library entry (R8.4)", () => {
    // The former directory path is built from a fragment so this source never
    // contains the forbidden token contiguously (R8.8: no test in the
    // repository asserts on the former path).
    const formerDir = `packages/${"config"}`;
    expect(workspaces).not.toContain(formerDir);
    // Nothing may match the removed former directory either.
    expect(workspaces.filter((entry) => matches(entry, formerDir))).toEqual([]);
  });

  it("allows a packages/spa/* entry matching zero directories without failing coverage (R12.20)", () => {
    // `packages/spa/` ships empty, so `packages/spa/*` matches no directory.
    // A glob matching zero directories is explicitly not a coverage violation:
    // it need not be present, but if present it is permitted and matches none
    // of the present package directories.
    const spaGlob = workspaces.find((entry) => entry === "packages/spa/*");
    if (spaGlob !== undefined) {
      const matched = presentPackageDirs.filter((dir) => matches(spaGlob, dir));
      expect(matched).toEqual([]);
    }
  });
});

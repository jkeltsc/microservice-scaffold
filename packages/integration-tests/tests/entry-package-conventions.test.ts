// Entry_Package conventions — the manifest and tsconfig facts that do not vary
// with input (registry-inversion R1.10, R1.11, R1.12, R1.13, R1.14).
//
// A sibling of `common-package-conventions.test.ts` and
// `spa-package-conventions.test.ts`, and shaped the same way: it asserts the
// structural contract at the source-of-truth level — the committed
// `app/package.json` and the RESOLVED `app/tsconfig.json` — rather than through
// the build pipeline.
//
// The Entry_Package is neither a Framework_Singleton nor a member of any
// Consumer_Category (R1.8, R1.9). It is the consumer-owned workspace package that
// holds the Entry_Module and receives the Generated_Registry, and this repository
// places its own at `app/`, taking the Entry_Root_Default (R1.15). Nothing here
// hard-codes that path or the scope: both the expected package name and the
// package directory are composed from the ProjectContext derived from the default
// Effective_Config, which is what this repository's absent Project_Config_File
// yields. So a project that relocates its Entry_Root or changes its scope moves
// these assertions with it rather than breaking them.
//
// Five groups of facts:
//
//   1. `name` is the Configured_Scope followed by `/` and the LAST PATH SEGMENT
//      of the Entry_Root, `type` is `module`, and the four standard scripts are
//      declared. `build` and `typecheck` each perform the Registry_Generation_Step
//      ahead of the compiler, which is what makes both succeed in this directory
//      on a clone that has never generated a registry (R1.10, R5.4).
//   2. `dependencies` names the scoped `overseer` and `contracts` packages and
//      nothing else scoped (R1.10).
//   3. No dependency field names a Microservice_Package — the Selected_Microservices
//      are Selector-dependent and the dependency resolver rejects such a manifest
//      with its `[deps:peer]` diagnostic, from which this package gets no
//      exemption (R1.11).
//   4. Neither `main` nor `types` is declared: nothing imports this package by
//      name and a container invokes it by path (R1.12).
//   5. All four Load_Bearing_Settings hold of the RESOLVED configuration — after
//      every `extends` is applied — exactly the way `check:invariants` judges
//      them, so `composite`/`declaration` inherited from `tsconfig.base.json`
//      satisfy the check as directly declared values would, while `outDir` and
//      `rootDir` must resolve to this package's own `dist` and `src` (R1.13). The
//      resolution goes through the Build_System's own
//      `resolveTsconfigWithCompiler`, not through a re-implementation of the
//      `extends` chain.
//
// R1.14 — the Entry_Package is a Tsc_Project and not a Bundler_Project — is
// asserted mechanically at this level as the two facts that decide it: its
// directory lies under no Consumer_Category Discovery_Root (so it is not a
// Spa_Package, the only Bundler_Project category), and its own `build` script
// invokes `tsc` rather than a bundler.
//
// Validates: Requirements 1.10, 1.11, 1.12, 1.13, 1.14

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { resolveTsconfigWithCompiler } from "@microservices/build-tools/dist/tsconfig-verifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

// The context this repository's absent Project_Config_File yields: the four
// defaults, the Entry_Root_Default among them. Every expectation below is
// composed from it, so no scope literal and no `app` literal appears here.
const context = projectContext(defaultEffectiveConfig());
const entryRoot = context.entryRoot;
/** The last path segment of the Entry_Root — the name the package name mirrors. */
const entrySegment = entryRoot.split("/").filter((s) => s.length > 0).at(-1) ?? "";
const expectedName = context.scopedName(entrySegment);
/** Absolute path of the Entry_Package's directory in this checked-out tree. */
const entryDir = resolve(repoRoot, ...entryRoot.split("/"));

interface Manifest {
  readonly name?: string;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[];
}

function readJson(absolutePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(absolutePath, "utf8")) as Record<
    string,
    unknown
  >;
}

const manifestPath = resolve(entryDir, "package.json");
const manifestRaw = readJson(manifestPath);
const manifest = manifestRaw as Manifest;

describe("the Entry_Package's manifest follows the Entry_Package conventions", () => {
  it("exists at the Entry_Root with a package.json and the Entry_Module", () => {
    // R1.15: this repository commits the Entry_Package's manifest, its tsconfig,
    // and the Entry_Module as tracked source at the Entry_Root_Default.
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(resolve(entryDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(resolve(entryDir, "src", "index.ts"))).toBe(true);
  });

  it("declares the Configured_Scope followed by the Entry_Root's last segment as its name (R1.10)", () => {
    expect(entrySegment.length).toBeGreaterThan(0);
    expect(manifest.name).toBe(expectedName);
  });

  it("is an ES module (R1.10)", () => {
    expect(manifest.type).toBe("module");
  });

  it("declares the four standard scripts (R1.10)", () => {
    const scripts = manifest.scripts ?? {};
    for (const scriptName of ["build", "test", "lint", "typecheck"] as const) {
      expect(scripts, `missing script '${scriptName}'`).toHaveProperty(
        scriptName,
      );
      expect(typeof scripts[scriptName]).toBe("string");
      expect((scripts[scriptName] ?? "").length).toBeGreaterThan(0);
    }
  });

  it("performs the Registry_Generation_Step ahead of the compiler in build and typecheck (R1.10, R5.4)", () => {
    // The `&&` chain is the mechanism: generation runs first and a failed
    // generation stops the chain before the compiler is reached, so both scripts
    // succeed in this directory on a clone that has never generated a registry.
    const scripts = manifest.scripts ?? {};
    for (const scriptName of ["build", "typecheck"] as const) {
      const script = scripts[scriptName] ?? "";
      const generationIndex = script.indexOf("generate-registry");
      const compilerIndex = script.indexOf("tsc");
      expect(
        generationIndex,
        `'${scriptName}' must perform a Registry_Generation_Step: ${script}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        compilerIndex,
        `'${scriptName}' must invoke the compiler: ${script}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        generationIndex,
        `'${scriptName}' must generate BEFORE compiling: ${script}`,
      ).toBeLessThan(compilerIndex);
      expect(script).toContain("&&");
    }
  });

  it("declares exactly the scoped overseer and contracts dependencies (R1.10)", () => {
    const deps = Object.keys(manifest.dependencies ?? {});
    const scoped = deps.filter((dep) => dep.startsWith(context.specifierPrefix));
    expect(new Set(scoped)).toEqual(
      new Set([
        context.framework.overseer.name,
        context.framework.contracts.name,
      ]),
    );
  });

  it("declares no Microservice_Package dependency in any dependency field (R1.11)", () => {
    // The Selected_Microservices are Selector-dependent, so naming one here would
    // be wrong for every other Selector — and the dependency resolver rejects
    // such a manifest with `[deps:peer]` regardless. The check reads the
    // microservice Discovery_Root's real members rather than a name pattern, so a
    // microservice whose identifier does not begin with "microservice" is caught.
    const microserviceNames = new Set(
      existsSync(resolve(repoRoot, ...context.roots.microservice.split("/")))
        ? readMicroserviceNames()
        : [],
    );
    expect(microserviceNames.size).toBeGreaterThan(0);

    const depFields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const allDeps = depFields.flatMap((field) =>
      Object.keys((manifestRaw[field] as Record<string, string> | undefined) ?? {}),
    );
    for (const dep of allDeps) {
      expect(
        microserviceNames.has(dep),
        `the Entry_Package must not depend on the Microservice_Package '${dep}'`,
      ).toBe(false);
    }
  });

  it("declares neither main nor types (R1.12)", () => {
    // Nothing imports the Entry_Package by name; a container invokes it by path
    // at the Entry_Point_Path, so no barrel validation applies to it.
    expect(manifestRaw).not.toHaveProperty("main");
    expect(manifestRaw).not.toHaveProperty("types");
    expect(manifest.main).toBeUndefined();
    expect(manifest.types).toBeUndefined();
  });

  it("is matched by exactly one workspaces entry (R1.8)", () => {
    const workspaces = (readJson(resolve(repoRoot, "package.json")) as Manifest)
      .workspaces ?? [];
    const matching = workspaces.filter((entry) => matchesWorkspace(entry, entryRoot));
    expect(
      matching,
      `${entryRoot} must be matched by exactly one workspaces entry, matched: ${JSON.stringify(matching)}`,
    ).toHaveLength(1);
  });

  it("is a Tsc_Project and not a Bundler_Project (R1.14)", () => {
    // Two facts decide it. The Entry_Root lies under no Consumer_Category
    // Discovery_Root, so the Entry_Package is not a Spa_Package — the only
    // Bundler_Project category — and it is not discovered as a member of any
    // category either. And its own `build` script invokes `tsc`, not a bundler.
    for (const root of Object.values(context.roots)) {
      expect(
        entryRoot === root || entryRoot.startsWith(`${root}/`),
        `the Entry_Root '${entryRoot}' must not lie inside the Discovery_Root '${root}'`,
      ).toBe(false);
    }
    expect(manifest.scripts?.build).toContain("tsc");
  });
});

describe("the Entry_Package satisfies all four Load_Bearing_Settings (R1.13)", () => {
  // Resolved the way `check:invariants` resolves it: through the Build_System's
  // own `resolveTsconfigWithCompiler`, which applies the whole `extends` chain
  // and returns `outDir`/`rootDir` as absolute compiler-resolved paths. So a
  // value inherited from `tsconfig.base.json` satisfies the check exactly as a
  // directly declared one does, and a declared relative path is judged by where
  // it actually resolves rather than by its text.
  const resolution = resolveTsconfigWithCompiler(entryDir);

  /** Strip a trailing separator so `dist` and `dist/` compare equal. */
  function normalize(path: string): string {
    return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  }

  it("resolves its tsconfig at all", () => {
    expect(
      resolution.kind,
      `resolving ${entryRoot}/tsconfig.json did not succeed: ${JSON.stringify(resolution)}`,
    ).toBe("resolved");
  });

  it("declares composite true in the resolved configuration", () => {
    // Inherited from tsconfig.base.json: every Tsc_Project is a root of the
    // single `tsc --build`, and the solution builder requires composite projects.
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.resolved.composite).toBe(true);
  });

  it("declares declaration true in the resolved configuration", () => {
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.resolved.declaration).toBe(true);
  });

  it("resolves outDir to its own dist directory", () => {
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.resolved.outDir).toBeDefined();
    expect(normalize(resolution.resolved.outDir as string)).toBe(
      resolve(entryDir, "dist"),
    );
  });

  it("resolves rootDir to its own src directory", () => {
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.resolved.rootDir).toBeDefined();
    expect(normalize(resolution.resolved.rootDir as string)).toBe(
      resolve(entryDir, "src"),
    );
  });
});

/**
 * The scoped names of the real Microservice_Packages: the direct subdirectories
 * of the configured microservice Discovery_Root, each composed under this run's
 * scope. Read from the filesystem rather than hard-coded, so a new microservice
 * is covered by the R1.11 assertion the moment it exists.
 */
function readMicroserviceNames(): readonly string[] {
  const root = resolve(repoRoot, ...context.roots.microservice.split("/"));
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => context.scopedName(entry.name));
}

/**
 * A `workspaces` entry matches a package directory either as an exact literal or,
 * for a `<container>/*` glob, as any DIRECT subdirectory of that container. The
 * same matcher `common-package-conventions.test.ts` uses, and the same one the
 * Repo_Invariant_Checker's Workspace_Coverage check decides by.
 */
function matchesWorkspace(entry: string, dirPath: string): boolean {
  if (entry.endsWith("/*")) {
    const container = entry.slice(0, -"/*".length);
    const rest = dirPath.startsWith(`${container}/`)
      ? dirPath.slice(container.length + 1)
      : undefined;
    return rest !== undefined && rest.length > 0 && !rest.includes("/");
  }
  return entry === dirPath;
}

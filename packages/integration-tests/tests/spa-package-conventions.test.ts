// Spa_Package convention and Node-floor test for the Demo_Spa
// (packages/spa/demo).
//
// A Spa_Package is a Consumer_Category package at `packages/spa/<name>/`: a
// bundler-built frontend whose Build_Kind is Bundler_Project. Unlike a
// Common_Package, its category contract is a non-empty `scripts.build` alone —
// it declares NO barrel (`main`/`types`), because a barrel would advertise an
// API the import-discipline check forbids anyone from importing. The Demo_Spa
// is a true sink: it declares no `@microservices`-scoped dependency of any
// kind. This suite asserts that structural contract at the source-of-truth
// level — the committed manifest and the committed `vite.config.ts` — in the
// style of `common-package-conventions.test.ts`, rather than through the build
// pipeline.
//
//   1. The Demo_Spa's manifest conventions: location at `packages/spa/demo`,
//      an `@microservices`-scoped name mirroring its directory, `"type":
//      "module"`, `"private": true`, a non-empty `scripts.build` (the category
//      contract) plus the other three standard scripts non-empty, NO `main`
//      and NO `types` (no barrel), the chosen Spa_Resolution_Pair `exports`
//      map `{ ".": "./dist/index.html" }`, the bundler pinned to a single
//      exact version with none of the range operators, and no
//      `@microservices`-scoped dependency in any dependency field.
//   2. The raised Node floor: the root manifest's `engines.node` is
//      `">=22.12.0"`, and every version its range admits satisfies the
//      `engines.node` range the *installed* bundler declares — read from the
//      installed `vite` manifest rather than restated, so a later bundler bump
//      that raises its own floor fails this test instead of quietly re-opening
//      the mismatch.
//   3. `vite.config.ts` declares no `test` block, so the Demo_Spa's suite runs
//      under Vitest's default Node environment.
//   4. Location/discovery: `packages/spa/demo` is matched by exactly one
//      `workspaces` entry (`packages/spa/*`).
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.17, 9.18, 11.3, 11.16

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

// The Demo_Spa lives at packages/spa/demo, a direct subdirectory of the spa
// Namespace_Container; its scoped name mirrors that directory exactly.
const spaRelDir = "packages/spa/demo";
const spaName = "@microservices/demo";
// The Demo_Spa's bundler. Its version is asserted structurally against the
// committed manifest; its engine range is read from the *installed* copy.
const bundlerPackage = "vite";

interface Manifest {
  readonly name?: string;
  readonly type?: string;
  readonly private?: boolean;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: unknown;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[];
}

function readManifest(relativePath: string): Manifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
  ) as Manifest;
}

const spaManifest = readManifest(`${spaRelDir}/package.json`);

describe("packages/spa/demo manifest follows Spa_Package conventions", () => {
  it("lives at a direct subdirectory of packages/spa/ (R6.1)", () => {
    // Membership in the spa Consumer_Category is decided by location alone:
    // a Spa_Package is a direct subdirectory of `packages/spa/`.
    expect(existsSync(resolve(repoRoot, spaRelDir, "package.json"))).toBe(true);
  });

  it("has an @microservices-scoped name that mirrors the directory (R6.2)", () => {
    expect(spaManifest.name).toBe(spaName);
  });

  it("is a private ES module", () => {
    expect(spaManifest.type).toBe("module");
    expect(spaManifest.private).toBe(true);
  });

  it("declares a non-empty scripts.build — the category contract (R6.3)", () => {
    const build = spaManifest.scripts?.build;
    expect(typeof build).toBe("string");
    // "at least one non-whitespace character"
    expect((build ?? "").trim().length).toBeGreaterThan(0);
  });

  it("exposes the four standard scripts, each non-empty (R6.4)", () => {
    const scripts = spaManifest.scripts ?? {};
    for (const scriptName of ["build", "test", "lint", "typecheck"] as const) {
      const value = scripts[scriptName];
      expect(typeof value, `missing script '${scriptName}'`).toBe("string");
      expect(
        (value ?? "").trim().length,
        `script '${scriptName}' must hold at least one non-whitespace character`,
      ).toBeGreaterThan(0);
    }
  });

  it("declares NO main and NO types — a Spa_Package has no barrel", () => {
    // The category contract is a non-empty `scripts.build` alone. A barrel
    // would advertise an API the import-discipline check forbids anyone from
    // importing, so `main`/`types` are deliberately absent.
    expect(spaManifest.main).toBeUndefined();
    expect(spaManifest.types).toBeUndefined();
  });

  it("declares the chosen Spa_Resolution_Pair exports map", () => {
    // The `exports` map is this sample's half of the chosen Spa_Resolution_Pair
    // (pair A): it makes `import.meta.resolve("@microservices/demo")` point
    // inside `dist/` whether or not the bundle has been built.
    expect(spaManifest.exports).toEqual({ ".": "./dist/index.html" });
  });

  it("pins the bundler to a single exact version with no range operator (R6.5)", () => {
    // The bundler is declared as a devDependency, its specifier a single exact
    // version: matches /^\d+\.\d+\.\d+$/ and contains none of the range
    // operators ^ ~ * > < = |.
    const spec = spaManifest.devDependencies?.[bundlerPackage];
    expect(
      typeof spec,
      `Demo_Spa must declare ${bundlerPackage} as a devDependency`,
    ).toBe("string");
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
    for (const op of ["^", "~", "*", ">", "<", "=", "|"] as const) {
      expect(
        (spec ?? "").includes(op),
        `bundler version '${spec ?? ""}' must not contain the range operator '${op}'`,
      ).toBe(false);
    }
  });

  it("declares no @microservices-scoped dependency of any kind — a true sink", () => {
    // The Demo_Spa is a true sink: it names no @microservices-scoped package in
    // any dependency field. Asserted across every field, not just
    // `dependencies`.
    const raw = JSON.parse(
      readFileSync(resolve(repoRoot, spaRelDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const depFields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const scopedDeps = depFields.flatMap((field) =>
      Object.keys(
        (raw[field] as Record<string, string> | undefined) ?? {},
      ).filter((dep) => dep.startsWith("@microservices/")),
    );
    expect(
      scopedDeps,
      `Demo_Spa must declare no @microservices-scoped dependency, found: ${JSON.stringify(scopedDeps)}`,
    ).toEqual([]);
  });

  it("is matched by exactly one workspaces entry (R6.17)", () => {
    // Location/discovery: `packages/spa/demo` is matched by exactly one
    // `workspaces` entry — the `packages/spa/*` glob.
    const workspaces = readManifest("package.json").workspaces ?? [];
    const matching = workspaces.filter((entry) => {
      if (entry.endsWith("/*")) {
        const container = entry.slice(0, -"/*".length);
        const rest = spaRelDir.startsWith(`${container}/`)
          ? spaRelDir.slice(container.length + 1)
          : undefined;
        return rest !== undefined && rest.length > 0 && !rest.includes("/");
      }
      return entry === spaRelDir;
    });
    expect(
      matching,
      `${spaRelDir} must be matched by exactly one workspaces entry, matched: ${JSON.stringify(matching)}`,
    ).toHaveLength(1);
  });
});

describe("vite.config.ts declares no test block (R11.3)", () => {
  it("keeps Vitest's default Node environment in force for the Demo_Spa suite", () => {
    // A `test` block would override Vitest's default `node` environment. Its
    // absence is asserted structurally against the committed config: no
    // `test:` property key in the defineConfig object.
    const source = readFileSync(
      resolve(repoRoot, spaRelDir, "vite.config.ts"),
      "utf8",
    );
    // Strip line comments so a comment mentioning `test` is not a false match,
    // then assert no `test:` config key remains.
    const withoutLineComments = source.replace(/\/\/[^\n]*/g, "");
    expect(withoutLineComments).not.toMatch(/\btest\s*:/);
  });
});

describe("the raised Node floor agrees with the installed bundler (R11.16, R9.18)", () => {
  // The bundler's engine range is read from the *installed* vite manifest,
  // resolved from the Demo_Spa's own directory so it is the pinned copy the
  // Demo_Spa actually installs, not a hoisted peer. Reading it (rather than
  // restating it) means a later bundler bump that raises its own floor fails
  // this test instead of quietly re-opening the mismatch.
  //
  // `createRequire(...).resolve(...)` is used for module RESOLUTION only — it
  // returns a path, which is then read and parsed as JSON. The repository forbids
  // CommonJS `require()` calls (ES modules only, enforced by
  // `no-restricted-syntax`), so the manifest is never `require`d.
  const resolveFromDemo = createRequire(
    pathToFileURL(resolve(repoRoot, spaRelDir, "package.json")),
  ).resolve;
  const installedBundlerManifest = JSON.parse(
    readFileSync(resolveFromDemo("vite/package.json"), "utf8"),
  ) as Manifest;

  const rootManifest = readManifest("package.json");
  const rootNodeRange = rootManifest.engines?.node;
  const bundlerNodeRange = installedBundlerManifest.engines?.node;

  it("declares the root engines.node floor as >=22.12.0", () => {
    expect(rootNodeRange).toBe(">=22.12.0");
  });

  it("has an installed bundler that declares an engines.node range", () => {
    expect(typeof bundlerNodeRange).toBe("string");
    expect((bundlerNodeRange ?? "").length).toBeGreaterThan(0);
  });

  it("admits only Node versions the installed bundler accepts (no engine mismatch)", async () => {
    // `subset(a, b)` is true iff every version admitted by range `a` satisfies
    // range `b`.
    //
    // Loaded by resolving the module to a FILE PATH and dynamic-importing that
    // path. Two constraints shape this, and a bare `await import("semver/…")`
    // satisfies neither: the repository is ES-modules-only and forbids CommonJS
    // `require()` calls (`no-restricted-syntax`), and semver ships no types, so
    // a statically-analysable specifier makes `tsc` fail with TS2307 unless
    // `@types/semver` is added. `.resolve()` is resolution only — it returns a
    // path, not a module — and importing through a variable specifier keeps the
    // checker out of it while still being a genuine ESM import of a real file.
    // semver is present in the installed tree (the toolchain depends on it
    // transitively). Being CJS, its callable arrives as the interop default.
    const subsetPath = createRequire(import.meta.url).resolve(
      "semver/ranges/subset",
    );
    const subsetSpecifier = pathToFileURL(subsetPath).href;
    const subsetModule = (await import(subsetSpecifier)) as {
      default: (sub: string, dom: string) => boolean;
    };
    const subset = subsetModule.default;

    // Every Node version the root range admits must satisfy the bundler's
    // range: the root range is a subset of the bundler's range.
    expect(
      subset(rootNodeRange ?? "", bundlerNodeRange ?? ""),
      `root engines.node '${rootNodeRange ?? ""}' must be a subset of the installed bundler's engines.node '${bundlerNodeRange ?? ""}'`,
    ).toBe(true);
  });
});

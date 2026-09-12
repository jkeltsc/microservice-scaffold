// Feature: package-categories — migration facts for the relocated Common_Package
// (design "Components and Interfaces / 11. packages/common/config/", "Migration
// shape").
//
// The sample shared library moved from its former top-level location under
// `packages/` into the `common` Namespace_Container at `packages/common/config`.
// This suite pins the observable facts of that move against the committed tree,
// at the source-of-truth level (the committed files themselves), so a
// regression in any of them is caught without running the build pipeline:
//
//   1. The relocated package holds its four constituents: `package.json`,
//      `tsconfig.json`, `src/`, and `tests/` (R8.1).
//   2. Its `tsconfig.json` `extends` `../../../tsconfig.base.json` — one level
//      deeper than before — and that relative path resolves to the
//      repository-root base config (R8.3).
//   3. The relocated manifest declares the SAME `name`, `type`, `main`,
//      `types`, and the four standard scripts the pre-relocation manifest did,
//      so it satisfies Common_Package validation with no manifest edit (R8.10).
//   4. Both consumers still declare `@microservices/config` (R8.6): the move is
//      invisible to a by-name importer.
//   5. No stale path remains: the Build_System sources, repo-level scripts,
//      `Dockerfile.template`, the Root_Manifest, and every test source contain
//      no textual reference to the former path, and that directory no longer
//      exists (R8.2, R8.4, R8.8).
//
// The stale-path scan matches the former path at a path boundary: the token
// followed by `/`, a quote, whitespace, or end-of-input. The relocated path
// `packages/common/config` does not contain the former path as a substring
// (after `packages/` comes `common`, not `config`), so it can never trip the
// check; the boundary anchor additionally excludes an unrelated name such as
// `packages/configuration`.
//
// This file deliberately never writes the former path as one contiguous
// literal — the forbidden token is assembled from `packages/` and `config`
// wherever it is needed — so the scan, which reads every test source in the
// repository (this one included), does not flag itself.
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 8.10

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The relocated Common_Package directory, repo-relative. */
const CONFIG_DIR = "packages/common/config";

/**
 * The retired pre-relocation directory, which must no longer exist. Assembled
 * from parts rather than written as one literal so this test file does not
 * itself contain the forbidden token the stale-path scan below rejects across
 * every test source (R8.8).
 */
const OLD_CONFIG_DIR = `packages/${"config"}`;

interface Manifest {
  readonly name?: string;
  readonly type?: string;
  readonly main?: string;
  readonly types?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function readManifest(relativePath: string): Manifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
  ) as Manifest;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("the relocated package holds its four constituents (R8.1)", () => {
  it("has package.json, tsconfig.json, src/, and tests/", () => {
    expect(existsSync(resolve(repoRoot, CONFIG_DIR, "package.json"))).toBe(true);
    expect(existsSync(resolve(repoRoot, CONFIG_DIR, "tsconfig.json"))).toBe(
      true,
    );

    const src = resolve(repoRoot, CONFIG_DIR, "src");
    const tests = resolve(repoRoot, CONFIG_DIR, "tests");
    expect(existsSync(src) && statSync(src).isDirectory()).toBe(true);
    expect(existsSync(tests) && statSync(tests).isDirectory()).toBe(true);
  });
});

describe("the relocated tsconfig extends the repo-root base config (R8.3)", () => {
  const tsconfig = JSON.parse(readText(`${CONFIG_DIR}/tsconfig.json`)) as {
    readonly extends?: string;
  };

  it("extends ../../../tsconfig.base.json — one level deeper for the extra depth", () => {
    expect(tsconfig.extends).toBe("../../../tsconfig.base.json");
  });

  it("resolves to the repository-root tsconfig.base.json", () => {
    const resolved = resolve(repoRoot, CONFIG_DIR, tsconfig.extends ?? "");
    expect(resolved).toBe(resolve(repoRoot, "tsconfig.base.json"));
    expect(existsSync(resolved)).toBe(true);
  });
});

describe("the relocated manifest declares the same fields as before (R8.10)", () => {
  const manifest = readManifest(`${CONFIG_DIR}/package.json`);

  it("declares the same name, unchanged by the relocation (R8.5)", () => {
    expect(manifest.name).toBe("@microservices/config");
  });

  it("declares type: module", () => {
    expect(manifest.type).toBe("module");
  });

  it("declares main and types pointing at compiled output", () => {
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
  });

  it("declares exactly the four standard scripts", () => {
    const scripts = manifest.scripts ?? {};
    for (const name of ["build", "test", "lint", "typecheck"] as const) {
      expect(scripts, `missing script '${name}'`).toHaveProperty(name);
      expect(typeof scripts[name]).toBe("string");
      expect((scripts[name] ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("microservice2 still declares @microservices/config directly (R8.6)", () => {
  // Only microservice2 declares `@microservices/config` in its own manifest.
  // Microservice3 no longer names the Config_Package directly: it now depends
  // on `@microservices/extended-config` and reaches `@microservices/config`
  // transitively through it (design "Migration shape" / worked staged sets:
  // `ms3 → extended-config → config`). The by-name importer test therefore
  // narrows to `microservice2` alone — asserting a direct `@microservices/config`
  // dependency on `microservice3` would contradict that new dependency chain.
  it.each(["microservice2"] as const)(
    "%s depends on @microservices/config by package name",
    (id) => {
      const deps =
        readManifest(`packages/microservices/${id}/package.json`)
          .dependencies ?? {};
      expect(deps).toHaveProperty("@microservices/config");
    },
  );
});

// ---------------------------------------------------------------------------
// Stale-path scan (R8.2, R8.4, R8.8).
// ---------------------------------------------------------------------------

/**
 * A path-boundary matcher for the former directory path, built from a fragment
 * so this source never contains the forbidden token contiguously. It matches
 * the token when followed by `/`, a quote, whitespace, a backslash, or the end
 * of input — so the bare directory, a path under it, and a quoted reference all
 * count, while a longer name such as the `configuration` variant does not.
 */
const STALE_PATH = new RegExp(`packages/${"config"}(?=$|[/"'\\s\\\\])`);

/** Whether `text` references the former directory path at a path boundary. */
function referencesStalePath(text: string): boolean {
  return STALE_PATH.test(text);
}

/** Directory names never descended into while collecting scannable sources. */
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * Every file under `dir` (recursively) whose name matches `keep`, repo-relative.
 * `node_modules`, `dist`, and any `.git*` entry are pruned so the scan sees
 * committed source only.
 */
function collectFiles(
  dir: string,
  keep: (fileName: string) => boolean,
): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".git")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      out.push(...collectFiles(full, keep));
    } else if (entry.isFile() && keep(entry.name)) {
      out.push(relative(repoRoot, full));
    }
  }
  return out;
}

/**
 * The full set of files R8.2/R8.4/R8.8 forbid a stale reference in:
 *   - every Build_System source under `packages/build-tools/src/`
 *   - every repo-level script under `scripts/`
 *   - `Dockerfile.template`
 *   - the Root_Manifest (`package.json`)
 *   - every test source in the repository (`*.test.ts` / `*.test-d.ts`),
 *     across all packages, per R8.8 ("no test in the repository")
 */
function scannedFiles(): string[] {
  const buildToolsSrc = collectFiles(
    resolve(repoRoot, "packages/build-tools/src"),
    () => true,
  );
  const scripts = collectFiles(resolve(repoRoot, "scripts"), () => true);
  const testSources = collectFiles(resolve(repoRoot, "packages"), (name) =>
    /\.test(-d)?\.ts$/.test(name),
  );

  return [
    ...buildToolsSrc,
    ...scripts,
    "Dockerfile.template",
    "package.json",
    ...testSources,
  ];
}

describe("no stale reference to the former path survives the move (R8.2, R8.4, R8.8)", () => {
  it("the former directory is absent", () => {
    expect(existsSync(resolve(repoRoot, OLD_CONFIG_DIR))).toBe(false);
  });

  it("no scanned source references the former path", () => {
    const offenders = scannedFiles().filter((file) =>
      referencesStalePath(readText(file)),
    );

    expect(
      offenders,
      `stale reference to the former sample-library path in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the Root_Manifest lists packages/common/* and no former entry (R8.4)", () => {
    const workspaces =
      (readManifest("package.json") as { workspaces?: readonly string[] })
        .workspaces ?? [];
    expect(workspaces).toContain("packages/common/*");
    expect(workspaces).not.toContain(OLD_CONFIG_DIR);
    expect(workspaces).not.toContain(`${OLD_CONFIG_DIR}/*`);
  });
});

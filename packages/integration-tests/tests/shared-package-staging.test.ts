// Task 7.2 + Task 12.1 — Image_Tree staging of the Selector-justified packages.
//
// Assembles the real image tree with `buildImageTree` for several selectors and
// asserts the staged scoped-package layout matches what the Selector justifies,
// and cross-checks the derived BuildPlan (Common_Package set, Spa_Package set,
// resolver order, Build_Kind, plan membership) for the same selectors.
//
// The staged-set claims (design "Worked staged sets" table; contracts is always
// staged on Framework_Singleton grounds and NEVER counted as a Common_Package):
//
//   Selector                    Staged Common set        Staged Spa set
//   microservice1               {}                       {demo}
//   microservice2               {config}                 {}
//   microservice3               {config, extended-config}{}
//   microservice2,microservice3 {config, extended-config}{}
//   *                           {config, extended-config}{demo}
//
// "The staged Common_Package set" means config/extended-config only — the count
// excludes the Framework_Singleton `contracts`, the selected microservices, and
// the Spa_Package `demo`. It is derived here by intersecting the staged
// `node_modules/@microservices/*` entries with the packages discovery classifies
// as `common` (equivalently, the packages living under `packages/common/`), so a
// Framework_Singleton or a microservice never contaminates the count. The
// Spa_Package set is derived the same way over the `spa` category.
//
// `buildImageTree` reads `process.env.MICROSERVICES`, generates the registry,
// runs a real `tsc --build`, and stages relative to cwd (the repo root). The
// test pins cwd to the repo root, sets the selector per case, and restores cwd +
// the selector env afterward. Because each assemble runs a real `tsc --build`
// (and, for a Microservice1-bearing selector, the demo `vite build`), the
// timeouts are generous and each selector is assembled once in a `beforeAll`,
// reused across that selector's cases.
//
// The plan-membership cases (R6.8–R6.11) derive the BuildPlan directly with
// `buildPlan` / `discoverPackages` — no assembly needed — to assert the Demo_Spa
// is a Bundler_Project, a root of NO `tsc --build` invocation for any selector,
// built through its own `npm run build` (present in `spaBuilds`), the bundler
// build being ordered ahead of staging by the assembler's two-phase execution.
//
// Validates: Requirements R5.1, R5.2, R5.3, R5.4, R5.5, R5.6, R5.8, R6.8, R6.9,
//            R6.10, R6.11, R6.12, R6.13, R8.7, R11.9

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { buildImageTree } from "@microservices/build-tools/dist/image-tree.js";
import { buildPlan } from "@microservices/build-tools/dist/build-plan.js";
import {
  discoverPackages,
  type ConsumerPackage,
} from "@microservices/build-tools/dist/discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** Real assembly runs a full `tsc --build` (+ vite build); give each case room. */
const ASSEMBLE_TIMEOUT_MS = 240_000;

/** The known Common_Package directory names in this repository. */
const COMMON_PACKAGE_NAMES = ["config", "extended-config"] as const;
/** The known Spa_Package directory name in this repository. */
const SPA_PACKAGE_NAMES = ["demo"] as const;

/**
 * Run `fn` with cwd pinned to the repo root and MICROSERVICES set to `selector`,
 * restoring both afterward. `buildImageTree`, `buildPlan`, and `discoverPackages`
 * all resolve repo-relative paths against cwd and read the selector from env.
 */
function withRepoRootAndSelector<T>(selector: string, fn: () => T): T {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    return fn();
  } finally {
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
}

/** Assemble the image tree for `selector` into a fresh temp outDir. */
function assemble(selector: string): { outDir: string } {
  const outDir = mkdtempSync(join(tmpdir(), "shared-package-staging-"));
  withRepoRootAndSelector(selector, () => buildImageTree(outDir));
  return { outDir };
}

/** The `node_modules/@microservices/` scope root under an assembled tree. */
function scopeRoot(outDir: string): string {
  return join(outDir, "node_modules", "@microservices");
}

/** Path to a staged scoped package under the image tree. */
function scopedPackageDir(outDir: string, name: string): string {
  return join(scopeRoot(outDir), name);
}

/** The sorted set of scoped entry names actually staged under the tree. */
function stagedScopedEntries(outDir: string): string[] {
  try {
    return readdirSync(scopeRoot(outDir)).sort();
  } catch {
    return [];
  }
}

/**
 * The set of staged directory names that are Common_Packages — the staged scope
 * entries intersected with the known Common_Package names, so `contracts`
 * (Framework_Singleton), the selected microservices, and the Spa_Package `demo`
 * are all excluded from the count (R5.8).
 */
function stagedCommonSet(outDir: string): string[] {
  const staged = new Set(stagedScopedEntries(outDir));
  return COMMON_PACKAGE_NAMES.filter((n) => staged.has(n)).sort();
}

/** The set of staged directory names that are Spa_Packages. */
function stagedSpaSet(outDir: string): string[] {
  const staged = new Set(stagedScopedEntries(outDir));
  return SPA_PACKAGE_NAMES.filter((n) => staged.has(n)).sort();
}

/**
 * Assert `name` is staged under the image tree as a REAL directory (not a
 * symlink) carrying `package.json` + `dist/`.
 */
function expectStagedRealPackage(outDir: string, name: string): void {
  const pkgDir = scopedPackageDir(outDir, name);
  const dirStat = lstatSync(pkgDir);
  expect(dirStat.isDirectory(), `${name} should be a directory`).toBe(true);
  expect(
    dirStat.isSymbolicLink(),
    `${name} must be a real directory, not a workspace symlink`,
  ).toBe(false);
  expect(lstatSync(join(pkgDir, "package.json")).isFile()).toBe(true);
  expect(lstatSync(join(pkgDir, "dist")).isDirectory()).toBe(true);
}

// ---------------------------------------------------------------------------
// Group 1 — staged Common_Package set per Selector (R5.1–R5.4, R5.8)
// ---------------------------------------------------------------------------

describe("Staged Common_Package set per Selector (R5.1–R5.4, R5.8)", () => {
  const outDirs: string[] = [];
  const outDirBySelector: Record<string, string> = {};

  const CASES: ReadonlyArray<{
    selector: string;
    commonSet: string[];
    ref: string;
  }> = [
    { selector: "microservice1", commonSet: [], ref: "R5.3" },
    { selector: "microservice2", commonSet: ["config"], ref: "R5.1" },
    {
      selector: "microservice3",
      commonSet: ["config", "extended-config"],
      ref: "R5.2",
    },
    {
      selector: "*",
      commonSet: ["config", "extended-config"],
      ref: "R5.4",
    },
  ];

  beforeAll(() => {
    for (const { selector } of CASES) {
      const { outDir } = assemble(selector);
      outDirs.push(outDir);
      outDirBySelector[selector] = outDir;
    }
  }, ASSEMBLE_TIMEOUT_MS * CASES.length);

  afterAll(() => {
    for (const dir of outDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const { selector, commonSet, ref } of CASES) {
    it(`stages Common set { ${commonSet.join(", ") || "∅"} } for selector ${selector} (${ref})`, () => {
      expect(stagedCommonSet(outDirBySelector[selector])).toEqual(commonSet);
    });
  }

  it("stages @microservices/contracts for every selector while counting no Framework_Singleton in the Common set (R5.8)", () => {
    for (const { selector, commonSet } of CASES) {
      const outDir = outDirBySelector[selector];
      // contracts is always staged...
      expectStagedRealPackage(outDir, "contracts");
      // ...but it is not one of the counted Common_Packages.
      expect(stagedCommonSet(outDir)).not.toContain("contracts");
      expect(stagedCommonSet(outDir)).toEqual(commonSet);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Common_Package staging shape (R5.6)
// ---------------------------------------------------------------------------

describe("Common_Package staging shape (R5.6)", () => {
  const outDirs: string[] = [];
  // `*` stages both Common_Packages, so one assembly proves the shape for both.
  let outDir: string;

  beforeAll(() => {
    ({ outDir } = assemble("*"));
    outDirs.push(outDir);
  }, ASSEMBLE_TIMEOUT_MS);

  afterAll(() => {
    for (const dir of outDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const name of COMMON_PACKAGE_NAMES) {
    it(`stages ${name} as a real directory with package.json, a compiled dist/ (barrel + declarations), and no src/ (R5.6)`, () => {
      const pkgDir = scopedPackageDir(outDir, name);

      // Real directory, never a workspace symlink.
      const dirStat = lstatSync(pkgDir);
      expect(dirStat.isDirectory()).toBe(true);
      expect(
        dirStat.isSymbolicLink(),
        `${name} must be a real directory, not a workspace symlink`,
      ).toBe(false);

      // package.json present.
      expect(lstatSync(join(pkgDir, "package.json")).isFile()).toBe(true);

      // Compiled dist/ holding the barrel module and its declarations.
      const distDir = join(pkgDir, "dist");
      expect(lstatSync(distDir).isDirectory()).toBe(true);
      const distEntries = readdirSync(distDir);
      expect(
        distEntries,
        `${name}/dist should hold the compiled barrel module`,
      ).toContain("index.js");
      expect(
        distEntries,
        `${name}/dist should hold the barrel's type declarations`,
      ).toContain("index.d.ts");

      // No src/ ships.
      expect(
        () => lstatSync(join(pkgDir, "src")),
        `${name} must ship no src/ directory`,
      ).toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Group 3 — Spa_Package staging (R6.12, R6.13, R8.7)
// ---------------------------------------------------------------------------

describe("Spa_Package staging (R6.12, R6.13, R8.7)", () => {
  const outDirs: string[] = [];
  let ms1OutDir: string;
  let ms23OutDir: string;

  beforeAll(() => {
    ({ outDir: ms1OutDir } = assemble("microservice1"));
    outDirs.push(ms1OutDir);
    ({ outDir: ms23OutDir } = assemble("microservice2,microservice3"));
    outDirs.push(ms23OutDir);
  }, ASSEMBLE_TIMEOUT_MS * 2);

  afterAll(() => {
    for (const dir of outDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selector microservice1 stages Spa set { demo } (R6.12)", () => {
    expect(stagedSpaSet(ms1OutDir)).toEqual(["demo"]);
  });

  it("stages demo as a real directory holding exactly package.json + the contents of dist/, with no src/, tests/, or node_modules/ (R6.12, R8.7)", () => {
    const demoDir = scopedPackageDir(ms1OutDir, "demo");

    // Real directory, never a workspace symlink.
    const dirStat = lstatSync(demoDir);
    expect(dirStat.isDirectory()).toBe(true);
    expect(
      dirStat.isSymbolicLink(),
      "demo must be a real directory, not a workspace symlink",
    ).toBe(false);

    // Exactly package.json + dist/ at the top level — no src/, tests/, node_modules/.
    const topLevel = readdirSync(demoDir).sort();
    expect(topLevel).toEqual(["dist", "package.json"]);

    // dist/ carries the bundled entry document.
    const distDir = join(demoDir, "dist");
    expect(lstatSync(distDir).isDirectory()).toBe(true);
    expect(readdirSync(distDir)).toContain("index.html");
  });

  it("selector microservice2,microservice3 stages an empty Spa set and creates no node_modules/@microservices/demo (R6.13)", () => {
    expect(stagedSpaSet(ms23OutDir)).toEqual([]);
    expect(() =>
      lstatSync(scopedPackageDir(ms23OutDir, "demo")),
    ).toThrow();
  });

  it("stages @microservices/contracts for both selectors — the Spa set counts no Framework_Singleton (R5.8)", () => {
    expectStagedRealPackage(ms1OutDir, "contracts");
    expectStagedRealPackage(ms23OutDir, "contracts");
    expect(stagedSpaSet(ms1OutDir)).not.toContain("contracts");
    expect(stagedSpaSet(ms23OutDir)).not.toContain("contracts");
  });
});

// ---------------------------------------------------------------------------
// Group 4 — Dependency_Resolver order and plan membership (R5.5, R6.8–R6.11)
//
// These read the derived BuildPlan directly (no assembly): the resolver order
// and the Build_Kind/phase split are plan facts, not tree facts.
// ---------------------------------------------------------------------------

describe("Resolver order and plan membership (R5.5, R6.8–R6.11)", () => {
  /** The BuildPlan for `selector`, derived over the real tree. */
  function planFor(selector: string) {
    return withRepoRootAndSelector(selector, () => buildPlan(selector));
  }

  it("microservice3 Required_Dependencies' Common members are exactly [config, extended-config] with config at the lower index (R5.5)", () => {
    const plan = planFor("microservice3");
    const commonMembers = plan.requiredDependencies
      .filter((pkg: ConsumerPackage) => pkg.category === "common")
      .map((pkg: ConsumerPackage) => pkg.dirName);

    expect(commonMembers).toEqual(["config", "extended-config"]);
    expect(commonMembers.indexOf("config")).toBeLessThan(
      commonMembers.indexOf("extended-config"),
    );
  });

  it("discovery classifies demo as a Bundler_Project (R6.8)", () => {
    const discovery = withRepoRootAndSelector("*", () => discoverPackages());
    const demo = discovery.byCategory.spa.find((pkg) => pkg.dirName === "demo");
    expect(demo, "demo should be discovered under the spa category").toBeDefined();
    expect(demo?.buildKind).toBe("bundler-project");
  });

  it("demo is a root of NO tsc --build invocation for any selector (R6.10)", () => {
    for (const selector of [
      "microservice1",
      "microservice2",
      "microservice3",
      "microservice1,microservice2",
      "microservice2,microservice3",
      "*",
    ]) {
      const plan = planFor(selector);
      expect(
        plan.tscRoots,
        `demo must not be a tsc --build root for selector ${selector}`,
      ).not.toContain("packages/spa/demo");
    }
  });

  it("demo is built through its own npm run build (in spaBuilds) for every selector that reaches it (R6.9, R6.11)", () => {
    // Selectors that select Microservice1 reach @microservices/demo.
    for (const selector of ["microservice1", "microservice1,microservice2", "*"]) {
      const plan = planFor(selector);
      const spaDirs = plan.spaBuilds.map((pkg: ConsumerPackage) => pkg.dirName);
      expect(
        spaDirs,
        `demo should be in spaBuilds for selector ${selector}`,
      ).toContain("demo");
      // Its packageDir is what `npm run build` runs in — its own directory.
      const demo = plan.spaBuilds.find(
        (pkg: ConsumerPackage) => pkg.dirName === "demo",
      );
      expect(demo?.packageDir).toBe("packages/spa/demo");
    }

    // Selectors that reach no Microservice1 build no Spa_Package.
    for (const selector of ["microservice2", "microservice3", "microservice2,microservice3"]) {
      const plan = planFor(selector);
      expect(
        plan.spaBuilds.map((pkg: ConsumerPackage) => pkg.dirName),
        `no Spa build for selector ${selector}`,
      ).toEqual([]);
    }
  });

  it("the demo bundler build is a plan phase distinct from the tsc roots — spaBuilds ∩ tscRoots is empty (R6.10, R6.11)", () => {
    // The assembler runs `tsc --build tscRoots` first, then one `npm run build`
    // per spaBuilds member, then staging. The plan's two build sets are disjoint
    // in Build_Kind — every tscRoot is a Tsc_Project, every spaBuild a
    // Bundler_Project — so no package is both compiled as a tsc root and bundled.
    const plan = planFor("*");
    const spaDirs = new Set(
      plan.spaBuilds.map((pkg: ConsumerPackage) => pkg.packageDir),
    );
    for (const root of plan.tscRoots) {
      expect(spaDirs.has(root), `${root} must not be both a tsc root and a Spa build`).toBe(false);
    }
    // And demo, the one Bundler_Project, is present in spaBuilds and absent from tscRoots.
    expect([...spaDirs]).toContain("packages/spa/demo");
    expect(plan.tscRoots).not.toContain("packages/spa/demo");
  });
});

// Task 7.22 — Baseline-equivalence integration tests.
//
// The atomic core swap (step 4) must leave the two shipped artifacts — the
// generated Microservice_Registry and the assembled Image_Tree — equivalent to
// the Pre_Change_Baseline for both shipped Selectors (`*` and
// `microservice1,microservice2`). "Equivalent" is spelled out by the design's
// "BuildPlan for the two shipped Selectors" table and the Testing Strategy
// "Integration tests" bullets:
//
//   1. Registry equivalence — for each Selector the generated registry declares
//      the SAME import-specifier set and the SAME per-entry field set as the
//      baseline: one `@microservices/<dirName>` specifier per Selected
//      Microservice and one entry carrying exactly { identifier, module,
//      sourcePackage } with identifier === sourcePackage's directory suffix
//      (R14.2). The specifier stays directory-derived; the relocation of
//      `config` to `packages/common/config` must not perturb it.
//
//   2. Image_Tree equivalence — for each Selector the scoped entry set under
//      `node_modules/@microservices/` equals the baseline set (`contracts`,
//      `microservice1`, … the Selected microservices) PLUS `config` exactly
//      when it is a required dependency (R14.7, R5.6, R7.6). Every scoped entry is
//      a REAL directory, never a workspace symlink, and the Overseer sits at
//      `packages/overseer/` inside the tree.
//
//   3. `contracts` staged file set — for each Selector the sorted tree-relative
//      path set under `node_modules/@microservices/contracts` equals
//      `package.json` plus every file of `dist/`, `dist/testing/` included
//      (R5.8). `copyPackage` is what keeps this byte-for-byte stable.
//
// The Image_Tree cases assemble the real tree with `buildImageTree`, which
// reads `process.env.MICROSERVICES`, generates the registry, runs a real
// `tsc --build`, and stages relative to cwd (the repo root). The suite pins cwd
// to the repo root, sets the Selector per case, and restores cwd + the Selector
// env afterward — the same pattern as `shared-package-staging.test.ts`. Because
// each assemble runs a real `tsc --build`, the timeouts are generous.
//
// The registry cases call `generateRegistry(selector)` directly. Like
// `buildImageTree`, that writes the gitignored generated registry file as a
// side effect; the suite snapshots and restores its prior contents so the
// working tree is left as it was found.
//
// Validates: Requirements R5.6, R5.8, R7.6, R14.2, R14.7

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

import { buildImageTree } from "@microservices/build-tools/dist/image-tree.js";
import { generateRegistry } from "@microservices/build-tools/dist/generate-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The generated (gitignored) registry file `generateRegistry` writes. */
const REGISTRY_PATH = resolve(
  repoRoot,
  "packages/overseer/src/generated/microservice-registry.ts",
);

/** Real assembly runs a full `tsc --build`; give each case room. */
const ASSEMBLE_TIMEOUT_MS = 180_000;

/**
 * The Pre_Change_Baseline scoped entry sets from the design's "BuildPlan for
 * the two shipped Selectors" table. `contracts` is the always-staged
 * Framework_Singleton; `config` is present exactly when it is a required dependency
 * (any Selector including `microservice2` or `microservice3`).
 */
const BASELINE = {
  "*": {
    selected: ["microservice1", "microservice2", "microservice3"],
    scopedEntries: [
      "config",
      "contracts",
      "microservice1",
      "microservice2",
      "microservice3",
    ],
  },
  "microservice1,microservice2": {
    selected: ["microservice1", "microservice2"],
    scopedEntries: ["config", "contracts", "microservice1", "microservice2"],
  },
} as const;

type ShippedSelector = keyof typeof BASELINE;
const SHIPPED_SELECTORS: readonly ShippedSelector[] = [
  "*",
  "microservice1,microservice2",
];

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

interface RegistryEntry {
  identifier: string;
  sourcePackage: string;
  /** `module: mN` — the local alias bound by the matching import. */
  moduleAlias: string;
}

/** Parsed shape of a generated registry, enough to compare against baseline. */
interface ParsedRegistry {
  /** The set of import specifiers, in the order they appear. */
  importSpecifiers: string[];
  /** One entry per registry row, in order. */
  entries: RegistryEntry[];
  /** The exact set of fields present on each entry row, deduplicated. */
  entryFieldSets: string[][];
}

/**
 * Parse the generated registry text into its specifier set and per-entry field
 * set. Deliberately structural, not a full-text diff: the design's baseline
 * claim is about the SPECIFIER SET and the PER-ENTRY FIELD SET, not the header
 * comment or whitespace.
 */
function parseRegistry(text: string): ParsedRegistry {
  const importSpecifiers = [
    ...text.matchAll(/import \* as (m\d+) from "([^"]+)";/g),
  ].map((m) => m[2]);

  const entryFieldSets: string[][] = [];
  const entries: RegistryEntry[] = [];
  // Registry rows are the `{ … }` object literals that carry an `identifier:`
  // field — this deliberately excludes the `{ MicroserviceRegistry }` type
  // import and any other brace pair in the emitted text.
  for (const row of text.matchAll(/\{ ([^}]*identifier:[^}]*) \}/g)) {
    const body = row[1];
    const fields = [...body.matchAll(/(\w+):/g)].map((m) => m[1]);
    entryFieldSets.push(fields);

    const identifier = /identifier:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    const sourcePackage = /sourcePackage:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
    const moduleAlias = /module:\s*(\w+)/.exec(body)?.[1] ?? "";
    entries.push({ identifier, sourcePackage, moduleAlias });
  }

  return { importSpecifiers, entries, entryFieldSets };
}

/**
 * Generate the registry for `selector`, read the emitted text back, and restore
 * the prior (gitignored) file contents. Returns the emitted text.
 */
function generateRegistryText(selector: string): string {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  const previousRegistry = readFileSync(REGISTRY_PATH, "utf8");
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    generateRegistry(selector);
    return readFileSync(REGISTRY_PATH, "utf8");
  } finally {
    writeFileSync(REGISTRY_PATH, previousRegistry, "utf8");
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
}

// ---------------------------------------------------------------------------
// Image_Tree helpers
// ---------------------------------------------------------------------------

/** Assemble the image tree for `selector` into a fresh temp outDir. */
function assemble(selector: string): { outDir: string } {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  const outDir = mkdtempSync(join(tmpdir(), "baseline-equivalence-"));
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    buildImageTree(outDir);
  } finally {
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
  return { outDir };
}

/** The `node_modules/@microservices/` scope root under an assembled tree. */
function scopeRoot(outDir: string): string {
  return join(outDir, "node_modules", "@microservices");
}

/** The sorted set of scoped entry names actually staged under the tree. */
function stagedScopedEntries(outDir: string): string[] {
  return readdirSync(scopeRoot(outDir)).sort();
}

/**
 * Every regular file under `root`, as tree-relative POSIX paths, sorted. Used
 * to pin the `contracts` staged file set.
 */
function fileSetRelativeTo(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Assert `name` is staged under the tree as a REAL directory (not a symlink).
 */
function expectRealDirectory(outDir: string, name: string): void {
  const stat = lstatSync(join(scopeRoot(outDir), name));
  expect(stat.isDirectory(), `${name} should be a directory`).toBe(true);
  expect(
    stat.isSymbolicLink(),
    `${name} must be a real directory, not a workspace symlink`,
  ).toBe(false);
}

// ---------------------------------------------------------------------------
// 1. Registry equivalence
// ---------------------------------------------------------------------------

describe("Baseline registry equivalence (R14.2)", () => {
  for (const selector of SHIPPED_SELECTORS) {
    describe(`selector ${selector}`, () => {
      const expectedSelected = BASELINE[selector].selected;
      let parsed: ParsedRegistry;

      beforeAll(() => {
        parsed = parseRegistry(generateRegistryText(selector));
      });

      it("declares the baseline import-specifier set, directory-derived and in Selector order", () => {
        expect(parsed.importSpecifiers).toEqual(
          expectedSelected.map((id) => `@microservices/${id}`),
        );
      });

      it("emits one entry per Selected Microservice carrying exactly { identifier, module, sourcePackage }", () => {
        expect(parsed.entryFieldSets).toEqual(
          expectedSelected.map(() => ["identifier", "module", "sourcePackage"]),
        );
      });

      it("ties each entry's identifier, sourcePackage, and module alias to its directory-derived import", () => {
        expect(
          parsed.entries.map((e) => ({
            identifier: e.identifier,
            sourcePackage: e.sourcePackage,
          })),
        ).toEqual(
          expectedSelected.map((id) => ({
            identifier: id,
            sourcePackage: `@microservices/${id}`,
          })),
        );
        // module alias mN matches the import that binds the same specifier.
        for (let i = 0; i < parsed.entries.length; i++) {
          const alias = parsed.entries[i].moduleAlias;
          expect(alias).toBe(`m${i}`);
          expect(parsed.importSpecifiers[i]).toBe(
            parsed.entries[i].sourcePackage,
          );
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Image_Tree equivalence + 3. contracts staged file set
// ---------------------------------------------------------------------------

describe("Baseline Image_Tree equivalence (R14.7, R5.6, R7.6, R5.8)", () => {
  const outDirs: string[] = [];

  afterAll(() => {
    for (const dir of outDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const selector of SHIPPED_SELECTORS) {
    describe(`selector ${selector}`, () => {
      const expected = BASELINE[selector];
      let outDir: string;

      beforeAll(() => {
        ({ outDir } = assemble(selector));
        outDirs.push(outDir);
      }, ASSEMBLE_TIMEOUT_MS);

      it("stages exactly the baseline scoped entry set (baseline + config where it is a required dependency) (R14.7)", () => {
        expect(stagedScopedEntries(outDir)).toEqual(expected.scopedEntries);
      });

      it("stages every scoped entry as a real directory, never a workspace symlink (R5.6)", () => {
        for (const name of expected.scopedEntries) {
          expectRealDirectory(outDir, name);
        }
      });

      it("places the Overseer at packages/overseer/ inside the tree (R7.6)", () => {
        const overseerDir = join(outDir, "packages", "overseer");
        expect(lstatSync(overseerDir).isDirectory()).toBe(true);
        expect(lstatSync(join(overseerDir, "package.json")).isFile()).toBe(
          true,
        );
        expect(lstatSync(join(overseerDir, "dist")).isDirectory()).toBe(true);
      });

      it("stages contracts as exactly package.json plus every file of dist/, dist/testing/ included (R5.8)", () => {
        const contractsRoot = join(scopeRoot(outDir), "contracts");
        const actual = fileSetRelativeTo(contractsRoot);

        const distFiles = fileSetRelativeTo(join(contractsRoot, "dist")).map(
          (p) => `dist/${p}`,
        );
        const expectedSet = ["package.json", ...distFiles].sort();

        expect(actual).toEqual(expectedSet);
        // dist/testing/ is part of the staged contracts surface.
        expect(actual.some((p) => p.startsWith("dist/testing/"))).toBe(true);
      });
    });
  }
});

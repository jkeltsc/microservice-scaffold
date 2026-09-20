// Task 14.8 — end-to-end over a non-default Effective_Config
// (config-driven-discovery spec).
//
// Feature: config-driven-discovery, Requirement 13.2: the Build_System test
// suite must include at least one assertion exercising a Configured_Scope other
// than the Scope_Default AND at least one in which all three Discovery_Roots
// differ from their Root_Defaults, with each such assertion reporting pass or
// fail from the Synthesized_Tree it configures.
//
// This suite is that assertion at the INTEGRATION level: it drives a real
// Build_System entry point — the compiled `generate-registry` bin — over a
// `pristineWorktree()` copy whose `scaffold.config.json` sets BOTH a scope other
// than `@microservices` (`@acme`) AND all three roots away from their defaults
// (`services`, `libs`, `web`) AND an Entry_Root away from the Entry_Root_Default
// (`runner` rather than `app`, registry-inversion R1.3). The copy carries
// synthesised Consumer_Packages
// under those relocated roots, named under the configured scope, plus a
// `workspaces` array covering them (npm reads that array statically to create the
// scoped symlinks). The copy's directory is passed as BOTH the Project_Directory
// and the spawn `cwd`, so the bin loads `scaffold.config.json` relative to it and
// discovers under the configured roots.
//
// The observable: the generated Microservice_Registry lands under the CONFIGURED
// Entry_Root and imports the selected synthesised microservice under the
// CONFIGURED scope (`@acme/<id>`), its `sourcePackage` carrying that scope —
// proving the loaded scope, the loaded roots, and the loaded Entry_Root all thread
// the whole way through discovery, path derivation, and registry generation, from
// a real spawned process reading a real file. A run that read a baked-in
// `@microservices` scope, a baked-in `packages/microservices` root, or a baked-in
// `app` Entry_Root would import nothing (the relocated roots hold no default-named
// package), emit the wrong scope, or write the registry somewhere this suite does
// not look — and this suite would fail.
//
// --- This suite NEVER touches the real working tree -------------------------
// The `scaffold.config.json`, the relocated root directories, the synthesised
// packages, and the workspace symlinks are written ONLY inside the
// `pristineWorktree()` copy — an OS temp directory. NO `scaffold.config.json` and
// NO package directory is ever created in the checked-out repository: an
// untracked config file would change what every other suite reads, which is
// exactly what Requirement 13.6 forbids. The registry the bin writes lands under
// the copy's own configured Entry_Root, not the real tree. Teardown
// removes the copy — including on failure — via `afterAll`; there is nothing in
// the real tree to undo. This follows `dev-session-scope.test.ts`.
//
// Validates: Requirements 13.2, 13.5, 13.6, 13.10, 13.11

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

// The non-default configuration this suite exercises. The scope differs from the
// Scope_Default and all three roots differ from their Root_Defaults; none of the
// roots begins with `packages`, so they never collide with a Framework_Singleton.
const SCOPE = "@acme";
const MS_ROOT = "services";
const COMMON_ROOT = "libs";
const SPA_ROOT = "web";
// The Entry_Root, away from the Entry_Root_Default `app` and colliding with none
// of the eight reserved paths, so the Config_Parser accepts it
// (registry-inversion R1.4, R1.6).
const ENTRY_ROOT = "runner";

// One synthesised microservice and one common library under the relocated roots.
const MS_ID = "gateway";
const COMMON_NAME = "settings";

// The Selector selecting the one synthesised microservice.
const SELECTOR = MS_ID;

// `pristineWorktree()` runs `npm ci`, and this suite also builds the copy's
// build-tools chain (contracts → build-tools) so the compiled bin exists. Give
// the whole beforeAll a generous budget; the spawned bin itself is milliseconds.
const PRISTINE_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 900_000;

/** The compiled generate-registry bin, relative to the copy root. */
const GENERATE_REGISTRY_BIN = "packages/build-tools/dist/bin/generate-registry.js";
/** Where the bin writes the registry, relative to the copy root: under the
 *  CONFIGURED Entry_Root, not under a Framework_Singleton and not under the
 *  Entry_Root_Default (registry-inversion R4.1). Spelled out here rather than
 *  imported, so the suite's expectation is independent of the derivation. */
const REGISTRY_OUT = `${ENTRY_ROOT}/src/generated/microservice-registry.ts`;
/** The retired location, which no run may write any more. */
const RETIRED_REGISTRY_OUT =
  "packages/overseer/src/generated/microservice-registry.ts";
/** The Entry_Root_Default's location, which a run under this config may not write
 *  either — the Entry_Root is a configured value, not a constant. */
const DEFAULT_REGISTRY_OUT = "app/src/generated/microservice-registry.ts";

let pristine: PristineWorktreeResult | undefined;
/** The generated registry bytes, captured after the spawned bin ran. */
let registry: string | undefined;
let genStatus = -1;
let genStderr = "";

/** A minimal valid microservice manifest under the configured scope. */
function microserviceManifest(): string {
  return (
    JSON.stringify(
      {
        name: `${SCOPE}/${MS_ID}`,
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { [`${SCOPE}/contracts`]: "*", express: "^5.1.0" },
      },
      null,
      2,
    ) + "\n"
  );
}

/** A minimal valid Common_Package manifest (a barrel) under the configured scope. */
function commonManifest(): string {
  return (
    JSON.stringify(
      {
        name: `${SCOPE}/${COMMON_NAME}`,
        version: "0.0.0",
        private: true,
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      null,
      2,
    ) + "\n"
  );
}

/** A minimal Entry_Package manifest under the configured scope, named as
 *  registry-inversion R1.10 requires: the scope, `/`, and the Entry_Root's last
 *  segment. */
function entryManifest(): string {
  return (
    JSON.stringify(
      {
        name: `${SCOPE}/${ENTRY_ROOT}`,
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          [`${SCOPE}/contracts`]: "*",
          [`${SCOPE}/overseer`]: "*",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Rewrite the root package.json `workspaces` array so it covers the relocated
 *  roots and the relocated Entry_Root (npm reads it statically). Preserves the
 *  framework entries. */
function rewriteWorkspaces(root: string): void {
  const manifestPath = resolve(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    workspaces?: unknown;
    [key: string]: unknown;
  };
  manifest.workspaces = [
    "packages/contracts",
    "packages/overseer",
    "packages/build-tools",
    "packages/integration-tests",
    ENTRY_ROOT,
    `${MS_ROOT}/*`,
    `${COMMON_ROOT}/*`,
    `${SPA_ROOT}/*`,
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

beforeAll(() => {
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    return;
  }
  const dir = pristine.dir;

  // The synthesised microservice, under the relocated microservice root.
  const msDir = resolve(dir, MS_ROOT, MS_ID);
  mkdirSync(msDir, { recursive: true });
  writeFileSync(resolve(msDir, "package.json"), microserviceManifest());

  // The synthesised common library, under the relocated common root. The spa
  // root is left absent (a tolerant root yields zero packages, no error).
  const commonDir = resolve(dir, COMMON_ROOT, COMMON_NAME);
  mkdirSync(commonDir, { recursive: true });
  writeFileSync(resolve(commonDir, "package.json"), commonManifest());

  // The Entry_Package at the relocated Entry_Root: a manifest alone, since the
  // generate-registry bin reads no content of the Entry_Module and writes the
  // registry into a directory it creates itself. It exists so the `workspaces`
  // entry below names a real directory.
  const entryDir = resolve(dir, ENTRY_ROOT);
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(resolve(entryDir, "package.json"), entryManifest());

  // The non-default configuration, written INSIDE the copy only. All four
  // recognised values differ from their defaults.
  writeFileSync(
    resolve(dir, "scaffold.config.json"),
    JSON.stringify(
      {
        scope: SCOPE,
        entry: ENTRY_ROOT,
        roots: { microservice: MS_ROOT, common: COMMON_ROOT, spa: SPA_ROOT },
      },
      null,
      2,
    ) + "\n",
  );

  // Cover the relocated roots and the relocated Entry_Root in the root
  // `workspaces` array (membership, not order), inside the copy only. No registry
  // template is rewritten: there is none — the Registry_Template was retired, and
  // the generator now writes a complete registry into the consumer's tree
  // (registry-inversion R3.6, R5.1).
  rewriteWorkspaces(dir);

  // Build the compiled bin's chain (contracts, then build-tools) inside the
  // copy. Only these two are needed to run generate-registry.
  for (const workspace of ["@microservices/contracts", "@microservices/build-tools"]) {
    const build = spawnSync("npm", ["run", "build", "--workspace", workspace], {
      cwd: dir,
      encoding: "utf8",
    });
    if ((build.status ?? 1) !== 0) {
      throw new Error(
        `building ${workspace} in the pristine copy failed:\n${build.stderr ?? build.stdout ?? ""}`,
      );
    }
  }

  // Run the real generate-registry bin with the copy as cwd, so it loads
  // scaffold.config.json relative to the copy and discovers under the configured
  // roots. The selector names the synthesised microservice.
  const run = spawnSync(process.execPath, [GENERATE_REGISTRY_BIN], {
    cwd: dir,
    env: { ...process.env, MICROSERVICES: SELECTOR },
    encoding: "utf8",
  });
  genStatus = run.status ?? -1;
  genStderr = run.stderr ?? "";
  try {
    registry = readFileSync(resolve(dir, REGISTRY_OUT), "utf8");
  } catch {
    registry = undefined;
  }
}, PRISTINE_TIMEOUT_MS);

afterAll(() => {
  // Remove the copy on completion, including on failure. Nothing in the real
  // tree to undo: every write happened inside the copy.
  if (pristine?.available === true) {
    pristine.cleanup();
    pristine = undefined;
  }
});

describe("Build_System end-to-end under a non-default scope and relocated roots (R13.2)", () => {
  it("skips cleanly when the pristine worktree is unavailable", () => {
    if (pristine === undefined || pristine.available !== true) {
      console.warn(
        `SKIP non-default-configuration: ${pristine?.reason ?? "pristine tree unavailable"}`,
      );
      return;
    }
    expect(pristine.available).toBe(true);
  });

  it(
    "generates a registry importing the microservice under the configured scope and relocated root",
    () => {
      if (pristine === undefined || pristine.available !== true) {
        return; // reason already reported by the skip case above
      }

      // The bin succeeded and wrote a registry.
      expect(genStatus, `stderr: ${genStderr}`).toBe(0);
      expect(registry, "no registry was written").toBeDefined();
      const text = registry as string;

      // The emitted import specifier and sourcePackage carry the CONFIGURED
      // scope, not the Scope_Default (R13.2 — scope threaded end-to-end).
      expect(text).toContain(`import * as m0 from "${SCOPE}/${MS_ID}";`);
      expect(text).toContain(`sourcePackage: "${SCOPE}/${MS_ID}"`);
      expect(text).toContain(`{ identifier: "${MS_ID}"`);
      // The contracts type-import is scoped too.
      expect(text).toContain(`from "${SCOPE}/contracts"`);
      // No default-scope specifier leaked through.
      expect(text).not.toContain("@microservices/");

      // The microservice was found under the RELOCATED root, not the default one:
      // had discovery read `packages/microservices`, the selector `gateway` would
      // have matched nothing and the bin would have exited non-zero writing no
      // registry — which the assertions above already rule out. The presence of
      // exactly the one selected identifier confirms the relocated root was read.
      const identifierLines = [
        ...text.matchAll(/\{ identifier: "([^"]+)"/g),
      ].map((match) => match[1]);
      expect(identifierLines).toEqual([MS_ID]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "writes the registry under the CONFIGURED Entry_Root and nowhere else",
    () => {
      if (pristine === undefined || pristine.available !== true) {
        return; // reason already reported by the skip case above
      }
      const dir = pristine.dir;

      // The configured Entry_Root is where the registry landed — the `entry` value
      // is threaded end-to-end just like the scope and the three roots
      // (registry-inversion R4.1, R13.2).
      expect(existsSync(resolve(dir, REGISTRY_OUT))).toBe(true);

      // And nowhere else. Not the retired location under the Overseer
      // Framework_Singleton — no run writes under a Framework_Singleton's directory
      // any more (R4.1) — and not the Entry_Root_Default's location, which would
      // mean a component read a literal instead of the threaded Effective_Config.
      expect(
        existsSync(resolve(dir, RETIRED_REGISTRY_OUT)),
        "a registry was written under the retired location beneath the Overseer",
      ).toBe(false);
      expect(
        existsSync(resolve(dir, DEFAULT_REGISTRY_OUT)),
        "a registry was written at the Entry_Root_Default, so the configured " +
          "Entry_Root was not the value the generator used",
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

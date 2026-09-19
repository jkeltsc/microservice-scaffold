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
// (`services`, `libs`, `web`). The copy carries synthesised Consumer_Packages
// under those relocated roots, named under the configured scope, plus a
// `workspaces` array covering them (npm reads that array statically to create the
// scoped symlinks). The copy's directory is passed as BOTH the Project_Directory
// and the spawn `cwd`, so the bin loads `scaffold.config.json` relative to it and
// discovers under the configured roots.
//
// The observable: the generated Microservice_Registry imports the selected
// synthesised microservice under the CONFIGURED scope (`@acme/<id>`) and its
// `sourcePackage` carries that scope — proving the loaded scope and the loaded
// roots both thread all the way through discovery and registry generation, from
// a real spawned process reading a real file. A run that read a baked-in
// `@microservices` scope or a baked-in `packages/microservices` root would import
// nothing (the relocated roots hold no default-named package) or emit the wrong
// scope, and this suite would fail.
//
// --- This suite NEVER touches the real working tree -------------------------
// The `scaffold.config.json`, the relocated root directories, the synthesised
// packages, and the workspace symlinks are written ONLY inside the
// `pristineWorktree()` copy — an OS temp directory. NO `scaffold.config.json` and
// NO package directory is ever created in the checked-out repository: an
// untracked config file would change what every other suite reads, which is
// exactly what Requirement 13.6 forbids. The registry the bin writes lands in the
// copy's own `packages/overseer/src/generated/`, not the real tree. Teardown
// removes the copy — including on failure — via `afterAll`; there is nothing in
// the real tree to undo. This follows `dev-session-scope.test.ts`.
//
// Validates: Requirements 13.2, 13.5, 13.6, 13.10, 13.11

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

// The non-default configuration this suite exercises. The scope differs from the
// Scope_Default and all three roots differ from their Root_Defaults; none of the
// roots begins with `packages`, so they never collide with a Framework_Singleton.
const SCOPE = "@acme";
const MS_ROOT = "services";
const COMMON_ROOT = "libs";
const SPA_ROOT = "web";

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
/** Where the bin writes the registry, relative to the copy root. */
const REGISTRY_OUT = "packages/overseer/src/generated/microservice-registry.ts";
/** The committed registry template, whose scoped specifiers must match the
 *  configured scope for a later Overseer compile; rewritten inside the copy. */
const REGISTRY_TEMPLATE =
  "packages/overseer/src/generated/microservice-registry.template.ts";

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

/** Rewrite the root package.json `workspaces` array so it covers the relocated
 *  roots (npm reads it statically). Preserves the framework entries. */
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

  // The non-default configuration, written INSIDE the copy only.
  writeFileSync(
    resolve(dir, "scaffold.config.json"),
    JSON.stringify(
      { scope: SCOPE, roots: { microservice: MS_ROOT, common: COMMON_ROOT, spa: SPA_ROOT } },
      null,
      2,
    ) + "\n",
  );

  // Cover the relocated roots in the root `workspaces` array (membership, not
  // order), and rewrite the committed registry template's scope to match the
  // configured scope so a later Overseer compile would resolve — both inside the
  // copy only.
  rewriteWorkspaces(dir);
  const template = readFileSync(resolve(dir, REGISTRY_TEMPLATE), "utf8");
  writeFileSync(
    resolve(dir, REGISTRY_TEMPLATE),
    template.split("@microservices/").join(`${SCOPE}/`),
  );

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
});

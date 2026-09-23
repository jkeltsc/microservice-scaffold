// Feature: platform-fixtures, Step 7 — the Fixture_Equivalent of the
// payload-coupled Tsconfig_Verifier claim (task 7.3).
//
// The payload-coupled Tsconfig_Verifier tests hand `verifyTsconfigs` a resolved
// configuration and assert the violation set. Their Fixture_Equivalent, here,
// runs the SAME verifier over a committed Project_Fixture tree — reading a real
// tsconfig `extends` chain through the TS compiler API — and asserts the
// reported violation TAG set equals that fixture's one declared Expected_
// Diagnostic. No Payload_Tree fact is asserted (R13.3): the only claim is over
// tags, exactly as the payload-coupled claim is.
//
// Subjects: the three committed tsconfig Project_Fixtures — `tsconfig--setting`,
// `tsconfig--absent`, `tsconfig--unresolvable` — each declaring its one
// Expected_Diagnostic in its `fixture.json`.
//
// Gating (R6.6, R6.7): `installedFixtureProjects` returns `available: false`
// locally when the Fixture_Projects_Root is uninstalled (the suite SKIPS with a
// clear reason), and THROWS in CI (the suite FAILS), so a workflow whose install
// step was removed cannot pass by skipping every assertion.
//
// Cleanliness (R13.7): the suite is READ-ONLY. It only `chdir`s into a fixture
// directory and calls `discoverPackages` + `verifyTsconfigs`, both of which read
// tsconfigs and write nothing. The working directory is restored in `finally`.
// Every scope/root is derived from each fixture's own `scaffold.config.json`
// over the defaults — no literal (R3.7). The platform's own verifier is used;
// no fixture module is executed (R3.7).
//
// Validates: Requirements 3.7, 6.6, 6.7, 13.1, 13.2, 13.3, 13.7

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { discoverPackages } from "../src/discovery.js";
import {
  verifyTsconfigs,
  resolveTsconfigWithCompiler,
} from "../src/tsconfig-verifier.js";
import { projectContext } from "../src/project-context.js";
import {
  defaultEffectiveConfig,
  PROJECT_CONFIG_FILE,
  type EffectiveConfig,
} from "../src/project-config.js";

import { installedFixtureProjects } from "@microservices/build-tools/dist/testing/index.js";

import { FIXTURES_ROOT } from "./fixture-paths.js";

const FIXTURE_PROJECTS_ROOT = join(FIXTURES_ROOT, "projects");

/** The three tsconfig Project_Fixtures whose fault the verifier reports. */
const SUBJECTS = ["tsconfig--setting", "tsconfig--absent", "tsconfig--unresolvable"];

interface FixtureManifest {
  readonly expectedDiagnostic: string;
}

/**
 * Build a fixture's Effective_Config from its own `scaffold.config.json` (if
 * present) layered over the five defaults, so scope and roots come from the
 * fixture rather than a literal here (R3.7). Most tsconfig fixtures declare only
 * a `scope`.
 */
function effectiveConfigOf(fixtureDir: string): EffectiveConfig {
  const defaults = defaultEffectiveConfig();
  const configPath = join(fixtureDir, PROJECT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return defaults;
  }

  const declared = JSON.parse(readFileSync(configPath, "utf8")) as {
    readonly scope?: string;
    readonly roots?: Partial<EffectiveConfig["roots"]>;
    readonly entry?: string;
  };

  return {
    scope: declared.scope ?? defaults.scope,
    roots: {
      microservice: declared.roots?.microservice ?? defaults.roots.microservice,
      common: declared.roots?.common ?? defaults.roots.common,
      spa: declared.roots?.spa ?? defaults.roots.spa,
    },
    entry: declared.entry ?? defaults.entry,
  };
}

describe("Tsconfig_Verifier Fixture_Equivalent: reported tag set == fixture's one tag (R13.1, R13.2)", () => {
  for (const name of SUBJECTS) {
    const fixtureDir = join(FIXTURE_PROJECTS_ROOT, name);

    it(`${name} reports exactly its declared Expected_Diagnostic`, () => {
      const handle = installedFixtureProjects(FIXTURE_PROJECTS_ROOT);
      if (!handle.available) {
        console.warn(handle.reason);
        return;
      }

      const expected = (
        JSON.parse(
          readFileSync(join(fixtureDir, "fixture.json"), "utf8"),
        ) as FixtureManifest
      ).expectedDiagnostic;

      const context = projectContext(effectiveConfigOf(fixtureDir));

      // `verifyTsconfigs` reads `process.cwd()` for the Project_Directory and
      // `resolveTsconfigWithCompiler` reads `extends` chains relative to it, so
      // the fixture must be the working directory for the duration. Read-only:
      // neither discovery nor verification writes. Restore cwd in `finally`.
      const previousCwd = process.cwd();
      let tags: Set<string>;
      try {
        process.chdir(fixtureDir);
        // These three are tsconfig faults, so discovery must succeed; a throw
        // here would be a different fault and should surface as a failure.
        const discovery = discoverPackages(context);
        const violations = verifyTsconfigs(
          context,
          discovery,
          resolveTsconfigWithCompiler,
        );
        tags = new Set(violations.map((v) => `[${v.tag}]`));
      } finally {
        process.chdir(previousCwd);
      }

      expect(
        [...tags],
        `${name} must report exactly the one-element tag set { ${expected} }, ` +
          `but reported { ${[...tags].join(", ")} }`,
      ).toEqual([expected]);
    });
  }
});

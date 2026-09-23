// Install-wiring example test — platform-fixtures task 2.4.
//
// The Fixture_Install is exposed as exactly one root npm script,
// `fixtures:install`, an npm clean install with the Fixture_Projects_Root
// (`fixtures/projects`) as its working directory via `--prefix`. This suite
// pins that wiring against the committed root `package.json` and asserts the
// invariants R6.1–R6.4 place around it:
//
//   * `scripts["fixtures:install"]` is exactly `npm ci --prefix fixtures/projects`
//     — an npm clean install rooted at the Fixture_Projects_Root (R6.1).
//   * No lifecycle script (preinstall/install/postinstall/prepare/…) and no
//     other script performs a Fixture_Install: only the `fixtures:install`
//     entry references `fixtures/projects` install or `fixtures:install`, and
//     the root `npm install` / `npm ci` are bare built-ins that trigger no
//     lifecycle install of the fixtures (R6.1, R6.2).
//   * The `ci` script keeps its Pre_Change_Baseline composition and order and
//     performs no Fixture_Install (R6.3).
//   * `fixtures:install` invokes no build with `--workspaces`, so the
//     Repo_Invariant_Checker's build-order-source check stays silent over the
//     Root_Manifest (R6.4). Asserted both directly and through the production
//     `checkBuildOrderSource` over the real script text.
//
// The availability probe (R6.8 — one shared function, no suite spelling its
// own) is `installedFixtureProjects` in
// `@microservices/build-tools/dist/testing/index.js`, added by task 3.2. Task
// 2.4 deferred the "one shared function" assertion to task 3.2; it now lives at
// the bottom of this file.
//
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.8

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  checkBuildOrderSource,
  type ScriptSource,
} from "@microservices/build-tools/dist/repo-invariants.js";
import { installedFixtureProjects } from "@microservices/build-tools/dist/testing/index.js";

import { FIXTURE_PROJECTS_ROOT } from "./fixture-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as Manifest;

/** The exact text the Fixture_Install script must carry (R6.1). */
const FIXTURES_INSTALL = "npm ci --prefix fixtures/projects";

/**
 * The `ci` script's Pre_Change_Baseline composition and order (R6.3). This is
 * the six-step gate as it stands before this feature and must stay exactly so:
 * a build, then check:invariants, then the four slower gates in order.
 */
const CI_BASELINE =
  "npm run build && npm run check:invariants && npm run typecheck --workspaces && npm run lint --workspaces && npm test && npm run test:types";

/**
 * The npm lifecycle script names that could run an install implicitly. A
 * Fixture_Install hidden behind any of these would make a clone's install cost
 * or resolved dependency set depend on this feature (R6.2).
 */
const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "preci",
  "postci",
] as const;

describe("the root package.json exposes the Fixture_Install as `fixtures:install` (R6.1)", () => {
  const scripts = manifest.scripts ?? {};

  it("declares fixtures:install as exactly `npm ci --prefix fixtures/projects`", () => {
    expect(scripts["fixtures:install"]).toBe(FIXTURES_INSTALL);
  });

  it("performs an npm clean install rooted at the Fixture_Projects_Root via --prefix", () => {
    const script = scripts["fixtures:install"] ?? "";
    // `npm ci` is the clean-install verb; `--prefix fixtures/projects` roots it
    // at the Fixture_Projects_Root rather than the repository root.
    expect(script).toContain("npm ci");
    expect(script).toContain("--prefix fixtures/projects");
    // It does not install at the repository root: no `--prefix` pointing
    // elsewhere and no bare `npm ci`/`npm install` without the prefix.
    expect(script.trim()).toBe(FIXTURES_INSTALL);
  });

  it("passes no `--workspaces` (R6.4)", () => {
    const script = scripts["fixtures:install"] ?? "";
    // A whole-token `--workspaces` check (allowing `--workspaces=<value>`),
    // deliberately NOT matching the single-package `--workspace <name>` flag.
    expect(/--workspaces(?:=|\b)/.test(script)).toBe(false);
  });
});

describe("no lifecycle script and no other script performs a Fixture_Install (R6.1, R6.2)", () => {
  const scripts = manifest.scripts ?? {};

  it("declares no lifecycle script at all that could carry an implicit install", () => {
    // The Root_Manifest declares none of the npm install-lifecycle hooks, so
    // the root `npm install`/`npm ci` remain bare built-ins: they run no
    // Fixture_Install, and a clone's install cost is unchanged by this feature.
    for (const name of LIFECYCLE_SCRIPTS) {
      expect(
        scripts[name],
        `root package.json must declare no "${name}" lifecycle script (it would run on \`npm install\`/\`npm ci\`)`,
      ).toBeUndefined();
    }
  });

  it("references a Fixture_Install only from the fixtures:install entry itself", () => {
    // No other script may reference the Fixture_Projects_Root install or the
    // `fixtures:install` script — only the entry itself performs it.
    for (const [name, value] of Object.entries(scripts)) {
      if (name === "fixtures:install") {
        continue;
      }
      expect(
        value.includes("fixtures/projects"),
        `script "${name}" must not reference the Fixture_Projects_Root install; only fixtures:install performs a Fixture_Install`,
      ).toBe(false);
      expect(
        value.includes("fixtures:install"),
        `script "${name}" must not invoke fixtures:install; a Fixture_Install runs only from its own entry (and, in CI, its own workflow step)`,
      ).toBe(false);
    }
  });
});

describe("the root ci script keeps its Pre_Change_Baseline composition and order (R6.3)", () => {
  const scripts = manifest.scripts ?? {};

  it("ci equals its Pre_Change_Baseline text exactly", () => {
    expect(scripts.ci).toBe(CI_BASELINE);
  });

  it("ci performs no Fixture_Install", () => {
    const ci = scripts.ci ?? "";
    expect(ci.includes("fixtures/projects")).toBe(false);
    expect(ci.includes("fixtures:install")).toBe(false);
  });
});

describe("the build-order-source check stays silent over fixtures:install (R6.4)", () => {
  it("checkBuildOrderSource reports nothing for the real fixtures:install script text", () => {
    // Drive the production check with the real script text shaped exactly as
    // the `check:invariants` bin's effect shell (rootManifestScripts) shapes
    // it: one ScriptSource named by the script name. `fixtures:install` uses
    // `--prefix`, not `--workspaces`, so the check emits no message over it.
    const scripts = manifest.scripts ?? {};
    const source: ScriptSource = {
      source: "fixtures:install",
      text: scripts["fixtures:install"] ?? "",
    };
    expect(checkBuildOrderSource([source], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The availability probe is one shared function (R6.8).
//
// Task 2.4 deferred this assertion to task 3.2, when the probe
// (`installedFixtureProjects`) came to exist in
// `@microservices/build-tools/dist/testing/`. It now exists, so the assertion
// lands here: R6.8 requires the availability probe to be exactly one shared
// function returning the Clone_Handle shape, with no suite spelling its own —
// so a suite imports THIS function rather than reimplementing a `node_modules`
// existence check. We assert it is that single shared function, and that it
// returns a Clone_Handle over the real (path-parameterised) Fixture_Projects_Root.
// ---------------------------------------------------------------------------

describe("the availability probe is one shared function returning a Clone_Handle (R6.8)", () => {
  it("exposes installedFixtureProjects as a shared function from the testing barrel", () => {
    expect(typeof installedFixtureProjects).toBe("function");
  });

  it("returns the Clone_Handle shape over the Fixture_Projects_Root, branching on `available`", () => {
    // `CI` non-empty turns absence into a throw (R6.7), which would make this
    // assertion of the return shape depend on whether the fixtures happen to be
    // installed in this environment. Neutralise `CI` for the duration of the
    // probe call so we exercise the return-shape contract (present -> available,
    // absent -> skip reason) deterministically; restore it afterwards.
    const savedCi = process.env.CI;
    delete process.env.CI;
    try {
      const handle = installedFixtureProjects(FIXTURE_PROJECTS_ROOT);
      expect(typeof handle.available).toBe("boolean");
      if (handle.available) {
        // The install is shared: `dir` is the root itself and `cleanup` is a
        // no-op the suite may call uniformly.
        expect(handle.dir).toBe(FIXTURE_PROJECTS_ROOT);
        expect(typeof handle.cleanup).toBe("function");
        expect(() => handle.cleanup()).not.toThrow();
      } else {
        // The skip reason names the `fixtures:install` script (R6.6).
        expect(handle.reason).toContain("fixtures:install");
      }
    } finally {
      if (savedCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = savedCi;
      }
    }
  });
});

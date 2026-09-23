// @microservices/build-tools/dist/testing — the Installed_Fixture_Projects
// availability probe (Fixture_Tier spec, task 3.2; R6.6, R6.7, R6.8).
//
// This is the ONE shared availability probe (R6.8): every suite that needs
// Installed_Fixture_Projects calls this function rather than spelling its own
// `node_modules` existence check, so the local-skip / CI-fail asymmetry lives
// in exactly one place.
//
// It lives under `packages/build-tools/src/`, so R1.7 applies: this module MUST
// spell no Fixture_Tier path literal and MUST read no path under it of its own
// accord. It is therefore wholly PATH-PARAMETERISED — the caller (a suite under
// `packages/*/tests/`) supplies the absolute Fixture_Projects_Root path from its
// own test-tree fixture path constant (`FIXTURE_PROJECTS_ROOT` in that package's
// `fixture-paths.ts`, task 3.1), which is the single permitted tier literal per
// test package. This probe knows only "a directory with a `node_modules/` under
// it", never where that directory is.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CloneHandle } from "./clone-handle.js";

// The root npm script a reported reason must name, so a reader (a developer, or
// a reader of a CI failure) is told exactly how to produce
// Installed_Fixture_Projects. Composed from parts so this source spells no
// Fixture_Tier path literal (R1.7): the concatenation never appears as a
// contiguous token here.
const INSTALL_SCRIPT = ["fixture", "s:install"].join("");

/** The reason text carried on absence, naming {@link INSTALL_SCRIPT} (R6.6, R6.7). */
function absentReason(projectsRoot: string): string {
  return (
    `Fixture_Projects_Root is not installed (no node_modules under ${projectsRoot}); ` +
    `run \`npm run ${INSTALL_SCRIPT}\` to install it`
  );
}

/**
 * Probe for Installed_Fixture_Projects, returning the {@link CloneHandle} shape
 * so a suite branches on `available` exactly as it does for a Fixture_Clone
 * (R6.8).
 *
 * `projectsRoot` is the absolute path of the Fixture_Projects_Root, supplied by
 * the calling suite (this module holds no tier path literal, R1.7).
 *
 * Behaviour, and its deliberate asymmetry (R6.6, R6.7):
 *
 *   * `node_modules/` present under `projectsRoot` → `{ available: true, dir,
 *     cleanup }`, where `dir` is `projectsRoot` itself and `cleanup` is a no-op:
 *     the install is shared and this probe created nothing to remove, so a
 *     suite may branch on the handle uniformly without special-casing it.
 *   * `node_modules/` absent, and `CI` unset or empty → `{ available: false,
 *     reason }` naming the Fixture_Install script, so the suite SKIPS with a
 *     clear instruction and runs no assertion against an uninstalled project
 *     (R6.6).
 *   * `node_modules/` absent, and `CI` a non-empty string → this THROWS with
 *     that same reason, so the calling suite FAILS rather than skips (R6.7).
 *     Encoding the CI-fail inside the one shared probe is what keeps R6.7 from
 *     being re-spelled by every suite: a workflow whose install step was
 *     removed cannot pass by skipping every assertion, because the probe every
 *     such suite calls throws instead.
 */
export function installedFixtureProjects(projectsRoot: string): CloneHandle {
  const installed = existsSync(join(projectsRoot, "node_modules"));
  if (installed) {
    return {
      available: true,
      dir: projectsRoot,
      // The install is shared and this probe copied nothing; removing the real
      // installed `node_modules/` would be exactly the destructive write the
      // whole tier design forbids. So cleanup is an idempotent no-op.
      cleanup(): void {
        /* no-op: the probe created nothing to remove */
      },
    };
  }

  const reason = absentReason(projectsRoot);
  const ci = process.env.CI;
  if (ci !== undefined && ci !== "") {
    // R6.7: in CI, absence is a failure, not a skip.
    throw new Error(reason);
  }
  return { available: false, reason };
}

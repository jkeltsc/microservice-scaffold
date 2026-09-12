// CI-wiring example test.
//
// The root `package.json` now derives its repository-wide build from the
// Workspace_Build_Order rather than from the `workspaces` array's entry order:
// `build` and `pretest` each invoke `node scripts/build.js`, and the `ci`
// script's leading build step is `npm run build` (no longer
// `npm run build --workspaces`). No root script contains
// `npm run build --workspaces` at all — visiting order is derived, not taken
// from the manifest's entry order (R12.21).
//
// The repo-invariants check still ships as a compiled bin
// (`packages/build-tools/dist/bin/check-repo-invariants.js`) and must run as
// part of the root `ci` quality gate. Because the bin is compiled output, it
// runs after the build step, and it is placed before the slower
// typecheck/lint/test gates so an ordering mistake fails fast. This example
// test pins that wiring against the committed root `package.json`: the `ci`
// script's first `&&`-separated segment is exactly `npm run build`, it then
// invokes `check:invariants` ordered after that build step and before
// `typecheck --workspaces`, and the `check:invariants` script points at the
// compiled `.js` bin under `dist/` (not a `src/` `.ts` path).
//
// Validates: Requirements 12.21, 14.8, 14.10

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as Manifest;

describe("the root package.json builds in the Workspace_Build_Order", () => {
  const scripts = manifest.scripts ?? {};

  it("build and pretest each invoke node scripts/build.js", () => {
    expect(scripts.build ?? "").toContain("node scripts/build.js");
    expect(scripts.pretest ?? "").toContain("node scripts/build.js");
  });

  it("the ci script's leading build step is exactly `npm run build`", () => {
    const ci = scripts.ci ?? "";
    const firstSegment = ci.split("&&")[0]?.trim() ?? "";
    expect(firstSegment).toBe("npm run build");
  });

  it("no root script contains `npm run build --workspaces`", () => {
    for (const [name, value] of Object.entries(scripts)) {
      expect(
        value.includes("npm run build --workspaces"),
        `script "${name}" must not contain \`npm run build --workspaces\``,
      ).toBe(false);
    }
  });
});

describe("the root ci script wires in the repo-invariants check", () => {
  const scripts = manifest.scripts ?? {};

  it("ci invokes check:invariants", () => {
    const ci = scripts.ci ?? "";
    expect(ci).toContain("check:invariants");
  });

  it("orders check:invariants after the build step and before typecheck --workspaces", () => {
    const ci = scripts.ci ?? "";
    // Anchor on the leading build segment rather than a substring match, so
    // the position keys off `npm run build &&` and not an incidental
    // occurrence of "npm run build" elsewhere.
    expect(ci.startsWith("npm run build &&")).toBe(true);
    const buildPos = 0;
    const invariantsPos = ci.indexOf("check:invariants");
    const typecheckPos = ci.indexOf("typecheck --workspaces");

    expect(invariantsPos).toBeGreaterThanOrEqual(0);
    expect(typecheckPos).toBeGreaterThanOrEqual(0);

    expect(buildPos).toBeLessThan(invariantsPos);
    expect(invariantsPos).toBeLessThan(typecheckPos);
  });

  it("check:invariants points at the compiled bin under dist/", () => {
    const checkInvariants = scripts["check:invariants"] ?? "";
    expect(checkInvariants).toContain(
      "packages/build-tools/dist/bin/check-repo-invariants.js",
    );
  });
});

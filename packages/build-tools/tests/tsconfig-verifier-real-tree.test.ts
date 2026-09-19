// Feature: config-driven-discovery, task 9.3 — the Tsconfig_Verifier is silent
// over THIS repository before it is wired in.
//
// This example-based test resolves this repository's Tsc_Project `tsconfig.json`
// files through the REAL `resolveTsconfigWithCompiler` (the compiler API over
// `ts.sys`, applying every `extends` chain) exactly as the wired
// Repo_Invariant_Checker will, and asserts an EMPTY violation list (R9.14).
//
// The point it proves: `microservice1/tsconfig.json` — the shape every package
// shares — declares only `outDir` and `rootDir` and inherits `composite` and
// `declaration` from `tsconfig.base.json`, and the resolved view still satisfies
// all four settings (R9.3). Because it uses the real resolver over the real
// tree, its passing is the precondition task 9.4 relies on: wiring the verifier
// into `collectViolations` then leaves `check:invariants` green (R9.14, R15.9).
//
// The verifier and the real resolver both resolve paths against `process.cwd()`,
// so this suite pins cwd to the repository root for the duration.
//
// Validates: Requirements 9.2, 9.3, 9.14, 14.13, 15.9

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverPackages } from "../src/discovery.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  renderTsconfigViolation,
  resolveTsconfigWithCompiler,
  verifyTsconfigs,
} from "../src/tsconfig-verifier.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> build-tools -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

describe("the Tsconfig_Verifier is silent over this repository (R9.14)", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    // Both discovery and the real resolver resolve repo-relative against cwd.
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  it("reports an empty violation list, so an inherited-through-extends value satisfies the check", () => {
    const context = projectContext(defaultEffectiveConfig());
    const discovery = discoverPackages(context);

    // Sanity: the verified set is non-empty — the four Framework_Singletons plus
    // the real microservices and common packages are actually being resolved.
    expect(context.framework.all.length).toBe(4);
    expect(discovery.byCategory.microservice.length).toBeGreaterThan(0);
    expect(discovery.byCategory.common.length).toBeGreaterThan(0);

    const violations = verifyTsconfigs(
      context,
      discovery,
      resolveTsconfigWithCompiler,
    );

    // Render any violation so a failure names the package and setting rather
    // than an opaque object count.
    expect(
      violations.map(renderTsconfigViolation),
      "the verifier must be silent over this repository before it is wired in",
    ).toEqual([]);
  });
});

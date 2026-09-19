// Feature: config-driven-discovery, Property 14: Every emitted specifier
// carries the Configured_Scope.
//
// For any Valid_Scope and any set of 1 to 5 Selected_Microservices whose
// identifiers are lowercase alphanumeric strings of 1 to 12 characters, every
// scoped specifier the Registry_Generator emits begins with that Configured_Scope
// followed by `/`, and the emitted text contains the Scope_Default followed by
// `/` only when the Configured_Scope equals the Scope_Default.
//
// `generateRegistry(context, selector, discovery)` writes the registry to
// `packages/overseer/src/generated/microservice-registry.ts` RELATIVE TO CWD. To
// avoid touching the checked-out tree — and to avoid racing the real generated
// registry that other suites write — this suite runs each generation with cwd
// pinned to a fresh OS temporary directory holding the empty
// `packages/overseer/src/generated/` skeleton, reads the emitted file from
// there, and removes the temp tree in `afterAll`. Nothing is written inside the
// checked-out repository.
//
// The discovery input is synthesized in memory: `generateRegistry` reads only
// `discovery.byCategory.microservice`, so a minimal Discovery carrying the
// generated identifiers as microservice packages is all it needs, and no tree is
// walked.
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 14.7

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";

import { generateRegistry } from "../src/generate-registry.js";
import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import {
  defaultEffectiveConfig,
  SCOPE_DEFAULT,
} from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import { validScope } from "./arbitraries/config.js";

/** The generator's cwd-relative output path (OVERSEER.packageDir + …). */
const REGISTRY_RELATIVE = "packages/overseer/src/generated/microservice-registry.ts";

/** A Microservice_Identifier: 1 to 12 lowercase alphanumeric characters. */
const arbIdentifier: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
    { minLength: 1, maxLength: 12 },
  )
  .map((chars) => chars.join(""));

/** 1 to 5 distinct Selected_Microservices. */
const arbIdentifiers: fc.Arbitrary<readonly string[]> = fc.uniqueArray(
  arbIdentifier,
  { minLength: 1, maxLength: 5 },
);

/**
 * A minimal Discovery whose microservice category holds one package per
 * identifier. `generateRegistry` reads `discovery.byCategory.microservice` only,
 * so the other Discovery fields are inert here.
 */
function discoveryOf(identifiers: readonly string[]): Discovery {
  const microservice: ConsumerPackage[] = identifiers.map((dirName) => ({
    category: "microservice",
    dirName,
    packageDir: `packages/microservices/${dirName}`,
    name: `scope/${dirName}`,
    dependencySpecifiers: [],
    buildKind: "tsc-project",
  }));
  return {
    byCategory: { microservice, common: [], spa: [] },
    nameByDir: new Map(),
    byName: new Map(),
  };
}

/** The scoped module specifiers of a generated registry, in source order: every
 *  `import * as mN from "<spec>"`, the `import type … from "<spec>"`, and each
 *  `sourcePackage: "<spec>"`. A specifier is scoped when it begins with `@`. */
function scopedSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/from "([^"]+)"/g)) {
    specs.push(m[1]!);
  }
  for (const m of source.matchAll(/sourcePackage: "([^"]+)"/g)) {
    specs.push(m[1]!);
  }
  return specs.filter((spec) => spec.startsWith("@"));
}

describe("Property 14: every emitted specifier carries the Configured_Scope", () => {
  let tempRoot: string;
  let registryPath: string;
  let previousCwd: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "registry-scope-"));
    mkdirSync(join(tempRoot, "packages/overseer/src/generated"), {
      recursive: true,
    });
    registryPath = join(tempRoot, REGISTRY_RELATIVE);
    previousCwd = process.cwd();
    // The generator resolves its output path against cwd, so writes land in the
    // temp tree, never the checked-out repository.
    process.chdir(tempRoot);
  });

  afterAll(() => {
    process.chdir(previousCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("emits only Configured_Scope specifiers, and the Scope_Default only when it is the scope", () => {
    fc.assert(
      fc.property(validScope(), arbIdentifiers, (scope, identifiers) => {
        const context = projectContext({
          ...defaultEffectiveConfig(),
          scope,
        });

        // `*` selects every microservice in the synthesized discovery, so the
        // registry declares one entry per generated identifier.
        generateRegistry(context, "*", discoveryOf(identifiers));
        const source = readFileSync(registryPath, "utf8");

        // R8.1–R8.3: every scoped specifier begins with the Configured_Scope
        // followed by `/`. The generator emits one import specifier and one
        // `sourcePackage` per identifier, plus the `contracts` type import — all
        // scoped — so this covers all three emission sites.
        const scoped = scopedSpecifiers(source);
        expect(scoped.length).toBeGreaterThan(0);
        for (const spec of scoped) {
          expect(spec.startsWith(`${scope}/`)).toBe(true);
        }

        // R8.4: the emitted text contains the Scope_Default followed by `/` only
        // when the Configured_Scope equals the Scope_Default. The banner's
        // generator attribution (`build-tools`) is scope-composed too, so a
        // non-default scope leaves no `@microservices/` anywhere in the file.
        const carriesDefault = source.includes(`${SCOPE_DEFAULT}/`);
        expect(carriesDefault).toBe(scope === SCOPE_DEFAULT);
      }),
      { numRuns: 200 },
    );
  });
});

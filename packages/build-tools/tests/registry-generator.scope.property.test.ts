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
// `generatedRegistryPath(context)` — `<Entry_Root>/src/generated/
// microservice-registry.ts` — RELATIVE TO CWD. To avoid touching the checked-out
// tree — and to avoid racing the real generated registry that other suites write
// — this suite runs each generation with cwd pinned to a fresh OS temporary
// directory, reads the emitted file from there, and removes the temp tree in
// `afterAll`. The generator creates every absent directory of its output path,
// so no skeleton is prepared. Nothing is written inside the checked-out
// repository.
//
// The discovery input is synthesized in memory: `generateRegistry` reads only
// `discovery.byCategory.microservice`, so a minimal Discovery carrying the
// generated identifiers as microservice packages is all it needs, and no tree is
// walked.
//
// Validates: Requirements 8.1, 8.2, 8.3, 8.4, 14.7

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as fc from "fast-check";

import {
  generateRegistry,
  generatedRegistryPath,
} from "../src/generate-registry.js";
import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import {
  defaultEffectiveConfig,
  SCOPE_DEFAULT,
} from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import { validScope } from "./arbitraries/config.js";

/** The generator's cwd-relative output path, read from the single derivation
 *  every writer and every guard reads it from. The Entry_Root does not vary with
 *  the scope this suite generates, so one default-config derivation covers every
 *  example. */
const REGISTRY_RELATIVE = generatedRegistryPath(
  projectContext(defaultEffectiveConfig()),
);

/** A Microservice_Identifier: 1 to 12 lowercase alphanumeric characters. */
const arbIdentifier: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
    minLength: 1,
    maxLength: 12,
  })
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

// ===========================================================================
// Feature: registry-inversion, Property 2: Every emitted specifier carries the
// Configured_Scope.
//
// For any generated Valid_Scope and any generated set of Selected_Microservices
// over a Synthesized_Tree holding 1 to 5 Microservice_Packages, an Entry_Root the
// Config_Parser accepts and 0 to 3 Common_Packages, every scoped specifier the
// emitted Generated_Registry contains begins with that Configured_Scope followed
// by `/`, compared code point for code point, and the emitted text contains the
// Scope_Default followed by `/` at no position unless the generated
// Configured_Scope equals the Scope_Default.
//
// The difference from Property 14 above is deliberate and is the whole cost
// argument of the design's Testing Strategy: Property 14 writes a real file
// through `generateRegistry` with `cwd` pinned to a temporary directory, while
// this property drives the PURE composer `registryText` and touches no filesystem
// at all. `generateRegistry` writes exactly what `registryText` returns, so the
// emitted bytes are the same subject; only the cost differs.
//
// The iff's right-hand branch is exercised explicitly rather than left to chance:
// `arbSynthesizedTreeWithEntry` draws scopes of at most 12 characters after the
// `@`, so it can never produce the 13-character `@microservices`. Each generated
// input is therefore checked twice — once under its own generated scope, where the
// Scope_Default must be absent, and once rescoped to the Scope_Default, where it
// must be present. Without the second half the biconditional would be asserted
// over one branch only.
//
// Validates: Requirements 4.5, 13.2

import { registryText } from "../src/generate-registry.js";
import {
  arbSynthesizedTreeWithEntry,
  effectiveConfigOf,
  microserviceIdentifiersOf,
  type EntryTreeDescription,
} from "./arbitraries/tree.js";

/** Asserts the two halves of Property 2 for one description and one selected set:
 *  every scoped specifier carries `description.scope`, and the Scope_Default
 *  appears in the text exactly when that scope IS the Scope_Default. */
function assertScopeDiscipline(
  description: EntryTreeDescription,
  selected: readonly string[],
): void {
  const context = projectContext(effectiveConfigOf(description));
  // A comma-separated Selector, so the header's Selector line carries no `*` and
  // every emitted specifier comes from the selected set.
  const text = registryText(context, selected.join(","), selected);

  // R4.5 / R13.2: every scoped specifier begins with the Configured_Scope
  // followed by `/`. This ranges over all three emission sites — each microservice
  // import, the `contracts` type import, and each entry's `sourcePackage`.
  const scoped = scopedSpecifiers(text);
  expect(scoped.length).toBeGreaterThan(0);
  for (const specifier of scoped) {
    expect(specifier.startsWith(`${description.scope}/`)).toBe(true);
  }

  // R13.2's second half, as a biconditional: the Scope_Default followed by `/`
  // appears at no position unless the Configured_Scope equals it. The header's
  // generator attribution is scope-composed too, so a non-default scope leaves the
  // Scope_Default nowhere in the file.
  expect(text.includes(`${SCOPE_DEFAULT}/`)).toBe(
    description.scope === SCOPE_DEFAULT,
  );
}

describe("Feature: registry-inversion, Property 2: every emitted specifier carries the Configured_Scope", () => {
  it("carries the Configured_Scope on every scoped specifier, and the Scope_Default only when it is the scope", () => {
    fc.assert(
      fc.property(
        arbSynthesizedTreeWithEntry().chain((description) =>
          fc
            .shuffledSubarray([...microserviceIdentifiersOf(description)], {
              minLength: 1,
            })
            .map((selected) => ({ description, selected })),
        ),
        ({ description, selected }) => {
          // The generated scope: never the Scope_Default, so the biconditional's
          // negative branch is the one asserted.
          assertScopeDiscipline(description, selected);
          // The same input rescoped to the Scope_Default, so the positive branch is
          // asserted too. `effectiveConfigOf` recomposes every name from the
          // description's `scope` field, so this is the one-field change it looks
          // like rather than a second layout.
          assertScopeDiscipline(
            { ...description, scope: SCOPE_DEFAULT },
            selected,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

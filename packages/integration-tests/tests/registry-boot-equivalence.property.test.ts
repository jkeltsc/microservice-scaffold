// Task 9.14 — Seam 12c: boot over a generated registry agrees with boot over a
// hand-built one.
//
// WHY THIS SUITE LIVES IN `integration-tests`
// ---------------------------------------------------------------------------
// It drives BOTH sides of the inversion in one test: the Registry_Generator
// (`@microservices/build-tools`) writes a Generated_Registry, and the
// Overseer_Library's boot pipeline (`@microservices/overseer`) consumes a
// registry VALUE carrying what that file declares. `integration-tests` is the
// package that may depend on both, so this is where the two meet.
//
// WHAT IS ACTUALLY COMPARED, AND WHY IT IS NOT A TAUTOLOGY
// ---------------------------------------------------------------------------
// The Generated_Registry is a TypeScript module full of static imports of
// packages that do not exist in a generated Synthesized_Tree, so it cannot be
// imported. What the property needs from it is not its executable behaviour but
// its DECLARED CONTENT: the ordered sequence of `identifier` / `sourcePackage`
// pairs and the import binding each entry's `module` field names. So the suite
// runs the real generator into an OS temp directory, reads the emitted file
// back, PARSES those fields out of it, and pairs each parsed identifier with a
// module value (a generated Microservice_Path plus a real Express router) — the
// registry value the Entry_Module would hand `boot` if those packages existed.
// The other side is a registry value composed in this file from the same
// identifiers, paths, and independently spelled scoped source packages, in an
// order this file resolves from the Selector itself. `boot` is then driven with
// each and the two outcomes are compared.
//
// The comparison therefore spans the generator's emitted ORDER and NAMES against
// this file's own derivation of them; nothing is read from the code under test
// and handed back to it.
//
// NO SOCKET IS BOUND
// ---------------------------------------------------------------------------
// `boot` is a pure pipeline over an injected registry: it performs no
// `process.exit`, no stderr write, and no `listen` (R3.5). `startServer` — the
// one function that binds — is never called here, so this suite spawns nothing
// and occupies no port.
//
// NOTHING IS WRITTEN INTO THE CHECKED-OUT TREE
// ---------------------------------------------------------------------------
// The generator writes through `generatedRegistryPath(context)`, which is
// `<Entry_Root>/src/generated/microservice-registry.ts`. The Entry_Root is a
// per-suite `mkdtempSync` directory, so every byte this suite writes lands in
// the operating system's temp area and is removed in `afterAll`. No git command
// of any kind is involved.
//
// Feature: registry-inversion, Property 3: Boot over a generated registry agrees
// with boot over a hand-built one
//
// Validates: Requirements 13.3

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type {
  MicroserviceRegistry,
  RegistryEntry,
} from "@microservices/contracts";
import { boot } from "@microservices/overseer";
import {
  arbEnvironment,
  arbIdentifier,
  arbPath,
  buildExpressRouter,
  toggleVarName,
} from "@microservices/build-tools/dist/testing/index.js";
import {
  generateRegistry,
  generatedRegistryPath,
} from "@microservices/build-tools/dist/generate-registry.js";
import type {
  ConsumerPackage,
  Discovery,
} from "@microservices/build-tools/dist/discovery.js";
import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import {
  projectContext,
  type ProjectContext,
} from "@microservices/build-tools/dist/project-context.js";

// ---------------------------------------------------------------------------
// The Entry_Root this suite generates into: one OS temp directory, reused across
// runs (each run replaces the file wholesale, which is the generator's own
// contract) and removed at the end.
// ---------------------------------------------------------------------------

const entryRootDir = mkdtempSync(join(tmpdir(), "registry-boot-equivalence-"));

afterAll(() => {
  rmSync(entryRootDir, { recursive: true, force: true });
});

/** The run's ProjectContext, with the Entry_Root pointed at the temp directory. */
const context: ProjectContext = projectContext({
  ...defaultEffectiveConfig(),
  entry: entryRootDir,
});

/**
 * A Discovery holding exactly the given directory names as Microservice_Packages,
 * ordered by ascending code point of directory name the way the real
 * Package_Discovery orders a category's members. Built in memory: the generator
 * reads nothing from a Discovery but `byCategory.microservice[].dirName`, so a
 * Synthesized_Tree needs no filesystem here.
 */
function microserviceDiscovery(dirNames: readonly string[]): Discovery {
  const packages: readonly ConsumerPackage[] = [...dirNames]
    .sort()
    .map((dirName) => ({
      category: "microservice" as const,
      dirName,
      packageDir: `${context.roots.microservice}/${dirName}`,
      name: context.scopedName(dirName),
      dependencySpecifiers: [],
      buildKind: "tsc-project" as const,
    }));
  return {
    byCategory: { microservice: packages, common: [], spa: [] },
    nameByDir: new Map(packages.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
  };
}

// ---------------------------------------------------------------------------
// Reading the emitted Generated_Registry back
// ---------------------------------------------------------------------------

/** One entry as the emitted module declares it. */
interface EmittedEntry {
  readonly identifier: string;
  /** The import binding the entry's `module` field names, e.g. `m0`. */
  readonly binding: string;
  readonly sourcePackage: string;
}

const ENTRY_LINE =
  /^\s*\{ identifier: "([^"]*)", module: (m\d+), sourcePackage: "([^"]*)" \},$/;
const IMPORT_LINE = /^import \* as (m\d+) from "([^"]*)";$/;

/**
 * Parse the ordered entries out of an emitted Generated_Registry, and resolve
 * each entry's `module` binding through the file's own import declarations. An
 * entry whose binding has no import, or whose import names a different package
 * than the entry's `sourcePackage`, is a defect the caller asserts against.
 */
function readEmittedRegistry(text: string): {
  readonly entries: readonly EmittedEntry[];
  readonly importSpecifierOfBinding: ReadonlyMap<string, string>;
} {
  const entries: EmittedEntry[] = [];
  const importSpecifierOfBinding = new Map<string, string>();

  for (const line of text.split("\n")) {
    const imported = IMPORT_LINE.exec(line);
    if (imported !== null) {
      importSpecifierOfBinding.set(imported[1], imported[2]);
      continue;
    }
    const entry = ENTRY_LINE.exec(line);
    if (entry !== null) {
      entries.push({
        identifier: entry[1],
        binding: entry[2],
        sourcePackage: entry[3],
      });
    }
  }

  return { entries, importSpecifierOfBinding };
}

/** Run the real generator for one Selector and read back what it wrote. */
function emittedRegistryFor(
  selector: string,
  dirNames: readonly string[],
): ReturnType<typeof readEmittedRegistry> {
  generateRegistry(context, selector, microserviceDiscovery(dirNames));
  return readEmittedRegistry(
    readFileSync(generatedRegistryPath(context), "utf8"),
  );
}

// ---------------------------------------------------------------------------
// This file's own derivations — deliberately independent of the code under test
// ---------------------------------------------------------------------------

/** The Scope_Default, spelled here rather than read from the config module. */
const SCOPE = "@microservices";

/**
 * The Selected_Microservices for a Selector, derived here from the Selector's
 * documented semantics: `*` or blank means every candidate in discovery order,
 * and a comma-separated list means the identifiers it names, trimmed, in the
 * order given.
 */
function referenceSelection(
  selector: string,
  dirNames: readonly string[],
): readonly string[] {
  if (selector.trim() === "*") return [...dirNames].sort();
  const named = selector
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return named.length === 0 ? [...dirNames].sort() : named;
}

/** A registry entry built in this file: the hand-built side of the comparison. */
function handBuiltEntry(identifier: string, path: string): RegistryEntry {
  return {
    identifier,
    sourcePackage: `${SCOPE}/${identifier}`,
    module: { path, router: buildExpressRouter(identifier, path) },
  };
}

/** The observable the two boots are compared on. */
interface Observed {
  readonly ok: boolean;
  readonly mounted: readonly string[];
  readonly messages: readonly string[];
}

/** Drive `boot` and reduce its result to the compared observable. */
function observe(
  registry: MicroserviceRegistry,
  env: NodeJS.ProcessEnv,
): Observed {
  const result = boot({ microserviceRegistry: registry, env });
  if (!result.ok) {
    return { ok: false, mounted: [], messages: [...result.messages] };
  }
  return {
    ok: true,
    mounted: result.registeredMicroservices
      .filter((info) => info.enabled)
      .map((info) => `${info.identifier} ${info.path}`),
    messages: [],
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The accepted toggle tokens, fixed here rather than read from the Overseer. */
const ACCEPTED_TOGGLE_TOKENS = [
  "enabled",
  "disabled",
  "true",
  "false",
  "1",
  "0",
] as const;

/**
 * A value the Overseer accepts: an accepted token in any casing, with tolerated
 * surrounding whitespace.
 */
const arbAcceptedToggleValue: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ACCEPTED_TOGGLE_TOKENS),
    fc.constantFrom("", " ", "  ", "\t"),
    fc.constantFrom("", " ", "\t"),
    fc.boolean(),
  )
  .map(([token, lead, trail, upper]) =>
    upper ? `${lead}${token.toUpperCase()}${trail}` : `${lead}${token}${trail}`,
  );

/** One generated case: a Synthesized_Tree, a Selector over it, and paths. */
interface Case {
  readonly dirNames: readonly string[];
  readonly selector: string;
  readonly pathOf: ReadonlyMap<string, string>;
}

const arbCase: fc.Arbitrary<Case> = fc
  .uniqueArray(arbIdentifier, { minLength: 1, maxLength: 5 })
  .chain((dirNames) =>
    fc
      .tuple(
        // The Selector: `*`, blank, or a comma-separated subset of the tree's
        // own directory names (shuffled, with tolerated whitespace), so
        // resolution always succeeds and the property never trips on an
        // unrelated `[selector:unmatched]`.
        fc.oneof(
          fc.constantFrom("*", " * ", "", "   "),
          fc
            .shuffledSubarray([...dirNames], { minLength: 1 })
            .chain((subset) =>
              fc
                .constantFrom("", " ", "  ")
                .map((pad) => subset.map((id) => `${pad}${id}${pad}`).join(",")),
            ),
        ),
        // One Microservice_Path per directory name. Paths may coincide: two
        // entries sharing a path is a boot FAILURE, and "agree on success or
        // failure" is precisely what this property asserts, so the collision
        // case is deliberately in the input space.
        fc.array(arbPath, {
          minLength: dirNames.length,
          maxLength: dirNames.length,
        }),
      )
      .map(([selector, paths]) => ({
        dirNames,
        selector,
        pathOf: new Map(dirNames.map((id, index) => [id, paths[index]])),
      })),
  );

/** An environment assigning every selected identifier an accepted value. */
const arbAcceptingEnvironment = (
  selected: readonly string[],
): fc.Arbitrary<NodeJS.ProcessEnv> => {
  const unique = [...new Set(selected)];
  return fc
    .array(arbAcceptedToggleValue, {
      minLength: unique.length,
      maxLength: unique.length,
    })
    .map((values) =>
      Object.fromEntries(
        unique.map((identifier, index) => [
          toggleVarName(identifier),
          values[index],
        ]),
      ),
    );
};

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("Property 3: boot over a generated registry agrees with boot over a hand-built one (R13.3)", () => {
  // Feature: registry-inversion, Property 3: Boot over a generated registry agrees with boot over a hand-built one
  it("agrees on success, on the ordered mounted identifier-and-path pairs, and on the reported messages", () => {
    fc.assert(
      fc.property(
        arbCase.chain((generated) =>
          arbAcceptingEnvironment(
            referenceSelection(generated.selector, generated.dirNames),
          ).map((env) => ({ ...generated, env })),
        ),
        ({ dirNames, selector, pathOf, env }) => {
          const emitted = emittedRegistryFor(selector, dirNames);
          const selected = referenceSelection(selector, dirNames);

          // The generator's emitted order and names, against this file's own
          // derivation of them.
          expect(emitted.entries.map((entry) => entry.identifier)).toEqual([
            ...selected,
          ]);
          for (const entry of emitted.entries) {
            expect(entry.sourcePackage).toBe(`${SCOPE}/${entry.identifier}`);
            // Each entry's `module` names the binding its own import declares.
            expect(emitted.importSpecifierOfBinding.get(entry.binding)).toBe(
              entry.sourcePackage,
            );
          }

          // Side A — the registry value carrying what the generated module
          // declares, each entry paired with a module of a generated path and a
          // real Express router.
          const fromGenerated: MicroserviceRegistry = emitted.entries.map(
            (entry) => {
              const path = pathOf.get(entry.identifier) ?? "";
              return {
                identifier: entry.identifier,
                sourcePackage: entry.sourcePackage,
                module: {
                  path,
                  router: buildExpressRouter(entry.identifier, path),
                },
              };
            },
          );

          // Side B — the same identifier, module, and source-package fields in
          // the same order, composed in this file.
          const handBuilt: MicroserviceRegistry = selected.map((identifier) =>
            handBuiltEntry(identifier, pathOf.get(identifier) ?? ""),
          );

          expect(observe(fromGenerated, env)).toEqual(observe(handBuilt, env));
        },
      ),
      { numRuns: 150 },
    );
  });

  // Feature: registry-inversion, Property 3: Boot over a generated registry agrees with boot over a hand-built one
  it("agrees for an arbitrary toggle environment, failure cases included", () => {
    // The same equivalence, quantified over environments that may omit a
    // toggle, carry an unparseable value, or enable an unregistered identifier.
    // Boot then fails — and the two sides must fail identically, reporting the
    // same ordered messages, which is the half of "agree on success or failure"
    // an accepting environment never exercises.
    fc.assert(
      fc.property(arbCase, arbEnvironment, ({ dirNames, selector, pathOf }, env) => {
        const emitted = emittedRegistryFor(selector, dirNames);
        const selected = referenceSelection(selector, dirNames);

        const fromGenerated: MicroserviceRegistry = emitted.entries.map(
          (entry) => {
            const path = pathOf.get(entry.identifier) ?? "";
            return {
              identifier: entry.identifier,
              sourcePackage: entry.sourcePackage,
              module: {
                path,
                router: buildExpressRouter(entry.identifier, path),
              },
            };
          },
        );
        const handBuilt: MicroserviceRegistry = selected.map((identifier) =>
          handBuiltEntry(identifier, pathOf.get(identifier) ?? ""),
        );

        expect(observe(fromGenerated, env)).toEqual(observe(handBuilt, env));
      }),
      { numRuns: 150 },
    );
  });
});

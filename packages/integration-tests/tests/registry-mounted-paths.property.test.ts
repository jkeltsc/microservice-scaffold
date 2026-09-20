// Task 9.14 — Seam 12c: the mounted path set is a function of the Selector and
// the toggles alone.
//
// WHY THIS SUITE LIVES IN `integration-tests`
// ---------------------------------------------------------------------------
// Like its sibling `registry-boot-equivalence.property.test.ts`, it drives the
// Registry_Generator and the Overseer_Library's boot pipeline in ONE test: the
// generator emits a Generated_Registry for a Selector, and boot is driven with
// the registry value that file declares. `integration-tests` is the package that
// may depend on both.
//
// WHAT THE PROPERTY ASSERTS
// ---------------------------------------------------------------------------
// The ordered identifier-and-path pairs boot reports as mounted equal the pairs
// formed by each Selected_Microservice whose toggle evaluated as enabled, paired
// with the Microservice_Path that microservice's module declares, in the order
// the Generated_Registry lists its entries — no extra pair, no absent one. Both
// halves of the expectation are derived HERE: the selection from the Selector's
// documented semantics, and the toggle classification from a table of accepted
// values fixed in this file. Nothing is read out of the code under test and
// handed back to it, so the equality is a real comparison rather than a restated
// implementation.
//
// The "function of the Selector and the toggles ALONE" half gets its own case:
// adding unselected microservices to the tree (with disabled toggles, which
// R7.2 ignores) leaves the mounted set unchanged.
//
// NO SOCKET IS BOUND
// ---------------------------------------------------------------------------
// `boot` is the pure pipeline: no `process.exit`, no stderr write, no `listen`.
// `startServer` is never called, so this suite spawns nothing and occupies no
// port; the mount table is read from boot's own reported result.
//
// NOTHING IS WRITTEN INTO THE CHECKED-OUT TREE
// ---------------------------------------------------------------------------
// The Entry_Root handed to the generator is a per-suite `mkdtempSync` directory,
// so the Generated_Registry the generator writes — and every byte this suite
// writes — lands in the operating system's temp area and is removed in
// `afterAll`. No git command of any kind is involved.
//
// Feature: registry-inversion, Property 4: The mounted path set is a function of
// the Selector and the toggles alone
//
// Validates: Requirements 13.4, 14.2

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { MicroserviceRegistry } from "@microservices/contracts";
import { boot } from "@microservices/overseer";
import {
  arbIdentifier,
  arbPath,
  buildExpressRouter,
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
// The Entry_Root this suite generates into
// ---------------------------------------------------------------------------

const entryRootDir = mkdtempSync(join(tmpdir(), "registry-mounted-paths-"));

afterAll(() => {
  rmSync(entryRootDir, { recursive: true, force: true });
});

const context: ProjectContext = projectContext({
  ...defaultEffectiveConfig(),
  entry: entryRootDir,
});

/**
 * A Discovery holding exactly the given directory names as Microservice_Packages,
 * ordered by ascending code point of directory name the way the real
 * Package_Discovery orders a category's members. In memory: the generator reads
 * nothing from a Discovery but those directory names.
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

const ENTRY_LINE =
  /^\s*\{ identifier: "([^"]*)", module: m\d+, sourcePackage: "([^"]*)" \},$/;

/** The ordered `identifier` / `sourcePackage` pairs the emitted module declares. */
function emittedEntries(
  selector: string,
  dirNames: readonly string[],
): readonly { readonly identifier: string; readonly sourcePackage: string }[] {
  generateRegistry(context, selector, microserviceDiscovery(dirNames));
  const text = readFileSync(generatedRegistryPath(context), "utf8");
  const entries: { identifier: string; sourcePackage: string }[] = [];
  for (const line of text.split("\n")) {
    const match = ENTRY_LINE.exec(line);
    if (match !== null) {
      entries.push({ identifier: match[1], sourcePackage: match[2] });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// This file's own derivations — the expectation side of the property
// ---------------------------------------------------------------------------

/**
 * The Selected_Microservices for a Selector, from the Selector's documented
 * semantics: `*` or blank means every candidate in discovery order, a
 * comma-separated list means the identifiers it names, trimmed, in the order
 * given.
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

/**
 * The accepted toggle values of the Pre_Change_Baseline, FIXED HERE rather than
 * read from the Overseer: `enabled|true|1` enable, `disabled|false|0` disable,
 * matched case-insensitively with surrounding whitespace tolerated.
 */
const ENABLING_TOKENS: readonly string[] = ["enabled", "true", "1"];
const DISABLING_TOKENS: readonly string[] = ["disabled", "false", "0"];

/** The toggle variable name, composed here: `MICROSERVICE_<UPPERCASED>_ENABLED`. */
function expectedToggleVarName(identifier: string): string {
  return `MICROSERVICE_${identifier.toUpperCase()}_ENABLED`;
}

/** Classify a value against the fixed table above. */
function classify(value: string): "enabled" | "disabled" | "invalid" {
  const normalised = value.trim().toLowerCase();
  if (ENABLING_TOKENS.includes(normalised)) return "enabled";
  if (DISABLING_TOKENS.includes(normalised)) return "disabled";
  return "invalid";
}

/** One mounted pair, rendered so ordered comparison is a plain array equality. */
function pair(identifier: string, path: string): string {
  return `${identifier} ${path}`;
}

/** Build the registry value the Entry_Module would hand `boot`. */
function registryFrom(
  entries: readonly { readonly identifier: string; readonly sourcePackage: string }[],
  pathOf: ReadonlyMap<string, string>,
): MicroserviceRegistry {
  return entries.map((entry) => {
    const path = pathOf.get(entry.identifier) ?? "";
    return {
      identifier: entry.identifier,
      sourcePackage: entry.sourcePackage,
      module: { path, router: buildExpressRouter(entry.identifier, path) },
    };
  });
}

/** The ordered mounted pairs boot reports. */
function mountedPairs(
  registry: MicroserviceRegistry,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const result = boot({ microserviceRegistry: registry, env });
  // A registry of distinct identifiers with distinct paths and an accepting
  // toggle for each entry boots; a failure here is the property's business to
  // report, so surface the messages rather than an opaque undefined.
  expect(result.ok ? "ok" : result.messages.join("\n")).toBe("ok");
  if (!result.ok) return [];
  return result.registeredMicroservices
    .filter((info) => info.enabled)
    .map((info) => pair(info.identifier, info.path));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** An accepted value in any casing, with tolerated surrounding whitespace. */
function arbValueFrom(tokens: readonly string[]): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...tokens),
      fc.constantFrom("", " ", "  ", "\t"),
      fc.constantFrom("", " ", "\t"),
      fc.boolean(),
    )
    .map(([token, lead, trail, upper]) =>
      upper
        ? `${lead}${token.toUpperCase()}${trail}`
        : `${lead}${token}${trail}`,
    );
}

const arbAcceptedToggleValue = arbValueFrom([
  ...ENABLING_TOKENS,
  ...DISABLING_TOKENS,
]);
const arbDisablingToggleValue = arbValueFrom(DISABLING_TOKENS);

/** A Selector over a tree: `*`, blank, or a comma-separated subset. */
function arbSelectorOver(dirNames: readonly string[]): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constantFrom("*", " * ", "", "  "),
    fc
      .shuffledSubarray([...dirNames], { minLength: 1 })
      .chain((subset) =>
        fc
          .constantFrom("", " ", "  ")
          .map((pad) => subset.map((id) => `${pad}${id}${pad}`).join(",")),
      ),
  );
}

/**
 * A Microservice_Path per directory name, each path's FIRST segment being that
 * microservice's own directory name, so distinct identifiers always declare
 * distinct paths. Duplicate paths are a boot failure (an ambiguous mount table),
 * and this property is about the mount table a successful boot produces; the
 * collision case belongs to the collision suite.
 */
function arbPathsFor(
  dirNames: readonly string[],
): fc.Arbitrary<ReadonlyMap<string, string>> {
  return fc
    .array(arbPath, {
      minLength: dirNames.length,
      maxLength: dirNames.length,
    })
    .map(
      (suffixes) =>
        new Map(
          dirNames.map((id, index) => [id, `/${id}${suffixes[index]}`]),
        ),
    );
}

/** N accepted toggle values, one per identifier of a list. */
function arbValuesFor(
  identifiers: readonly string[],
  value: fc.Arbitrary<string>,
): fc.Arbitrary<readonly string[]> {
  return fc.array(value, {
    minLength: identifiers.length,
    maxLength: identifiers.length,
  });
}

interface Case {
  readonly dirNames: readonly string[];
  readonly selector: string;
  readonly pathOf: ReadonlyMap<string, string>;
  readonly env: NodeJS.ProcessEnv;
  readonly selected: readonly string[];
}

/**
 * A tree of 1–5 microservices, a Selector over it, a path per microservice, and
 * an environment that assigns every SELECTED identifier an accepted value and
 * every unselected one a disabling value. Unselected identifiers are kept
 * disabled deliberately: an enabled toggle for an identifier outside the
 * registry is the `[toggle:unknown]` failure (R7.1), a different property's
 * subject, while a disabled one is ignored (R7.2) and belongs here.
 */
const arbCase: fc.Arbitrary<Case> = fc
  .uniqueArray(arbIdentifier, { minLength: 1, maxLength: 5 })
  .chain((dirNames) =>
    arbSelectorOver(dirNames).chain((selector) => {
      const selected = referenceSelection(selector, dirNames);
      const unselected = dirNames.filter((id) => !selected.includes(id));
      return fc
        .tuple(
          arbPathsFor(dirNames),
          arbValuesFor(selected, arbAcceptedToggleValue),
          arbValuesFor(unselected, arbDisablingToggleValue),
        )
        .map(([pathOf, selectedValues, unselectedValues]) => ({
          dirNames,
          selector,
          pathOf,
          selected,
          env: Object.fromEntries([
            ...selected.map((id, index) => [
              expectedToggleVarName(id),
              selectedValues[index],
            ]),
            ...unselected.map((id, index) => [
              expectedToggleVarName(id),
              unselectedValues[index],
            ]),
          ]) as NodeJS.ProcessEnv,
        }));
    }),
  );

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("Property 4: the mounted path set is a function of the Selector and the toggles alone (R13.4, R14.2)", () => {
  // Feature: registry-inversion, Property 4: The mounted path set is a function of the Selector and the toggles alone
  it("mounts exactly the enabled Selected_Microservices at their declared paths, in registry order", () => {
    fc.assert(
      fc.property(arbCase, ({ dirNames, selector, pathOf, selected, env }) => {
        const entries = emittedEntries(selector, dirNames);
        // The emitted entry sequence IS the Selected_Microservices, in this
        // file's own resolution order. Asserted before the mount comparison so a
        // parse that read nothing out of the emitted module fails here rather
        // than making the comparison below trivially true.
        expect(entries.map((e) => e.identifier)).toEqual([...selected]);
        expect(entries.map((e) => e.sourcePackage)).toEqual(
          selected.map((id) => `@microservices/${id}`),
        );
        const registry = registryFrom(entries, pathOf);

        const expected = selected
          .filter((identifier) => {
            const raw = env[expectedToggleVarName(identifier)];
            return raw !== undefined && classify(raw) === "enabled";
          })
          .map((identifier) => pair(identifier, pathOf.get(identifier) ?? ""));

        expect(mountedPairs(registry, env)).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });

  // Feature: registry-inversion, Property 4: The mounted path set is a function of the Selector and the toggles alone
  it("is unchanged by microservices the Selector does not name", () => {
    // The ALONE half: widening the tree with further candidates — each disabled,
    // so R7.2 ignores its toggle — changes neither the emitted entries nor the
    // mounted pairs, as long as the Selector still names the same subset.
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbIdentifier, { minLength: 2, maxLength: 6 })
          .chain((all) =>
            fc
              .shuffledSubarray([...all], { minLength: 1, maxLength: all.length - 1 })
              .chain((subset) => {
                const extras = all.filter((id) => !subset.includes(id));
                return fc
                  .tuple(
                    arbPathsFor(all),
                    arbValuesFor(subset, arbAcceptedToggleValue),
                    arbValuesFor(extras, arbDisablingToggleValue),
                  )
                  .map(([pathOf, subsetValues, extraValues]) => ({
                    subset,
                    extras,
                    pathOf,
                    env: Object.fromEntries([
                      ...subset.map((id, index) => [
                        expectedToggleVarName(id),
                        subsetValues[index],
                      ]),
                      ...extras.map((id, index) => [
                        expectedToggleVarName(id),
                        extraValues[index],
                      ]),
                    ]) as NodeJS.ProcessEnv,
                  }));
              }),
          ),
        ({ subset, extras, pathOf, env }) => {
          const selector = subset.join(",");

          const narrow = emittedEntries(selector, subset);
          const wide = emittedEntries(selector, [...subset, ...extras]);
          expect(wide).toEqual(narrow);

          expect(mountedPairs(registryFrom(wide, pathOf), env)).toEqual(
            mountedPairs(registryFrom(narrow, pathOf), env),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

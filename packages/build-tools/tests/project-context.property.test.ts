// Feature: config-driven-discovery — projectContext composes framework names
//
// `projectContext(config)` derives, from one Effective_Config, the four
// Framework_Singleton records with their names composed under the run's scope.
// The name-composition rule is exact (R3.7): each name is the Configured_Scope,
// then `/`, then the Framework_Singleton's directory name used unchanged,
// character for character. Nothing else — no trimming, no case change, no scope
// normalisation — happens to a framework name.
//
// The lookup rule is exact and case-sensitive (R3.8): `frameworkByName` returns
// the record whose composed name equals the queried string code point for code
// point, and returns `undefined` for a name differing in case or in any other
// character.
//
// These are properties of the derivation over the whole Valid_Scope input space,
// so the test generates a Valid_Scope, builds a context (roots take their
// defaults — irrelevant to name composition), and checks the two rules against
// every declared framework directory. `projectContext` is pure and total over
// any EffectiveConfig and touches no filesystem, so no tree is materialised.
//
// Since registry-inversion the same derivation also yields the Entry_Root and
// the Entry_Point_Path, and they join the rules asserted here on the same terms
// (R1.3, R7.1): `entryRoot` is `config.entry` character for character, and
// `entryPointPath` is that string joined to `dist/index.js` by a single `/` with
// no normalisation of either part. Purity and totality are asserted over a
// deliberately wider `entry` input space than the Config_Parser would accept —
// any string at all, an empty one and a whitespace-only one included — because
// `projectContext` is total over any EffectiveConfig and validation is the
// parser's job, not the derivation's.
//
// Validates: Requirements 1.9, 3.6, 3.7, 3.8
// Validates: registry-inversion Requirements 1.3, 7.1

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { FRAMEWORK_DIRECTORIES } from "../src/framework.js";
import {
  defaultEffectiveConfig,
  type EffectiveConfig,
} from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";

/**
 * A Valid_Scope: `@` followed by one or more characters, each a lowercase ASCII
 * letter, an ASCII digit, or a hyphen (R3.1). Written locally rather than
 * imported so this test carries no cross-task dependency on a shared config
 * arbitrary.
 */
const validScope = (): fc.Arbitrary<string> =>
  fc
    .stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
      minLength: 1,
      maxLength: 24,
    })
    .map((tail) => `@${tail}`);

/** An Effective_Config over a generated scope; roots take their defaults, which
 *  play no part in framework-name composition. */
const configWithScope = (): fc.Arbitrary<EffectiveConfig> =>
  validScope().map((scope) => ({
    ...defaultEffectiveConfig(),
    scope,
  }));

/**
 * Any `entry` value an EffectiveConfig can carry — the derivation is total over
 * all of them, so the pool is deliberately wider than the Config_Parser's
 * accepted set: plain relative paths, then strings the parser would reject
 * (absolute, trailing slash, backslash, dot segments, empty, whitespace-only,
 * a trailing space) and non-ASCII, mixed-case, and free-form text. Every one of
 * them must come back verbatim, which is what "no normalisation" means.
 */
const anyEntryRoot = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom(
      "app",
      "apps/server",
      "a",
      "App",
      "my-app/nested/deep",
      "",
      " ",
      "   ",
      "app ",
      " app",
      "/app",
      "app/",
      "app\\win",
      "./app",
      "../app",
      "app//double",
      "packages/app",
      "ünïcode-app",
    ),
    fc.string(),
  );

/** An Effective_Config over a generated scope AND a generated Entry_Root. */
const configWithEntry = (): fc.Arbitrary<EffectiveConfig> =>
  fc.tuple(validScope(), anyEntryRoot()).map(([scope, entry]) => ({
    ...defaultEffectiveConfig(),
    scope,
    entry,
  }));

describe("projectContext: framework name composition (R3.7) and lookup (R3.8)", () => {
  it("composes each framework name as scope + '/' + the unchanged directory name", () => {
    fc.assert(
      fc.property(configWithScope(), (config) => {
        const context = projectContext(config);

        // The four records, and `all`, all present and in fixed order.
        const { contracts, overseer, buildTools, integrationTests, all } =
          context.framework;
        expect(all).toEqual([
          contracts,
          overseer,
          buildTools,
          integrationTests,
        ]);
        expect(all).toHaveLength(FRAMEWORK_DIRECTORIES.length);

        // Each singleton's directory facts are the scope-free framework facts,
        // and its name is scope + '/' + the unchanged directory name (R3.7).
        for (let i = 0; i < FRAMEWORK_DIRECTORIES.length; i += 1) {
          const source = FRAMEWORK_DIRECTORIES[i]!;
          const derived = all[i]!;
          expect(derived.dirName).toBe(source.dirName);
          expect(derived.packageDir).toBe(source.packageDir);
          expect(derived.staging).toBe(source.staging);
          expect(derived.name).toBe(`${config.scope}/${source.dirName}`);
          // Composed via scopedName too — one and the same rule (R3.6).
          expect(context.scopedName(source.dirName)).toBe(derived.name);
        }

        // The derived scope-dependent strings (R3.6).
        expect(context.specifierPrefix).toBe(`${config.scope}/`);
        expect(context.scopeDir).toBe(`node_modules/${config.scope}`);
        // The one Effective_Config is threaded unchanged (R1.9).
        expect(context.config).toBe(config);
      }),
      { numRuns: 200 },
    );
  });

  it("derives entryRoot verbatim and entryPointPath as entryRoot + '/dist/index.js'", () => {
    fc.assert(
      fc.property(configWithEntry(), (config) => {
        const context = projectContext(config);

        // R1.3 — the Entry_Root is `config.entry` character for character: no
        // trimming, no separator normalisation, no case normalisation.
        expect(context.entryRoot).toBe(config.entry);

        // R7.1 — the Entry_Point_Path is the Entry_Root joined to
        // `dist/index.js` by a single `/`, neither part normalised. Composed
        // here from the config's own value, so the assertion states the rule
        // rather than reading the context's `entryRoot` back to itself.
        expect(context.entryPointPath).toBe(`${config.entry}/dist/index.js`);
        expect(context.entryPointPath).toBe(
          `${context.entryRoot}/dist/index.js`,
        );

        // The Entry_Root is a sibling of the roots, not a member of them: the
        // three Discovery_Roots are untouched by the entry derivation, and no
        // category's root is the Entry_Root's source.
        expect(context.roots).toEqual(config.roots);

        // The joined suffix appears exactly once and at the very end, so the
        // derivation appends rather than interpolating anywhere else.
        expect(
          context.entryPointPath.endsWith(`${config.entry}/dist/index.js`),
        ).toBe(true);
        expect(context.entryPointPath.length).toBe(
          config.entry.length + "/dist/index.js".length,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("is pure: two derivations from one config yield equal entry values, and nothing mutates the config", () => {
    fc.assert(
      fc.property(configWithEntry(), (config) => {
        const first = projectContext(config);
        const second = projectContext(config);

        // Total and pure over any EffectiveConfig: the same input yields the
        // same strings, and the input object is left alone.
        expect(second.entryRoot).toBe(first.entryRoot);
        expect(second.entryPointPath).toBe(first.entryPointPath);
        expect(config.entry).toBe(first.entryRoot);
        expect(first.config).toBe(config);
      }),
      { numRuns: 200 },
    );
  });

  it("derives the repository's own Entry_Root from the default Effective_Config", () => {
    // The unconfigured case, which is this repository's: `entry` takes the
    // Entry_Root_Default, and the Entry_Point_Path follows from it.
    const context = projectContext(defaultEffectiveConfig());
    expect(context.entryRoot).toBe("app");
    expect(context.entryPointPath).toBe("app/dist/index.js");
  });

  it("resolves frameworkByName exactly and case-sensitively", () => {
    fc.assert(
      fc.property(configWithScope(), (config) => {
        const context = projectContext(config);

        for (const entry of context.framework.all) {
          // Exact name resolves to that very record.
          expect(context.frameworkByName(entry.name)).toBe(entry);

          // An upper-cased name does not resolve — no case normalisation (R3.8).
          const upper = entry.name.toUpperCase();
          if (upper !== entry.name) {
            expect(context.frameworkByName(upper)).toBeUndefined();
          }

          // Neither the bare directory name (missing scope) nor a trailing-space
          // variant resolves — the compare is character for character.
          expect(context.frameworkByName(entry.dirName)).toBeUndefined();
          expect(context.frameworkByName(`${entry.name} `)).toBeUndefined();
        }

        // A name under a different scope never resolves.
        const otherScope = config.scope === "@other" ? "@elsewhere" : "@other";
        expect(
          context.frameworkByName(
            `${otherScope}/${context.framework.contracts.dirName}`,
          ),
        ).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});

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
// Validates: Requirements 1.9, 3.6, 3.7, 3.8

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

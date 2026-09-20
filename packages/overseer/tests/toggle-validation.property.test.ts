// Feature: microservice-scaffold, Property 8: Boot toggle validation.
//
// For any registry R with identifier set I(R) and any environment E (a partial
// mapping from MICROSERVICE_*_ENABLED variable names to strings), let:
//   Missing        = { x in I(R) : env-var for x not in E }
//   Invalid        = { x in I(R) : env-var for x present but parseToggle rejects it }
//   PhantomEnabled = { x not in I(R) : env-var present and parseToggle => enabled }
//   PhantomDisabled= { x not in I(R) : env-var present and parseToggle => disabled }
// Then validateToggles(R, E):
//   - succeeds iff Missing = ∅ AND Invalid = ∅ AND PhantomEnabled = ∅
//     (PhantomDisabled is ignored entirely);
//   - on failure, its missing/invalid/unknownEnabled sets equal
//     Missing/Invalid/PhantomEnabled;
//   - on success, toggleMap.enabled set = { x in I(R) : parseToggle(E[var]).enabled === true }.
//
// Validates: Requirements R4.3, R7.1, R7.2, R7.3

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import type { MicroserviceRegistry, RegistryEntry } from '@microservices/contracts';
import {
  arbEnvironment,
  arbIdentifier,
  buildExpressRouter,
  toggleVarName,
} from '@microservices/build-tools/dist/testing/index.js';

import { parseToggle, validateToggles } from '../src/toggles.js';

/** Build a contract-conforming registry entry for an identifier. */
function entry(identifier: string): RegistryEntry {
  const path = `/${identifier}`;
  return {
    identifier,
    sourcePackage: `@microservices/${identifier}`,
    module: { path, router: buildExpressRouter(identifier, path) },
  };
}

/**
 * A registry whose identifiers are unique. Duplicate identifiers are a separate
 * collision concern (Property 6); here we constrain to the well-formed case so
 * the toggle semantics are exercised on their own.
 */
const arbUniqueRegistry: fc.Arbitrary<MicroserviceRegistry> = fc
  .uniqueArray(arbIdentifier, { minLength: 0, maxLength: 6 })
  .map((identifiers) => identifiers.map(entry));

/**
 * Compute the reference sets straight from the specification text, using the
 * same parseToggle primitive but an independent set-based derivation, so the
 * test does not merely re-run the implementation's control flow.
 */
function referenceSets(
  registry: MicroserviceRegistry,
  env: Record<string, string>,
) {
  const registered = new Set(registry.map((e) => e.identifier));

  const missing = new Set<string>();
  const invalid = new Set<string>();
  const enabledTrue = new Set<string>();

  for (const id of registered) {
    const raw = env[toggleVarName(id)];
    if (raw === undefined) {
      missing.add(id);
      continue;
    }
    const parsed = parseToggle(raw);
    if (!parsed.ok) {
      invalid.add(id);
    } else if (parsed.enabled) {
      enabledTrue.add(id);
    }
  }

  // Phantoms: any MICROSERVICE_<X>_ENABLED whose derived identifier is not
  // registered. Enabled phantoms are errors; disabled/unparseable are ignored.
  const phantomEnabled = new Set<string>();
  const togglePattern = /^MICROSERVICE_(.+)_ENABLED$/;
  for (const [name, value] of Object.entries(env)) {
    const m = togglePattern.exec(name);
    if (m === null) continue;
    const id = m[1]!.toLowerCase();
    if (registered.has(id)) continue;
    const parsed = parseToggle(value);
    if (parsed.ok && parsed.enabled) phantomEnabled.add(id);
  }

  return { missing, invalid, phantomEnabled, enabledTrue };
}

function setEquals(actual: Iterable<string>, expected: Set<string>): boolean {
  const a = new Set(actual);
  if (a.size !== expected.size) return false;
  for (const x of a) if (!expected.has(x)) return false;
  return true;
}

describe('Property 8: boot toggle validation', () => {
  it('reports Missing / Invalid / PhantomEnabled exactly and ignores PhantomDisabled', () => {
    fc.assert(
      fc.property(arbUniqueRegistry, arbEnvironment, (registry, env) => {
        const ref = referenceSets(registry, env);
        const result = validateToggles(registry, env);

        const shouldSucceed =
          ref.missing.size === 0 &&
          ref.invalid.size === 0 &&
          ref.phantomEnabled.size === 0;

        expect(result.ok).toBe(shouldSucceed);

        if (result.ok) {
          // Success: toggleMap enabled set equals the reference enabled-true set.
          const enabledIds = [...result.toggleMap.enabled.entries()]
            .filter(([, v]) => v === true)
            .map(([k]) => k);
          expect(setEquals(enabledIds, ref.enabledTrue)).toBe(true);
        } else {
          // Failure: each reported set equals its reference set exactly.
          expect(setEquals(result.missing, ref.missing)).toBe(true);
          expect(
            setEquals(
              result.invalid.map((i) => i.identifier),
              ref.invalid,
            ),
          ).toBe(true);
          expect(setEquals(result.unknownEnabled, ref.phantomEnabled)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('carries the original raw value for each invalid registered toggle', () => {
    fc.assert(
      fc.property(arbUniqueRegistry, arbEnvironment, (registry, env) => {
        const result = validateToggles(registry, env);
        if (result.ok) return;
        for (const { identifier, rawValue } of result.invalid) {
          // rawValue is exactly the environment value that failed to parse.
          expect(rawValue).toBe(env[toggleVarName(identifier)]);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Feature: registry-inversion, Property 11: Toggle variable names and value
// semantics are unchanged
//
// The registry moved out of this package and the entrypoint moved out with it.
// The toggle contract did NOT move: the variable a microservice's toggle is read
// from is still `MICROSERVICE_<IDENTIFIER>_ENABLED` with the directory name
// uppercased code point for code point, and the values that variable accepts are
// still the Pre_Change_Baseline's six tokens, case-insensitively, with
// surrounding whitespace tolerated.
//
// WHY THE EXPECTATION TABLE IS SPELLED OUT BELOW
// ---------------------------------------------------------------------------
// The expectation is FIXED IN THIS FILE — the six tokens, their enabled/disabled
// split, the normalisation rule, and the variable-name composition are all
// written here as literals. Deriving any of them from `parseToggle`,
// `toggleVarName`, or the relocated arbitraries module would make the property
// agree with the implementation by construction and assert nothing: a drift in
// the accepted set would drift the expectation with it. That is why this block
// imports neither the shared `toggleVarName` helper (the suite above does, for a
// different purpose) nor the shared `ACCEPTED_TOGGLE_TOKENS`.
//
// WHAT "the only variable the composition reads" IS CHECKED AGAINST
// ---------------------------------------------------------------------------
// Decoy variables: near-miss names built from the same identifier — the
// lowercased spelling, a truncated suffix, a missing prefix — each carrying an
// ENABLING value. If the composition read any of them, an identifier whose
// canonical variable says `disabled` would come out enabled, or an identifier
// with no canonical variable would stop being reported missing. Neither may
// happen. `MICROSERVICE_<lowercased>_ENABLED` is the load-bearing decoy: it
// matches the toggle-variable PATTERN, so only the case-sensitive comparison of
// the composed name keeps it from being read.
//
// Validates: Requirements 14.3, 13.11
// ---------------------------------------------------------------------------

/** The six accepted tokens of the Pre_Change_Baseline, fixed here. */
const BASELINE_ENABLING_TOKENS: readonly string[] = ['enabled', 'true', '1'];
const BASELINE_DISABLING_TOKENS: readonly string[] = ['disabled', 'false', '0'];

/** The Pre_Change_Baseline's variable name, composed here from the identifier. */
function baselineToggleVarName(identifier: string): string {
  return 'MICROSERVICE_' + identifier.toUpperCase() + '_ENABLED';
}

/**
 * The Pre_Change_Baseline's classification of one raw value: trim surrounding
 * whitespace, fold case, then look the token up in the two fixed sets. Anything
 * else is invalid.
 */
function baselineClassification(
  raw: string,
): 'enabled' | 'disabled' | 'invalid' {
  const normalised = raw.trim().toLowerCase();
  if (BASELINE_ENABLING_TOKENS.includes(normalised)) return 'enabled';
  if (BASELINE_DISABLING_TOKENS.includes(normalised)) return 'disabled';
  return 'invalid';
}

/**
 * Values spanning the accepted tokens in assorted casing and whitespace, plus
 * outright invalid strings. Generated from THIS file's token table, so the
 * generator and the expectation share one declaration and neither reads the code
 * under test.
 */
const arbBaselineToggleValue: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...BASELINE_ENABLING_TOKENS, ...BASELINE_DISABLING_TOKENS),
  fc
    .tuple(
      fc.constantFrom(...BASELINE_ENABLING_TOKENS, ...BASELINE_DISABLING_TOKENS),
      fc.constantFrom('', ' ', '  ', '\t'),
      fc.constantFrom('', ' ', '\t'),
      fc.constantFrom<'lower' | 'upper' | 'mixed'>('lower', 'upper', 'mixed'),
    )
    .map(([token, lead, trail, casing]) => {
      const cased =
        casing === 'upper'
          ? token.toUpperCase()
          : casing === 'lower'
            ? token.toLowerCase()
            : token
                .split('')
                .map((ch, i) => (i % 2 === 0 ? ch.toLowerCase() : ch.toUpperCase()))
                .join('');
      return `${lead}${cased}${trail}`;
    }),
  // Deliberately unaccepted values, so the `invalid` classification is exercised.
  fc.constantFrom('yes', 'no', 'on', 'off', 'enable', 'disable', '', ' ', '2', '-1', 'TRUEISH'),
);

/** Near-miss variable names for an identifier. None may ever be read. */
function decoyVarNames(identifier: string): readonly string[] {
  return [
    // Matches the toggle-variable pattern, but the identifier is not uppercased.
    'MICROSERVICE_' + identifier + '_ENABLED',
    // Truncated or altered suffix.
    'MICROSERVICE_' + identifier.toUpperCase() + '_ENABLE',
    'MICROSERVICE_' + identifier.toUpperCase() + '_DISABLED',
    'MICROSERVICE_' + identifier.toUpperCase(),
    // Missing or altered prefix.
    identifier.toUpperCase() + '_ENABLED',
    'MICROSERVICES_' + identifier.toUpperCase() + '_ENABLED',
  ].filter((name) => name !== baselineToggleVarName(identifier));
}

describe('Property 11: toggle variable names and value semantics are unchanged (R14.3, R13.11)', () => {
  // Feature: registry-inversion, Property 11: Toggle variable names and value semantics are unchanged
  it('classifies every value exactly as the Pre_Change_Baseline table does', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbIdentifier, { minLength: 1, maxLength: 5 }),
        fc.array(arbBaselineToggleValue, { minLength: 1, maxLength: 5 }),
        (identifiers, values) => {
          // One value per identifier, cycling the generated values so a short
          // list still covers a long identifier set.
          const assigned = identifiers.map(
            (identifier, index) => [identifier, values[index % values.length]!] as const,
          );
          const env: Record<string, string> = {};
          for (const [identifier, value] of assigned) {
            env[baselineToggleVarName(identifier)] = value;
          }

          const registry: MicroserviceRegistry = identifiers.map(entry);
          const result = validateToggles(registry, env);

          const expected = new Map(
            assigned.map(([identifier, value]) => [
              identifier,
              baselineClassification(value),
            ]),
          );
          const anyInvalid = [...expected.values()].includes('invalid');

          // Every registered identifier has a value, so nothing is missing; and
          // every variable names a registered identifier, so nothing is phantom.
          // The outcome is therefore decided by the value table alone.
          expect(result.ok).toBe(!anyInvalid);

          if (result.ok) {
            for (const [identifier, classification] of expected) {
              expect(result.toggleMap.enabled.get(identifier)).toBe(
                classification === 'enabled',
              );
            }
          } else {
            expect(result.missing).toEqual([]);
            expect(result.unknownEnabled).toEqual([]);
            const reportedInvalid = new Set(result.invalid.map((i) => i.identifier));
            const expectedInvalid = new Set(
              [...expected.entries()]
                .filter(([, classification]) => classification === 'invalid')
                .map(([identifier]) => identifier),
            );
            expect(setEquals(reportedInvalid, expectedInvalid)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: registry-inversion, Property 11: Toggle variable names and value semantics are unchanged
  it('reads MICROSERVICE_<IDENTIFIER>_ENABLED and no near-miss variable name', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbIdentifier, { minLength: 1, maxLength: 4 }),
        fc.constantFrom(...BASELINE_DISABLING_TOKENS),
        fc.constantFrom(...BASELINE_ENABLING_TOKENS),
        fc.boolean(),
        (identifiers, disablingValue, enablingValue, omitCanonical) => {
          const env: Record<string, string> = {};
          for (const identifier of identifiers) {
            // Every decoy carries an ENABLING value: reading any one of them
            // would flip the outcome observably.
            for (const decoy of decoyVarNames(identifier)) {
              env[decoy] = enablingValue;
            }
            if (!omitCanonical) {
              env[baselineToggleVarName(identifier)] = disablingValue;
            }
          }

          const registry: MicroserviceRegistry = identifiers.map(entry);
          const result = validateToggles(registry, env);

          if (omitCanonical) {
            // With only decoys present, every identifier is MISSING: no decoy
            // stood in for the canonical variable.
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(setEquals(result.missing, new Set(identifiers))).toBe(true);
              expect(result.invalid).toEqual([]);
              expect(result.unknownEnabled).toEqual([]);
            }
          } else {
            // With the canonical variable disabling and every decoy enabling,
            // every identifier evaluates DISABLED and nothing is reported.
            expect(result.ok).toBe(true);
            if (result.ok) {
              for (const identifier of identifiers) {
                expect(result.toggleMap.enabled.get(identifier)).toBe(false);
              }
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

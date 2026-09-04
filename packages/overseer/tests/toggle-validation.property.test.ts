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

import type { MicroserviceRegistry, RegistryEntry } from '@scaffold/contracts';
import {
  arbEnvironment,
  arbIdentifier,
  buildExpressRouter,
  toggleVarName,
} from '@scaffold/contracts/testing';

import { parseToggle, validateToggles } from '../src/toggles.js';

/** Build a contract-conforming registry entry for an identifier. */
function entry(identifier: string): RegistryEntry {
  const path = `/${identifier}`;
  return {
    identifier,
    sourcePackage: `@scaffold/${identifier}`,
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

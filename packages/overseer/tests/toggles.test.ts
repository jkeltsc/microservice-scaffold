import { describe, it, expect } from 'vitest';

import type { MicroserviceRegistry, RegistryEntry } from '@scaffold/contracts';
import { buildExpressRouter } from '@scaffold/contracts/testing';

import {
  parseToggle,
  validateToggles,
  toggleVarName,
} from '../src/toggles.js';

// Unit tests for the Overseer toggle parser and validator (task 7.3).
//
// Covers Property 7 (parseToggle token mapping) and Property 8 (validateToggles
// missing / invalid / phantom-enabled classification, phantom-disabled ignored).

/** Build a registry entry with a contract-conforming router. */
function entry(identifier: string): RegistryEntry {
  const path = `/${identifier}`;
  return {
    identifier,
    sourcePackage: `@scaffold/${identifier}`,
    module: { path, router: buildExpressRouter(identifier, path) },
  };
}

describe('parseToggle', () => {
  it('maps enabled/true/1 (any case, trimmed) to enabled', () => {
    for (const raw of ['enabled', 'true', '1', 'ENABLED', ' TrUe ', '\t1\t']) {
      expect(parseToggle(raw)).toEqual({ ok: true, enabled: true });
    }
  });

  it('maps disabled/false/0 (any case, trimmed) to disabled', () => {
    for (const raw of ['disabled', 'false', '0', 'DISABLED', ' FaLsE ', ' 0 ']) {
      expect(parseToggle(raw)).toEqual({ ok: true, enabled: false });
    }
  });

  it('rejects any other token, carrying the original unmodified value', () => {
    for (const raw of ['yes', 'no', '', '  ', '2', 'enable', ' Yes ']) {
      expect(parseToggle(raw)).toEqual({ ok: false, rawValue: raw });
    }
  });
});

describe('validateToggles', () => {
  const microserviceRegistry: MicroserviceRegistry = [
    entry('microservice1'),
    entry('microservice2'),
  ];

  it('succeeds and produces a toggle map when all toggles are valid', () => {
    const result = validateToggles(microserviceRegistry, {
      MICROSERVICE_MICROSERVICE1_ENABLED: 'enabled',
      MICROSERVICE_MICROSERVICE2_ENABLED: 'false',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.toggleMap.enabled.get('microservice1')).toBe(true);
    expect(result.toggleMap.enabled.get('microservice2')).toBe(false);
    expect([...result.toggleMap.enabled.keys()].sort()).toEqual([
      'microservice1',
      'microservice2',
    ]);
  });

  it('reports missing toggles for registered identifiers', () => {
    const result = validateToggles(microserviceRegistry, {
      MICROSERVICE_MICROSERVICE1_ENABLED: 'enabled',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.missing).toEqual(['microservice2']);
    expect(result.invalid).toEqual([]);
    expect(result.unknownEnabled).toEqual([]);
  });

  it('reports invalid toggles carrying the rejected value', () => {
    const result = validateToggles(microserviceRegistry, {
      MICROSERVICE_MICROSERVICE1_ENABLED: 'enabled',
      MICROSERVICE_MICROSERVICE2_ENABLED: 'yes',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.invalid).toEqual([
      { identifier: 'microservice2', rawValue: 'yes' },
    ]);
    expect(result.missing).toEqual([]);
  });

  it('reports phantom-enabled toggles for unregistered identifiers (R7.1)', () => {
    const result = validateToggles(microserviceRegistry, {
      MICROSERVICE_MICROSERVICE1_ENABLED: 'enabled',
      MICROSERVICE_MICROSERVICE2_ENABLED: 'enabled',
      MICROSERVICE_LEGACY_ENABLED: 'true',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.unknownEnabled).toEqual(['legacy']);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('ignores phantom-disabled toggles entirely (R7.2)', () => {
    const result = validateToggles(microserviceRegistry, {
      MICROSERVICE_MICROSERVICE1_ENABLED: 'enabled',
      MICROSERVICE_MICROSERVICE2_ENABLED: 'enabled',
      MICROSERVICE_LEGACY_ENABLED: 'disabled',
      MICROSERVICE_OLD_ENABLED: 'garbage',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.toggleMap.enabled.has('legacy')).toBe(false);
    expect(result.toggleMap.enabled.has('old')).toBe(false);
  });

  it('collects all four categories together in one pass (R7.3)', () => {
    const result = validateToggles(
      [entry('microservice1'), entry('microservice2'), entry('microservice3')],
      {
        // microservice1: missing
        MICROSERVICE_MICROSERVICE2_ENABLED: 'maybe', // invalid
        MICROSERVICE_MICROSERVICE3_ENABLED: 'enabled', // valid
        MICROSERVICE_PHANTOM_ENABLED: '1', // unknown-enabled
        MICROSERVICE_GONE_ENABLED: '0', // phantom-disabled, ignored
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.missing).toEqual(['microservice1']);
    expect(result.invalid).toEqual([
      { identifier: 'microservice2', rawValue: 'maybe' },
    ]);
    expect(result.unknownEnabled).toEqual(['phantom']);
  });

  it('derives the env-var name via toggleVarName', () => {
    expect(toggleVarName('microservice1')).toBe(
      'MICROSERVICE_MICROSERVICE1_ENABLED',
    );
  });
});

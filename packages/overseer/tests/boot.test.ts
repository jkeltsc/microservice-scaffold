import { describe, it, expect } from 'vitest';

import type { MicroserviceRegistry, RegistryEntry } from '@scaffold/contracts';
import { buildExpressRouter } from '@scaffold/contracts/testing';

import { boot } from '../src/boot.js';
import { toggleVarName } from '../src/toggles.js';

// Unit tests for the boot pipeline composition (task 7.14).
//
// `boot` is pure of process effects (no exit, no stderr): it takes an injected
// microservice registry + env + config and returns a discriminated result. These
// tests exercise the ordered composition and each failure category's message
// shape, plus a happy-path smoke test with a synthetic registry.

/**
 * Build a contract-conforming registry entry for a given identifier.
 *
 * Only the path is overridable: the router is always a real Express router,
 * because a wrong-shaped router is not a runtime condition — the generated
 * registry is type-checked against `MicroserviceModule`, so a module that failed
 * to export one never reaches `boot`.
 */
function entry(
  identifier: string,
  overrides: Partial<{ path: string }> = {},
): RegistryEntry {
  const path = overrides.path ?? `/${identifier}`;
  return {
    identifier,
    sourcePackage: `@scaffold/${identifier}`,
    module: { path, router: buildExpressRouter(identifier, path) },
  };
}

/** All-enabled environment for a set of identifiers. */
function enabledEnv(...identifiers: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const id of identifiers) env[toggleVarName(id)] = 'enabled';
  return env;
}

describe('boot — happy path', () => {
  it('builds an app and reports enabled identifiers with a valid registry', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('microservice1'),
      entry('microservice2'),
    ];
    const result = boot({
      microserviceRegistry,
      env: {
        ...enabledEnv('microservice1'),
        [toggleVarName('microservice2')]: 'disabled',
      },
      config: { port: 8080 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected boot success');
    // Express apps are callable request-listener functions.
    expect(typeof result.app).toBe('function');
    expect(result.config.port).toBe(8080);
    // Only the enabled microservice is reported.
    expect(result.enabledIdentifiers).toEqual(['microservice1']);
  });

  it('returns registeredMicroservices with identifier, path, and toggle state', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('microservice1'),
      entry('microservice2'),
    ];
    const result = boot({
      microserviceRegistry,
      env: {
        ...enabledEnv('microservice1'),
        [toggleVarName('microservice2')]: 'disabled',
      },
      config: { port: 8080 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected boot success');
    expect(result.registeredMicroservices).toEqual([
      { identifier: 'microservice1', path: '/microservice1', enabled: true },
      { identifier: 'microservice2', path: '/microservice2', enabled: false },
    ]);
  });
});

describe('boot — module path failure (step 2)', () => {
  it('aborts with a [module] message naming the offending package', () => {
    // A path that does not start with "/" — the one module-level defect the type
    // system cannot catch, and therefore the only one step 2 still checks.
    const microserviceRegistry: MicroserviceRegistry = [
      entry('microservice1', { path: 'no-slash' }),
    ];
    const result = boot({ microserviceRegistry, env: enabledEnv('microservice1') });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected boot failure');
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0]).toContain('[module]');
    expect(result.messages.join('\n')).toContain('@scaffold/microservice1');
  });

  it('aggregates defects across multiple entries in a single attempt', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('microservice1', { path: 'bad1' }),
      entry('microservice2'),                     // valid — not reported
      entry('microservice3', { path: '' }),
    ];
    const result = boot({
      microserviceRegistry,
      env: enabledEnv('microservice1', 'microservice2', 'microservice3'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected boot failure');
    // Both offending packages are reported; the valid one is not.
    expect(result.messages).toHaveLength(2);
    expect(result.messages.join('\n')).toContain('@scaffold/microservice1');
    expect(result.messages.join('\n')).toContain('@scaffold/microservice3');
    expect(result.messages.join('\n')).not.toContain('@scaffold/microservice2');
  });
});

describe('boot — collision failure (step 3)', () => {
  it('aborts with a [collision:path] message for two modules sharing a path', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('microservice1', { path: '/shared' }),
      entry('microservice2', { path: '/shared' }),
    ];
    const result = boot({
      microserviceRegistry,
      env: enabledEnv('microservice1', 'microservice2'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected boot failure');
    const joined = result.messages.join('\n');
    expect(joined).toContain('[collision:path]');
    expect(joined).toContain('/shared');
    expect(joined).toContain('microservice1');
    expect(joined).toContain('microservice2');
  });

  it('allows parent/child paths — only exact duplicates collide', () => {
    // Parent/child overlaps (e.g. /api and /api/v2) are a valid Express mount
    // topology: buildApp sorts mounts by path length descending, so the longer
    // mount always wins for its subtree.
    const microserviceRegistry: MicroserviceRegistry = [
      entry('api', { path: '/api' }),
      entry('apiv2', { path: '/api/v2' }),
    ];
    const result = boot({
      microserviceRegistry,
      env: enabledEnv('api', 'apiv2'),
    });

    expect(result.ok).toBe(true);
  });

  it('allows a microservice at "/_registry" — there is no reserved introspection path', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('sneaky', { path: '/_registry' }),
    ];
    const result = boot({
      microserviceRegistry,
      env: enabledEnv('sneaky'),
    });

    expect(result.ok).toBe(true);
  });

  it('allows a microservice at "/" — root does not collide with anything', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('root', { path: '/' }),
    ];
    const result = boot({
      microserviceRegistry,
      env: enabledEnv('root'),
    });

    expect(result.ok).toBe(true);
  });

  // There is no identifier-collision case: two entries cannot share an
  // identifier, because the identifier IS the namespace directory name and the
  // generator emits one entry per directory. Step 3 checks paths only.
});

describe('boot — toggle failures (step 4, batched)', () => {
  it('reports missing, invalid, and unknown-enabled toggles together', () => {
    const microserviceRegistry: MicroserviceRegistry = [
      entry('microservice1'),
      entry('microservice2'),
    ];
    const result = boot({
      microserviceRegistry,
      env: {
        // microservice1 missing entirely
        [toggleVarName('microservice2')]: 'nonsense', // invalid
        [toggleVarName('phantom')]: 'enabled', // unknown-enabled
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected boot failure');
    const joined = result.messages.join('\n');
    expect(joined).toContain('[toggle:missing]');
    expect(joined).toContain(toggleVarName('microservice1'));
    expect(joined).toContain('[toggle:invalid]');
    expect(joined).toContain('"nonsense"');
    expect(joined).toContain('[toggle:unknown]');
    expect(joined).toContain('phantom');
  });
});

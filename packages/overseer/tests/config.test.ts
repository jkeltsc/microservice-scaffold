import { describe, it, expect, vi, afterEach } from 'vitest';

import { loadConfig, DEFAULT_PORT, type AppConfig } from '../src/config.js';

// Unit tests for the Overseer runtime config loader (task 7.2, R3.1).
//
// Covers the invalid-value policy documented in `src/config.ts`: unset/empty
// falls back to the default; a valid positive integer is honored; anything
// else falls back to the default with a stderr warning.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('defaults to 8080 when PORT is unset', () => {
    const config: AppConfig = loadConfig({});
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.port).toBe(8080);
  });

  it('parses a valid positive integer PORT', () => {
    expect(loadConfig({ PORT: '3000' }).port).toBe(3000);
  });

  it('honors the boundary ports 1 and 65535', () => {
    expect(loadConfig({ PORT: '1' }).port).toBe(1);
    expect(loadConfig({ PORT: '65535' }).port).toBe(65535);
  });

  it('trims surrounding whitespace around a valid value', () => {
    expect(loadConfig({ PORT: '  8081  ' }).port).toBe(8081);
  });

  it('falls back to the default for an empty or whitespace-only PORT', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(loadConfig({ PORT: '' }).port).toBe(DEFAULT_PORT);
    expect(loadConfig({ PORT: '   ' }).port).toBe(DEFAULT_PORT);
    // Empty/whitespace is treated as "unset", so no warning is emitted.
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '99999', 'abc', '80.5', '1e3', '0x1f', '12a'])(
    'falls back to the default and warns for invalid PORT "%s"',
    (raw) => {
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(loadConfig({ PORT: raw }).port).toBe(DEFAULT_PORT);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('[config:warning]');
    },
  );

  it('defaults to reading process.env when no env is supplied', () => {
    const original = process.env.PORT;
    try {
      process.env.PORT = '4321';
      expect(loadConfig().port).toBe(4321);
    } finally {
      if (original === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = original;
      }
    }
  });
});

// Feature: microservice-scaffold, Property 7: Toggle-token parsing.
//
// For any string t, letting norm(t) = t.trim().toLowerCase():
//   - norm(t) in {"enabled","true","1"}   -> parseToggle(t) = {ok:true, enabled:true}
//   - norm(t) in {"disabled","false","0"}  -> parseToggle(t) = {ok:true, enabled:false}
//   - otherwise                            -> parseToggle(t) = {ok:false, rawValue:t}
//     (the ORIGINAL, unmodified token is preserved for diagnostics)
//
// Validates: Requirements R4.1, R4.5

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { parseToggle } from '../src/toggles.js';

/** The two accepted token classes, in their canonical (normalized) form. */
const ENABLED_TOKENS = ['enabled', 'true', '1'] as const;
const DISABLED_TOKENS = ['disabled', 'false', '0'] as const;
const ALL_ACCEPTED = new Set<string>([...ENABLED_TOKENS, ...DISABLED_TOKENS]);

/**
 * Wrap a token in a random casing + surrounding-whitespace variant while
 * preserving its normalized value. norm(decorate(tok)) === tok by construction,
 * so the accepted-token branches must hold for every decoration.
 */
const arbWhitespace = fc.constantFrom('', ' ', '  ', '\t', ' \t ', '\n');

function arbDecoratedToken(
  tokens: readonly string[],
): fc.Arbitrary<{ raw: string; token: string }> {
  return fc
    .tuple(
      fc.constantFrom(...tokens),
      arbWhitespace,
      arbWhitespace,
      // A per-character casing mask so we cover mixed-case forms like "eNaBlEd".
      fc.array(fc.boolean(), { minLength: 0, maxLength: 8 }),
    )
    .map(([token, lead, trail, caseMask]) => {
      const cased = token
        .split('')
        .map((ch, i) => (caseMask[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');
      return { raw: `${lead}${cased}${trail}`, token };
    });
}

describe('Property 7: toggle-token parsing', () => {
  it('maps enabled/true/1 (any case, any surrounding whitespace) to {ok:true, enabled:true}', () => {
    fc.assert(
      fc.property(arbDecoratedToken(ENABLED_TOKENS), ({ raw }) => {
        expect(parseToggle(raw)).toEqual({ ok: true, enabled: true });
      }),
      { numRuns: 200 },
    );
  });

  it('maps disabled/false/0 (any case, any surrounding whitespace) to {ok:true, enabled:false}', () => {
    fc.assert(
      fc.property(arbDecoratedToken(DISABLED_TOKENS), ({ raw }) => {
        expect(parseToggle(raw)).toEqual({ ok: true, enabled: false });
      }),
      { numRuns: 200 },
    );
  });

  it('rejects any other string, carrying the original unmodified token as rawValue', () => {
    // Arbitrary strings whose normalized form is NOT an accepted token. We draw
    // from fc.string and discard the (rare) strings that happen to normalize to
    // an accepted token, so every generated value belongs in the reject branch.
    const arbRejected = fc
      .string()
      .filter((s) => !ALL_ACCEPTED.has(s.trim().toLowerCase()));

    fc.assert(
      fc.property(arbRejected, (raw) => {
        expect(parseToggle(raw)).toEqual({ ok: false, rawValue: raw });
      }),
      { numRuns: 200 },
    );
  });
});

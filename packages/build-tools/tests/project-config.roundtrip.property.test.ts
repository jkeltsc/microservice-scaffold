// Feature: config-driven-discovery
//
// Property 2: Parse and print round-trip.
// Property 3 (idempotence) is appended to this file by task 2.5.
//
// For any Effective_Config, `parseProjectConfig(serializeProjectConfig(config))`
// returns kind "parsed" with a config equal in every value to the original
// (R2.10), and `serializeProjectConfig` declares every value and renders two
// equal Effective_Configs byte-identically (R2.9). Since registry-inversion the
// Entry_Root is one of those values: five in total — the Configured_Scope, the
// three Discovery_Roots, and the Entry_Root.
//
// The generated Effective_Config is drawn from the shared arbitraries: its
// Configured_Scope from `validScope()` (a Valid_Scope of 2 to 32 characters),
// its three Discovery_Roots from `nonOverlappingRootTriple()` — three
// Valid_Root_Paths that are pairwise unequal, none nested in another at a `/`
// boundary, and none in a nesting/equality relation with a Framework_Singleton
// directory — and its Entry_Root from `arbAcceptedEntryRoot()` over the reserved
// set of THAT triple, so the Entry_Root collides with none of the eight reserved
// paths the serialized text then declares (registry-inversion R1.6). That is
// exactly the input space Requirement 14.2 names: a config the parser is
// required to accept unchanged, so the round-trip must both accept it (no
// diagnostic) and reproduce every value.
//
// Validates: Requirements 2.9, 2.10, 14.2
// Validates: registry-inversion Requirements 1.2

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  serializeProjectConfig,
  type EffectiveConfig,
} from "../src/project-config.js";
import {
  arbAcceptedEntryRoot,
  arbEntryConfigText,
  configText,
  nonOverlappingRootTriple,
  reservedEntryPaths,
  validScope,
} from "./arbitraries/config.js";

/**
 * A valid, non-overlapping Effective_Config: a Valid_Scope, a non-overlapping
 * root triple in microservice, common, spa order, and an Entry_Root clear of
 * that triple's reserved set. Every value this yields is one the Config_Parser
 * must accept, so a round-trip failure is a genuine defect rather than an
 * out-of-space input.
 *
 * The Entry_Root is drawn AFTER the triple and against that triple's reserved
 * set, because the serialized text declares all three roots: an Entry_Root drawn
 * independently could land inside a declared root and the parser would rightly
 * reject the serializer's own output.
 */
function effectiveConfig(): fc.Arbitrary<EffectiveConfig> {
  return fc
    .tuple(validScope(), nonOverlappingRootTriple())
    .chain(([scope, triple]) =>
      arbAcceptedEntryRoot(reservedEntryPaths(triple)).map(
        (entry): EffectiveConfig => {
          const [microservice, common, spa] = triple;
          return {
            scope,
            roots: { microservice, common, spa },
            entry,
          };
        },
      ),
    );
}

describe("Property 2: parse and print round-trip", () => {
  it("parsing a serialized Effective_Config recovers every value with no diagnostic", () => {
    fc.assert(
      fc.property(effectiveConfig(), (config) => {
        const text = serializeProjectConfig(config);
        const outcome = parseProjectConfig(text, PROJECT_CONFIG_FILE);

        // R2.10 — the parser accepts the serializer's output, reporting nothing.
        expect(outcome.kind).toBe("parsed");
        if (outcome.kind !== "parsed") return;

        // R2.10 — the recovered config equals the original in every value.
        const recovered = outcome.parsed.config;
        expect(recovered.scope).toBe(config.scope);
        expect(recovered.roots.microservice).toBe(config.roots.microservice);
        expect(recovered.roots.common).toBe(config.roots.common);
        expect(recovered.roots.spa).toBe(config.roots.spa);
        // The Entry_Root round-trips character for character too.
        expect(recovered.entry).toBe(config.entry);
      }),
      { numRuns: 200 },
    );
  });

  it("declares every value and only those, and renders equal configs byte-identically", () => {
    fc.assert(
      fc.property(effectiveConfig(), (config) => {
        const text = serializeProjectConfig(config);

        // R2.9 — the rendered text declares every value and no other key, the
        // Entry_Root included.
        const shape: unknown = JSON.parse(text);
        expect(shape).toEqual({
          scope: config.scope,
          roots: {
            microservice: config.roots.microservice,
            common: config.roots.common,
            spa: config.roots.spa,
          },
          entry: config.entry,
        });

        // R2.9 — two Effective_Configs equal in every value render to
        // byte-identical text. A structurally-equal but distinct object must
        // serialize to the exact same bytes.
        const twin: EffectiveConfig = {
          scope: config.scope,
          roots: {
            microservice: config.roots.microservice,
            common: config.roots.common,
            spa: config.roots.spa,
          },
          entry: config.entry,
        };
        expect(serializeProjectConfig(twin)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Print is idempotent under re-parsing.
//
// For any JSON object text the Config_Parser accepts, serializing the resulting
// Effective_Config, then parsing and serializing that text again, produces text
// identical to the first serialization (R14.3). This is idempotence of the
// serialize/parse pair: once a value has passed through `serializeProjectConfig`
// it is a fixed point of the round-trip, so no further pass changes it.
//
// The generated texts come from the shared `configText()` arbitrary — JSON
// object texts that declare any subset of the recognised keys with accepted
// values, varying member order and insignificant whitespace, and sometimes
// mixing in unrecognised keys or wrong-typed values — united with
// `arbEntryConfigText()`, whose texts ALWAYS declare `entry`, so the Entry_Root
// reaches the fixed point rather than only ever being the default. The parser MAY reject such
// a text (a wrong-typed `scope`, an overlapping root pair, ...); Requirement
// 14.3 says to discard those runs without failing, which `fc.pre` does: the run
// counts as a discard, not a pass, so the property still explores the accepted
// texts it is about.
//
// Validates: Requirements 14.3

describe("Property 3: print is idempotent under re-parsing", () => {
  it("serializing an accepted config, then re-parsing and re-serializing, reaches a fixed point", () => {
    fc.assert(
      fc.property(fc.oneof(configText(), arbEntryConfigText()), (text) => {
        const first = parseProjectConfig(text, PROJECT_CONFIG_FILE);

        // R14.3 — only accepted texts are in scope; discard the rest without
        // failing so the run counts as a precondition miss, not a pass.
        fc.pre(first.kind === "parsed");
        if (first.kind !== "parsed") return;

        // Serialize the accepted config, then round-trip that serialization.
        const config1 = first.parsed.config;
        const text1 = serializeProjectConfig(config1);

        const second = parseProjectConfig(text1, PROJECT_CONFIG_FILE);
        // The serializer's output is always accepted (Property 2), so a
        // rejection here would be a genuine defect rather than an out-of-space
        // input — assert it rather than discarding.
        expect(second.kind).toBe("parsed");
        if (second.kind !== "parsed") return;

        const config2 = second.parsed.config;
        const text2 = serializeProjectConfig(config2);

        // R14.3 — the second serialization is byte-identical to the first: once
        // serialized, the text is a fixed point of parse-then-serialize.
        expect(text2).toBe(text1);
        // And the two configs are equal in every value, so the fixed point
        // holds at the config level as well as the text level.
        expect(config2).toEqual(config1);
      }),
      { numRuns: 200 },
    );
  });
});

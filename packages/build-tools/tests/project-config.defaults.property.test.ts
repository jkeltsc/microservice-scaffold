// Property 4: An undeclared value takes its default.
//
// For any Project_Config text declaring any proper subset of the four
// recognised value keys (`scope` and the three `roots` members) with ACCEPTED
// values, each declared value appears in the Effective_Config character for
// character (R1.4), and each undeclared value equals that key's Scope_Default
// or Root_Default (R1.4). Plus the two single-value assertions: the JSON text
// `{}` yields an Effective_Config equal in all four values to
// `defaultEffectiveConfig()` (R1.6), and that same `{}` outcome equals what the
// absent-file path yields — asserted here as `{}` parse equals
// `defaultEffectiveConfig()`, the value the Config_Loader yields for an absent
// file (R1.5).
//
// `configText()` from the shared arbitraries generates subset-declaring texts,
// but it does not report WHICH keys it declared, and this property must assert
// declared-preserved versus undeclared-defaulted per key. So it builds a small
// local arbitrary that draws each of the four values independently as
// present-with-an-accepted-value or absent, renders the JSON, and carries the
// declared choices alongside the text so each key can be checked against the
// right expectation.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  parseProjectConfig,
  defaultEffectiveConfig,
  SCOPE_DEFAULT,
  ROOT_DEFAULTS,
  PROJECT_CONFIG_FILE,
} from "../src/project-config.js";
import { validScope, nonOverlappingRootTriple } from "./arbitraries/config.js";

/** The value chosen for one recognised key: either declared with an accepted
 *  string, or left absent so it must take its default. */
type Choice = { readonly declared: false } | { readonly declared: true; readonly value: string };

/** The four independent choices of one generated config, plus the JSON text
 *  they render to, so each key can be checked against the right expectation. */
interface SubsetConfig {
  readonly scope: Choice;
  readonly microservice: Choice;
  readonly common: Choice;
  readonly spa: Choice;
  readonly text: string;
}

/** Turns a possibly-absent value into a {@link Choice}. */
function toChoice(value: string | undefined): Choice {
  return value === undefined
    ? ({ declared: false } as const)
    : ({ declared: true, value } as const);
}

/**
 * A config declaring any subset of the four recognised value keys with accepted
 * values, tracking which keys were declared.
 *
 * The scope choice is drawn independently — scope participates in no
 * overlap/framework check, so its value is free. The three root choices,
 * however, cannot be drawn independently: two independently-valid root paths can
 * still be equal, nested, or collide with a Framework_Singleton directory, all
 * of which the parser CORRECTLY rejects. A declared root also has to stay clear
 * of the DEFAULTS the undeclared categories take, since a defaulted root still
 * participates in the parser's overlap and framework checks.
 *
 * So the roots are drawn from `nonOverlappingRootTriple()` — three valid,
 * pairwise non-overlapping, non-framework-colliding paths whose lead segments
 * are never `packages`. Each category then independently either DECLARES its
 * root (taking that category's slot from the triple) or omits it (taking the
 * `packages/<category>` default). The resulting effective set is always
 * acceptable: the triple's members never nest with each other, and because
 * their lead segment is never `packages` they never nest with a `packages/*`
 * default either, while the three defaults are themselves mutually
 * non-overlapping and non-framework. Every subset is reachable — including the
 * empty subset (`{}`) and the full set, the boundary case where the property
 * degenerates to "every value is preserved and none is defaulted".
 */
function subsetConfig(): fc.Arbitrary<SubsetConfig> {
  return fc
    .record({
      scope: fc.option(validScope(), { nil: undefined }),
      triple: nonOverlappingRootTriple(),
      declareMicroservice: fc.boolean(),
      declareCommon: fc.boolean(),
      declareSpa: fc.boolean(),
    })
    .map((draw) => {
      const [microserviceRoot, commonRoot, spaRoot] = draw.triple;
      const scope = toChoice(draw.scope);
      const microservice = toChoice(
        draw.declareMicroservice ? microserviceRoot : undefined,
      );
      const common = toChoice(draw.declareCommon ? commonRoot : undefined);
      const spa = toChoice(draw.declareSpa ? spaRoot : undefined);
      const topMembers: [string, string][] = [];
      if (scope.declared) {
        topMembers.push(["scope", JSON.stringify(scope.value)]);
      }

      const rootsMembers: [string, string][] = [];
      if (microservice.declared) {
        rootsMembers.push(["microservice", JSON.stringify(microservice.value)]);
      }
      if (common.declared) {
        rootsMembers.push(["common", JSON.stringify(common.value)]);
      }
      if (spa.declared) {
        rootsMembers.push(["spa", JSON.stringify(spa.value)]);
      }

      // Only emit a `roots` key when at least one member is declared; a config
      // declaring `scope` alone must not carry an empty `roots` object, since
      // that would change which keys are "declared".
      if (rootsMembers.length > 0) {
        topMembers.push(["roots", renderObject(rootsMembers)]);
      }

      return {
        scope,
        microservice,
        common,
        spa,
        text: renderObject(topMembers),
      };
    });
}

/** Renders `[key, rawValueJson]` pairs as a compact JSON object, splicing the
 *  already-serialised value verbatim. */
function renderObject(members: readonly [string, string][]): string {
  if (members.length === 0) return "{}";
  const body = members
    .map(([key, value]) => `${JSON.stringify(key)}: ${value}`)
    .join(", ");
  return `{ ${body} }`;
}

/** The Effective_Config a declared-or-absent choice must produce for one key:
 *  the declared value character for character, or the given default. */
function expected(choice: Choice, fallback: string): string {
  return choice.declared ? choice.value : fallback;
}

describe("Property 4: an undeclared value takes its default (R1.4)", () => {
  it("preserves each declared value and defaults each undeclared value", () => {
    fc.assert(
      fc.property(subsetConfig(), (subset) => {
        const outcome = parseProjectConfig(subset.text, PROJECT_CONFIG_FILE);

        // Every generated config declares only accepted values, so the parser
        // must accept it. A rejection here is itself a failure.
        expect(outcome.kind).toBe("parsed");
        if (outcome.kind !== "parsed") return;

        const { config } = outcome.parsed;

        expect(config.scope).toBe(expected(subset.scope, SCOPE_DEFAULT));
        expect(config.roots.microservice).toBe(
          expected(subset.microservice, ROOT_DEFAULTS.microservice),
        );
        expect(config.roots.common).toBe(
          expected(subset.common, ROOT_DEFAULTS.common),
        );
        expect(config.roots.spa).toBe(expected(subset.spa, ROOT_DEFAULTS.spa));
      }),
    );
  });
});

describe("the empty object yields the defaults (R1.5, R1.6)", () => {
  it("parses `{}` to an Effective_Config equal in all four values to defaultEffectiveConfig()", () => {
    // R1.6: `{}` yields all four defaults. R1.5: an absent file yields the same
    // Effective_Config, which `defaultEffectiveConfig()` is by definition, so
    // asserting `{}` equals it also pins the absent-file equality.
    const outcome = parseProjectConfig("{}", PROJECT_CONFIG_FILE);

    expect(outcome.kind).toBe("parsed");
    if (outcome.kind !== "parsed") return;

    expect(outcome.parsed.config).toEqual(defaultEffectiveConfig());
  });

  it("yields each of the four defaults individually", () => {
    const outcome = parseProjectConfig("{}", PROJECT_CONFIG_FILE);
    if (outcome.kind !== "parsed") throw new Error("expected `{}` to parse");

    const { config } = outcome.parsed;
    expect(config.scope).toBe(SCOPE_DEFAULT);
    expect(config.roots.microservice).toBe(ROOT_DEFAULTS.microservice);
    expect(config.roots.common).toBe(ROOT_DEFAULTS.common);
    expect(config.roots.spa).toBe(ROOT_DEFAULTS.spa);
  });
});

/**
 * Validates: Requirements 1.4, 1.5, 1.6, 14.4
 */

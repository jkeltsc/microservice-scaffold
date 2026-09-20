// Property 10: the Config_Loader accepts exactly the root sets passing every
// Filesystem_Validation (Requirement 14.14; Requirements 5.1, 5.2, 5.3, 5.4,
// 5.5, 5.7, 5.8).
//
// The subject under test is `validateDiscoveryRoots(parsed, probeRoot)` from
// `config-loader.ts` — the only function taking a prober, and the whole of the
// Filesystem_Validation stage. A ParsedConfig is a branded value constructible
// only by `parseProjectConfig`, so the property obtains one the sanctioned way:
// it builds a valid config text from `validScope()` + `nonOverlappingRootTriple()`,
// serialises it, parses it, and narrows the outcome to kind "parsed".
//
// The oracle here NEVER calls anything from `config-loader.ts`. It recomputes,
// from the drawn per-category `RootProbe` responses alone, exactly which
// diagnostics Requirement 5 says the loader must report, and in exactly the
// order Requirement 5.5 fixes (Consumer_Category rank, then tag). The property is
// then a straight comparison of the loader's outcome against that oracle, plus
// the R5.8 assertion that the recording prober was called with exactly the three
// root paths in microservice, common, spa order.
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 14.14

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  CONSUMER_CATEGORIES,
  type ConsumerCategory,
} from "../src/framework.js";
import {
  parseProjectConfig,
  serializeProjectConfig,
  type ConfigTag,
  type EffectiveConfig,
  type ParsedConfig,
} from "../src/project-config.js";
import {
  loadProjectConfig,
  validateDiscoveryRoots,
  type ConfigFileRead,
  type LoadOutcome,
  type RootProbe,
} from "../src/config-loader.js";
import {
  validScope,
  nonOverlappingRootTriple,
  type RootTriple,
} from "./arbitraries/config.js";
import {
  proberResponses,
  recordingProber,
  type ProberResponses,
} from "./arbitraries/probe.js";

// ---------------------------------------------------------------------------
// Obtaining a ParsedConfig the sanctioned way
// ---------------------------------------------------------------------------

/**
 * The Entry_Root every config built here declares. This suite is about the
 * Filesystem_Validation of the three Discovery_Roots, so the Entry_Root only has
 * to be one the parser accepts alongside any generated triple: a single segment
 * longer than the eight characters `validSegment()` ever produces, so no
 * generated root can equal it, lie inside it, or contain it — the Entry_Root
 * cannot accidentally become the reason a config is rejected.
 */
const ENTRY_ROOT = "entry-package-root";

/** A valid scope paired with three non-overlapping, non-framework roots. */
function validConfig(): fc.Arbitrary<{
  readonly scope: string;
  readonly roots: RootTriple;
}> {
  return fc.record({ scope: validScope(), roots: nonOverlappingRootTriple() });
}

/**
 * Serialises a valid config, parses it, and narrows to the branded ParsedConfig
 * — the only way to obtain one. Any rejection here is a bug in the arbitraries
 * or the parser, not an expected outcome, so it throws rather than being folded
 * into the property.
 */
function parseValid(scope: string, roots: RootTriple): ParsedConfig {
  const config: EffectiveConfig = {
    scope,
    roots: { microservice: roots[0], common: roots[1], spa: roots[2] },
    entry: ENTRY_ROOT,
  };
  const text = serializeProjectConfig(config);
  const outcome = parseProjectConfig(text, "scaffold.config.json");
  if (outcome.kind !== "parsed") {
    throw new Error(
      `expected a valid config to parse, got: ${JSON.stringify(outcome.diagnostics)}`,
    );
  }
  return outcome.parsed;
}

// ---------------------------------------------------------------------------
// The independent oracle
// ---------------------------------------------------------------------------

/** Consumer_Category rank in microservice, common, spa order (R5.5 primary key). */
const CATEGORY_RANK: Readonly<Record<ConsumerCategory, number>> = {
  microservice: 0,
  common: 1,
  spa: 2,
};

/**
 * The single diagnostic (if any) Requirement 5 assigns to one category given its
 * drawn probe response, recomputed from the acceptance criteria alone.
 *
 * - `failed` → `[config:root-unreadable]` for any category (R5.7);
 * - `absent` → `[config:root-missing]` for microservice only (R5.1); none for
 *   common or spa (R5.2);
 * - `not-directory` → `[config:root-not-directory]` for any category (R5.3);
 * - `directory` holding a `package.json` → `[config:root-is-package]` (R5.4);
 *   a directory not holding one is accepted (no diagnostic).
 */
function expectedTagFor(
  category: ConsumerCategory,
  probe: RootProbe,
): ConfigTag | undefined {
  switch (probe.kind) {
    case "failed":
      return "config:root-unreadable";
    case "absent":
      return category === "microservice" ? "config:root-missing" : undefined;
    case "not-directory":
      return "config:root-not-directory";
    case "directory":
      return probe.holdsPackageJsonFile ? "config:root-is-package" : undefined;
  }
}

/** The ordered tag/category pairs the loader must report, per R5.5: sorted by
 *  ascending category rank, then ascending code-point comparison of tag. */
function oracleOrder(
  responses: ProberResponses,
): readonly { readonly category: ConsumerCategory; readonly tag: ConfigTag }[] {
  const entries: {
    readonly category: ConsumerCategory;
    readonly tag: ConfigTag;
  }[] = [];
  for (const category of CONSUMER_CATEGORIES) {
    const tag = expectedTagFor(category, responses[category]);
    if (tag !== undefined) {
      entries.push({ category, tag });
    }
  }
  return entries.sort((a, b) => {
    const rankDiff = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
    if (rankDiff !== 0) return rankDiff;
    if (a.tag < b.tag) return -1;
    if (a.tag > b.tag) return 1;
    return 0;
  });
}

/** The three root paths as a category-keyed record, for the recording prober. */
function rootPathsOf(config: EffectiveConfig): Record<ConsumerCategory, string> {
  return {
    microservice: config.roots.microservice,
    common: config.roots.common,
    spa: config.roots.spa,
  };
}

/** The diagnostic tags the outcome carries, or `undefined` when it loaded. */
function outcomeTags(outcome: LoadOutcome): readonly ConfigTag[] | undefined {
  return outcome.kind === "loaded"
    ? undefined
    : outcome.diagnostics.map((d) => d.tag);
}

/** The `(tag, at)` pairs the outcome carries, empty when it loaded. */
function outcomePairs(
  outcome: LoadOutcome,
): readonly { readonly tag: ConfigTag; readonly at: string }[] {
  return outcome.kind === "loaded"
    ? []
    : outcome.diagnostics.map((d) => ({ tag: d.tag, at: d.at }));
}

describe("Property 10: the Config_Loader accepts exactly the root sets passing every Filesystem_Validation", () => {
  it("returns loaded iff every root passes, with R5.5-ordered diagnostics otherwise, probing exactly the three roots in order (R5.1–R5.5, R5.7, R5.8)", () => {
    fc.assert(
      fc.property(
        validConfig(),
        proberResponses(),
        ({ scope, roots }, responses) => {
          const parsed = parseValid(scope, roots);
          const config = parsed.config;
          const rootPaths = rootPathsOf(config);

          const expected = oracleOrder(responses);
          const shouldLoad = expected.length === 0;

          const prober = recordingProber(responses, rootPaths);
          const outcome = validateDiscoveryRoots(parsed, prober.probeRoot);

          // R5.8 — probed exactly the three root paths, in microservice, common,
          // spa order, and nothing else (no package.json probe: the field carries
          // that answer). Distinct roots come from nonOverlappingRootTriple().
          expect(prober.probedPaths).toEqual([
            rootPaths.microservice,
            rootPaths.common,
            rootPaths.spa,
          ]);

          // R5.1, R5.2, R5.7 biconditional — loaded iff no validation failed.
          expect(outcome.kind === "loaded").toBe(shouldLoad);

          if (outcome.kind === "loaded") {
            // The Effective_Config is returned unchanged (roots carried through,
            // including a common/spa root that was absent — R5.2).
            expect(outcome.config).toEqual(config);
            return;
          }

          // R5.3, R5.4, R5.5 — exactly the oracle's diagnostics, in its order,
          // one per (validation, category) pair.
          expect(outcome.diagnostics.map((d) => d.tag)).toEqual(
            expected.map((e) => e.tag),
          );
          // Each Filesystem_Validation names its Consumer_Category in `at`.
          expect(outcome.diagnostics.map((d) => d.at)).toEqual(
            expected.map((e) => e.category),
          );
          // At most one diagnostic per (tag, category) pair (R5.5): the reported
          // pairs are unique.
          const pairs = outcomePairs(outcome).map((p) => `${p.tag}\u0000${p.at}`);
          expect(new Set(pairs).size).toBe(pairs.length);
          // Every diagnostic part is non-empty (R2.13).
          for (const d of outcome.diagnostics) {
            expect(d.tag.length).toBeGreaterThan(0);
            expect(d.at.length).toBeGreaterThan(0);
            expect(d.found.length).toBeGreaterThan(0);
            expect(d.reason.length).toBeGreaterThan(0);
          }
        },
      ),
    );
  });

  it("is deterministic: two runs over one response set produce byte-identical, identically-ordered diagnostics (R5.5)", () => {
    fc.assert(
      fc.property(
        validConfig(),
        proberResponses(),
        ({ scope, roots }, responses) => {
          const rootPaths = rootPathsOf(
            parseValid(scope, roots).config,
          );

          const runOnce = (): LoadOutcome => {
            const parsed = parseValid(scope, roots);
            const prober = recordingProber(responses, rootPaths);
            return validateDiscoveryRoots(parsed, prober.probeRoot);
          };

          const first = runOnce();
          const second = runOnce();
          expect(outcomeTags(second)).toEqual(outcomeTags(first));
          // Full diagnostic objects match byte-for-byte across the two runs.
          if (first.kind === "rejected" && second.kind === "rejected") {
            expect(second.diagnostics).toEqual(first.diagnostics);
          } else {
            expect(second.kind).toBe(first.kind);
          }
        },
      ),
    );
  });

  it("drives the same outcome through loadProjectConfig with an injected reader (R5.6, R5.8)", () => {
    fc.assert(
      fc.property(
        validConfig(),
        proberResponses(),
        ({ scope, roots }, responses) => {
          const config: EffectiveConfig = {
            scope,
            roots: { microservice: roots[0], common: roots[1], spa: roots[2] },
            entry: ENTRY_ROOT,
          };
          const text = serializeProjectConfig(config);
          const rootPaths = rootPathsOf(config);

          // A reader that returns the valid config text; the parser accepts it,
          // so the load reaches the Filesystem_Validation stage (R5.6).
          const read: ConfigFileRead = { kind: "text", text };
          const prober = recordingProber(responses, rootPaths);

          const viaLoad = loadProjectConfig(
            () => read,
            prober.probeRoot,
            "scaffold.config.json",
          );

          // Same outcome as calling validateDiscoveryRoots directly.
          const expected = oracleOrder(responses);
          expect(viaLoad.kind === "loaded").toBe(expected.length === 0);
          if (viaLoad.kind === "rejected") {
            expect(viaLoad.diagnostics.map((d) => d.tag)).toEqual(
              expected.map((e) => e.tag),
            );
          }
          // R5.8 again through the whole load path.
          expect(prober.probedPaths).toEqual([
            rootPaths.microservice,
            rootPaths.common,
            rootPaths.spa,
          ]);
        },
      ),
    );
  });

  // ---- Concrete worked cases pinning the criteria individually -------------

  const concreteConfig = (): ParsedConfig =>
    parseValid("@acme", ["svc/mods", "lib/shared", "web/apps"] as const);

  const probeAll = (responses: ProberResponses): LoadOutcome => {
    const parsed = concreteConfig();
    const prober = recordingProber(responses, rootPathsOf(parsed.config));
    return validateDiscoveryRoots(parsed, prober.probeRoot);
  };

  it("R5.1/R5.2: an absent microservice root fails, an absent common/spa root does not", () => {
    // All absent: only the microservice root produces a diagnostic.
    const outcome = probeAll({
      microservice: { kind: "absent" },
      common: { kind: "absent" },
      spa: { kind: "absent" },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.diagnostics.map((d) => d.tag)).toEqual([
        "config:root-missing",
      ]);
      expect(outcome.diagnostics[0]?.at).toBe("microservice");
    }
  });

  it("R5.2: absent common and spa with a present microservice directory loads", () => {
    const outcome = probeAll({
      microservice: { kind: "directory", holdsPackageJsonFile: false },
      common: { kind: "absent" },
      spa: { kind: "absent" },
    });
    expect(outcome.kind).toBe("loaded");
  });

  it("R5.3: a non-directory root is rejected for every category", () => {
    const outcome = probeAll({
      microservice: { kind: "not-directory" },
      common: { kind: "not-directory" },
      spa: { kind: "not-directory" },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.diagnostics.map((d) => [d.tag, d.at])).toEqual([
        ["config:root-not-directory", "microservice"],
        ["config:root-not-directory", "common"],
        ["config:root-not-directory", "spa"],
      ]);
    }
  });

  it("R5.4: a directory holding a package.json is itself a package", () => {
    const outcome = probeAll({
      microservice: { kind: "directory", holdsPackageJsonFile: true },
      common: { kind: "directory", holdsPackageJsonFile: false },
      spa: { kind: "directory", holdsPackageJsonFile: false },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.diagnostics.map((d) => d.tag)).toEqual([
        "config:root-is-package",
      ]);
    }
  });

  it("R5.7: a probe failure yields exactly one [config:root-unreadable] for that category", () => {
    const outcome = probeAll({
      microservice: { kind: "directory", holdsPackageJsonFile: false },
      common: { kind: "failed", reason: "EACCES: permission denied" },
      spa: { kind: "directory", holdsPackageJsonFile: false },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.diagnostics.map((d) => [d.tag, d.at])).toEqual([
        ["config:root-unreadable", "common"],
      ]);
      expect(outcome.diagnostics[0]?.found).toBe("EACCES: permission denied");
    }
  });

  it("R5.5: a mixed run orders diagnostics by category rank then tag", () => {
    // microservice: not-directory; common: is-package; spa: unreadable.
    const outcome = probeAll({
      microservice: { kind: "not-directory" },
      common: { kind: "directory", holdsPackageJsonFile: true },
      spa: { kind: "failed", reason: "boom" },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.diagnostics.map((d) => [d.tag, d.at])).toEqual([
        ["config:root-not-directory", "microservice"],
        ["config:root-is-package", "common"],
        ["config:root-unreadable", "spa"],
      ]);
    }
  });
});

// Shared fast-check arbitraries for the Filesystem_Validation property suite
// (Property 10 / Requirement 14.14, Requirement 5).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it. It
// lives under `tests/arbitraries/` alongside the config generators; the point of
// putting them in one place is that a property drawing prober responses genuinely
// draws from one shared generator.
//
// The generators here are aligned with the `RootProbe` / `ProbeRoot` shapes in
// `packages/build-tools/src/config-loader.ts`. One `RootProbe` answers every
// Filesystem_Validation of Requirement 5 for one root — including the
// `package.json` question via `holdsPackageJsonFile` — so a recording prober need
// only record the one root path it is called with (Requirement 5.8): there is no
// second probe of the `package.json` entry to record.

import * as fc from "fast-check";

import {
  CONSUMER_CATEGORIES,
  type ConsumerCategory,
} from "../../src/framework.js";
import type { ProbeRoot, RootProbe } from "../../src/config-loader.js";

/**
 * A drawn prober response per Consumer_Category, in the same key set as an
 * Effective_Config's `roots`. Each value is one of the `RootProbe` shapes the
 * design's Property 10 names: absent, a directory (holding a `package.json`
 * regular file directly inside it or not), an entry resolving to a non-directory,
 * or a probe failure.
 */
export type ProberResponses = Readonly<Record<ConsumerCategory, RootProbe>>;

/**
 * A `RootProbe` drawn from the five shapes of Property 10:
 *
 * - `absent` — no entry, or a link whose target is absent (R5.1, R5.2);
 * - `directory` with `holdsPackageJsonFile: false` — a plain directory (accepted);
 * - `directory` with `holdsPackageJsonFile: true` — a directory that is itself a
 *   package (R5.4);
 * - `not-directory` — an entry resolving to a non-directory (R5.3);
 * - `failed` — a probe failure other than absence (R5.7).
 *
 * The `failed` reason is drawn non-empty so a constructed `[config:root-unreadable]`
 * diagnostic never violates the non-empty-parts invariant (R2.13).
 */
export function rootProbe(): fc.Arbitrary<RootProbe> {
  return fc.oneof(
    fc.constant<RootProbe>({ kind: "absent" }),
    fc.constant<RootProbe>({ kind: "not-directory" }),
    fc.constant<RootProbe>({ kind: "directory", holdsPackageJsonFile: false }),
    fc.constant<RootProbe>({ kind: "directory", holdsPackageJsonFile: true }),
    fc
      .string({ minLength: 1, maxLength: 24 })
      .map<RootProbe>((reason) => ({ kind: "failed", reason })),
  );
}

/**
 * One prober response per Consumer_Category, each independently drawn from
 * {@link rootProbe}. Every combination of the five shapes across the three
 * categories is reachable, so the property exercises absent-microservice
 * failures (R5.1), absent common/spa non-failures (R5.2), non-directory roots
 * (R5.3), root-is-package (R5.4), probe failures (R5.7), and every mixture that
 * decides the ordering of a multi-diagnostic run (R5.5).
 */
export function proberResponses(): fc.Arbitrary<ProberResponses> {
  return fc.record({
    microservice: rootProbe(),
    common: rootProbe(),
    spa: rootProbe(),
  });
}

/** A `ProbeRoot` that records every path it is asked to probe, in call order,
 *  alongside the mapping from a root path to the response it answers. */
export interface RecordingProber {
  /** The injected prober to hand to `validateDiscoveryRoots` / `loadProjectConfig`. */
  readonly probeRoot: ProbeRoot;
  /** The root paths probed, in the order they were probed (R5.8 assertion). */
  readonly probedPaths: readonly string[];
}

/**
 * Builds a recording {@link ProbeRoot} from drawn per-category responses and the
 * Effective_Config's three root paths.
 *
 * The prober answers by matching the path it is called with against the three
 * root paths (microservice, then common, then spa). It records every path it is
 * called with — including a path outside the three roots — so the property can
 * assert the prober was called with exactly the three root paths, in
 * microservice, common, spa order, and nothing else (R5.8). A path matching none
 * of the three roots throws, because the loader must never probe such a path;
 * the throw surfaces that violation loudly rather than silently returning a
 * plausible response.
 *
 * @param responses the drawn `RootProbe` per Consumer_Category.
 * @param rootPaths the Effective_Config's root path per Consumer_Category.
 */
export function recordingProber(
  responses: ProberResponses,
  rootPaths: Readonly<Record<ConsumerCategory, string>>,
): RecordingProber {
  const probedPaths: string[] = [];
  const byPath = new Map<string, RootProbe>();
  for (const category of CONSUMER_CATEGORIES) {
    byPath.set(rootPaths[category], responses[category]);
  }

  const probeRoot: ProbeRoot = (rootPath) => {
    probedPaths.push(rootPath);
    const response = byPath.get(rootPath);
    if (response === undefined) {
      throw new Error(
        `recording prober was asked to probe '${rootPath}', which is not one of the three Discovery_Roots (R5.8)`,
      );
    }
    return response;
  };

  return { probeRoot, probedPaths };
}

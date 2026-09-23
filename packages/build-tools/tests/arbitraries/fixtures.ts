// Shared fast-check arbitraries for this package's Fixture_Tier property suites
// (Fixture_Tier spec, task 4.1; R16.3, R16.7, R16.11).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it. It
// lives under `tests/arbitraries/` alongside `config.ts` and `tree.ts`, the same
// convention the rest of this package's generators follow: the generators only
// THIS package's suites draw on live here, imported by relative path within
// `packages/build-tools/` only.
//
// The generators two PACKAGES need do NOT live here — they live in
// `packages/build-tools/src/testing/`, compile to `dist/testing/`, and cross the
// package boundary by compiled path (design "Arbitraries, and where they live").
// The Diagnostic_Tag generator, the qualifier generator, and the
// behaviour-preserving perturbation generator are three such shared generators:
// the integration-tests Property 2 suite (task 4.4) draws on the perturbation
// generator, and this package's Property 6 suite (task 4.5) draws on the tag and
// qualifier generators. This module RE-EXPORTS the two Property 6 needs so the
// build-tools naming suite has a single package-local import surface, and BINDS
// the perturbation generator to this package's own Discovery_Root reassignment
// generator so a consumer here needs no second argument.
//
// This module lives under `tests/`, not under `packages/build-tools/src/`, so
// the R1.7 prohibition on a `fixtures` path literal does not govern it (R1.7
// governs `src/`). It spells none nonetheless — it composes only generators.

import type * as fc from "fast-check";

import {
  arbBehaviourPreservingPerturbation,
  type BehaviourPreservingPerturbation,
} from "@microservices/build-tools/dist/testing/index.js";

import { discoveryRootReassignment } from "./config.js";

// Re-export the two shared generators this package's Property 6 (scenario-naming)
// suite draws on, so that suite imports them from this one package-local module
// alongside the rest of its arbitraries rather than reaching across two import
// styles. Their single definition remains in `src/testing/scenario-arbitraries.ts`.
export {
  arbDiagnosticTag,
  arbScenarioQualifier,
} from "@microservices/build-tools/dist/testing/index.js";

/**
 * A behaviour-preserving perturbation (R16.3), pre-bound to this package's own
 * Discovery_Root reassignment generator ({@link discoveryRootReassignment} in
 * `config.ts`) as the `relocate-roots` kind's target-roots source.
 *
 * The shared generator in `src/testing/` takes the root generator as a parameter
 * precisely so it spells no root literal (R16.11); this wrapper supplies the one
 * `config.ts` already owns, so a consuming suite in this package draws a whole
 * perturbation with no argument and still spells no root literal of its own.
 */
export function arbPerturbation(): fc.Arbitrary<BehaviourPreservingPerturbation> {
  return arbBehaviourPreservingPerturbation(discoveryRootReassignment());
}

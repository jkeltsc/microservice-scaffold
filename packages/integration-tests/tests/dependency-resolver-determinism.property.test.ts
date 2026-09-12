// Task 12.2 — The Dependency_Resolver determinism property test.
//
// Property 7 says the Dependency_Resolver is a pure function of its inputs: for
// one unchanged Selector over one unchanged repository, every run returns the
// SAME Required_Dependencies list and the SAME Staged_Dependencies list, element
// for element in the same order. Nothing about the result may depend on run
// count, iteration order of a Map or Set, or any other incidental ordering that
// a naive implementation might leak.
//
// The resolver under test is `packages/build-tools/src/required-dependencies.ts`
// (`resolveDependencySets`), reached here through the real-filesystem shell
// `buildPlan` in `build-plan.ts`, which discovers the committed tree once per
// call and returns the two lists as `requiredDependencies` and
// `stagedDependencies`. Deep-importing the compiled module from
// `@microservices/build-tools/dist/...` is the same access pattern the sibling
// suites use (e.g. `baseline-equivalence.test.ts` imports
// `@microservices/build-tools/dist/image-tree.js` and
// `.../dist/generate-registry.js`).
//
// `buildPlan(selector)` reads the repo-relative filesystem (discovery walks
// `packages/`), so the suite pins cwd to the repo root for the duration and
// restores it afterward, exactly as `baseline-equivalence.test.ts` and
// `shared-package-staging.test.ts` do. It also reads no `process.env`
// (the selector is passed explicitly), so no env save/restore is needed.
//
// The generator draws selectors from the REAL discovered microservice
// identifiers — `*`, each single identifier, and comma-joined non-empty subsets
// (in shuffled order, to exercise ordering) — so `resolveSelected` always
// succeeds and the property never trips on an unrelated `[selector:*]` error.
// Repeat counts run 2..20; the resolver is pure and in-memory (no build), so
// even the top of that range stays fast.
//
// Validates: Requirements 5.10

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { buildPlan } from "@microservices/build-tools/dist/build-plan.js";
import { discoverPackages } from "@microservices/build-tools/dist/discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The real discovered microservice identifiers, in discovery order. Read once,
 * from the committed tree, so the generator quantifies over exactly the
 * selectors `resolveSelected` accepts.
 */
const MICROSERVICE_IDENTIFIERS: readonly string[] =
  discoverPackages().byCategory.microservice.map((pkg) => pkg.dirName);

/**
 * A stable, element-identical fingerprint of a Consumer_Package list: its
 * repo-relative package directories, in list order. `packageDir` is unique per
 * package and preserves order, so two runs are "element-identical, in the same
 * order" exactly when their fingerprints are deep-equal.
 */
function fingerprint(
  list: readonly { readonly packageDir: string }[],
): readonly string[] {
  return list.map((pkg) => pkg.packageDir);
}

/**
 * Selectors drawn from the real microservice identifiers: `*`, every single
 * identifier, and every comma-joined non-empty subset in a shuffled order. Each
 * one resolves successfully, so the property observes determinism rather than a
 * selection error.
 */
const arbSelector: fc.Arbitrary<string> = fc.oneof(
  fc.constant("*"),
  fc.constantFrom(...MICROSERVICE_IDENTIFIERS),
  fc
    .subarray([...MICROSERVICE_IDENTIFIERS], { minLength: 1 })
    .chain((subset) =>
      fc.shuffledSubarray(subset, { minLength: subset.length }),
    )
    .map((ordered) => ordered.join(",")),
);

describe("Dependency_Resolver determinism (R5.10, Property 7)", () => {
  let previousCwd: string;

  beforeAll(() => {
    previousCwd = process.cwd();
    process.chdir(repoRoot);
  });

  afterAll(() => {
    process.chdir(previousCwd);
  });

  it("has at least one microservice to draw selectors from", () => {
    expect(MICROSERVICE_IDENTIFIERS.length).toBeGreaterThan(0);
  });

  // Feature: scaffold-demo-samples, Property 7: The Dependency_Resolver is deterministic for an unchanged selector
  it("returns element-identical Required_Dependencies and Staged_Dependencies across repeated runs for an unchanged selector", () => {
    fc.assert(
      fc.property(
        arbSelector,
        fc.integer({ min: 2, max: 20 }),
        (selector, repeats) => {
          const first = buildPlan(selector);
          const firstRequired = fingerprint(first.requiredDependencies);
          const firstStaged = fingerprint(first.stagedDependencies);

          for (let run = 1; run < repeats; run++) {
            const next = buildPlan(selector);
            expect(fingerprint(next.requiredDependencies)).toEqual(
              firstRequired,
            );
            expect(fingerprint(next.stagedDependencies)).toEqual(firstStaged);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

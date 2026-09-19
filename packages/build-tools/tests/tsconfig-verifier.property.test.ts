// Feature: config-driven-discovery, Property 15: The Tsconfig_Verifier accepts
// exactly the configurations satisfying the four settings.
//
// For any assignment of resolved values to the four Load_Bearing_Settings —
// `composite` and `declaration` each `true`, `false`, or unset, and
// `outDir`/`rootDir` each the package's own `dist`/`src` directory, a
// differently-spelled path resolving to that same directory, a path resolving
// elsewhere, or unset — the Tsconfig_Verifier reports no violation iff every
// JUDGED value satisfies its required value, reports exactly one violation per
// unsatisfied judged setting naming the package directory and the setting,
// reports exactly one violation and no per-setting violation when the
// configuration is absent or cannot be resolved, and returns its violations
// ordered by ascending code-point comparison of package directory and then of
// setting name.
//
// The set of JUDGED settings is parameterized by whether the verified package is
// a Non_Shipping_Singleton (a Framework_Singleton whose `staging === "none"`:
// `build-tools`, `integration-tests`). For such a package only `composite` and
// `declaration` are judged and any `outDir`/`rootDir` assignment is disregarded;
// for every other verified package all four are judged (R9.1, R9.8, R9.13,
// R14.8).
//
// The verifier's resolution mechanism is injected, so this suite supplies
// resolved values directly (R14.8) with no filesystem: a per-package resolver
// keyed by package directory returns the generated case. The context and
// discovery are synthesized in memory; `verifyTsconfigs` reads
// `context.framework.all`, `discovery.byCategory.microservice`, and
// `discovery.byCategory.common`, so those are all it needs.
//
// `verifyTsconfigs` resolves `outDir`/`rootDir` targets against `process.cwd()`
// (R9.4), so the generated absolute paths are built against the same directory.
//
// Validates: Requirements 9.1, 9.4, 9.5, 9.7, 9.10, 9.15, 14.8

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import type { ConsumerPackage, Discovery } from "../src/discovery.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  verifyTsconfigs,
  type LoadBearingSetting,
  type ResolveTsconfig,
  type TsconfigViolation,
} from "../src/tsconfig-verifier.js";
import { resolvedTsconfig, type TsconfigCase } from "./arbitraries/tsconfig.js";

const context = projectContext(defaultEffectiveConfig());

/** The four setting names, in the order R9.10's comparator produces. */
const SETTINGS: readonly LoadBearingSetting[] = [
  "composite",
  "declaration",
  "outDir",
  "rootDir",
];

/** The two settings judged for every verified package. */
const ALWAYS_JUDGED: readonly LoadBearingSetting[] = ["composite", "declaration"];

/** The package directories of the Non_Shipping_Singletons — the two
 *  Framework_Singletons whose `staging === "none"` (`build-tools`,
 *  `integration-tests`). Their `outDir`/`rootDir` are never judged (R9.8, R9.13). */
const NON_SHIPPING_SINGLETON_DIRS: ReadonlySet<string> = new Set(
  context.framework.all
    .filter((singleton) => singleton.staging === "none")
    .map((singleton) => singleton.packageDir),
);

/** The Load_Bearing_Settings the verifier judges for the given package: all four
 *  for a shipping package, `composite` and `declaration` alone for a
 *  Non_Shipping_Singleton (R9.1, R9.8, R9.13). */
function judgedSettings(packageDir: string): readonly LoadBearingSetting[] {
  return NON_SHIPPING_SINGLETON_DIRS.has(packageDir) ? ALWAYS_JUDGED : SETTINGS;
}

/**
 * A minimal Discovery carrying the given directory names as microservice and
 * common packages. `verifyTsconfigs` reads only `byCategory.microservice` and
 * `byCategory.common`, so the map fields are inert here.
 */
function discoveryOf(
  microservices: readonly string[],
  commons: readonly string[],
): Discovery {
  const mk = (
    category: ConsumerPackage["category"],
    root: string,
    dirName: string,
  ): ConsumerPackage => ({
    category,
    dirName,
    packageDir: `${root}/${dirName}`,
    name: `scope/${dirName}`,
    dependencySpecifiers: [],
    buildKind: "tsc-project",
  });
  return {
    byCategory: {
      microservice: microservices.map((d) =>
        mk("microservice", context.roots.microservice, d),
      ),
      common: commons.map((d) => mk("common", context.roots.common, d)),
      spa: [],
    },
    nameByDir: new Map(),
    byName: new Map(),
  };
}

/** A dirName: 1 to 10 lowercase alphanumeric characters. */
const arbDirName: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
    minLength: 1,
    maxLength: 10,
  })
  .map((chars) => chars.join(""));

/** Ascending code-point comparison, mirroring the verifier's own comparator. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

describe("Property 15: the Tsconfig_Verifier accepts exactly the satisfying configurations", () => {
  it("reports exactly the unsatisfied settings, whole-package shapes suppress per-setting checks, and the order is total", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 4 }),
            fc.uniqueArray(arbDirName, { minLength: 0, maxLength: 4 }),
          )
          .chain(([microservices, commons]) => {
            // Every verified package directory: the four Framework_Singletons,
            // plus the generated microservices and commons.
            const packageDirs = [
              ...context.framework.all.map((s) => s.packageDir),
              ...microservices.map((d) => `${context.roots.microservice}/${d}`),
              ...commons.map((d) => `${context.roots.common}/${d}`),
            ];
            // One generated case per package directory, resolved against cwd —
            // the same directory `verifyTsconfigs` resolves its targets against.
            const cases = fc.tuple(
              ...packageDirs.map((dir) =>
                resolvedTsconfig(process.cwd(), dir),
              ),
            );
            return fc.record({
              microservices: fc.constant(microservices),
              commons: fc.constant(commons),
              packageDirs: fc.constant(packageDirs),
              cases,
            });
          }),
        ({ microservices, commons, packageDirs, cases }) => {
          const caseByDir = new Map<string, TsconfigCase>(
            packageDirs.map((dir, index) => [dir, cases[index]!]),
          );

          const resolveTsconfig: ResolveTsconfig = (packageDir) => {
            const generated = caseByDir.get(packageDir);
            expect(generated, `resolver called for unverified ${packageDir}`).toBeDefined();
            return generated!.resolution;
          };

          const violations = verifyTsconfigs(
            context,
            discoveryOf(microservices, commons),
            resolveTsconfig,
          );

          // --- Per-package expectations, computed from the generated cases. ---
          for (const dir of packageDirs) {
            const generated = caseByDir.get(dir)!;
            const forDir = violations.filter((v) => v.packageDir === dir);

            if (generated.kind === "resolved") {
              // R9.5: exactly one violation per unsatisfied JUDGED setting, none
              // for a satisfied one and none for a setting not judged for this
              // package; every violation is a per-setting one. For a
              // Non_Shipping_Singleton `outDir`/`rootDir` are not judged, so an
              // unsatisfying assignment to either produces no violation.
              const unsatisfied = judgedSettings(dir).filter(
                (setting) => !generated.satisfies[setting],
              );
              const reported = forDir
                .map((v) => v.setting)
                .filter((s): s is LoadBearingSetting => s !== undefined);
              expect(new Set(reported)).toEqual(new Set(unsatisfied));
              expect(reported).toHaveLength(unsatisfied.length);
              for (const v of forDir) {
                expect(v.tag).toBe("tsconfig:setting");
                expect(v.setting).toBeDefined();
                expect(v.packageDir).toBe(dir);
              }
            } else {
              // R9.7 / R9.15: exactly one whole-package violation and NO
              // per-setting violation.
              expect(forDir).toHaveLength(1);
              const only = forDir[0]!;
              expect(only.setting).toBeUndefined();
              expect(only.tag).toBe(
                generated.kind === "absent"
                  ? "tsconfig:absent"
                  : "tsconfig:unresolvable",
              );
              expect(only.packageDir).toBe(dir);
            }
          }

          // --- No violation names a package outside the verified set. ---
          const verified = new Set(packageDirs);
          for (const v of violations) {
            expect(verified.has(v.packageDir)).toBe(true);
          }

          // --- Soundness+completeness: empty iff every package satisfies every
          // setting JUDGED for it (all four for a shipping package, composite
          // and declaration alone for a Non_Shipping_Singleton). ---
          const allSatisfied = packageDirs.every((dir) => {
            const generated = caseByDir.get(dir)!;
            return (
              generated.kind === "resolved" &&
              judgedSettings(dir).every((setting) => generated.satisfies[setting])
            );
          });
          expect(violations.length === 0).toBe(allSatisfied);

          // --- R9.10: ordered by packageDir then setting name, whole-package
          // shapes (empty sort key) sorting first. The comparator is total. ---
          const sortKey = (v: TsconfigViolation): readonly [string, string] => [
            v.packageDir,
            v.setting ?? "",
          ];
          for (let i = 1; i < violations.length; i += 1) {
            const [prevDir, prevSetting] = sortKey(violations[i - 1]!);
            const [curDir, curSetting] = sortKey(violations[i]!);
            const byDir = compareStrings(prevDir, curDir);
            const order =
              byDir !== 0 ? byDir : compareStrings(prevSetting, curSetting);
            expect(order).toBeLessThan(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

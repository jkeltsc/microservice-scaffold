// Feature: package-categories, Property 9: Category-contract validation is exact, total, and reported once
//
// For any set of discovered Consumer_Packages with arbitrary `main`, `types`,
// and `scripts.build` values, the set of packages discovery reports as
// offending equals exactly the set of Common_Packages lacking `main` or `types`
// as non-empty strings plus the set of Spa_Packages lacking a non-empty
// `scripts.build` — no Microservice_Package and no Spa_Package barrel state is
// ever reported, no offender is skipped, and every offender appears in one
// failure whose lines are sorted by directory name and are identical across
// repeated runs.
//
// The property is exercised through `discoverPackagesFrom(listContainer,
// readManifest)`, the pure core of Package_Discovery, over generated in-memory
// layouts. The category contract is validation stage 5, the *last* stage, so
// generated layouts are deliberately kept valid at stages 1–4 (manifest
// readability, declared name validity, mirroring, name uniqueness): a layout
// that trips an earlier stage would mask the contract failure this property is
// about. The generator maintains those invariants by construction — every
// discovered package has a readable manifest, EVERY discovered Consumer_Package
// (a Microservice_Package included, per R3.6/R4.5, which now routes a
// Microservice_Package through the same mirroring check rather than exempting
// it) declares exactly `@microservices/<dirName>`, no directory name collides
// with a Framework_Singleton name, and no directory name is shared by two
// members across any categories (they would mirror to the same declared name
// and fail as duplicates before the category contract is reached — which is
// why a Microservice_Package can no longer be co-located at the same directory
// name as a Common_Package the way the pre-step-7 generator arranged). The
// assertion that the observed failure carries the `[barrel:invalid]` tag rather
// than an earlier stage's tag keeps that invariant honest.
//
// The oracle (`referenceOffenders`) is written from Requirement 4 rather than
// from `discovery.ts`: it walks the generated layout itself, applies R4.1 to
// Common_Packages and R4.3 to Spa_Packages, exempts Microservice_Packages
// (R4.5), and applies no exemption of its own (R4.4). What each offender is
// reported as *missing* is checked field by field rather than against a copied
// message string, so the property constrains behavior instead of wording.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.7

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_SINGLETONS,
  NAMESPACE_CONTAINER,
  WORKSPACE_SCOPE,
  type ConsumerCategory,
} from "../src/framework.js";
import {
  discoverPackagesFrom,
  type ContainerEntry,
  type Discovery,
  type ListContainer,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";

// ---------------------------------------------------------------------------
// In-memory layout model
// ---------------------------------------------------------------------------

/** A manifest under construction: arbitrary parsed JSON, as it is on disk. */
type Manifest = Record<string, unknown>;

/** One generated Consumer_Package: where it sits and what its manifest declares. */
interface PackageSpec {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  readonly packageDir: string;
  readonly name: string;
  readonly manifest: Manifest;
}

/**
 * A generated repository layout. `absent` names the Consumer_Categories whose
 * Namespace_Container directory does not exist — only `common` and `spa`, since
 * an absent `packages/microservices/` fails discovery outright (R2.7) and would
 * mask this property's subject.
 */
interface Layout {
  readonly packages: readonly PackageSpec[];
  readonly absent: readonly ConsumerCategory[];
}

/**
 * Directory names the generator draws from. Deliberately excludes every
 * Framework_Singleton directory name (a member mirroring one would collide with
 * the framework's own name at validation stage 4). `Beta` alongside `beta`
 * exercises the ordering claim across code points, since an uppercase letter
 * sorts ahead of every lowercase one.
 */
const DIR_POOL: readonly string[] = [
  "Beta",
  "admin",
  "alpha",
  "beta",
  "config",
  "lib",
  "portal",
  "zeta",
];

/** Non-package entries a Namespace_Container may hold, none of them discoverable. */
const NOISE_ENTRIES: readonly ContainerEntry[] = [
  { name: "README.md", isDirectory: false },
  { name: ".DS_Store", isDirectory: false },
  { name: ".cache", isDirectory: true },
];

/** Ascending code-point comparison. */
function ascending(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The report order R4.7 requires: directory name, then `packageDir` as tiebreak. */
function byDirThenPackageDir(a: PackageSpec, b: PackageSpec): number {
  return (
    ascending(a.dirName, b.dirName) || ascending(a.packageDir, b.packageDir)
  );
}

// ---------------------------------------------------------------------------
// Manifest field states
// ---------------------------------------------------------------------------

/**
 * The state matrix one manifest field is varied over. Every state other than
 * `valid` is a violation of "declared as a non-empty string": `blank` because
 * whitespace-only is not a usable path or command, the rest because they are
 * absent or not strings at all.
 */
type FieldState =
  "absent" | "empty" | "blank" | "number" | "null" | "object" | "valid";

const FIELD_STATES: readonly FieldState[] = [
  "absent",
  "empty",
  "blank",
  "number",
  "null",
  "object",
  "valid",
];

/** How the `scripts` field itself is shaped, independent of its `build` entry. */
type ScriptsState =
  | { readonly kind: "absent" }
  /** `scripts` present but not an object: null, a string, a number, an array. */
  | { readonly kind: "non-object"; readonly value: unknown }
  | { readonly kind: "object"; readonly build: FieldState };

/** Set `field` on `manifest` according to `state`, or leave it undeclared. */
function applyField(
  manifest: Manifest,
  field: string,
  state: FieldState,
  validValue: string,
): void {
  switch (state) {
    case "absent":
      return;
    case "empty":
      manifest[field] = "";
      return;
    case "blank":
      manifest[field] = "   ";
      return;
    case "number":
      manifest[field] = 42;
      return;
    case "null":
      manifest[field] = null;
      return;
    case "object":
      manifest[field] = { path: validValue };
      return;
    case "valid":
      manifest[field] = validValue;
      return;
  }
}

/** Attach `scripts` to `manifest` according to `state`. */
function applyScripts(manifest: Manifest, state: ScriptsState): void {
  switch (state.kind) {
    case "absent":
      return;
    case "non-object":
      manifest.scripts = state.value;
      return;
    case "object": {
      const scripts: Manifest = { test: "vitest --run" };
      applyField(scripts, "build", state.build, "vite build");
      manifest.scripts = scripts;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbFieldState: fc.Arbitrary<FieldState> = fc.constantFrom(
  ...FIELD_STATES,
);

/** A `scripts` field that is present but is not an object. */
const arbNonObjectScripts: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant<unknown>(null),
  fc.constant<unknown>("vite build"),
  fc.constant<unknown>(7),
  fc.constant<unknown>(["vite build"]),
);

const arbScriptsState: fc.Arbitrary<ScriptsState> = fc.oneof(
  { arbitrary: fc.constant<ScriptsState>({ kind: "absent" }), weight: 1 },
  {
    arbitrary: arbNonObjectScripts.map((value): ScriptsState => ({
      kind: "non-object",
      value,
    })),
    weight: 1,
  },
  {
    arbitrary: arbFieldState.map((build): ScriptsState => ({
      kind: "object",
      build,
    })),
    weight: 4,
  },
);

/** One generated container member, before the layout invariants are applied. */
interface EntrySpec {
  readonly category: ConsumerCategory;
  readonly dirName: string;
  readonly main: FieldState;
  readonly types: FieldState;
  readonly scripts: ScriptsState;
}

const arbEntry: fc.Arbitrary<EntrySpec> = fc.record({
  category: fc.constantFrom(...CONSUMER_CATEGORIES),
  dirName: fc.constantFrom(...DIR_POOL),
  main: arbFieldState,
  types: arbFieldState,
  scripts: arbScriptsState,
});

/**
 * The declared name of a generated member. EVERY discovered Consumer_Package —
 * a Microservice_Package included — must mirror its directory to clear
 * validation stage 3 (R3.6, and R4.5 which now applies the mirroring check to a
 * Microservice_Package rather than exempting it). The pre-step-7 `svc-` prefix
 * that let a microservice keep a distinct name while sharing a directory name
 * with a library is no longer legal: a non-mirroring microservice name now
 * throws `[discovery:mirror]` at stage 3.
 */
function declaredName(_category: ConsumerCategory, dirName: string): string {
  return `${WORKSPACE_SCOPE}/${dirName}`;
}

/**
 * Turn generated entries into a layout that is valid at validation stages 1–4:
 * one member per (category, directory), and no directory name shared by any two
 * members across categories — every member now mirrors, so two members at the
 * same directory name (in whatever containers) would declare the same name and
 * fail as duplicates at stage 4, before the category contract is ever reached.
 * That is stricter than the pre-step-7 rule, which only deduplicated across the
 * mirrored (Common/Spa) categories and let a Microservice_Package share a
 * directory name with a library; under universal mirroring a microservice's
 * name mirrors too, so it must be deduplicated alongside the rest.
 */
function toPackages(entries: readonly EntrySpec[]): PackageSpec[] {
  const seen = new Set<string>();
  const mirrored = new Set<string>();
  const packages: PackageSpec[] = [];

  for (const entry of entries) {
    const key = `${entry.category}/${entry.dirName}`;
    if (seen.has(key)) continue;
    // Every category mirrors now, so every directory name must be unique
    // across the whole layout, not only across Common and Spa.
    if (mirrored.has(entry.dirName)) continue;
    mirrored.add(entry.dirName);
    seen.add(key);

    const manifest: Manifest = {
      name: declaredName(entry.category, entry.dirName),
    };
    applyField(manifest, "main", entry.main, "./dist/index.js");
    applyField(manifest, "types", entry.types, "./dist/index.d.ts");
    applyScripts(manifest, entry.scripts);

    packages.push({
      category: entry.category,
      dirName: entry.dirName,
      packageDir: `${NAMESPACE_CONTAINER[entry.category]}/${entry.dirName}`,
      name: String(manifest.name),
      manifest,
    });
  }

  return packages;
}

const arbLayout: fc.Arbitrary<Layout> = fc
  .record({
    entries: fc.array(arbEntry, { maxLength: 10 }),
    absent: fc.subarray<ConsumerCategory>(["common", "spa"]),
  })
  .map(({ entries, absent }) => ({
    packages: toPackages(entries),
    absent,
  }));

// ---------------------------------------------------------------------------
// Injected readers over a layout
// ---------------------------------------------------------------------------

function categoryOfContainer(
  containerDir: string,
): ConsumerCategory | undefined {
  return CONSUMER_CATEGORIES.find(
    (category) => NAMESPACE_CONTAINER[category] === containerDir,
  );
}

/**
 * A container lister over a layout. Members are handed back in *descending*
 * name order and interleaved with non-package noise, so any ordering in the
 * reported failure is discovery's own doing rather than the lister's.
 */
function listerFor(layout: Layout): ListContainer {
  return (containerDir) => {
    const category = categoryOfContainer(containerDir);
    if (category === undefined || layout.absent.includes(category)) {
      return undefined;
    }
    return [
      ...layout.packages
        .filter((pkg) => pkg.category === category)
        .map((pkg) => ({ name: pkg.dirName, isDirectory: true })),
      ...NOISE_ENTRIES,
    ].sort((a, b) => ascending(b.name, a.name));
  };
}

/**
 * A manifest reader over a layout. The four Framework_Singleton directories are
 * present and each declares a full barrel and a `build` script, so a framework
 * package could never be reported as a contract offender even if discovery
 * reached for its manifest — the absence of framework directories from the
 * failure is therefore evidence about location-based exclusion, and the
 * *presence* of a barrel there means a framework package is never reported for
 * lacking one either (R4.6 is Property 1's subject; this file only relies on
 * the framework never appearing here).
 */
function readerFor(layout: Layout): ReadManifest {
  const byDir = new Map<string, Manifest>(
    layout.packages.map((pkg) => [pkg.packageDir, pkg.manifest]),
  );
  for (const singleton of FRAMEWORK_SINGLETONS) {
    byDir.set(singleton.packageDir, {
      name: singleton.name,
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      scripts: { build: "tsc --build" },
    });
  }
  return (packageDir) => {
    const manifest = byDir.get(packageDir);
    return manifest === undefined
      ? { kind: "absent" }
      : { kind: "ok", manifest: manifest as PackageManifest };
  };
}

// ---------------------------------------------------------------------------
// Oracle, written from Requirement 4
// ---------------------------------------------------------------------------

/** "Declared as a non-empty string": whitespace-only does not count. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The `build` entry of a manifest's `scripts`, or `undefined` when there is none. */
function buildScriptOf(manifest: Manifest): unknown {
  const scripts: unknown = manifest.scripts;
  if (scripts === null || typeof scripts !== "object") return undefined;
  return (scripts as Record<string, unknown>).build;
}

/** What a package is expected to be reported as missing. */
interface ExpectedOffender {
  readonly pkg: PackageSpec;
  /** `main`/`types` for a Common_Package; empty for a Spa_Package. */
  readonly missingBarrelFields: readonly ("main" | "types")[];
  /** True for a Spa_Package reported for its `scripts.build`. */
  readonly missingBuildScript: boolean;
}

/**
 * The packages Requirement 4 says must be reported, in the order R4.7 requires.
 *
 * - A Common_Package offends when `main` or `types` is not a non-empty string (R4.1).
 * - A Spa_Package offends when `scripts.build` is not a non-empty string (R4.3),
 *   and its barrel state is not consulted at all (R4.2).
 * - A Microservice_Package never offends (R4.5).
 * - No package is exempt on any other ground (R4.4).
 *
 * A member of an absent Namespace_Container is never discovered and so is never
 * a candidate for validation.
 */
function referenceOffenders(layout: Layout): ExpectedOffender[] {
  return layout.packages
    .filter((pkg) => !layout.absent.includes(pkg.category))
    .flatMap((pkg): ExpectedOffender[] => {
      if (pkg.category === "common") {
        const missing = (["main", "types"] as const).filter(
          (field) => !isNonEmptyString(pkg.manifest[field]),
        );
        return missing.length === 0
          ? []
          : [
              {
                pkg,
                missingBarrelFields: missing,
                missingBuildScript: false,
              },
            ];
      }
      if (pkg.category === "spa") {
        return isNonEmptyString(buildScriptOf(pkg.manifest))
          ? []
          : [{ pkg, missingBarrelFields: [], missingBuildScript: true }];
      }
      return [];
    })
    .sort((a, b) => byDirThenPackageDir(a.pkg, b.pkg));
}

/** The packages a layout's containers actually yield, absent containers aside. */
function discoveredPackages(layout: Layout): PackageSpec[] {
  return layout.packages.filter((pkg) => !layout.absent.includes(pkg.category));
}

// ---------------------------------------------------------------------------
// Running discovery and reading its failure
// ---------------------------------------------------------------------------

type Outcome =
  | { readonly kind: "ok"; readonly discovery: Discovery }
  | { readonly kind: "failed"; readonly message: string };

function runDiscovery(layout: Layout): Outcome {
  try {
    return {
      kind: "ok",
      discovery: discoverPackagesFrom(listerFor(layout), readerFor(layout)),
    };
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return { kind: "failed", message: (error as Error).message };
  }
}

/** One reported offender line, split into the directory and the stated reason. */
interface ReportedOffender {
  readonly packageDir: string;
  readonly reason: string;
}

interface Failure {
  /** The count the headline states. */
  readonly count: number;
  readonly offenders: readonly ReportedOffender[];
}

const OFFENDER_LINE = /^ {2}"([^"]+)" — (.+)$/u;

/**
 * Parse a `[barrel:invalid]` failure: a headline stating how many offenders
 * there are, then one indented line per offender. Parsing rather than string
 * matching is what lets the assertions below talk about the reported *set*, its
 * order, and each stated reason separately.
 */
function parseFailure(message: string): Failure {
  const [headline, ...lines] = message.split("\n");
  const headlineMatch = /^\[barrel:invalid\] (\d+) /u.exec(headline ?? "");
  expect(
    headlineMatch,
    `unexpected headline: ${String(headline)}`,
  ).not.toBeNull();

  return {
    count: Number(headlineMatch?.[1]),
    offenders: lines.map((line) => {
      const match = OFFENDER_LINE.exec(line);
      expect(match, `unparsable offender line: ${line}`).not.toBeNull();
      return { packageDir: String(match?.[1]), reason: String(match?.[2]) };
    }),
  };
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("Property 9: category-contract validation is exact, total, and reported once", () => {
  it("reports exactly the Common barrel and Spa build-script offenders, once, in order", () => {
    // Both branches below carry real assertions, so the property is only as
    // strong as the coverage the generator gives it; these counters make a
    // vacuous pass (all-clean layouts, or all-offending ones) a failure.
    let clean = 0;
    let offending = 0;

    fc.assert(
      fc.property(arbLayout, (layout) => {
        const expected = referenceOffenders(layout);
        const outcome = runDiscovery(layout);

        if (expected.length === 0) {
          clean += 1;
          // Exactness in the other direction: nothing beyond the oracle's
          // offenders is treated as a violation, so a layout the oracle
          // accepts must discover every one of its members (R4.2, R4.4, R4.5).
          expect(outcome.kind === "failed" ? outcome.message : "ok").toBe("ok");
          if (outcome.kind !== "ok") return;
          const discovered = new Set(
            CONSUMER_CATEGORIES.flatMap((category) =>
              outcome.discovery.byCategory[category].map(
                (pkg) => pkg.packageDir,
              ),
            ),
          );
          expect(discovered).toEqual(
            new Set(discoveredPackages(layout).map((pkg) => pkg.packageDir)),
          );
          return;
        }

        offending += 1;
        expect(outcome.kind).toBe("failed");
        if (outcome.kind !== "failed") return;

        // The failure is the category-contract stage's, not an earlier stage's
        // — which also confirms the generated layout reached stage 5 at all.
        expect(outcome.message.startsWith("[barrel:invalid] ")).toBe(true);
        // One failure, not one per criterion and not one per category (R4.7).
        expect(outcome.message.split("[barrel:invalid]")).toHaveLength(2);

        const failure = parseFailure(outcome.message);

        // Totality: every offender the oracle names is reported, in R4.7's
        // order, and nothing else is.
        expect(
          failure.offenders.map((offender) => offender.packageDir),
        ).toEqual(expected.map((offender) => offender.pkg.packageDir));
        expect(failure.count).toBe(expected.length);
        expect(failure.offenders).toHaveLength(expected.length);

        for (const [index, offender] of failure.offenders.entries()) {
          const { pkg, missingBarrelFields, missingBuildScript } = expected[
            index
          ] as ExpectedOffender;

          // Exactness of the stated reason, field by field rather than against
          // a copied message: a Common_Package names each of `main`/`types`
          // that is missing and no field that is present (R4.1); a Spa_Package
          // names its `scripts.build` and never a barrel field (R4.2, R4.3).
          expect(offender.reason.includes('"main"')).toBe(
            missingBarrelFields.includes("main"),
          );
          expect(offender.reason.includes('"types"')).toBe(
            missingBarrelFields.includes("types"),
          );
          expect(offender.reason.includes("scripts.build")).toBe(
            missingBuildScript,
          );
          expect(pkg.category === "common" || pkg.category === "spa").toBe(
            true,
          );
        }

        // No Microservice_Package is ever an offender (R4.5), and no entry that
        // is not a discovered Consumer_Package is either.
        const reported = new Set(
          failure.offenders.map((offender) => offender.packageDir),
        );
        for (const pkg of layout.packages) {
          if (pkg.category === "microservice") {
            expect(reported.has(pkg.packageDir)).toBe(false);
          }
        }
        for (const singleton of FRAMEWORK_SINGLETONS) {
          expect(reported.has(singleton.packageDir)).toBe(false);
        }
        for (const noise of NOISE_ENTRIES) {
          for (const category of CONSUMER_CATEGORIES) {
            expect(
              reported.has(`${NAMESPACE_CONTAINER[category]}/${noise.name}`),
            ).toBe(false);
          }
        }

        // Run-stability: a second run over the same unchanged layout produces a
        // byte-identical failure (R4.7).
        const again = runDiscovery(layout);
        expect(again.kind === "failed" ? again.message : "ok").toBe(
          outcome.message,
        );
      }),
      { numRuns: 200 },
    );

    expect(clean).toBeGreaterThan(0);
    expect(offending).toBeGreaterThan(0);
  });

  it("never applies barrel validation to a Spa_Package that declares a build script", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIR_POOL),
        arbFieldState,
        arbFieldState,
        (dirName, main, types) => {
          const manifest: Manifest = {
            name: `${WORKSPACE_SCOPE}/${dirName}`,
            scripts: { build: "vite build" },
          };
          applyField(manifest, "main", main, "./dist/index.js");
          applyField(manifest, "types", types, "./dist/index.d.ts");

          const layout: Layout = {
            packages: [
              {
                category: "spa",
                dirName,
                packageDir: `${NAMESPACE_CONTAINER.spa}/${dirName}`,
                name: String(manifest.name),
                manifest,
              },
            ],
            absent: ["common"],
          };

          const outcome = runDiscovery(layout);
          expect(outcome.kind === "failed" ? outcome.message : "ok").toBe("ok");
          if (outcome.kind !== "ok") return;
          expect(
            outcome.discovery.byCategory.spa.map((pkg) => pkg.packageDir),
          ).toEqual([`${NAMESPACE_CONTAINER.spa}/${dirName}`]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never applies either check to a Microservice_Package", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIR_POOL),
        arbFieldState,
        arbFieldState,
        arbScriptsState,
        (dirName, main, types, scripts) => {
          // A Microservice_Package mirrors its directory like every other
          // discovered Consumer_Package (R3.6); it is still never held to the
          // barrel or build-script contract (R4.5), which is what this asserts.
          const manifest: Manifest = {
            name: `${WORKSPACE_SCOPE}/${dirName}`,
          };
          applyField(manifest, "main", main, "./dist/index.js");
          applyField(manifest, "types", types, "./dist/index.d.ts");
          applyScripts(manifest, scripts);

          const layout: Layout = {
            packages: [
              {
                category: "microservice",
                dirName,
                packageDir: `${NAMESPACE_CONTAINER.microservice}/${dirName}`,
                name: String(manifest.name),
                manifest,
              },
            ],
            absent: ["common", "spa"],
          };

          const outcome = runDiscovery(layout);
          expect(outcome.kind === "failed" ? outcome.message : "ok").toBe("ok");
          if (outcome.kind !== "ok") return;
          expect(
            outcome.discovery.byCategory.microservice.map(
              (pkg) => pkg.packageDir,
            ),
          ).toEqual([`${NAMESPACE_CONTAINER.microservice}/${dirName}`]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// Feature: platform-fixtures, Step 8 — the Classification_Guard (task 8.3).
//
// This suite is the guard over the committed Classification_Record at
// `packages/integration-tests/platform-test-classification.json`. It derives the
// Platform_Test_Set through the task-8.1 module (`platformTestSet` from
// `@microservices/build-tools/dist/testing/index.js`) and holds the record to the
// requirements of R12:
//
//   - Totality and single-valuedness (R12.1, R12.6): every entry declares exactly
//     one of the three Test_Class names and exactly the one per-class field its
//     class requires — `fixtureEquivalent` for a Payload_Coupled_Test,
//     `retainedReason` for a Drift_Detector, neither for a Payload_Independent_Test.
//     Single-valuedness is checked STRUCTURALLY: an entry carrying BOTH
//     `fixtureEquivalent` and `retainedReason` fails even if its `class` string is
//     one of the three.
//   - Referential integrity (R12.6): each `fixtureEquivalent` names a path that is
//     itself a member of the derived Platform_Test_Set.
//   - Both-ways completeness (R12.5): the derived set and the record's path set are
//     equal, reported in ONE failure that states the direction of every mismatch
//     (present-in-derived-absent-in-record, and vice versa) rather than
//     short-circuiting on the first offending path.
//   - Drift_Detector set EQUALITY (R12.7): the record's Drift_Detectors equal an
//     explicit list held in THIS guard's own source (the two real-tree suites).
//   - Payload_Independent import check (R12.8): for each Payload_Independent_Test,
//     the file declares NO static and NO dynamic import whose specifier is this
//     repository's Configured_Scope + "/" + a discovered Consumer_Package name.
//     BOTH halves are DERIVED — the scope from the Effective_Config, the names from
//     a Package_Discovery run — and a violation fails naming the file AND the
//     specifier.
//   - No path under a Discovery_Root (R12.4): the record names no path under any
//     configured Discovery_Root.
//   - Non-vacuity floor (R12.9): the derived set holds at least two members.
//
// The guard reads the record and the real repository (derivation, discovery,
// per-file import scan) READ-ONLY: it writes nothing.
//
// SHARED STRUCTURAL PREDICATE. Totality, single-valuedness, the per-class field
// checks, referential integrity of each `fixtureEquivalent`, and both-ways
// completeness are the STRUCTURAL half of the guard's verdict — and they are
// exactly what Property 7 (`classification-guard.property.test.ts`, task 8.4)
// quantifies over. To keep the two derivations that must agree from drifting,
// that structural predicate lives once in `classifyRecordAgainstSet`
// (`@microservices/build-tools/dist/testing`), and BOTH this guard and Property 7
// call it. This guard layers its two REAL-REPOSITORY-SPECIFIC checks — the R12.8
// payload-import scan and the R12.7 Drift_Detector set equality — on top; those
// are facts about this repository's files, not about an arbitrary record's shape,
// so they are NOT part of the shared structural predicate.
//
// Validates: Requirements 12.1, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 14.2

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  platformTestSet,
  classifyRecordAgainstSet,
  TEST_CLASSES,
  type TestClass,
} from "@microservices/build-tools/dist/testing/index.js";
import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { discoverPackages } from "@microservices/build-tools/dist/discovery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The explicit Drift_Detector set (R12.7, R14.2), held HERE in the guard's own
 * source. Retaining a further payload-asserting test as a Drift_Detector must be a
 * deliberate edit to THIS list rather than a classification chosen in passing.
 */
const DRIFT_DETECTORS: readonly string[] = [
  "packages/build-tools/tests/discovery-real-tree.test.ts",
  "packages/build-tools/tests/workspace-build-order-real-tree.test.ts",
];

/** One raw record entry, before validation. */
interface RecordEntry {
  readonly path?: unknown;
  readonly class?: unknown;
  readonly fixtureEquivalent?: unknown;
  readonly retainedReason?: unknown;
}

/** Read and parse the committed Classification_Record from the repo root. */
function readRecord(): readonly RecordEntry[] {
  const recordPath = resolve(
    repoRoot,
    "packages",
    "integration-tests",
    "platform-test-classification.json",
  );
  const parsed: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
  expect(Array.isArray(parsed), "the record is a top-level JSON array").toBe(
    true,
  );
  return parsed as readonly RecordEntry[];
}

/**
 * Whether a record entry carries a given per-class field as a declared value
 * (present, not `undefined`). STRUCTURAL — it does not consult `class`.
 */
function hasField(entry: RecordEntry, field: keyof RecordEntry): boolean {
  return Object.prototype.hasOwnProperty.call(entry, field)
    ? (entry[field] as unknown) !== undefined
    : false;
}

const record = readRecord();
const derived = platformTestSet();
const derivedSet = new Set(derived);

const context = projectContext(defaultEffectiveConfig());
const scope = defaultEffectiveConfig().scope;
const discovery = discoverPackages(context);

/** The names of every discovered Consumer_Package (microservice/common/spa). */
const consumerPackageNames: readonly string[] = [
  ...discovery.byCategory.microservice,
  ...discovery.byCategory.common,
  ...discovery.byCategory.spa,
].map((pkg) => pkg.name);

/**
 * The forbidden payload specifiers of R12.8: `<scope>/<consumerName>` for each
 * discovered Consumer_Package. The discovered `name` is already the scoped name,
 * but a Consumer_Package's declared name mirrors `<scope>/<dirName>` exactly, so
 * composing from scope + "/" + dirName yields the same specifier while keeping
 * BOTH halves derived (scope from the Effective_Config, name from discovery).
 */
const forbiddenSpecifiers: ReadonlySet<string> = new Set([
  ...consumerPackageNames,
  ...[
    ...discovery.byCategory.microservice,
    ...discovery.byCategory.common,
    ...discovery.byCategory.spa,
  ].map((pkg) => `${scope}/${pkg.dirName}`),
]);

/** The configured Discovery_Roots (microservice/common/spa). */
const discoveryRoots: readonly string[] = [
  context.roots.microservice,
  context.roots.common,
  context.roots.spa,
];

/**
 * Extract every import specifier of a TypeScript source — static
 * `import … from "<spec>"` / `export … from "<spec>"` and dynamic
 * `import("<spec>")`, both quote styles. Over-matching a specifier in a comment or
 * string is harmless: the check only fails on an exact match to a forbidden
 * payload specifier, and a payload import in live code is exactly what R12.8
 * forbids.
 */
function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const fromForm = /\bfrom\s*["']([^"']+)["']/g;
  const dynamicForm = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [fromForm, dynamicForm]) {
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

describe("Classification_Guard over the committed Classification_Record", () => {
  it("holds at least two derived Platform_Test_Set members (R12.9)", () => {
    // Non-vacuity floor: a rename that emptied the derivation must not let the
    // guard pass by classifying nothing.
    expect(
      derived.length,
      `derived Platform_Test_Set holds ${derived.length} member(s); the non-vacuity floor is 2`,
    ).toBeGreaterThanOrEqual(2);
  });

  it("accepts the committed record under the shared structural predicate (R12.5, R12.6)", () => {
    // The structural half of the verdict comes from the SAME predicate Property 7
    // exercises over generated records — `classifyRecordAgainstSet` from
    // `@microservices/build-tools/dist/testing`. Running it here over the real
    // (derived set, committed record) pair is what makes the guard and the
    // property share one predicate rather than two that could drift. An empty
    // offence list is acceptance; each offence names its offending path.
    const offences = classifyRecordAgainstSet(derived, record);
    expect(
      offences,
      offences.map((offence) => `${offence.path}: ${offence.reason}`).join("\n"),
    ).toEqual([]);
  });

  it("assigns every entry exactly one of the three Test_Classes (R12.1, R12.6)", () => {
    const offences: string[] = [];
    for (const entry of record) {
      const path = typeof entry.path === "string" ? entry.path : "<no path>";
      if (!TEST_CLASSES.includes(entry.class as TestClass)) {
        offences.push(
          `${path}: class ${JSON.stringify(entry.class)} is not one of ${TEST_CLASSES.join(", ")}`,
        );
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("carries exactly the one per-class field its class requires — structurally (R12.6)", () => {
    // Single-valuedness checked STRUCTURALLY: an entry carrying BOTH
    // `fixtureEquivalent` and `retainedReason` fails regardless of its `class`.
    const offences: string[] = [];
    for (const entry of record) {
      const path = typeof entry.path === "string" ? entry.path : "<no path>";
      const hasFixture = hasField(entry, "fixtureEquivalent");
      const hasReason = hasField(entry, "retainedReason");

      if (hasFixture && hasReason) {
        offences.push(
          `${path}: carries BOTH fixtureEquivalent and retainedReason (single-valuedness)`,
        );
        continue;
      }

      switch (entry.class as TestClass) {
        case "Payload_Coupled_Test":
          if (!hasFixture)
            offences.push(`${path}: Payload_Coupled_Test with no fixtureEquivalent`);
          if (hasReason)
            offences.push(`${path}: Payload_Coupled_Test carries retainedReason`);
          if (hasFixture && typeof entry.fixtureEquivalent !== "string")
            offences.push(`${path}: fixtureEquivalent is not a string`);
          break;
        case "Drift_Detector":
          if (!hasReason)
            offences.push(`${path}: Drift_Detector with no retainedReason`);
          if (hasFixture)
            offences.push(`${path}: Drift_Detector carries fixtureEquivalent`);
          if (hasReason && typeof entry.retainedReason !== "string")
            offences.push(`${path}: retainedReason is not a string`);
          break;
        case "Payload_Independent_Test":
          if (hasFixture)
            offences.push(`${path}: Payload_Independent_Test carries fixtureEquivalent`);
          if (hasReason)
            offences.push(`${path}: Payload_Independent_Test carries retainedReason`);
          break;
        default:
          // Wrong-class entries are reported by the totality test above.
          break;
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("names an in-set fixtureEquivalent for every Payload_Coupled_Test (R12.6)", () => {
    const offences: string[] = [];
    for (const entry of record) {
      if (entry.class !== "Payload_Coupled_Test") continue;
      const path = typeof entry.path === "string" ? entry.path : "<no path>";
      const fixture = entry.fixtureEquivalent;
      if (typeof fixture !== "string") continue; // structural test covers this
      if (!derivedSet.has(fixture)) {
        offences.push(
          `${path}: fixtureEquivalent "${fixture}" is not a member of the derived Platform_Test_Set`,
        );
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("agrees both ways with the derived Platform_Test_Set, reported in one failure (R12.5)", () => {
    // Collect BOTH directions before asserting, so neither expect short-circuits
    // the other; report the direction of every mismatch.
    const recordPaths = new Set(
      record
        .map((entry) => entry.path)
        .filter((p): p is string => typeof p === "string"),
    );

    const presentInDerivedAbsentInRecord = derived
      .filter((path) => !recordPaths.has(path))
      .sort();
    const presentInRecordAbsentInDerived = [...recordPaths]
      .filter((path) => !derivedSet.has(path))
      .sort();

    const report = [
      ...presentInDerivedAbsentInRecord.map(
        (path) => `present-in-derived-absent-in-record: ${path}`,
      ),
      ...presentInRecordAbsentInDerived.map(
        (path) => `present-in-record-absent-in-derived: ${path}`,
      ),
    ].join("\n");

    expect(
      {
        presentInDerivedAbsentInRecord,
        presentInRecordAbsentInDerived,
      },
      report,
    ).toEqual({
      presentInDerivedAbsentInRecord: [],
      presentInRecordAbsentInDerived: [],
    });
  });

  it("holds a Drift_Detector set equal to the guard's explicit list (R12.7, R14.2)", () => {
    const recordedDriftDetectors = record
      .filter((entry) => entry.class === "Drift_Detector")
      .map((entry) => entry.path)
      .filter((p): p is string => typeof p === "string")
      .sort();
    const expected = [...DRIFT_DETECTORS].sort();
    expect(recordedDriftDetectors).toEqual(expected);
  });

  it("names no path under any configured Discovery_Root (R12.4)", () => {
    const offences: string[] = [];
    for (const entry of record) {
      if (typeof entry.path !== "string") continue;
      for (const root of discoveryRoots) {
        if (entry.path.startsWith(`${root}/`)) {
          offences.push(`${entry.path}: lies under Discovery_Root ${root}`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });

  it("declares no payload import in any Payload_Independent_Test (R12.8)", () => {
    // The forbidden set is non-empty only if discovery found Consumer_Packages;
    // guard the meaningfulness of this check.
    expect(
      forbiddenSpecifiers.size,
      "discovery found no Consumer_Packages, so the payload-import check is vacuous",
    ).toBeGreaterThan(0);

    const offences: string[] = [];
    for (const entry of record) {
      if (entry.class !== "Payload_Independent_Test") continue;
      if (typeof entry.path !== "string") continue;
      const source = readFileSync(resolve(repoRoot, entry.path), "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (forbiddenSpecifiers.has(specifier)) {
          offences.push(`${entry.path}: imports payload specifier "${specifier}"`);
        }
      }
    }
    expect(offences, offences.join("\n")).toEqual([]);
  });
});

// @microservices/build-tools/dist/testing — the shared Classification_Record
// STRUCTURAL VALIDATOR (platform-tier spec, task 8.4; R12.5, R12.6, R16.8).
//
// ONE PREDICATE, TWO CONSUMERS
// ---------------------------------------------------------------------------
// Two callers evaluate "does this Classification_Record classify this
// Platform_Test_Set correctly?" and must agree:
//
//   - the Classification_Guard (`platform-test-classification.test.ts`, task 8.3)
//     asserts the STRUCTURAL half of that verdict over the REAL committed record
//     and the REAL derived Platform_Test_Set; and
//   - Property 7 (`classification-guard.property.test.ts`, task 8.4) asserts the
//     accept-iff-well-formed verdict over GENERATED (path-list, record) pairs.
//
// The two derivations were meant to agree, so the acceptance predicate lives
// here once and both import it by compiled path from
// `@microservices/build-tools/dist/testing/index.js`. Both consumers live in
// `packages/integration-tests`, but the design's cross-package rule sends a
// shared predicate through `src/testing/` rather than a package-private
// `tests/`.
//
// THE STRUCTURAL ACCEPTANCE CRITERION (Property 7; R12.5, R12.6)
// ---------------------------------------------------------------------------
// This module computes exactly the STRUCTURAL predicate Property 7 quantifies
// over. A record is accepted (the returned offence list is empty) if and only if,
// against a given path list:
//
//   1. TOTALITY — the record's path set equals the given list exactly: every
//      listed path is classified, and no entry names a path outside the list.
//   2. SINGLE-VALUEDNESS — every entry declares exactly one of the three
//      Test_Class names, and carries exactly the one per-class field its class
//      requires. Single-valuedness is STRUCTURAL: an entry carrying BOTH
//      `fixtureEquivalent` and `retainedReason` is rejected regardless of its
//      `class` string.
//   3. FIXTURE-COMPLETENESS — every Payload_Coupled_Test entry names a
//      `fixtureEquivalent` that is itself a member of the given list, and every
//      Drift_Detector entry names a `retainedReason`.
//
// This is NARROWER than the full Classification_Guard (task 8.3), and
// deliberately so. The guard additionally enforces two REAL-REPOSITORY-SPECIFIC
// checks Property 7 does NOT quantify over — the R12.8 payload-import scan (no
// Payload_Independent_Test imports a discovered Consumer_Package) and the R12.7
// Drift_Detector set EQUALITY against an explicit list — because both are facts
// about THIS repository's files, not about the structural shape of an arbitrary
// record. Property 7's acceptance criterion, as the design states it, is the
// structural predicate alone; so this validator computes the structural predicate
// alone, and the guard layers its two repo-specific checks on top.
//
// R1.7 / [scope:literal]. This module lives under `packages/build-tools/src/`.
// It spells no Fixture_Tier path token and no Scope_Default scope literal: it is
// pure over its two arguments and reaches no filesystem and no scope. (The raw
// R1.7 scan is a token match, so this comment names neither token contiguously.)

/** The three exact Test_Class strings (Glossary). Spelled here as the single
 *  source both consumers share, so the guard and the property never drift on the
 *  spelling of the class names. */
export const TEST_CLASSES = [
  "Payload_Coupled_Test",
  "Drift_Detector",
  "Payload_Independent_Test",
] as const;

/** One of the three Test_Class names. */
export type TestClass = (typeof TEST_CLASSES)[number];

/**
 * One candidate record entry, before validation. Every field is `unknown` so a
 * malformed entry — a missing `class`, a non-string `class`, a `fixtureEquivalent`
 * that is not a string — is data the validator inspects rather than a type error
 * that could never be generated. The property generates entries of exactly this
 * shape, malformations included.
 */
export interface ClassificationEntry {
  readonly path?: unknown;
  readonly class?: unknown;
  readonly fixtureEquivalent?: unknown;
  readonly retainedReason?: unknown;
}

/**
 * One structural offence the validator found. `path` names the offending path
 * (Property 7 asserts every rejection names it); `reason` states which of the
 * three checks failed, for a legible failure message. An offence whose subject is
 * a path outside the list still carries that path in `path`.
 */
export interface ClassificationOffence {
  /** The offending path. `<no path>` when the entry declared no string `path`
   *  (itself an offence — an entry with no path cannot be classified). */
  readonly path: string;
  /** A human-legible statement of what was wrong, for the failure message. */
  readonly reason: string;
}

/**
 * Whether an entry carries a given per-class field as a DECLARED value (present
 * as an own property and not `undefined`). STRUCTURAL — it does not consult
 * `class`. This is what makes single-valuedness structural: an entry carrying
 * both `fixtureEquivalent` and `retainedReason` "has" both fields here regardless
 * of what its `class` says.
 */
function hasField(
  entry: ClassificationEntry,
  field: keyof ClassificationEntry,
): boolean {
  return Object.prototype.hasOwnProperty.call(entry, field)
    ? (entry[field] as unknown) !== undefined
    : false;
}

/**
 * The pure structural validator: given the Platform_Test_Set-shaped path list and
 * a candidate record over it, return every structural offence, naming the
 * offending path for each. An EMPTY list means ACCEPT.
 *
 * ACCEPT if and only if (Property 7):
 *   - every path in `pathList` appears in the record exactly once, classified;
 *   - the record names no path outside `pathList`;
 *   - every entry declares exactly one of the three Test_Classes and exactly the
 *     one per-class field its class requires (structural single-valuedness);
 *   - every Payload_Coupled_Test names a `fixtureEquivalent` that is a member of
 *     `pathList`, and every Drift_Detector names a `retainedReason`.
 *
 * The validator collects EVERY offence rather than short-circuiting, so a caller
 * can report them all; Property 7 only needs the accept/reject verdict and that
 * each reported offence names its path, both of which this satisfies.
 *
 * @param pathList the Platform_Test_Set-shaped list of repo-relative paths.
 * @param record the candidate Classification_Record to validate against it.
 */
export function classifyRecordAgainstSet(
  pathList: readonly string[],
  record: readonly ClassificationEntry[],
): readonly ClassificationOffence[] {
  const offences: ClassificationOffence[] = [];
  const listSet = new Set(pathList);

  // The record's own path set, and a per-path count so a duplicate entry is a
  // single-valuedness offence (a path classified twice is not classified "exactly
  // once").
  const recordPathCounts = new Map<string, number>();
  for (const entry of record) {
    if (typeof entry.path !== "string") continue;
    recordPathCounts.set(entry.path, (recordPathCounts.get(entry.path) ?? 0) + 1);
  }

  // ── Per-entry checks: class validity, single-valuedness, per-class fields,
  //    referential integrity, and membership in the list. ──────────────────────
  for (const entry of record) {
    const path = typeof entry.path === "string" ? entry.path : "<no path>";

    if (typeof entry.path !== "string") {
      offences.push({ path, reason: "entry declares no string path" });
      continue;
    }

    // A path outside the list is an offence (totality: names no path outside).
    if (!listSet.has(entry.path)) {
      offences.push({
        path,
        reason: "entry names a path outside the Platform_Test_Set",
      });
    }

    // A path classified more than once fails single-valuedness. Report once,
    // against the first sighting, so the count check does not fire per duplicate.
    const count = recordPathCounts.get(entry.path) ?? 0;
    if (count > 1) {
      offences.push({
        path,
        reason: `path is classified ${count} times (not exactly once)`,
      });
      // Only report the duplicate once.
      recordPathCounts.set(entry.path, 0);
    }

    const isKnownClass = TEST_CLASSES.includes(entry.class as TestClass);
    if (!isKnownClass) {
      offences.push({
        path,
        reason: `class ${JSON.stringify(entry.class)} is not one of ${TEST_CLASSES.join(", ")}`,
      });
    }

    const hasFixture = hasField(entry, "fixtureEquivalent");
    const hasReason = hasField(entry, "retainedReason");

    // Structural single-valuedness: carrying BOTH per-class fields is a
    // two-classes-at-once offence regardless of the `class` string.
    if (hasFixture && hasReason) {
      offences.push({
        path,
        reason: "entry carries both fixtureEquivalent and retainedReason (single-valuedness)",
      });
      // The both-fields offence subsumes the per-class field checks below; skip
      // them so a single mistake yields a single, legible offence.
      continue;
    }

    switch (entry.class as TestClass) {
      case "Payload_Coupled_Test":
        if (!hasFixture) {
          offences.push({
            path,
            reason: "Payload_Coupled_Test names no fixtureEquivalent",
          });
        } else if (typeof entry.fixtureEquivalent !== "string") {
          offences.push({ path, reason: "fixtureEquivalent is not a string" });
        } else if (!listSet.has(entry.fixtureEquivalent)) {
          offences.push({
            path,
            reason: `fixtureEquivalent "${entry.fixtureEquivalent}" is not a member of the Platform_Test_Set`,
          });
        }
        break;
      case "Drift_Detector":
        if (!hasReason) {
          offences.push({
            path,
            reason: "Drift_Detector names no retainedReason",
          });
        } else if (typeof entry.retainedReason !== "string") {
          offences.push({ path, reason: "retainedReason is not a string" });
        }
        break;
      case "Payload_Independent_Test":
        // A Payload_Independent_Test carries NEITHER per-class field.
        if (hasFixture) {
          offences.push({
            path,
            reason: "Payload_Independent_Test carries fixtureEquivalent",
          });
        }
        if (hasReason) {
          offences.push({
            path,
            reason: "Payload_Independent_Test carries retainedReason",
          });
        }
        break;
      default:
        // Wrong-class entries are already reported by the class-validity check.
        break;
    }
  }

  // ── Totality, the other direction: every listed path is classified. ─────────
  for (const listedPath of pathList) {
    if (!recordPathCounts.has(listedPath)) {
      offences.push({
        path: listedPath,
        reason: "listed path is absent from the record (not classified)",
      });
    }
  }

  return offences;
}

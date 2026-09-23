// Feature: platform-fixtures, Step 6 — the Diagnostic_Coverage_Record guard
// (task 6.3).
//
// The Diagnostic_Coverage_Record at `fixtures/diagnostic-coverage.json` lists
// every Diagnostic_Tag the Build_System emits and, for each, either the
// Fixture_Scenario(s) that provoke it or the recorded reason it is not an
// Expressible_Tag. This guard holds that record honest against the code and the
// tier, so a diagnostic added without a subject is a NAMED failure rather than
// an untested branch. It asserts:
//
//   (R5.2) The derived emitted-tag set — from `emittedDiagnosticTags()`, the
//     two-recogniser scan of `packages/build-tools/src/` (task 6.1) — equals the
//     record's key set, failing by NAMING every tag present in one and absent
//     from the other, BOTH directions.
//
//   (R5.3) Every Scenario_Directory_Name the record names exists as a scenario
//     directory under `fixtures/trees/` or `fixtures/projects/`, and every
//     Fixture_Scenario directory (all of them) is named by the record. Failure
//     names the offender.
//
//   (R5.4) Every inexpressible entry's reason-kind is one of the TWO permitted
//     kinds — a permission/unreadable filesystem state, or a tag not
//     fixture-provokable by construction (a self-consistency assertion over the
//     Build_System's own output, an unreachable internal invariant guard, or a
//     runtime status line sharing the Diagnostic_Tag shape). Any other reason
//     kind is rejected, so a future fake reason fails, failing by NAMING the tag
//     and the rejected kind.
//
//   (R5.5) A tag whose record entry names a scenario is treated as covered only
//     when that scenario's R4.6 minimality assertion is present. The per-scenario
//     spawn suites (`fixture-scenario-diagnostics.test.ts`, task 4.3, and the
//     Project_Fixture equivalents) assert "present AND passing" mechanically by
//     spawning the entry point; here the STRUCTURAL backing is asserted — the
//     covering scenario has a `fixture.json` whose `expectedDiagnostic` equals
//     the tag, and its Scenario_Directory_Name recovers that same tag through the
//     shared derivation (task 3.5) — which is precisely what those suites key
//     their per-scenario assertion on. A record entry therefore cannot claim
//     coverage no scenario structurally backs.
//
// The tag derivation is imported from `./diagnostic-tags.js` and the recovery
// derivation from the shared `@microservices/build-tools/dist/testing/` module
// (task 3.5), never a local copy. The Fixture_Tier paths come from
// `./fixture-paths.js`. This suite lives under `packages/integration-tests/tests/`,
// so naming a `fixtures/` path through those shared constants is allowed (R1.7
// forbids a `fixtures` literal only in Build_System SOURCE).
//
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { expectedDiagnosticOf } from "@microservices/build-tools/dist/testing/index.js";

import { emittedDiagnosticTags } from "./diagnostic-tags.js";
import {
  FIXTURES_ROOT,
  FIXTURE_TREES_ROOT,
  FIXTURE_PROJECTS_ROOT,
} from "./fixture-paths.js";

// --- The record's shape (mirrored from the design's DiagnosticCoverageRecord) --
//
// Keys are Diagnostic_Tags in BRACKETED form — "[config:root-overlap]" — so the
// key set compares directly against `emittedDiagnosticTags()`, which yields
// bracketed tags, and against a scenario's bracketed `fixture.json`
// `expectedDiagnostic`. A covered entry names ONE OR MANY scenarios, because a
// single tag may be provoked by several scenarios (e.g. `[config:shape]` by four)
// and R5.3 requires every one of them be named. An inexpressible entry carries a
// reason-KIND drawn from the two R5.4 permits, plus a one-sentence prose reason.

/** The two — and only two — reason kinds R5.4 permits. */
const PERMITTED_INEXPRESSIBLE_KINDS = [
  "permission-state",
  "not-fixture-provokable",
] as const;

interface CoveredTag {
  readonly covered: true;
  readonly scenarios: readonly string[];
}
interface InexpressibleTag {
  readonly covered: false;
  readonly inexpressible: string;
  readonly reason: string;
}
type CoverageEntry = CoveredTag | InexpressibleTag;
type DiagnosticCoverageRecord = Readonly<Record<string, CoverageEntry>>;

const RECORD_PATH = resolve(FIXTURES_ROOT, "diagnostic-coverage.json");

/** The committed Diagnostic_Coverage_Record, read from repo-relative bytes. */
const record: DiagnosticCoverageRecord = JSON.parse(
  readFileSync(RECORD_PATH, "utf8"),
) as DiagnosticCoverageRecord;

/**
 * Every direct-subdirectory Fixture_Scenario name in one partition root, other
 * than that root's own files (`node_modules/` under the Fixture_Projects_Root is
 * excluded because it is not a scenario).
 */
function scenarioDirsUnder(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name);
}

const treeScenarios = new Set(scenarioDirsUnder(FIXTURE_TREES_ROOT));
const projectScenarios = new Set(scenarioDirsUnder(FIXTURE_PROJECTS_ROOT));
const allScenarios = new Set([...treeScenarios, ...projectScenarios]);

/** Absolute directory of a scenario, whichever partition holds it (or null). */
function scenarioDir(name: string): string | null {
  if (treeScenarios.has(name)) return resolve(FIXTURE_TREES_ROOT, name);
  if (projectScenarios.has(name)) return resolve(FIXTURE_PROJECTS_ROOT, name);
  return null;
}

/** A scenario's declared Expected_Diagnostic, from its `fixture.json`. */
function declaredDiagnostic(dir: string): string {
  const manifest = JSON.parse(
    readFileSync(join(dir, "fixture.json"), "utf8"),
  ) as { readonly expectedDiagnostic: string };
  return manifest.expectedDiagnostic;
}

const derivedTags = emittedDiagnosticTags();
const recordKeys = new Set(Object.keys(record));

/** Scenario names the record names, across all covered entries. */
function namedScenarios(): Set<string> {
  const named = new Set<string>();
  for (const entry of Object.values(record)) {
    if (entry.covered) for (const s of entry.scenarios) named.add(s);
  }
  return named;
}

describe("Diagnostic_Coverage_Record — sanity", () => {
  it("is a non-empty object and the derivation yielded tags", () => {
    expect(recordKeys.size, "the record must have entries").toBeGreaterThan(0);
    expect(derivedTags.size, "the scan must yield tags").toBeGreaterThan(0);
  });
});

describe("R5.2 — the derived tag set equals the record's key set (both ways)", () => {
  it("names every tag emitted by the Build_System but absent from the record", () => {
    const missing = [...derivedTags].filter((t) => !recordKeys.has(t)).sort();
    expect(
      missing,
      `these tags are emitted by the Build_System but have no entry in ` +
        `${RECORD_PATH}: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("names every record key not emitted by the Build_System", () => {
    const phantom = [...recordKeys].filter((t) => !derivedTags.has(t)).sort();
    expect(
      phantom,
      `these record keys are not emitted by the Build_System (phantom tags): ` +
        `${phantom.join(", ")}`,
    ).toEqual([]);
  });
});

describe("R5.3 — every named scenario exists and every scenario is named", () => {
  it("every Scenario_Directory_Name the record names exists as a scenario directory", () => {
    const named = namedScenarios();
    const missing = [...named].filter((s) => !allScenarios.has(s)).sort();
    expect(
      missing,
      `the record names these scenarios, but no directory exists for them ` +
        `under fixtures/trees/ or fixtures/projects/: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every Fixture_Scenario directory is named by the record", () => {
    const named = namedScenarios();
    const unnamed = [...allScenarios].filter((s) => !named.has(s)).sort();
    expect(
      unnamed,
      `these scenario directories exist but no record entry names them: ` +
        `${unnamed.join(", ")}`,
    ).toEqual([]);
  });
});

describe("R5.4 — every inexpressible reason is one of the two permitted kinds", () => {
  const inexpressible = Object.entries(record).filter(
    (pair): pair is [string, InexpressibleTag] => !pair[1].covered,
  );

  it("rejects any reason kind outside the permitted two, naming the tag and the kind", () => {
    const offenders = inexpressible
      .filter(
        ([, entry]) =>
          !(PERMITTED_INEXPRESSIBLE_KINDS as readonly string[]).includes(
            entry.inexpressible,
          ),
      )
      .map(([tag, entry]) => `${tag} -> "${entry.inexpressible}"`)
      .sort();
    expect(
      offenders,
      `an inexpressible entry may only record one of ` +
        `[${PERMITTED_INEXPRESSIBLE_KINDS.join(", ")}]; these do not: ` +
        `${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("requires a non-empty prose reason on every inexpressible entry", () => {
    const empty = inexpressible
      .filter(([, entry]) => entry.reason.trim().length === 0)
      .map(([tag]) => tag)
      .sort();
    expect(
      empty,
      `these inexpressible tags carry no prose reason: ${empty.join(", ")}`,
    ).toEqual([]);
  });
});

describe("R5.5 — a coverage claim is backed by a present R4.6 assertion", () => {
  const covered = Object.entries(record).filter(
    (pair): pair is [string, CoveredTag] => pair[1].covered,
  );

  it("names at least one scenario for every covered tag", () => {
    const empty = covered
      .filter(([, entry]) => entry.scenarios.length === 0)
      .map(([tag]) => tag)
      .sort();
    expect(
      empty,
      `these tags claim coverage but name no scenario: ${empty.join(", ")}`,
    ).toEqual([]);
  });

  it("each covering scenario structurally backs the tag it is claimed for", () => {
    // The structural backing the per-scenario spawn suites (task 4.3 and the
    // Project_Fixture equivalents) key their "present and passing" R4.6
    // assertion on: the scenario's `fixture.json` `expectedDiagnostic` equals
    // the tag, AND its directory name recovers that same tag through the shared
    // derivation. A claim a scenario does not structurally back is a named
    // failure here, so the record cannot claim coverage a test does not provide.
    const offences: string[] = [];
    for (const [tag, entry] of covered) {
      for (const scenario of entry.scenarios) {
        const dir = scenarioDir(scenario);
        if (dir === null) {
          offences.push(`${tag}: scenario "${scenario}" has no directory`);
          continue;
        }
        if (!existsSync(join(dir, "fixture.json"))) {
          offences.push(`${tag}: scenario "${scenario}" has no fixture.json`);
          continue;
        }
        const declared = declaredDiagnostic(dir);
        if (declared !== tag) {
          offences.push(
            `${tag}: scenario "${scenario}" fixture.json declares ${declared}`,
          );
        }
        // Recovery through the SHARED derivation (task 3.5), not a local copy.
        // Throws — naming the directory — on a malformed name; let it surface.
        const recovered = expectedDiagnosticOf(scenario);
        if (recovered !== tag) {
          offences.push(
            `${tag}: scenario "${scenario}" name recovers ${recovered}`,
          );
        }
      }
    }
    expect(
      offences,
      `these coverage claims are not structurally backed by their scenario ` +
        `(R5.5):\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  it("confirms every covering scenario directory is a real directory", () => {
    for (const [, entry] of covered) {
      for (const scenario of entry.scenarios) {
        const dir = scenarioDir(scenario);
        expect(dir, `scenario "${scenario}" must resolve`).not.toBeNull();
        expect(
          statSync(dir as string).isDirectory(),
          `scenario "${scenario}" must be a directory`,
        ).toBe(true);
      }
    }
  });
});

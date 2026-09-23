// Feature: platform-fixtures, Step 11 — the steering guard (task 11.3, R17.14).
//
// This is a guard over DOCUMENTATION, not over source code. It reads the
// Steering_Documents on disk and asserts, mechanically, that they keep saying
// the one thing this feature depends on being said: a test writes into the
// Fixture_Tier only at the in-fixture Permitted_Write_Location set, and
// everything else it needs to mutate goes to a Fixture_Clone. Two obligations:
//
//   1. NEGATIVE (over every Steering_Document): no document states that a
//      test/suite may write, edit, or mutate a file *in place inside a
//      Fixture_Scenario* at a location that is NOT one of the permitted ones.
//      This passes today — tech.md says the OPPOSITE ("it never edits a scenario
//      in place") — so it is a guard against a FUTURE edit that would grant such
//      permission, implemented as a real line-by-line scan with teeth, never a
//      stubbed `expect(true)`.
//
//   2. POSITIVE (over `.kiro/steering/tech.md` specifically): the file names
//      each of the three in-fixture Permitted_Write_Locations — a `dist/` under
//      `fixtures/`, a `*.tsbuildinfo` under `fixtures/`, and the
//      Fixture_Projects_Root's `node_modules/` — and names the `fixtures:install`
//      script. A missing one fails naming `.kiro/steering/tech.md` and the reason.
//
// The guard reads the docs READ-ONLY and writes nothing to the tree.
//
// Validates: Requirements 17.14

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The four Steering_Documents, as Project_Directory-relative POSIX paths. */
const STEERING_DOCS = [
  ".kiro/steering/platform-split.md",
  ".kiro/steering/product.md",
  ".kiro/steering/structure.md",
  ".kiro/steering/tech.md",
] as const;

const TECH = ".kiro/steering/tech.md";

function readDoc(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// NEGATIVE scan — no affirmative in-place write permission (R17.14)
// ---------------------------------------------------------------------------
//
// HEURISTIC AND ITS SCOPE. A fully general natural-language parse of "may a
// test write into a scenario at a non-permitted location?" is infeasible, so
// this is a deliberately conservative, single-line heuristic tuned to two
// requirements: (a) it passes cleanly on every current Steering_Document, and
// (b) it would catch an obvious AFFIRMATIVE permission to write in place.
//
// A line is flagged when ALL of the following hold, judged over that one line:
//
//   * it contains an ACTOR — a test or suite (the thing R17.14 forbids granting
//     permission to);
//   * it contains a MUTATION verb — write / edit / mutate / modify / overwrite;
//   * it contains an IN-PLACE-SCENARIO phrase — "in place" together with a
//     Fixture_Scenario reference (a scenario / a fixture / the Fixture_Tier),
//     i.e. it is talking about mutating the committed fixture itself rather than
//     a Fixture_Clone or one of the named generated-output locations;
//   * it reads as an AFFIRMATIVE PERMISSION — it contains a permission word
//     (may / can / allowed / permitted / write into / writes into) AND is NOT
//     negated by a prohibitive marker (never / not / no / must not / cannot /
//     forbidden / rejected / instead / goes to a Fixture_Clone / clones it
//     first).
//
// The prohibitive-marker test is what keeps the current tech.md sentences from
// tripping the scan: "it never edits a scenario in place" and "every other
// in-fixture mutation goes to a Fixture_Clone" both carry a prohibitive marker,
// as does the Permitted_Write_Location sentence ("the whole of what a test may
// write inside `fixtures/`" is a bounded permission, not an in-place-scenario
// permission — it names the three generated-output locations, not a scenario).
//
// The heuristic is intentionally line-scoped: a permission split across two
// sentences would slip past it. That is an accepted limit — the point is to
// catch the obvious single-sentence grant a careless future edit would add, and
// to fail LOUDLY naming the document and 1-based line number when it does.

const ACTOR = /\b(test|tests|suite|suites)\b/i;
const MUTATION = /\b(write|writes|writing|edit|edits|editing|mutate|mutates|mutating|modify|modifies|modifying|overwrite|overwrites|overwriting)\b/i;
const IN_PLACE = /\bin[\s-]?place\b/i;
const SCENARIO_REF = /\b(scenario|scenarios|fixture|fixtures|Fixture_Scenario|Fixture_Tier)\b/i;
const PERMISSION = /\b(may|can|could|allowed|permitted|permit|permits)\b|\bwrite[s]?\s+(into|inside|in)\b/i;
const PROHIBITIVE = /\b(never|not|no|cannot|can't|forbidden|forbids|prohibit|prohibited|rejected|rejects|instead|only|whole of)\b|Fixture_Clone|clone[s]? it first|goes to a/i;

interface Offender {
  readonly doc: string;
  readonly line: number; // 1-based
  readonly text: string;
}

/**
 * Scan one document's text line by line for an affirmative permission to write
 * in place inside a Fixture_Scenario at a non-permitted location. Returns one
 * offender per matching line, carrying the 1-based line number.
 */
function inPlacePermissionOffenders(doc: string, text: string): Offender[] {
  const offenders: Offender[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const isAffirmativeInPlaceWrite =
      ACTOR.test(line) &&
      MUTATION.test(line) &&
      IN_PLACE.test(line) &&
      SCENARIO_REF.test(line) &&
      PERMISSION.test(line) &&
      !PROHIBITIVE.test(line);
    if (isAffirmativeInPlaceWrite) {
      offenders.push({ doc, line: index + 1, text: line.trim() });
    }
  }
  return offenders;
}

describe("no Steering_Document permits an in-place write into a Fixture_Scenario (R17.14)", () => {
  it.each(STEERING_DOCS)(
    "%s grants no affirmative in-place-write permission",
    (doc) => {
      const offenders = inPlacePermissionOffenders(doc, readDoc(doc));
      const report = offenders
        .map((o) => `${o.doc}:${o.line}: ${o.text}`)
        .join("\n");
      expect(offenders, `a Steering_Document permits an in-place write into a Fixture_Scenario:\n${report}`).toEqual(
        [],
      );
    },
  );

  // Teeth: the scan fires over a synthetic document held in memory, and the
  // report carries the 1-based line number. No file is written.
  it("fails on a document that grants in-place-write permission, naming the line", () => {
    const synthetic = [
      "# Heading", // line 1
      "", // line 2
      "A test may edit a scenario in place at any location it likes.", // line 3
      "", // line 4
      "Trailing prose.", // line 5
    ].join("\n");

    const offenders = inPlacePermissionOffenders("synthetic.md", synthetic);

    expect(offenders.length).toBeGreaterThan(0);
    for (const offender of offenders) {
      expect(offender.doc).toBe("synthetic.md");
      expect(offender.line).toBe(3);
    }
  });

  // The prohibitive form of the same sentence — the current tech.md phrasing —
  // is NOT flagged.
  it("does not flag a prohibitive statement about editing a scenario in place", () => {
    const prohibitive = [
      "A test that needs to perturb a committed scenario clones it first; it never edits a scenario in place.",
      "Every other in-fixture mutation goes to a Fixture_Clone.",
      "Those three are the whole of what a test may write inside `fixtures/`.",
    ].join("\n");

    expect(inPlacePermissionOffenders("synthetic.md", prohibitive)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POSITIVE assertions over tech.md — the four things it must name (R17.14)
// ---------------------------------------------------------------------------
//
// Each matcher is matched on the CONCEPT (a co-occurrence within the in-fixture
// Permitted_Write_Locations context), not on one exact sentence, so a reworded
// doc still passes while an actual removal fails. Matched case-sensitively over
// the raw text of `.kiro/steering/tech.md`.

interface PositiveCheck {
  readonly what: string;
  readonly present: (tech: string) => boolean;
}

const POSITIVE_CHECKS: readonly PositiveCheck[] = [
  {
    what: "a `dist/` under `fixtures/` (in-fixture Permitted_Write_Location)",
    // `dist/` co-occurring with `fixtures/` inside the in-fixture context. The
    // in-fixture sentence names "a `dist/` under `fixtures/`".
    present: (tech) => /a `dist\/` under `fixtures\/`/.test(tech),
  },
  {
    what: "a `*.tsbuildinfo` under `fixtures/` (in-fixture Permitted_Write_Location)",
    present: (tech) => /a `\*\.tsbuildinfo` under `fixtures\/`/.test(tech),
  },
  {
    what: "the Fixture_Projects_Root's `node_modules/` (in-fixture Permitted_Write_Location)",
    // Fixture_Projects_Root co-occurring with node_modules/ — the sentence
    // names "the Fixture_Projects_Root's `node_modules/`".
    present: (tech) =>
      tech.includes("Fixture_Projects_Root") && tech.includes("node_modules/"),
  },
  {
    what: "the `fixtures:install` script",
    present: (tech) => tech.includes("fixtures:install"),
  },
];

describe("tech.md names the three in-fixture Permitted_Write_Locations and the install script (R17.14)", () => {
  it.each(POSITIVE_CHECKS)("names $what", ({ what, present }) => {
    const tech = readDoc(TECH);
    expect(present(tech), `${TECH} no longer names ${what}`).toBe(true);
  });

  // A tighter co-occurrence check that the three in-fixture locations are named
  // in the SAME in-fixture context, so a stray `dist/` elsewhere cannot satisfy
  // the concept on its own. The in-fixture sentence carries the marker phrase
  // "in-fixture Permitted_Write_Locations".
  it("names the three in-fixture locations in the in-fixture Permitted_Write_Locations context", () => {
    const tech = readDoc(TECH);
    expect(
      tech.includes("in-fixture Permitted_Write_Locations"),
      `${TECH} no longer carries the "in-fixture Permitted_Write_Locations" marker`,
    ).toBe(true);
  });
});

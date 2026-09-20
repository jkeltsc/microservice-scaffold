// Feature: config-driven-discovery — the JSON-shape and unknown-key surface of
// `parseProjectConfig`, exercised by example rather than by property.
//
// Where the property suites quantify over an input space (a scope string, a
// root path), the rules under test here are a small, closed set of enumerated
// cases: the finite list of JSON types a non-object top level can be, the finite
// list of recognised keys that can hold a wrong-typed value, and the two
// unknown-key positions. One worked example per case is the sharper instrument —
// each pins the exact tag, key path, `found` (the JSON type found), and the
// no-further-validation / still-validated behaviour the requirement fixes.
//
// The rules pinned:
//   - R2.4 — a non-object top level (array, string, number, boolean, null)
//     yields exactly one `[config:shape]` naming the JSON type found, with NO
//     further validation of that input.
//   - R2.5 / R3.4 — a wrong-typed recognised key yields exactly one
//     `[config:shape]` for that key: a non-string `scope` (and NO
//     `[config:scope]`), a non-object `roots` (array and null each counting as
//     not-an-object, with NO member checks), and a non-string `roots` member.
//   - registry-inversion R1.5 — a non-string `entry` is the same closed
//     enumeration: exactly one `[config:shape]` at the key path `entry` naming
//     the JSON type found, NO `[config:entry-path]`, and no Entry_Root_Default
//     substituted, so a wrong-typed `entry` can raise no
//     `[config:entry-overlap]` either.
//   - R2.6, registry-inversion R1.7 — an unknown top-level key, and an unknown
//     `roots` member, each yield one `[config:unknown-key]` naming the key and
//     listing the recognised keys at that position in ascending code-point order
//     — at the top level now `'entry', 'roots', 'scope'` — while every recognised
//     key of the same input is still validated.
//   - R4.10 — a `roots` member rejected for being wrong-typed is excluded from
//     the overlap and framework comparisons with NO Root_Default substituted, so
//     no `[config:root-overlap]` or `[config:root-framework]` diagnostic names a
//     value that has already been rejected.
//
// Every `found` oracle is the JSON type name computed independently in this file
// (see `jsonType`), not imported from the parser, so the assertions check the
// parser against the spec rather than against itself.
//
// Validates: Requirements 2.4, 2.5, 2.6, 3.4, 4.10
// Validates: registry-inversion Requirements 1.2, 1.5, 1.7

import { describe, expect, it } from "vitest";

import {
  PROJECT_CONFIG_FILE,
  parseProjectConfig,
  type ConfigDiagnostic,
} from "../src/project-config.js";

/**
 * The JSON type name the parser names in a `[config:shape]` diagnostic's `found`
 * part, computed here as an independent oracle from the requirement's own
 * enumeration (R2.4): null and array are distinguished from object, everything
 * else is its `typeof`.
 */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Parse `value` as the whole config text and return the outcome. */
function parse(text: string) {
  return parseProjectConfig(text, PROJECT_CONFIG_FILE);
}

/** The diagnostics of a rejected outcome; fails the test if it parsed. */
function rejectedDiagnostics(text: string): readonly ConfigDiagnostic[] {
  const outcome = parse(text);
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") {
    throw new Error("expected a rejected outcome");
  }
  return outcome.diagnostics;
}

/** Asserts a diagnostic has all four parts present and non-empty (R2.13). */
function expectAllPartsNonEmpty(diag: ConfigDiagnostic): void {
  expect(diag.tag.length).toBeGreaterThan(0);
  expect(diag.at.length).toBeGreaterThan(0);
  expect(diag.found.length).toBeGreaterThan(0);
  expect(diag.reason.length).toBeGreaterThan(0);
}

describe("R2.4: a non-object top level yields exactly one [config:shape] and no further validation", () => {
  // One case per JSON type a non-object top level can be. Each carries a nested
  // shape that WOULD produce further diagnostics if the parser looked inside it
  // (a wrong-typed scope, an unknown key), so "no further validation" is
  // observable: the count is one and the tag is only ever `[config:shape]`.
  const cases: ReadonlyArray<{ readonly label: string; readonly text: string }> =
    [
      { label: "array", text: JSON.stringify([{ scope: 42 }]) },
      { label: "string", text: JSON.stringify("@microservices") },
      { label: "number", text: JSON.stringify(1234) },
      { label: "boolean", text: JSON.stringify(true) },
      { label: "null", text: JSON.stringify(null) },
    ];

  for (const { label, text } of cases) {
    it(`reports the JSON type '${label}' and nothing else`, () => {
      const parsed: unknown = JSON.parse(text);
      const diagnostics = rejectedDiagnostics(text);

      // Exactly one diagnostic, no further validation of the input (R2.4).
      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0]!;
      expect(diag.tag).toBe("config:shape");
      // Names the Project_Config_File path and the JSON type found.
      expect(diag.at).toBe(PROJECT_CONFIG_FILE);
      expect(diag.found).toBe(jsonType(parsed));
      expect(diag.found).toBe(label);
      expectAllPartsNonEmpty(diag);
    });
  }
});

describe("R3.4: a non-string `scope` yields exactly one [config:shape] for scope and no [config:scope]", () => {
  // One case per JSON type `scope` can wrongly be. A number/boolean/null/array/
  // object scope is a shape error, never a Valid_Scope charset error.
  const cases: ReadonlyArray<{ readonly label: string; readonly value: unknown }> =
    [
      { label: "number", value: 42 },
      { label: "boolean", value: true },
      { label: "null", value: null },
      { label: "array", value: ["@microservices"] },
      { label: "object", value: { name: "@microservices" } },
    ];

  for (const { label, value } of cases) {
    it(`reports [config:shape] for a ${label} scope, alone, with no [config:scope]`, () => {
      const text = JSON.stringify({ scope: value });
      const diagnostics = rejectedDiagnostics(text);

      const shapeDiags = diagnostics.filter((d) => d.tag === "config:shape");
      const scopeDiags = diagnostics.filter((d) => d.tag === "config:scope");

      // Exactly one diagnostic, the shape one; no charset diagnostic (R3.4).
      expect(diagnostics).toHaveLength(1);
      expect(shapeDiags).toHaveLength(1);
      expect(scopeDiags).toHaveLength(0);

      const diag = shapeDiags[0]!;
      expect(diag.at).toBe("scope");
      expect(diag.found).toBe(jsonType(value));
      expect(diag.found).toBe(label);
      expectAllPartsNonEmpty(diag);
    });
  }
});

describe("R2.5: a `roots` that is not a JSON object yields exactly one [config:shape] with no member checks", () => {
  // A JSON array and JSON null each count as not-an-object (R2.5), alongside the
  // primitive types. Each `roots` value below embeds a member that WOULD fail if
  // the parser descended into it, so "no member checks" is observable: exactly
  // one diagnostic, tagged shape, at key path `roots`.
  const cases: ReadonlyArray<{ readonly label: string; readonly value: unknown }> =
    [
      { label: "array", value: [{ microservice: 1 }] },
      { label: "null", value: null },
      { label: "string", value: "packages/microservices" },
      { label: "number", value: 7 },
      { label: "boolean", value: false },
    ];

  for (const { label, value } of cases) {
    it(`reports [config:shape] at 'roots' for a ${label} and no member diagnostics`, () => {
      const text = JSON.stringify({ roots: value });
      const diagnostics = rejectedDiagnostics(text);

      // Exactly one diagnostic; no member checks (R2.5).
      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0]!;
      expect(diag.tag).toBe("config:shape");
      expect(diag.at).toBe("roots");
      expect(diag.found).toBe(jsonType(value));
      expect(diag.found).toBe(label);
      expectAllPartsNonEmpty(diag);
    });
  }
});

describe("R2.5: a `roots` member of the wrong JSON type yields exactly one [config:shape] for that member", () => {
  // One case per JSON type a `roots` member can wrongly be. The other two
  // members are left undeclared so nothing but the wrong-typed member can
  // produce a diagnostic.
  const cases: ReadonlyArray<{ readonly label: string; readonly value: unknown }> =
    [
      { label: "number", value: 3 },
      { label: "boolean", value: true },
      { label: "null", value: null },
      { label: "array", value: ["packages/microservices"] },
      { label: "object", value: { path: "packages/microservices" } },
    ];

  for (const { label, value } of cases) {
    it(`reports [config:shape] at 'roots.microservice' for a ${label} member`, () => {
      const text = JSON.stringify({ roots: { microservice: value } });
      const diagnostics = rejectedDiagnostics(text);

      expect(diagnostics).toHaveLength(1);
      const diag = diagnostics[0]!;
      expect(diag.tag).toBe("config:shape");
      expect(diag.at).toBe("roots.microservice");
      expect(diag.found).toBe(jsonType(value));
      expect(diag.found).toBe(label);
      expectAllPartsNonEmpty(diag);
    });
  }
});

describe("registry-inversion R1.5: a non-string `entry` yields exactly one [config:shape] for entry and no [config:entry-path]", () => {
  // One case per JSON type `entry` can wrongly be, the same closed enumeration
  // the `scope` and `roots`-member cases above walk. A wrong-typed `entry` is a
  // shape error and never a Valid_Root_Path error, and because no
  // Entry_Root_Default is substituted for it, it can raise no overlap diagnostic
  // either — which the counts below pin.
  const cases: ReadonlyArray<{ readonly label: string; readonly value: unknown }> =
    [
      { label: "number", value: 42 },
      { label: "boolean", value: true },
      { label: "null", value: null },
      { label: "array", value: ["app"] },
      { label: "object", value: { path: "app" } },
    ];

  for (const { label, value } of cases) {
    it(`reports [config:shape] at 'entry' for a ${label}, alone, with no [config:entry-path]`, () => {
      const text = JSON.stringify({ entry: value });
      const diagnostics = rejectedDiagnostics(text);

      const shape = diagnostics.filter((d) => d.tag === "config:shape");
      const entryPath = diagnostics.filter(
        (d) => d.tag === "config:entry-path",
      );
      const entryOverlap = diagnostics.filter(
        (d) => d.tag === "config:entry-overlap",
      );

      // Exactly one diagnostic, the shape one; no path and no overlap
      // diagnostic, the latter because no default was substituted.
      expect(diagnostics).toHaveLength(1);
      expect(shape).toHaveLength(1);
      expect(entryPath).toHaveLength(0);
      expect(entryOverlap).toHaveLength(0);

      const diag = shape[0]!;
      expect(diag.at).toBe("entry");
      expect(diag.found).toBe(jsonType(value));
      expect(diag.found).toBe(label);
      expectAllPartsNonEmpty(diag);
    });
  }

  it("still validates the recognised keys of the same input", () => {
    // A wrong-typed `entry` alongside a wrong-typed `scope`: each recognised key
    // is validated on its own, so exactly two shape diagnostics appear, ordered
    // by ascending code point of the key path ('entry' before 'scope').
    const text = JSON.stringify({ scope: 42, entry: [] });
    const diagnostics = rejectedDiagnostics(text);

    expect(diagnostics.map((d) => `${d.tag} ${d.at}`)).toEqual([
      "config:shape entry",
      "config:shape scope",
    ]);
  });
});

describe("R2.6: an unknown top-level key yields [config:unknown-key] listing recognised keys, recognised keys still validated", () => {
  it("names the unknown key and lists 'entry', 'roots', 'scope' in ascending code-point order", () => {
    const text = JSON.stringify({ nonsense: 1 });
    const diagnostics = rejectedDiagnostics(text);

    const unknown = diagnostics.filter((d) => d.tag === "config:unknown-key");
    expect(unknown).toHaveLength(1);
    const diag = unknown[0]!;
    expect(diag.at).toBe("nonsense");
    expect(diag.found).toBe("nonsense");
    // Recognised keys, ascending code point: 'e' < 'r' < 's' (R1.7).
    expect(diag.reason).toContain("'entry', 'roots', 'scope'");
    expectAllPartsNonEmpty(diag);
  });

  it("still validates the recognised keys of the same input", () => {
    // An unknown key alongside a wrong-typed recognised `scope`: R2.6 requires
    // the parser to keep validating `scope`, so BOTH a [config:unknown-key] and
    // a [config:shape] for scope appear.
    const text = JSON.stringify({ nonsense: 1, scope: 42 });
    const diagnostics = rejectedDiagnostics(text);

    const unknown = diagnostics.filter((d) => d.tag === "config:unknown-key");
    const shape = diagnostics.filter((d) => d.tag === "config:shape");

    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.at).toBe("nonsense");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.at).toBe("scope");
  });
});

describe("R2.6: an unknown `roots` member yields [config:unknown-key], recognised members still validated", () => {
  it("names the unknown member at its key path and lists the recognised members", () => {
    const text = JSON.stringify({ roots: { widget: "packages/widget" } });
    const diagnostics = rejectedDiagnostics(text);

    const unknown = diagnostics.filter((d) => d.tag === "config:unknown-key");
    expect(unknown).toHaveLength(1);
    const diag = unknown[0]!;
    expect(diag.at).toBe("roots.widget");
    expect(diag.found).toBe("widget");
    // Recognised `roots` members, in ascending code-point order.
    expect(diag.reason).toContain("'common', 'microservice', 'spa'");
    expectAllPartsNonEmpty(diag);
  });

  it("still validates the recognised members of the same `roots` object", () => {
    // An unknown member alongside a wrong-typed recognised member: both the
    // unknown-key and the member shape diagnostic must appear (R2.6).
    const text = JSON.stringify({
      roots: { widget: "packages/widget", microservice: 5 },
    });
    const diagnostics = rejectedDiagnostics(text);

    const unknown = diagnostics.filter((d) => d.tag === "config:unknown-key");
    const shape = diagnostics.filter((d) => d.tag === "config:shape");

    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.at).toBe("roots.widget");
    expect(shape).toHaveLength(1);
    expect(shape[0]!.at).toBe("roots.microservice");
  });
});

describe("R4.10: a rejected `roots` member is excluded from overlap and framework comparisons with no default substituted", () => {
  it("does not raise [config:root-overlap] naming a wrong-typed member that would otherwise collide", () => {
    // `common` is set equal to the default microservice root — if the parser
    // substituted the microservice Root_Default for its rejected (wrong-typed)
    // member, `microservice` and `common` would be equal and an overlap would
    // be reported. R4.10 forbids that substitution, so the only diagnostic is
    // the shape error for the rejected member.
    const text = JSON.stringify({
      roots: { microservice: 42, common: "packages/microservices" },
    });
    const diagnostics = rejectedDiagnostics(text);

    const shape = diagnostics.filter((d) => d.tag === "config:shape");
    const overlap = diagnostics.filter((d) => d.tag === "config:root-overlap");
    const framework = diagnostics.filter(
      (d) => d.tag === "config:root-framework",
    );

    // The rejected member is reported, once, as a shape error.
    expect(shape).toHaveLength(1);
    expect(shape[0]!.at).toBe("roots.microservice");
    // No overlap or framework diagnostic names the excluded member (R4.10).
    expect(overlap).toHaveLength(0);
    expect(framework).toHaveLength(0);
  });

  it("does not raise [config:root-framework] for a wrong-typed member, even though its default sits under packages/", () => {
    // The microservice Root_Default is `packages/microservices`, which does not
    // collide with a Framework_Singleton directory; but the point of this case
    // is the exclusion itself: a rejected member produces neither an overlap nor
    // a framework diagnostic, because no default is substituted for it to
    // compare. We reject `microservice` and declare the other two as their own
    // distinct, framework-safe paths so the ONLY diagnostic is the shape error.
    const text = JSON.stringify({
      roots: {
        microservice: ["packages/microservices"],
        common: "packages/common",
        spa: "packages/spa",
      },
    });
    const diagnostics = rejectedDiagnostics(text);

    expect(diagnostics).toHaveLength(1);
    const diag = diagnostics[0]!;
    expect(diag.tag).toBe("config:shape");
    expect(diag.at).toBe("roots.microservice");
    expect(diag.found).toBe("array");
  });
});

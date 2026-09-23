// Focused sanity coverage for the two-recogniser tag derivation
// (platform-fixtures spec, task 6.1). The Diagnostic_Coverage_Record guard's
// own set-equality test lands in task 6.3; this file only exercises the pure
// core `emittedTagsFromSources` over synthesised sources, plus the real-repo
// shell's recovery of the six render-composed tags Form B exists to catch.

import { describe, it, expect } from "vitest";

import {
  emittedTagsFromSources,
  emittedDiagnosticTags,
  type TagSource,
} from "./diagnostic-tags.js";

const source = (text: string): TagSource[] => [{ file: "synthetic.ts", text }];

describe("emittedTagsFromSources — Form A (bracketed literal)", () => {
  it("collects a bracketed tag from ordinary code text", () => {
    const tags = emittedTagsFromSources(source('throw new Error("[foo:bar] boom");'));
    expect(tags).toEqual(new Set(["[foo:bar]"]));
  });

  it("collects a bracketed tag that occurs only inside a comment", () => {
    // A tag whose sole textual occurrence is a JSDoc @throws annotation must
    // still be recovered — comments are NOT stripped.
    const jsdoc = ["/**", " * @throws when the widget is absent, tagged elsewhere.", " * emits [comment-only:tag]", " */", "export function f() {}"].join("\n");
    const tags = emittedTagsFromSources(source(jsdoc));
    expect(tags).toEqual(new Set(["[comment-only:tag]"]));
  });

  it("preserves hyphenated categories and details", () => {
    const tags = emittedTagsFromSources(source('const x = "[build-order:root-overlap]";'));
    expect(tags).toEqual(new Set(["[build-order:root-overlap]"]));
  });
});

describe("emittedTagsFromSources — Form B (tag-union member)", () => {
  it("collects members of a `type <Name>Tag = ...;` union and brackets them", () => {
    const decl = ['export type WidgetTag =', '  | "widget:missing"', '  | "widget:broken";'].join("\n");
    const tags = emittedTagsFromSources(source(decl));
    expect(tags).toEqual(new Set(["[widget:missing]", "[widget:broken]"]));
  });

  it("collects members of a `readonly tag: ...;` property signature", () => {
    const decl = 'interface V { readonly tag: "gadget:setting" | "gadget:absent"; }';
    const tags = emittedTagsFromSources(source(decl));
    expect(tags).toEqual(new Set(["[gadget:setting]", "[gadget:absent]"]));
  });

  it("ignores a tag-shaped literal outside any union declaration span", () => {
    // A bare tag-shaped string in ordinary code is NOT a Form-B member and has
    // no brackets for Form A, so it must not be imported as a phantom key.
    const tags = emittedTagsFromSources(source('const selector = "phantom:token";'));
    expect(tags).toEqual(new Set<string>());
  });

  it("stops a union span at the terminating semicolon", () => {
    const text = ['type OneTag = "real:member";', 'const other = "phantom:after";'].join("\n");
    const tags = emittedTagsFromSources(source(text));
    expect(tags).toEqual(new Set(["[real:member]"]));
  });
});

describe("emittedDiagnosticTags — real repository", () => {
  const tags = emittedDiagnosticTags();

  it("recovers the six render-composed tags Form B exists to catch", () => {
    for (const composed of [
      "[config:unparsable]",
      "[config:root-not-directory]",
      "[config:root-is-package]",
      "[tsconfig:setting]",
      "[tsconfig:absent]",
      "[tsconfig:unresolvable]",
    ]) {
      expect(tags.has(composed)).toBe(true);
    }
  });

  it("yields only bracketed tags", () => {
    for (const tag of tags) {
      expect(tag).toMatch(/^\[[a-z][a-z-]*:[a-z][a-z-]*\]$/);
    }
  });

  it("derives a non-trivial set", () => {
    expect(tags.size).toBeGreaterThan(6);
  });
});

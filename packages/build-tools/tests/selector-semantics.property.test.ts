// Feature: microservice-scaffold, Property 2: Selector parsing.
// For any string s (including undefined, empty, whitespace-only, "*", and
// arbitrary comma-separated forms):
//  - s selects "all" iff s is undefined, empty after trimming, exactly "*", or
//    splits into zero non-empty entries after trimming.
//  - Otherwise s selects the list L obtained by splitting s on ",", trimming
//    each entry, and discarding empty entries, order preserved.
//
// The property is now expressed over the SELECTION OUTCOME — the return value of
// `resolveSelected(s, directories)` — rather than over the intermediate parse
// representation, because `parseSelector` is module-internal: `resolveSelected`
// is the only thing production calls, and the parse result exists solely as its
// input. That is the better level for two reasons. It states the property over
// the surface a caller can actually observe, so the assertion survives any
// refactor of the intermediate representation; and it is strictly no weaker,
// because both branches of the parse rule are injectively visible in the
// outcome: an all-selector resolves to EVERY discovered directory (in discovery
// order), while a list-selector resolves to EXACTLY the named identifiers, in
// selector order, duplicates and all. Each run therefore pins order, trimming,
// empty-entry dropping and the all/list classification itself.
//
// The `directories` argument is constructed so the two branches can never be
// confused: it always contains a sentinel directory that no selector under test
// can name, so an all-resolution contains the sentinel and a list-resolution
// cannot. `directories` is also always non-empty, keeping the all-branch clear
// of the R5.5 empty-namespace throw (which Property 3 covers).
//
// Validates: Requirements R5.2, R6.1, R6.2, R10.3

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { resolveSelected } from "../src/selector.js";
import { arbSelectorString } from "@microservices/contracts/testing";

/**
 * Reference implementation of the split/trim/drop-empties list derivation,
 * kept deliberately independent of the production parser so the property test
 * checks against an oracle rather than re-deriving from the same code path.
 */
function referenceList(input: string): string[] {
  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * A directory name that is guaranteed absent from `named` — uppercase, so no
 * generated identifier can collide with it, and extended until unique in the
 * pathological case where a raw selector string named it anyway.
 */
function sentinelAbsentFrom(named: readonly string[]): string {
  let sentinel = "SENTINEL-DIRECTORY";
  while (named.includes(sentinel)) {
    sentinel += "-X";
  }
  return sentinel;
}

/**
 * The discovered namespace used to observe a selector: every identifier the
 * selector names (so a list-selector resolves rather than throwing) plus a
 * sentinel the selector cannot name (so the set is never equal to any list the
 * selector could produce, making all-vs-list unambiguous).
 */
function directoriesFor(named: readonly string[]): {
  readonly directories: string[];
  readonly sentinel: string;
} {
  const sentinel = sentinelAbsentFrom(named);
  return { directories: [...new Set(named), sentinel], sentinel };
}

describe("Property 2: selector semantics via resolveSelected", () => {
  it("classifies arbitrary selector strings per the all/list rule", () => {
    fc.assert(
      fc.property(arbSelectorString, (s) => {
        const list = referenceList(s);
        const { directories, sentinel } = directoriesFor(list);

        const trimmed = s.trim();
        const expectAll =
          trimmed === "" || trimmed === "*" || list.length === 0;

        const resolved = resolveSelected(s, directories);

        if (expectAll) {
          // All-branch: every discovered directory, in discovery order. The
          // sentinel's presence is what proves this was the all-branch and not
          // a list resolution that happened to look similar.
          expect(resolved).toEqual(directories);
          expect(resolved).toContain(sentinel);
        } else {
          // List-branch: exactly the named identifiers, in selector order,
          // duplicates preserved — and never the sentinel.
          expect(resolved).toEqual(list);
          expect(resolved).not.toContain(sentinel);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("treats undefined as an all-selector", () => {
    const { directories, sentinel } = directoriesFor([]);
    expect(resolveSelected(undefined, directories)).toEqual(directories);
    expect(resolveSelected(undefined, directories)).toContain(sentinel);
  });

  it("preserves order and drops empty entries for list selectors", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .stringMatching(/^[a-z][a-z0-9-]*$/)
            .filter((s) => s.length > 0 && s.length <= 20),
          { minLength: 1, maxLength: 6 },
        ),
        (ids) => {
          // Interleave stray whitespace and empty entries; selection must
          // recover exactly `ids` in order.
          const raw = ids.map((id) => `  ${id} `).join(",") + ",,";
          const { directories, sentinel } = directoriesFor(ids);

          const resolved = resolveSelected(raw, directories);
          expect(resolved).toEqual(ids);
          expect(resolved).not.toContain(sentinel);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Pinned edge cases from the design's "selector parsing spot cases". An
  // all-selector resolves to the whole namespace including the sentinel.
  it.each(["", "  ", ",,,", "*"] as const)(
    "pinned edge case %j -> all",
    (input) => {
      const { directories, sentinel } = directoriesFor([]);
      const resolved = resolveSelected(input, directories);
      expect(resolved).toEqual(directories);
      expect(resolved).toContain(sentinel);
    },
  );

  it("pinned edge case ' microservice1 , microservice2 ' -> list", () => {
    const directories = [
      "microservice1",
      "microservice2",
      "microservice3",
      "SENTINEL-DIRECTORY",
    ];
    expect(
      resolveSelected(" microservice1 , microservice2 ", directories),
    ).toEqual(["microservice1", "microservice2"]);
  });
});

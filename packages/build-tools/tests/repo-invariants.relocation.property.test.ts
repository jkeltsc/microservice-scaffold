// Feature: config-driven-discovery, Property 17: Import-discipline violations are
// invariant under relocation and rename.
//
// For any Synthesized_Tree carrying import specifiers and Dependency_Specifiers,
// any Discovery_Root assignment satisfying the overlap and framework constraints,
// and any Valid_Scope, the Repo_Invariant_Checker reports the same set of
// import-discipline and Common_Package dependency-direction violations for that
// layout under every assignment and every scope, and each reported violation
// names the offending file or package by a Project_Directory-relative POSIX path
// and names the offending specifier verbatim.
//
// The two checks under test — `checkImportDiscipline(context, discovery, files,
// readSource)` and `checkDependencyDirection(context, discovery)` — are pure and
// RETURN their message lists, so the property runs them over an in-memory
// `importLayout()` from `arbitraries/tree.ts`, with no filesystem. Each specifier
// in that layout is LABELLED with the verdict it must draw (escape, peer,
// overseer, spa, or legal), so the expected violation set is known by
// construction rather than recomputed by a second copy of the checker.
//
// "The same set under every assignment and every scope" is a metamorphic claim:
// relocation rewrites every reported FILE PATH by its root prefix, and a rename
// rewrites every reported BY-NAME SPECIFIER by its scope. So the comparison is
// against a CANONICAL projection — file paths stripped of their root prefix,
// specifiers stripped of their scope — which must be byte-identical across the
// base layout, its relocation, and its rename.
//
// Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6, 7.9, 14.16

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  checkDependencyDirection,
  checkImportDiscipline,
} from "../src/repo-invariants.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import { CONSUMER_CATEGORIES, type ConsumerCategory } from "../src/framework.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext, type ProjectContext } from "../src/project-context.js";
import {
  DEFAULT_ROOTS,
  importLayout,
  importLayoutRelocatedAs,
  importLayoutRescopedAs,
  relocatedRoots,
  validScope,
  type ImportLayoutDescription,
  type ImportSpecifierSpec,
  type RootAssignment,
} from "./arbitraries/tree.js";

/** A default-scope context at `roots`, then re-scoped to `scope`. */
function contextFor(roots: RootAssignment, scope: string): ProjectContext {
  return projectContext({ ...defaultEffectiveConfig(), scope, roots });
}

/** The scoped package name of a layout member under a layout's scope. */
function nameOf(layout: ImportLayoutDescription, dirName: string): string {
  return `${layout.scope}/${dirName}`;
}

/** The repo-relative package directory of a member under a layout's roots. */
function packageDirOf(
  layout: ImportLayoutDescription,
  category: ConsumerCategory,
  dirName: string,
): string {
  return `${layout.roots[category]}/${dirName}`;
}

/** The `Discovery` a layout presents to the two checks. Every member's scoped
 *  dependency-direction edges are set from the layout's own labelled specifiers
 *  so `checkDependencyDirection` has something to report on too. */
function discoveryOf(layout: ImportLayoutDescription): Discovery {
  const overseerName = `${layout.scope}/overseer`;

  const packages: ConsumerPackage[] = layout.packages.map((pkg) => {
    // A common package's dependency-direction edges: it names each peer/overseer
    // target that appears in any of its files (an upward edge, a R7.9 violation),
    // plus a legal downward edge to itself is never added. This gives
    // checkDependencyDirection real inputs whose scope is rewritten on rename.
    const upward = new Set<string>();
    if (pkg.category === "common") {
      for (const file of pkg.files) {
        for (const spec of file.specifiers) {
          if (spec.label === "peer") {
            upward.add(nameOf(layout, spec.targetDirName));
          } else if (spec.label === "overseer") {
            upward.add(overseerName);
          }
        }
      }
    }
    return {
      category: pkg.category,
      dirName: pkg.dirName,
      packageDir: packageDirOf(layout, pkg.category, pkg.dirName),
      name: nameOf(layout, pkg.dirName),
      dependencySpecifiers: [...upward].sort(),
      buildKind: buildKindOf(pkg.category),
    };
  });

  return {
    byCategory: {
      microservice: packages.filter((pkg) => pkg.category === "microservice"),
      common: packages.filter((pkg) => pkg.category === "common"),
      spa: packages.filter((pkg) => pkg.category === "spa"),
    },
    nameByDir: new Map(packages.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
  };
}

/** The concrete import specifier text a labelled spec emits under a layout. */
function specifierText(
  layout: ImportLayoutDescription,
  spec: ImportSpecifierSpec,
): string {
  switch (spec.label) {
    case "escape":
      return spec.relative;
    case "peer":
      return nameOf(layout, spec.targetDirName);
    case "overseer":
      return `${layout.scope}/overseer`;
    case "spa":
      return nameOf(layout, spec.targetDirName);
    case "legal":
      return spec.specifier;
  }
}

/** The `(filePath, source)` pairs a layout's files present to
 *  `checkImportDiscipline`, plus the ordered list of file paths. */
function filesOf(layout: ImportLayoutDescription): {
  readonly paths: readonly string[];
  readonly readSource: (file: string) => string;
} {
  const sourceByPath = new Map<string, string>();
  for (const pkg of layout.packages) {
    const dir = packageDirOf(layout, pkg.category, pkg.dirName);
    for (const file of pkg.files) {
      const path = `${dir}/${file.relPathInPackage}`;
      const lines = file.specifiers.map(
        (spec, i) => `import binding${String(i)} from "${specifierText(layout, spec)}";`,
      );
      sourceByPath.set(path, [...lines, "export const value = 1;", ""].join("\n"));
    }
  }
  return {
    paths: [...sourceByPath.keys()],
    readSource: (file) => sourceByPath.get(file) ?? "",
  };
}

/** All import-discipline + dependency-direction messages for a layout. */
function violationsOf(layout: ImportLayoutDescription): readonly string[] {
  const context = contextFor(layout.roots, layout.scope);
  const discovery = discoveryOf(layout);
  const { paths, readSource } = filesOf(layout);
  return [
    ...checkImportDiscipline(context, discovery, paths, readSource),
    ...checkDependencyDirection(context, discovery),
  ];
}

/**
 * Canonicalise a message set so relocation and rename are factored out: strip
 * each layout root prefix (replacing it with a category tag) and each scope
 * prefix (replacing it with `@scope`). What remains is the root- and
 * scope-independent identity of every reported file, package, and specifier,
 * which Property 17 requires to be identical across the transformations.
 */
function canonical(
  messages: readonly string[],
  layout: ImportLayoutDescription,
): readonly string[] {
  return [...messages]
    .map((message) => {
      let out = message;
      // Anchor every replacement at the opening quote of a reported path or
      // specifier, so a short root or scope name cannot collide with a substring
      // mid-token (e.g. a root "a" inside a directory name "omega"). Both a file
      // path and a by-name specifier are reported inside `"..."`, and both begin
      // at the quote, so `"<root>/` and `"<scope>/` are the only forms to rewrite.
      for (const category of CONSUMER_CATEGORIES) {
        out = out
          .split(`"${layout.roots[category]}/`)
          .join(`"<${category}>/`);
      }
      out = out.split(`"${layout.scope}/`).join('"@scope/');
      return out;
    })
    .sort();
}

describe("Property 17: import-discipline violations are invariant under relocation and rename", () => {
  it("reports the same violation set (canonically) under relocation and under rename", () => {
    // Coverage guards: the property must see layouts that actually produce
    // violations, and it must see the transformations genuinely move something.
    let withViolations = 0;

    fc.assert(
      fc.property(
        importLayout(),
        relocatedRoots(),
        validScope(),
        (base, roots, scope) => {
          const relocated = importLayoutRelocatedAs(base, roots);
          const rescoped = importLayoutRescopedAs(base, scope);

          const baseMessages = violationsOf(base);
          if (baseMessages.length > 0) withViolations += 1;

          const baseCanonical = canonical(baseMessages, base);

          // Relocation: the violation set is identical once each reported file
          // path's root prefix is factored out (R7.2, R7.3, R7.9).
          expect(canonical(violationsOf(relocated), relocated)).toEqual(
            baseCanonical,
          );

          // Rename: the violation set is identical once each reported by-name
          // specifier's scope is factored out (R7.4, R7.5, R7.6, R7.9).
          expect(canonical(violationsOf(rescoped), rescoped)).toEqual(
            baseCanonical,
          );

          // Combined: relocating AND renaming leaves the same canonical set.
          const both = importLayoutRescopedAs(
            importLayoutRelocatedAs(base, roots),
            scope,
          );
          expect(canonical(violationsOf(both), both)).toEqual(baseCanonical);
        },
      ),
      { numRuns: 200 },
    );

    expect(withViolations).toBeGreaterThan(0);
  });

  it("names the file by a repo-relative path and the specifier verbatim (concrete)", () => {
    const layout: ImportLayoutDescription = {
      packages: [
        {
          category: "microservice",
          dirName: "alpha",
          files: [
            {
              relPathInPackage: "src/index.ts",
              specifiers: [
                { label: "peer", targetDirName: "beta" },
                { label: "escape", relative: "../../elsewhere/thing.js" },
              ],
            },
          ],
        },
        {
          category: "microservice",
          dirName: "beta",
          files: [],
        },
      ],
      roots: DEFAULT_ROOTS,
      scope: defaultEffectiveConfig().scope,
    };

    const messages = violationsOf(layout);
    const alphaFile = "packages/microservices/alpha/src/index.ts";

    expect(
      messages.some(
        (m) =>
          m.startsWith("[imports:peer] ") &&
          m.includes(`"${alphaFile}"`) &&
          m.includes('"@microservices/beta"'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.startsWith("[imports:escape] ") &&
          m.includes(`"${alphaFile}"`) &&
          m.includes('"../../elsewhere/thing.js"'),
      ),
    ).toBe(true);
  });
});

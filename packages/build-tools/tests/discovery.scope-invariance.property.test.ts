// Feature: config-driven-discovery, Property 12: Discovery is invariant under a
// consistent scope rename.
//
// For any Synthesized_Tree and any ordered pair of distinct Valid_Scopes,
// rewriting every declared package `name`, every Dependency_Specifier, and every
// composed Framework_Singleton name from the first scope to the second yields,
// for each Consumer_Category, a discovery result identical to the original in
// order, directory name, recorded directory, build kind, and Dependency_Specifier
// list once the scope prefix is disregarded, and neither run reports an error.
//
// The property is exercised through `discoverPackagesFrom(context, listRoot,
// readManifest)` over the in-memory Synthesized_Trees of `arbitraries/tree.ts`.
// The rename is a pure transformation of the tree's `scope` field (`rescopedAs`),
// and `treeInputs` recomposes every declared name and every dependency specifier
// from that field — so a conforming name keeps mirroring `<scope>/<dir>` under
// the new scope, which is exactly the "consistent" rename the property means.
// The context threaded into each run is built from the tree's own scope, so a
// package name and the name discovery expects it to mirror are rewritten
// together; a rename that touched only one would surface as a `[discovery:mirror]`
// failure, which the "neither run errors" assertion would catch.
//
// "Once the scope prefix is disregarded": a declared name is `<scope>/<dir>` and
// a specifier is `<scope>/<dep>`, so stripping the leading `<scope>/` from each
// yields a scope-free projection that must match across the two runs.
//
// Validates: Requirements 6.6, 6.7, 6.8, 14.6

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  discoverPackagesFrom,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import {
  CONSUMER_CATEGORIES,
} from "../src/framework.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  DEFAULT_ROOTS,
  rescopedAs,
  synthesizedTree,
  treeInputs,
  validScope,
  type TreeDescription,
} from "./arbitraries/tree.js";

/** A context at the default roots under the given scope. Only the scope varies
 *  between the two runs, so roots and recorded directories stay constant. */
function contextWithScope(scope: string) {
  const base = defaultEffectiveConfig();
  return projectContext({ ...base, scope });
}

/** Runs the pure discovery core over a description under its own scope, catching
 *  any thrown validation failure so "neither run errors" is assertable. */
function tryDiscover(
  description: TreeDescription,
): { readonly ok: true; readonly discovery: Discovery } | { readonly ok: false; readonly message: string } {
  const { listRoot, readManifest } = treeInputs(description);
  try {
    return {
      ok: true,
      discovery: discoverPackagesFrom(
        contextWithScope(description.scope),
        listRoot,
        readManifest,
      ),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Strips a `<scope>/` prefix, leaving the scope-free remainder. A name or
 *  specifier that does not carry the scope is returned unchanged, which is how a
 *  non-scoped dependency (never produced by a conforming tree) would still be
 *  comparable. */
function withoutScope(value: string, scope: string): string {
  const prefix = `${scope}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** A discovered package projected scope-free: every field, with the scope
 *  stripped from the declared name and from each dependency specifier. */
function scopeFreeFields(pkg: ConsumerPackage, scope: string) {
  return {
    category: pkg.category,
    dirName: pkg.dirName,
    packageDir: pkg.packageDir,
    buildKind: pkg.buildKind,
    name: withoutScope(pkg.name, scope),
    dependencySpecifiers: pkg.dependencySpecifiers.map((specifier) =>
      withoutScope(specifier, scope),
    ),
  };
}

describe("Property 12: discovery is invariant under a consistent scope rename", () => {
  it("yields scope-free-identical results under any ordered pair of distinct scopes", () => {
    let nonEmpty = 0;

    fc.assert(
      fc.property(
        synthesizedTree(),
        validScope(),
        validScope(),
        (baseTree, scopeA, scopeB) => {
          // Only distinct scopes exercise the rename; equal ones are discarded
          // without failing.
          fc.pre(scopeA !== scopeB);

          const treeA = rescopedAs(baseTree, scopeA);
          const treeB = rescopedAs(baseTree, scopeB);

          const runA = tryDiscover(treeA);
          const runB = tryDiscover(treeB);

          // Neither run reports an error (R6.8): a consistent rename keeps every
          // name mirroring its directory, so no validation stage fails.
          expect(runA.ok, runA.ok ? "" : runA.message).toBe(true);
          expect(runB.ok, runB.ok ? "" : runB.message).toBe(true);
          if (!runA.ok || !runB.ok) return;

          if (baseTree.packages.length > 0) nonEmpty += 1;

          for (const category of CONSUMER_CATEGORIES) {
            const before = runA.discovery.byCategory[category];
            const after = runB.discovery.byCategory[category];

            // Equal length and same order (R6.6): compare positionally, scope
            // stripped from names and specifiers on each side.
            expect(after).toHaveLength(before.length);
            expect(
              after.map((pkg) => scopeFreeFields(pkg, scopeB)),
            ).toEqual(before.map((pkg) => scopeFreeFields(pkg, scopeA)));
          }

          // The declared-name sets match once the scope is stripped (R6.7): the
          // resolution index keys differ only by their scope prefix.
          expect(
            [...runB.discovery.byName.keys()]
              .map((name) => withoutScope(name, scopeB))
              .sort(),
          ).toEqual(
            [...runA.discovery.byName.keys()]
              .map((name) => withoutScope(name, scopeA))
              .sort(),
          );
        },
      ),
      { numRuns: 200 },
    );

    expect(nonEmpty).toBeGreaterThan(0);
  });

  it("renames names and specifiers together, keeping mirroring intact (concrete)", () => {
    const base: TreeDescription = {
      packages: [
        {
          category: "common",
          dirName: "config",
          dependencyDirNames: [],
          defect: undefined,
        },
        {
          category: "microservice",
          dirName: "alpha",
          dependencyDirNames: ["config"],
          defect: undefined,
        },
      ],
      roots: DEFAULT_ROOTS,
      scope: defaultEffectiveConfig().scope,
    };

    const runDefault = tryDiscover(base);
    const runRenamed = tryDiscover(rescopedAs(base, "@acme"));

    expect(runDefault.ok).toBe(true);
    expect(runRenamed.ok).toBe(true);
    if (!runDefault.ok || !runRenamed.ok) return;

    const alphaDefault = runDefault.discovery.byName.get(
      "@microservices/alpha",
    ) as ConsumerPackage;
    const alphaRenamed = runRenamed.discovery.byName.get(
      "@acme/alpha",
    ) as ConsumerPackage;

    expect(alphaDefault.dependencySpecifiers).toEqual(["@microservices/config"]);
    expect(alphaRenamed.dependencySpecifiers).toEqual(["@acme/config"]);
    expect(alphaRenamed.packageDir).toBe(alphaDefault.packageDir);
  });
});

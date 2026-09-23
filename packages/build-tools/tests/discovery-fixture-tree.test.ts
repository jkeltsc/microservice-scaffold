// Feature: platform-fixtures — the Fixture_Equivalent of the payload-coupled
// per-category Package_Discovery claim (design "the ordering argument").
//
// `discovery-real-tree.test.ts` is a Payload_Coupled_Test: it runs
// `discoverPackages(context)` over the committed `packages/` tree and asserts the
// exact per-category rows the Data Models table fixes. Every one of its
// assertions would change if a package of the Payload_Tree were renamed,
// relocated, or removed, so it is coupled to the payload. This suite is its
// Fixture_Equivalent (R13.1): it makes the SAME KIND of claim — run
// Package_Discovery, assert the per-category result — but over a Tree_Fixture
// instead of the committed `packages/` tree, and asserts NO fact about the
// Payload_Tree (R13.7). The two passing together is the evidence that the fixture
// subjects are faithful stand-ins for the payload the coupled test still guards.
//
// The per-category claim, stated as an OUTCOME. The payload-coupled test asserts
// "discovery over this tree yields per-category rows X"; over a hostile
// Tree_Fixture that same claim reads "discovery over this tree yields outcome X",
// where X is the Diagnostic_Tag the tree provokes when the per-category rows
// cannot be produced. So the equivalent runs BOTH routes into Package_Discovery
// over one fixture subject — the effect shell `discoverPackages` reading the
// fixture from disk, and the pure core `discoverPackagesFrom` over the in-memory
// transcription of that SAME fixture — and asserts they land on the identical
// per-category outcome: the same `byCategory` sequences when discovery succeeds,
// the same thrown Diagnostic_Tag when it does not. Agreement over a fixture is
// the payload-coupled test's structure (run discovery, assert the result)
// re-expressed over a fixture subject.
//
// Derived-configuration discipline (R13.2): every Discovery_Root and every
// Configured_Scope this suite discovers against comes from the SUBJECT fixture's
// own `scaffold.config.json` (or the defaults when it declares none), read
// through `fixtureConfig` below. The suite spells no `packages/...` path literal
// and no `@microservices` scope literal of its own, so it re-imports none of the
// assumptions the payload-coupled test carried.
//
// Worktree discipline: the committed fixtures are read only — never installed,
// never built, never written to. The one effect is a `process.chdir` into the
// fixture directory, restored in a `finally`.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.7

import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPackages,
  discoverPackagesFrom,
  type ConsumerPackage,
  type Discovery,
  type ListRoot,
  type ManifestRead,
  type PackageManifest,
  type ReadManifest,
  type RootEntry,
} from "../src/discovery.js";
import { CONSUMER_CATEGORIES, type ConsumerCategory } from "../src/framework.js";
import {
  defaultEffectiveConfig,
  PROJECT_CONFIG_FILE,
  type EffectiveConfig,
} from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import { FIXTURES_ROOT } from "./fixture-paths.js";
import { type RootAssignment } from "./arbitraries/tree.js";

const TREES_ROOT = join(FIXTURES_ROOT, "trees");

// ---------------------------------------------------------------------------
// Comparable projection of a discovered package — the same per-category fields
// the payload-coupled test compares (category, directory name, declared name,
// build kind, and the Dependency_Specifier list element-by-element in order).
// `packageDir` carries the (possibly relocated) root prefix both routes derive
// from the same roots, so it is equal by construction and not the substance of
// the claim.
// ---------------------------------------------------------------------------

function comparablePackage(pkg: ConsumerPackage) {
  return {
    category: pkg.category,
    dirName: pkg.dirName,
    name: pkg.name,
    buildKind: pkg.buildKind,
    dependencySpecifiers: [...pkg.dependencySpecifiers],
  };
}

/** A discovery result projected per category into the comparable shape, one
 *  sequence per Consumer_Category in the fixed category order — the per-category
 *  view the payload-coupled test asserts, over a fixture subject. */
function comparableByCategory(discovery: Discovery) {
  const out = {} as Record<
    ConsumerCategory,
    ReturnType<typeof comparablePackage>[]
  >;
  for (const category of CONSUMER_CATEGORIES) {
    out[category] = discovery.byCategory[category].map(comparablePackage);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-category outcome: either the per-category rows discovery produced, or
// the Diagnostic_Tag it threw when it could not produce them. Both routes into
// Package_Discovery over one fixture must land on the identical outcome.
// ---------------------------------------------------------------------------

type DiscoveryOutcome =
  | {
      readonly kind: "ok";
      readonly byCategory: Record<
        ConsumerCategory,
        ReturnType<typeof comparablePackage>[]
      >;
    }
  | { readonly kind: "tag"; readonly tag: string };

/** The bracket tag `[category:detail]` recovered from a thrown discovery error.
 *  Discovery frames every failure as a leading bracketed tag, so the first match
 *  is the Diagnostic_Tag. */
function tagOf(value: unknown): string | undefined {
  const message = value instanceof Error ? value.message : String(value);
  const match = /\[[a-z][a-z-]*:[a-z][a-z-]*\]/.exec(message);
  return match?.[0];
}

/** Runs a discovery thunk and reduces it to a per-category outcome: the per-
 *  category rows if it returned, the recovered Diagnostic_Tag if it threw one. A
 *  throw carrying no recognisable tag re-propagates — that is a genuine failure,
 *  not an outcome to compare. */
function outcomeOf(run: () => Discovery): DiscoveryOutcome {
  try {
    return { kind: "ok", byCategory: comparableByCategory(run()) };
  } catch (error) {
    const tag = tagOf(error);
    if (tag === undefined) throw error;
    return { kind: "tag", tag };
  }
}

// ---------------------------------------------------------------------------
// The subject's own configuration — every root and the scope come from the
// fixture's scaffold.config.json (or the defaults when absent). No literal here.
// ---------------------------------------------------------------------------

/** Reads a fixture's `scaffold.config.json` if present, else the defaults. The
 *  committed discovery fixtures declare none, so this yields the default scope
 *  and roots — which is what makes their `<microservice-root>/...` layout
 *  discoverable — but the derivation is the fixture's own, never a substituted
 *  literal. */
function fixtureConfig(fixtureDir: string): EffectiveConfig {
  const base = defaultEffectiveConfig();
  let declared: Record<string, unknown> = {};
  try {
    declared = JSON.parse(
      readFileSync(join(fixtureDir, PROJECT_CONFIG_FILE), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return base;
  }
  const roots = (declared.roots ?? {}) as Partial<RootAssignment>;
  return {
    scope: typeof declared.scope === "string" ? declared.scope : base.scope,
    roots: {
      microservice: roots.microservice ?? base.roots.microservice,
      common: roots.common ?? base.roots.common,
      spa: roots.spa ?? base.roots.spa,
    },
    entry: typeof declared.entry === "string" ? declared.entry : base.entry,
  };
}

/**
 * The pure core's two injected readers, built by transcribing a fixture read
 * from disk into memory: `listRoot` answers each configured Discovery_Root with
 * its direct entries, and `readManifest` returns the exact manifest read state
 * for each package directory. This is the in-memory transcription of the SAME
 * fixture the effect shell reads, so the two routes differ only in whether they
 * touch the real filesystem — the payload-coupled test's "discovery over the
 * tree" made against a fixture, twice, and required to agree.
 */
function transcribe(
  fixtureDir: string,
  config: EffectiveConfig,
): { readonly listRoot: ListRoot; readonly readManifest: ReadManifest } {
  const rootToCategory = new Map<string, ConsumerCategory>(
    CONSUMER_CATEGORIES.map((category) => [config.roots[category], category]),
  );

  const listRoot: ListRoot = (rootDir): readonly RootEntry[] | undefined => {
    if (!rootToCategory.has(rootDir)) return undefined;
    const absolute = join(fixtureDir, ...rootDir.split("/"));
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return undefined;
    }
    return entries.map((entry) => {
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(join(absolute, entry.name)).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      return { name: entry.name, isDirectory };
    });
  };

  const readManifest: ReadManifest = (packageDir): ManifestRead => {
    const manifestPath = join(
      fixtureDir,
      ...packageDir.split("/"),
      "package.json",
    );
    let text: string;
    try {
      text = readFileSync(manifestPath, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR"
        ? { kind: "absent" }
        : { kind: "unreadable" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "unparsable" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unparsable" };
    }
    return { kind: "ok", manifest: parsed as PackageManifest };
  };

  return { listRoot, readManifest };
}

/** The committed `discovery--*` Tree_Fixtures — the fixtures whose fault lives in
 *  Package_Discovery, so both discovery routes reach it and the per-category
 *  claim has a subject. */
function discoveryFixtures(): readonly string[] {
  return readdirSync(TREES_ROOT, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("discovery--"),
    )
    .map((entry) => entry.name)
    .sort();
}

describe("Feature: platform-fixtures: the per-category Package_Discovery claim over a Tree_Fixture (Fixture_Equivalent of discovery-real-tree)", () => {
  const fixtures = discoveryFixtures();

  it("has committed discovery Tree_Fixtures to assert over", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    it(`${name}: the effect shell over the fixture on disk and the pure core over its transcription yield the identical per-category outcome`, () => {
      const fixtureDir = join(TREES_ROOT, name);
      // The subject's OWN configuration — no path literal, no scope literal.
      const config = fixtureConfig(fixtureDir);
      const context = projectContext(config);

      // Route B — the effect shell, reading the fixture from disk with its
      // directory as the Project_Directory. Read only: no write, no install.
      const previousCwd = process.cwd();
      let onDisk: DiscoveryOutcome;
      try {
        process.chdir(fixtureDir);
        onDisk = outcomeOf(() => discoverPackages(context));
      } finally {
        process.chdir(previousCwd);
      }

      // Route A — the pure core over the in-memory transcription of that SAME
      // fixture, touching no filesystem after the transcription is built.
      const { listRoot, readManifest } = transcribe(fixtureDir, config);
      const inMemory = outcomeOf(() =>
        discoverPackagesFrom(context, listRoot, readManifest),
      );

      // The per-category claim over a fixture subject: both routes into
      // Package_Discovery land on the identical outcome — the same byCategory
      // sequences on success, the same Diagnostic_Tag on failure.
      expect(onDisk).toEqual(inMemory);
    });
  }
});

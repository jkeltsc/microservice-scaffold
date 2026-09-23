// Feature: platform-fixtures — the Fixture_Equivalent of the payload-coupled
// Workspace_Build_Order and Project_List claim (design "the ordering argument",
// Testing Strategy table: "Derived build order and Project_List — Tree_Fixture —
// the Build_Sequence is a derivation over discovered records, not over compiled
// output").
//
// `workspace-build-order-real-tree.test.ts` is a Drift_Detector: it runs the
// Workspace_Build_Order derivation over the committed `packages/` tree and pins
// the one order that tree produces. It is retained on purpose (R14.1) and is NOT
// what this suite mirrors — a Drift_Detector's whole point is to assert the ONE
// order the committed Payload_Tree yields, and re-stating that would be a second
// Drift_Detector, not a Fixture_Equivalent. What this suite mirrors instead is
// the *claim* that the payload-coupled test embodies: run the SAME derivation —
// `workspaceBuildOrder(context, workspaceNodesFrom(discoverPackages(context),
// readDependencySpecifiers(context)))` for the whole-workspace build order, and
// `buildPlan(context).tscRoots` / `projectListFrom(...)` for the Project_List —
// and assert the derived order (the package directories in order) and the
// Project_List (the ordered `tsc --build` roots) it produces. This suite makes
// that claim over a Tree_Fixture subject instead of the committed tree, and
// asserts NO fact about the Payload_Tree (R13.7). The two passing together is the
// evidence the fixture subject is a faithful stand-in for the payload the
// Drift_Detector still guards.
//
// Why a MATERIALISED Synthesized_Tree rather than a committed `fixtures/trees/`
// fixture: every committed Tree_Fixture is HOSTILE — each provokes a discovery or
// config Diagnostic_Tag, so Package_Discovery over it THROWS rather than yielding
// discoverable records, and the Build_Sequence derivation has no subject to order.
// A derived build order and Project_List claim needs a WELL-FORMED tree that
// discovery succeeds over, so the subject is a `Synthesized_Tree` with an
// Entry_Package that the shared `materializeEntryTree` writes into an OS temporary
// directory — a fixture the same way the committed trees are, just one that must
// succeed rather than fail, so it is built rather than committed. It is discovered
// from disk exactly as the CLI shell discovers the real tree, so the derivation
// runs over records read from a real filesystem, not composed inline.
//
// Derived-configuration discipline (R13.2): every Discovery_Root, the
// Configured_Scope, and the Entry_Root come from the SUBJECT tree's own
// description, threaded through `projectContext(effectiveConfigOf(description))`.
// The suite spells no `packages/...` path literal and no `@microservices` scope
// literal of its own; every package directory it asserts against is composed from
// the subject's own roots and identifiers. The subject deliberately uses a
// Configured_Scope OTHER than the Scope_Default and a set of Discovery_Roots ALL
// differing from their Root_Defaults, so the fixture subject does not silently
// re-import the assumptions the payload-coupled test carried (R13.6 — both halves
// reinforced here as well as in registry-generator-fixture.test.ts).
//
// Worktree discipline (R11.2, R11.3): the materialised tree lives inside ONE
// temporary root created in `beforeAll` and removed in `afterAll`, whether the
// assertions pass or fail. `materializeEntryTree` refuses any destination outside
// the OS temporary directory, and discovery reads manifests only — it never builds
// and never writes. `cwd` is pinned to the materialised tree and restored in a
// `finally`. Nothing is written into the checked-out tree, and no committed fixture
// is touched.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.6, 13.7

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPlan } from "../src/build-plan.js";
import { discoverPackages, readDependencySpecifiers } from "../src/discovery.js";
import { projectListFrom } from "../src/dev-supervisor.js";
import { projectContext } from "../src/project-context.js";
import {
  workspaceBuildOrder,
  workspaceNodesFrom,
} from "../src/workspace-build-order.js";
import {
  effectiveConfigOf,
  materializeEntryTree,
  removeMaterializedTree,
  type EntryTreeDescription,
  type PackageSpec,
} from "./arbitraries/tree.js";

// ---------------------------------------------------------------------------
// The subject fixture — a well-formed Synthesized_Tree with an Entry_Package, at
// a Configured_Scope OTHER than the default and with a set of Discovery_Roots ALL
// differing from their defaults (R13.6). Written as a fixed description so the
// claim is a deterministic example the way the payload-coupled real-tree
// build-order test is a deterministic example — no `@microservices` literal and
// no default `packages/...` root appears. The Framework_Singletons (`contracts`,
// `build-tools`, `overseer`, `integration-tests`) and the Entry_Package are
// written by `materializeEntryTree`; only the Consumer_Packages are described
// here.
// ---------------------------------------------------------------------------

const SUBJECT_SCOPE = "@acme";
const SUBJECT_ROOTS = {
  microservice: "services",
  common: "libs",
  spa: "frontends",
} as const;
const SUBJECT_ENTRY_ROOT = "entrypoint";

/** Two Common_Packages with one declared edge between them, three microservices,
 *  and one spa — a non-trivial per-category layout so the derived order carries
 *  every Build_Sequence statement and the intra-`common` edge (statement 3's only
 *  calculated order) is exercised. `extended` declares `base`, so the derivation
 *  must place `base` before `extended` within statement 3. Each microservice
 *  declares only directory-mirroring scoped dependencies drawn from this same
 *  tree, so under `SUBJECT_SCOPE` every specifier resolves. */
const SUBJECT_PACKAGES: readonly PackageSpec[] = [
  {
    category: "common",
    dirName: "base",
    dependencyDirNames: [],
    defect: undefined,
  },
  {
    category: "common",
    dirName: "extended",
    dependencyDirNames: ["base"],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "alpha",
    dependencyDirNames: ["base"],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "bravo",
    dependencyDirNames: ["extended"],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "charlie",
    dependencyDirNames: [],
    defect: undefined,
  },
  {
    category: "spa",
    dirName: "web",
    dependencyDirNames: [],
    defect: undefined,
  },
];

const SUBJECT: EntryTreeDescription = {
  packages: SUBJECT_PACKAGES,
  roots: SUBJECT_ROOTS,
  scope: SUBJECT_SCOPE,
  entryRoot: SUBJECT_ENTRY_ROOT,
};

// The context threads the subject's OWN scope, roots and Entry_Root — no literal
// is substituted. Every package directory the order claim compares against is
// composed from the subject's own roots below.
const context = projectContext(effectiveConfigOf(SUBJECT));

/** A package directory under the subject's OWN configured roots — the suite's
 *  statement of where a package lands, composed from the subject's roots rather
 *  than a `packages/...` literal. */
function serviceDir(id: string): string {
  return `${SUBJECT_ROOTS.microservice}/${id}`;
}
function commonDir(name: string): string {
  return `${SUBJECT_ROOTS.common}/${name}`;
}
function spaDir(name: string): string {
  return `${SUBJECT_ROOTS.spa}/${name}`;
}

/** The four Framework_Singleton directories, in `packages/` (their location is
 *  fixed regardless of scope), plus the Entry_Root — the fixed positions the
 *  Build_Sequence emits around the Consumer_Packages. Read from the context's own
 *  framework records and Entry_Root, never spelled here beyond the fixed
 *  Framework_Singleton directory names the layout rule pins. */
const CONTRACTS_DIR = context.framework.contracts.packageDir;
const BUILD_TOOLS_DIR = context.framework.buildTools.packageDir;
const OVERSEER_DIR = context.framework.overseer.packageDir;
const INTEGRATION_TESTS_DIR = context.framework.integrationTests.packageDir;
const ENTRY_DIR = context.entryRoot;

/**
 * Derives the whole-workspace Workspace_Build_Order over the materialised subject,
 * exactly as the CLI shell derives it over the real tree, and returns the ordered
 * package directories.
 */
function deriveOrder(materializedDir: string): readonly string[] {
  const previousCwd = process.cwd();
  try {
    process.chdir(materializedDir);
    const nodes = workspaceNodesFrom(
      context,
      discoverPackages(context),
      readDependencySpecifiers(context),
    );
    return workspaceBuildOrder(context, nodes).map((node) => node.packageDir);
  } finally {
    process.chdir(previousCwd);
  }
}

/** Derives the Project_List (the ordered `tsc --build` roots) over the
 *  materialised subject for a given Selector, through the same `buildPlan` the
 *  image and dev paths derive it from, and cross-checks it against the pure
 *  `projectListFrom` over the same discovery. */
function deriveProjectList(
  materializedDir: string,
  selector: string,
): readonly string[] {
  const previousCwd = process.cwd();
  try {
    process.chdir(materializedDir);
    const discovery = discoverPackages(context);
    const readDependencies = readDependencySpecifiers(context);
    const plan = buildPlan(context, selector);
    const viaProjectListFrom = projectListFrom(
      context,
      selector,
      discovery,
      readDependencies,
    );
    // `buildPlan.tscRoots` and `projectListFrom` are the same derivation over one
    // plan (design R13.8); assert they agree so the Project_List claim is not
    // read off a single path that could drift.
    expect(viaProjectListFrom).toEqual(plan.tscRoots);
    return plan.tscRoots;
  } finally {
    process.chdir(previousCwd);
  }
}

describe("Feature: platform-fixtures: the derived build order and Project_List over a Tree_Fixture (Fixture_Equivalent of workspace-build-order-real-tree)", () => {
  let tempRoot: string;

  beforeAll(() => {
    // ONE temporary root for the whole suite; the subject tree lives in a
    // subdirectory of it.
    tempRoot = mkdtempSync(join(tmpdir(), "build-order-fixture-"));
  });

  afterAll(() => {
    // Runs whether the assertions passed or failed. `removeMaterializedTree`
    // refuses a destination outside the OS temporary directory.
    if (tempRoot !== undefined) removeMaterializedTree(tempRoot);
  });

  it("uses a non-default Configured_Scope and non-default Discovery_Roots (R13.6)", () => {
    // Guards that the subject genuinely differs from the defaults, so the claims
    // below are not silently re-importing the Drift_Detector's assumptions.
    const defaults = projectContext(
      effectiveConfigOf({
        ...SUBJECT,
        scope: "@microservices",
        roots: {
          microservice: "packages/microservices",
          common: "packages/common",
          spa: "packages/spa",
        },
      }),
    );
    expect(context.scopedName("alpha")).not.toBe(defaults.scopedName("alpha"));
    expect(SUBJECT.roots.microservice).not.toBe(defaults.roots.microservice);
    expect(SUBJECT.roots.common).not.toBe(defaults.roots.common);
    expect(SUBJECT.roots.spa).not.toBe(defaults.roots.spa);
  });

  it("yields the whole-workspace build order the Build_Sequence produces over the fixture, in that order", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    try {
      // The expected order is the suite's OWN statement of the Build_Sequence's
      // eight statements over the subject's per-category membership, composed from
      // the subject's own roots: statement 1 `contracts`; statement 2
      // `build-tools`; statement 3 the two Common_Packages (`base` before
      // `extended` — the one declared intra-`common` edge); statement 4 the three
      // microservices in `packageDir` code-point order; statement 5 the Overseer;
      // statement 6 the Entry_Package; statement 7 `integration-tests`; statement
      // 8 the single Spa_Package last.
      const expected = [
        CONTRACTS_DIR,
        BUILD_TOOLS_DIR,
        commonDir("base"),
        commonDir("extended"),
        serviceDir("alpha"),
        serviceDir("bravo"),
        serviceDir("charlie"),
        OVERSEER_DIR,
        ENTRY_DIR,
        INTEGRATION_TESTS_DIR,
        spaDir("web"),
      ];
      expect(deriveOrder(materialized.dir)).toEqual(expected);
    } finally {
      removeMaterializedTree(materialized.dir);
    }
  });

  it("places contracts first (statement 1) and integration-tests before the Spa phase (statement 7) over the fixture", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    try {
      const order = deriveOrder(materialized.dir);
      // Not a graph consequence: these are the Build_Sequence's fixed statement
      // positions, the same claim the Drift_Detector makes over the real tree.
      expect(order[0]).toBe(CONTRACTS_DIR);
      const integrationIdx = order.indexOf(INTEGRATION_TESTS_DIR);
      const spaIdx = order.indexOf(spaDir("web"));
      expect(integrationIdx).toBeGreaterThanOrEqual(0);
      expect(spaIdx).toBe(integrationIdx + 1);
      expect(spaIdx).toBe(order.length - 1);
    } finally {
      removeMaterializedTree(materialized.dir);
    }
  });

  it("places the Entry_Package after the Overseer and before integration-tests (statement 6) over the fixture", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    try {
      const order = deriveOrder(materialized.dir);
      const overseerIdx = order.indexOf(OVERSEER_DIR);
      const entryIdx = order.indexOf(ENTRY_DIR);
      const integrationIdx = order.indexOf(INTEGRATION_TESTS_DIR);
      expect(entryIdx).toBe(overseerIdx + 1);
      expect(integrationIdx).toBe(entryIdx + 1);
    } finally {
      removeMaterializedTree(materialized.dir);
    }
  });

  it("derives, for the all-Selector, the Project_List the Build_Sequence produces over the fixture, in that order", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    try {
      // The image-path Project_List (the ordered `tsc --build` roots) over the
      // all-Selector: statement 1 `contracts`, statement 3 the required
      // Common_Packages (both are reached — `base` by `alpha`, `extended` by
      // `bravo`, and `base` again transitively — so both compile, `base` first),
      // statement 4 the three microservices, statement 5 the Overseer, statement 6
      // the Entry_Package. No `build-tools`, no `integration-tests`, no Spa_Package
      // (those never reach the image `tsc --build`).
      const expected = [
        CONTRACTS_DIR,
        commonDir("base"),
        commonDir("extended"),
        serviceDir("alpha"),
        serviceDir("bravo"),
        serviceDir("charlie"),
        OVERSEER_DIR,
        ENTRY_DIR,
      ];
      expect(deriveProjectList(materialized.dir, "*")).toEqual(expected);
    } finally {
      removeMaterializedTree(materialized.dir);
    }
  });

  it("derives, for a single-microservice Selector, the minimal Project_List over the fixture", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    try {
      // `charlie` alone: it declares no Common_Package, so no `common` member is
      // required. The roots are statement 1 `contracts`, statement 4 the one
      // Selected_Microservice, statement 5 the Overseer, statement 6 the
      // Entry_Package — minimality by construction, no unrequired Common_Package.
      const expected = [
        CONTRACTS_DIR,
        serviceDir("charlie"),
        OVERSEER_DIR,
        ENTRY_DIR,
      ];
      expect(deriveProjectList(materialized.dir, "charlie")).toEqual(expected);
    } finally {
      removeMaterializedTree(materialized.dir);
    }
  });
});

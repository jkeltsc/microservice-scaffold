// Feature: platform-fixtures — the Fixture_Equivalent of the payload-coupled
// Registry_Generator claim (design "the ordering argument").
//
// `registry-generator.property.test.ts` (registry-inversion Property 1) is the
// payload-coupled claim about the Registry_Generator: the sequence of import
// specifiers it emits equals the Configured_Scope followed by `/` and each
// Selected_Microservice's directory name, in R4.3 order, with the entry
// sequence carrying the same specifiers and identifiers. This suite is its
// Fixture_Equivalent (R13.1): it asserts the SAME claim — the emitted import
// specifiers, `sourcePackage` values, and `identifier` entries — but over a
// materialised Tree_Fixture discovered from disk rather than over identifiers
// composed inline, and it asserts NO fact about the committed Payload_Tree
// (R13.7). The two passing together is the evidence that a discovered fixture
// subject yields the registry the payload-coupled test asserts over composed
// identifiers.
//
// Why a materialised tree rather than a committed Tree_Fixture: every committed
// Tree_Fixture under `fixtures/trees/` is hostile — each provokes a discovery or
// config Diagnostic_Tag, so Package_Discovery over it THROWS rather than yielding
// discoverable microservices, and the Registry_Generator's per-microservice
// emission has no subject. This equivalent therefore uses a Synthesized_Tree
// with an Entry_Package — a well-formed fixture tree the shared `materializeEntryTree`
// writes into an OS temporary directory — as its subject: discovery over it
// SUCCEEDS and yields microservices, which is exactly what the emitted-specifier
// claim needs. It is a fixture the same way the committed trees are, just one
// that must succeed rather than fail, so it is built rather than committed.
//
// Derived-configuration discipline (R13.2): every Discovery_Root, the
// Configured_Scope, and the Entry_Root come from the SUBJECT tree's own
// description, threaded through `projectContext(effectiveConfigOf(description))`
// and read back through `context.scopedName(...)`. The suite spells no
// `packages/...` path literal and no `@microservices` scope literal of its own.
// The subject deliberately uses a Configured_Scope OTHER than the Scope_Default
// and a set of Discovery_Roots ALL differing from their Root_Defaults, so the
// fixture subject does not silently re-import the assumptions the payload-coupled
// test carried (R13.6 — the scope half is discharged here; the roots half too).
//
// Worktree discipline (R11.2, R11.3): every byte this suite writes — the
// materialised tree AND the registry `generateRegistry` writes under it — lands
// inside ONE temporary root created in `beforeAll` and removed in `afterAll`,
// whether the assertions pass or fail. `materializeEntryTree` refuses any
// destination outside the OS temporary directory, and `generateRegistry`
// resolves its output path against `cwd`, which is pinned to the materialised
// tree and restored in a `finally`. Nothing is written into the checked-out
// tree, and no committed fixture is touched.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.7

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverPackages } from "../src/discovery.js";
import {
  generateRegistry,
  generatedRegistryPath,
  registryText,
} from "../src/generate-registry.js";
import { projectContext } from "../src/project-context.js";
import { resolveSelected } from "../src/selector.js";
import {
  effectiveConfigOf,
  materializeEntryTree,
  removeMaterializedTree,
  type EntryTreeDescription,
  type PackageSpec,
} from "./arbitraries/tree.js";

// ---------------------------------------------------------------------------
// The subject fixture — a well-formed Synthesized_Tree with an Entry_Package,
// at a Configured_Scope OTHER than the default and with a set of Discovery_Roots
// ALL differing from their defaults (R13.6). Written as a fixed description so
// the claim is a deterministic example the way the payload-coupled real-tree
// discovery test is a deterministic example — no `@microservices` literal and no
// default `packages/...` root appears.
// ---------------------------------------------------------------------------

const SUBJECT_SCOPE = "@acme";
const SUBJECT_ROOTS = {
  microservice: "services",
  common: "libs",
  spa: "frontends",
} as const;
const SUBJECT_ENTRY_ROOT = "entrypoint";

/** Three microservices, one common package, one spa — a non-trivial per-category
 *  layout so the emitted registry carries several entries in a fixed order. The
 *  microservice directory names are distinct Microservice_Identifiers; each
 *  declares only directory-mirroring scoped dependencies drawn from this same
 *  tree, so under `SUBJECT_SCOPE` every specifier resolves. */
const SUBJECT_PACKAGES: readonly PackageSpec[] = [
  {
    category: "microservice",
    dirName: "alpha",
    dependencyDirNames: ["shared"],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "bravo",
    dependencyDirNames: [],
    defect: undefined,
  },
  {
    category: "microservice",
    dirName: "charlie",
    dependencyDirNames: ["shared"],
    defect: undefined,
  },
  {
    category: "common",
    dirName: "shared",
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

// ---------------------------------------------------------------------------
// Projections of an emitted registry — the emission sites the payload-coupled
// test asserts over: the module import specifiers, the entry `sourcePackage`
// values, and the entry `identifier` values, each in source order.
// ---------------------------------------------------------------------------

/** The microservice import specifiers of an emitted registry, in source order:
 *  one per `import * as mN from "<specifier>";` declaration. The `contracts`
 *  type import is deliberately not matched — it is not a Selected_Microservice. */
function moduleImportSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/^import \* as m\d+ from "([^"]+)";$/gm)].map(
    (match) => match[1] as string,
  );
}

/** The `sourcePackage` values of an emitted registry's entries, in source order. */
function sourcePackages(source: string): readonly string[] {
  return [...source.matchAll(/sourcePackage: "([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

/** The `identifier` values of an emitted registry's entries, in source order. */
function entryIdentifiers(source: string): readonly string[] {
  return [...source.matchAll(/\{ identifier: "([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

describe("Feature: platform-fixtures: the Registry_Generator's emitted specifiers and entries over a Tree_Fixture (Fixture_Equivalent of registry-generator Property 1)", () => {
  let tempRoot: string;

  beforeAll(() => {
    // ONE temporary root for the whole suite; the subject tree and every registry
    // written under it live inside subdirectories of this root.
    tempRoot = mkdtempSync(join(tmpdir(), "registry-fixture-"));
  });

  afterAll(() => {
    // Runs whether the assertions passed or failed. `removeMaterializedTree`
    // refuses a destination outside the OS temporary directory.
    if (tempRoot !== undefined) removeMaterializedTree(tempRoot);
  });

  // The context threads the subject's OWN scope, roots and Entry_Root — no
  // literal is substituted. Every scoped name the registry claim compares against
  // is composed from `context.scopedName(...)`, so the assertions carry the
  // subject's `@acme` scope rather than the default.
  const context = projectContext(effectiveConfigOf(SUBJECT));

  it("uses a non-default Configured_Scope and non-default Discovery_Roots (R13.6)", () => {
    // Guards that the subject genuinely differs from the defaults, so the claim
    // below is not silently re-importing the payload-coupled test's assumptions.
    const defaults = projectContext(
      effectiveConfigOf({
        ...SUBJECT,
        scope: "@microservices",
        roots: { microservice: "packages/microservices", common: "packages/common", spa: "packages/spa" },
      }),
    );
    expect(context.scopedName("alpha")).not.toBe(defaults.scopedName("alpha"));
    expect(SUBJECT.roots.microservice).not.toBe(defaults.roots.microservice);
    expect(SUBJECT.roots.common).not.toBe(defaults.roots.common);
    expect(SUBJECT.roots.spa).not.toBe(defaults.roots.spa);
  });

  it("emits, for the all-selector, the scoped import specifier of each discovered microservice, with the entry sequence carrying the same specifiers and identifiers", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    const previousCwd = process.cwd();
    try {
      // Discover the microservices from the materialised fixture ON DISK — this
      // is the fixture subject the claim is asserted over, not composed inline.
      process.chdir(materialized.dir);
      const discovery = discoverPackages(context);

      // The all-selector's Selected_Microservices, in discovery order (R4.3).
      const discoveredIdentifiers = discovery.byCategory.microservice.map(
        (pkg) => pkg.dirName,
      );
      const selected = resolveSelected("*", discoveredIdentifiers);

      // The expected sequence — the suite's OWN statement of the claim, composed
      // from the subject's scope through the context, not a re-read of the code
      // under test. Discovery yields the three microservices in code-point order.
      const expectedIdentifiers = ["alpha", "bravo", "charlie"];
      expect([...selected]).toEqual(expectedIdentifiers);
      const expectedSpecifiers = expectedIdentifiers.map((id) =>
        context.scopedName(id),
      );

      // The pure composer the generator writes through — the emitted text is a
      // function of the subject's context, the selector, and the discovered
      // Selected_Microservices alone.
      const text = registryText(context, "*", [...selected]);

      // R4.3 / R13.1: the import-specifier sequence, element for element.
      expect(moduleImportSpecifiers(text)).toEqual(expectedSpecifiers);
      // R4.4: the entry sequence carries the same specifiers and identifiers, in
      // the same order — the "no extra and no absent" half over both sites.
      expect(sourcePackages(text)).toEqual(expectedSpecifiers);
      expect(entryIdentifiers(text)).toEqual(expectedIdentifiers);
    } finally {
      process.chdir(previousCwd);
      removeMaterializedTree(materialized.dir);
    }
  });

  it("emits, for a comma-separated list selector, exactly the named microservices in the list's order", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    const previousCwd = process.cwd();
    try {
      process.chdir(materialized.dir);
      const discovery = discoverPackages(context);
      const discoveredIdentifiers = discovery.byCategory.microservice.map(
        (pkg) => pkg.dirName,
      );

      // A list in an order that is genuinely not the discovery order, so "the
      // order the identifiers appear in the list" is a real claim.
      const listOrder = ["charlie", "alpha"];
      const selected = resolveSelected(listOrder.join(","), discoveredIdentifiers);
      expect([...selected]).toEqual(listOrder);

      const expectedSpecifiers = listOrder.map((id) => context.scopedName(id));
      const text = registryText(context, listOrder.join(","), [...selected]);

      expect(moduleImportSpecifiers(text)).toEqual(expectedSpecifiers);
      expect(sourcePackages(text)).toEqual(expectedSpecifiers);
      expect(entryIdentifiers(text)).toEqual(listOrder);
    } finally {
      process.chdir(previousCwd);
      removeMaterializedTree(materialized.dir);
    }
  });

  it("writes, through generateRegistry over the discovered fixture, a registry whose emitted specifiers and entries match registryText (the composer the writer uses)", () => {
    const materialized = materializeEntryTree(SUBJECT, tempRoot);
    const previousCwd = process.cwd();
    try {
      // `generateRegistry` resolves its output path against `cwd`; pinning it to
      // the materialised tree keeps the write inside the temporary directory —
      // the registry lands at `<Entry_Root>/src/generated/...` UNDER the subject,
      // never in the checked-out tree.
      process.chdir(materialized.dir);
      const discovery = discoverPackages(context);

      generateRegistry(context, "*", discovery);

      const absolutePath = join(
        materialized.dir,
        generatedRegistryPath(context),
      );
      expect(existsSync(absolutePath)).toBe(true);
      const written = readFileSync(absolutePath, "utf8");

      // The written registry's emission sites carry exactly the scoped specifiers
      // and identifiers of the discovered microservices, in discovery order.
      const expectedIdentifiers = ["alpha", "bravo", "charlie"];
      const expectedSpecifiers = expectedIdentifiers.map((id) =>
        context.scopedName(id),
      );
      expect(moduleImportSpecifiers(written)).toEqual(expectedSpecifiers);
      expect(sourcePackages(written)).toEqual(expectedSpecifiers);
      expect(entryIdentifiers(written)).toEqual(expectedIdentifiers);
    } finally {
      process.chdir(previousCwd);
      removeMaterializedTree(materialized.dir);
    }
  });
});

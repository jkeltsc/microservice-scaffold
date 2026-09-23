// @microservices/build-tools/dist/testing — the shared Fixture_Scenario
// generators (Fixture_Tier spec, task 4.1; R16.3, R16.7, R16.11).
//
// These three generators cross the package boundary the sanctioned way: they
// live under `packages/build-tools/src/`, compile to `dist/testing/`, and are
// imported by compiled path from `@microservices/build-tools/dist/testing/index.js`
// by a package declaring `@microservices/build-tools` as a development
// dependency. They live here rather than in a package-private `tests/arbitraries/`
// module because BOTH packages' property suites draw on them:
//
//   - the Diagnostic_Tag generator and the qualifier generator feed Property 6
//     (`packages/build-tools/tests/scenario-naming.property.test.ts`, task 4.5),
//     which round-trips a generated tag through `scenarioDirectoryName` /
//     `expectedDiagnosticOf`;
//   - the behaviour-preserving perturbation generator feeds Property 2
//     (`packages/integration-tests/tests/fixture-scenario-diagnostics.property.test.ts`,
//     task 4.4), which applies a generated perturbation to a Fixture_Clone of a
//     scenario and asserts the reported Diagnostic_Tag set is unchanged.
//
// R1.7 governs this tree: no source under `packages/build-tools/src/` may spell
// the Fixture_Tier's directory-name token as a path literal, comments included.
// These generators are pure over DESCRIPTIONS and never name the tier: the
// perturbation applier is wholly path-parameterised on a caller-supplied clone
// directory, exactly as the sibling `fixtureClone(sourceDir)` and
// `clearOutput(directory, root)` helpers are. And the `[scope:literal]` check
// (R12.4) forbids spelling this project's default scope here, so a scope this
// module needs is composed generatively or drawn from a fixture-only scope.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// The Diagnostic_Tag generator (Property 6; R16.7)
// ---------------------------------------------------------------------------
//
// A Diagnostic_Tag has the form `[<category>:<detail>]` where both parts are
// non-empty strings of lowercase letters and hyphens (matching the real tag
// shape the Build_System emits — `[config:root-overlap]`, `[build-order:cycle]`,
// `[entry-registry:absent]`). The Scenario_Directory_Name derivation replaces
// the single `:` with `--` and recovers by splitting on the FIRST `--`, so a
// tag must round-trip: its category and its detail each use SINGLE hyphens only,
// and neither part contains the doubled `--` that is reserved for the separator.
// This generator constructs parts that satisfy that constraint by construction.

/** A part (category or detail) of a Diagnostic_Tag: 1 to 20 lowercase letters
 *  and single hyphens, never starting or ending with a hyphen and never holding
 *  the doubled `--` the Scenario_Directory_Name reserves as its separator.
 *
 *  Real categories with an inner hyphen (`build-order`, `entry-registry`,
 *  `image-tree`) are exactly what makes the doubled separator necessary, so the
 *  generator deliberately produces single-hyphenated parts — while never
 *  producing `--`, which would make the name un-recoverable. */
const arbTagPart: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 1,
    maxLength: 10,
  })
  .chain((letters) =>
    // Interleave optional single hyphens BETWEEN letters only, never at an end
    // and never two in a row, so the part matches /^[a-z](-?[a-z])*$/ and holds
    // no `--`.
    fc
      .array(fc.boolean(), {
        minLength: letters.length - 1,
        maxLength: letters.length - 1,
      })
      .map((hyphenAfter) => {
        let out = letters[0]!;
        for (let i = 1; i < letters.length; i += 1) {
          out += (hyphenAfter[i - 1] ? "-" : "") + letters[i]!;
        }
        return out;
      }),
  );

/**
 * A Diagnostic_Tag string of the `[<category>:<detail>]` form (R16.7).
 *
 * Both parts are non-empty lowercase-letter-and-single-hyphen strings holding no
 * `--`, so the pair round-trips through `scenarioDirectoryName` and
 * `expectedDiagnosticOf`: the derivation replaces the single `:` with `--`, and
 * recovery splits on the FIRST (and only) `--`. Property 6 asserts exactly this
 * round-trip and the derivation's injectivity.
 */
export function arbDiagnosticTag(): fc.Arbitrary<string> {
  return fc
    .tuple(arbTagPart, arbTagPart)
    .map(([category, detail]) => `[${category}:${detail}]`);
}

// ---------------------------------------------------------------------------
// The Scenario_Directory_Name qualifier generator (Property 6; R16.7)
// ---------------------------------------------------------------------------

/**
 * An optional Scenario_Directory_Name qualifier (R4.1): a non-empty string of
 * lowercase letters, digits, and hyphens, or `undefined` for the no-qualifier
 * case.
 *
 * A qualifier appears in a Scenario_Directory_Name AFTER the `.` separator, and
 * recovery discards everything from the first `.` onward — so a qualifier never
 * affects the recovered tag. It is nonetheless constrained to `[a-z0-9-]+` per
 * R4.1, and never contains a `.` (which would confuse the qualifier boundary) or
 * the doubled `--` (kept clear so a qualifier reads like the directory names the
 * rest of the tier uses). Property 6 draws both the present and absent cases so
 * the round-trip holds with and without a qualifier.
 */
export function arbScenarioQualifier(): fc.Arbitrary<string | undefined> {
  const present = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
      minLength: 1,
      maxLength: 8,
    })
    .chain((chars) =>
      fc
        .array(fc.boolean(), {
          minLength: chars.length - 1,
          maxLength: chars.length - 1,
        })
        .map((hyphenAfter) => {
          let out = chars[0]!;
          for (let i = 1; i < chars.length; i += 1) {
            out += (hyphenAfter[i - 1] ? "-" : "") + chars[i]!;
          }
          return out;
        }),
    );
  return fc.option(present, { nil: undefined });
}

// ---------------------------------------------------------------------------
// The behaviour-preserving perturbation generator (Property 2; R16.3)
// ---------------------------------------------------------------------------
//
// A behaviour-preserving perturbation is a change to a Fixture_Scenario that
// leaves the Diagnostic_Tag it provokes unchanged. The three kinds R16.3 names,
// each modelled as a variant of a discriminated union so the generator stays
// pure over a DESCRIPTION and the mutating work is a separate, path-parameterised
// applier:
//
//   1. `permute-workspaces` — reorder the scenario's Root_Manifest `workspaces`
//      entries. The order is load-bearing for nothing, so no derivation changes.
//   2. `add-package` — add a well-formed member package in a Consumer_Category
//      the scenario's Expected_Diagnostic does not concern. A well-formed member
//      introduces no new diagnostic, so the reported set is unchanged.
//   3. `relocate-roots` — rewrite the scenario's Discovery_Roots to any
//      assignment the Config_Parser accepts, moving each existing member and the
//      `workspaces` globs with it. The scenario's fault travels intact, so the
//      one diagnostic it provokes is unchanged.
//
// The `unconcernedCategory` and the `newRoots` are carried on the DESCRIPTION so
// the generator is a pure `fast-check` arbitrary (re-run during shrinking); the
// applier turns a description into filesystem writes against a caller-supplied
// copy directory.

/** The three Consumer_Categories, spelled scope-free and root-free — the axis a
 *  perturbation's added package and relocation range over. Spelled here rather
 *  than imported so this generator states the category set it ranges over
 *  directly, the same discipline `config.ts` follows with its framework and root
 *  literals. */
export const PERTURBATION_CATEGORIES = [
  "microservice",
  "common",
  "spa",
] as const;

/** One of the three Consumer_Categories a perturbation may name. */
export type PerturbationCategory = (typeof PERTURBATION_CATEGORIES)[number];

/** A per-category Discovery_Root assignment, in the shape a Config_Parser roots
 *  block carries. */
export interface PerturbationRoots {
  readonly microservice: string;
  readonly common: string;
  readonly spa: string;
}

/**
 * A behaviour-preserving perturbation description — one of the three kinds R16.3
 * names. Pure data; {@link applyPerturbation} turns it into writes against a
 * clone directory.
 */
export type BehaviourPreservingPerturbation =
  /** Reorder the Root_Manifest `workspaces` entries; membership is unchanged. */
  | { readonly kind: "permute-workspaces"; readonly seed: number }
  /**
   * Add a well-formed member package in `category` (a Consumer_Category the
   * scenario's Expected_Diagnostic does not concern). `dirName` is the member's
   * directory name; the applier composes its declared name from the scenario's
   * own Configured_Scope so the added package mirrors its directory and stays
   * well-formed.
   */
  | {
      readonly kind: "add-package";
      readonly category: PerturbationCategory;
      readonly dirName: string;
    }
  /** Relocate the Discovery_Roots to `roots`, an assignment the Config_Parser
   *  accepts. The applier moves each existing member and the `workspaces` globs. */
  | { readonly kind: "relocate-roots"; readonly roots: PerturbationRoots };

/** A member directory name for the `add-package` kind: 1 to 12 lowercase-
 *  alphanumeric-or-hyphen chars starting with a letter, so it reads like a real
 *  member directory. Prefixed so a generated name never collides with a
 *  scenario's own members by construction. */
const arbAddedMemberDirName: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.stringMatching(/^[a-z0-9-]*$/).map((s) => s.slice(0, 10)),
  )
  .map(([head, tail]) => `wellformed-${head}${tail}`);

/**
 * A behaviour-preserving perturbation (R16.3), taking a Root_Assignment
 * generator for the `relocate-roots` kind.
 *
 * The `relocate-roots` kind's target roots come from `arbRoots` — the caller
 * passes the Discovery_Root reassignment generator (task 4.1 adds it to
 * `packages/build-tools/tests/arbitraries/config.ts`), so this module spells no
 * root literal and no property spells one either (R16.11). The `add-package`
 * kind's `category` ranges over all three Consumer_Categories; the CONSUMING
 * property (Property 2, task 4.4) narrows it to a category the scenario's
 * Expected_Diagnostic does not concern, because only the property knows which
 * category a given scenario's fault lives in.
 *
 * @param arbRoots a generator of Discovery_Root assignments the Config_Parser
 *   accepts, supplied by the calling suite so this module holds no root literal.
 */
export function arbBehaviourPreservingPerturbation(
  arbRoots: fc.Arbitrary<PerturbationRoots>,
): fc.Arbitrary<BehaviourPreservingPerturbation> {
  const permute = fc
    .nat()
    .map((seed): BehaviourPreservingPerturbation => ({
      kind: "permute-workspaces",
      seed,
    }));

  const addPackage = fc
    .tuple(fc.constantFrom(...PERTURBATION_CATEGORIES), arbAddedMemberDirName)
    .map(([category, dirName]): BehaviourPreservingPerturbation => ({
      kind: "add-package",
      category,
      dirName,
    }));

  const relocate = arbRoots.map(
    (roots): BehaviourPreservingPerturbation => ({
      kind: "relocate-roots",
      roots,
    }),
  );

  return fc.oneof(permute, addPackage, relocate);
}

// ---------------------------------------------------------------------------
// The applier (path-parameterised; writes only to a caller-supplied directory)
// ---------------------------------------------------------------------------
//
// The generator above is pure. Applying a perturbation needs filesystem writes
// and knowledge of the scenario's own Root_Manifest and Project_Config_File, so
// the applier is a separate function — and, like every writing helper in this
// tree, it is wholly path-parameterised: it writes ONLY inside the `scenarioDir`
// it is handed, which the caller supplies as a Fixture_Clone in an OS temp
// directory (Property 2 never perturbs the committed scenario). This module
// therefore names no tier path and reads no path of its own accord (R1.7); it
// reads and rewrites only files under the caller's directory.

/** The recognised Project_Config_File name. A filename, not a Fixture_Tier path
 *  token, so spelling it does not offend R1.7. */
const PROJECT_CONFIG_FILE_NAME = "scaffold.config.json";
/** The Root_Manifest filename. */
const ROOT_MANIFEST_NAME = "package.json";
/** The fallback Configured_Scope for a scenario declaring none — a fixture-only
 *  scope, never this project's default scope (R12.4). */
const FALLBACK_SCOPE = "@fx";
/** The default Discovery_Roots a scenario relocation moves FROM when its
 *  Project_Config_File declares none. Spelled here as the applier's own mirror
 *  of the Root_Defaults, so it can find each existing member to move it. */
const DEFAULT_PERTURBATION_ROOTS: PerturbationRoots = {
  microservice: "packages/microservices",
  common: "packages/common",
  spa: "packages/spa",
};

/** Reads and parses a JSON file under the clone, returning `undefined` when it
 *  is absent or unparsable (a scenario may declare no Project_Config_File). */
function readJsonIfPresent(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Writes a JSON object the way npm writes a manifest: two-space indent, one
 *  trailing newline. */
function writeJson(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** The Configured_Scope a scenario declares, or the fallback fixture scope when
 *  it declares no Project_Config_File or no `scope` (never this project's default
 *  scope literal, R12.4). */
function scopeOf(config: Record<string, unknown> | undefined): string {
  const scope = config?.["scope"];
  return typeof scope === "string" ? scope : FALLBACK_SCOPE;
}

/** The Discovery_Roots a scenario's Project_Config_File declares, defaulting each
 *  undeclared root to its Root_Default so the applier can locate every member. */
function rootsOf(config: Record<string, unknown> | undefined): PerturbationRoots {
  const roots = config?.["roots"];
  const declared =
    typeof roots === "object" && roots !== null
      ? (roots as Record<string, unknown>)
      : {};
  const pick = (key: keyof PerturbationRoots): string => {
    const value = declared[key];
    return typeof value === "string"
      ? value
      : DEFAULT_PERTURBATION_ROOTS[key];
  };
  return {
    microservice: pick("microservice"),
    common: pick("common"),
    spa: pick("spa"),
  };
}

/** The `workspaces` array a Root_Manifest declares, or an empty array. */
function workspacesOf(manifest: Record<string, unknown>): string[] {
  const workspaces = manifest["workspaces"];
  return Array.isArray(workspaces)
    ? workspaces.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** A deterministic in-place shuffle seeded by `seed`, so a re-run of the same
 *  perturbation description produces the same order (a `fast-check` value must be
 *  reproducible during shrinking). Fisher–Yates over a small linear-congruential
 *  sequence — enough to reorder a `workspaces` array, no cryptographic claim. */
function seededPermutation<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    // LCG step (Numerical Recipes constants), then reduce into [0, i].
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Apply a behaviour-preserving perturbation to a Fixture_Scenario copy at
 * `scenarioDir` (R16.3). Mutates ONLY files under `scenarioDir`, which the
 * caller supplies as a Fixture_Clone in an OS temp directory — never the
 * committed scenario. Reads the scenario's own Root_Manifest and (optional)
 * Project_Config_File to preserve its Configured_Scope and to locate its members.
 *
 * Each kind:
 *
 *   * `permute-workspaces` — reorder the Root_Manifest `workspaces` array by the
 *     description's seed and rewrite the manifest. A scenario declaring no
 *     `workspaces` array is left unchanged (there is nothing to reorder), which
 *     is still behaviour-preserving.
 *   * `add-package` — write a well-formed member package under the scenario's
 *     Discovery_Root for `category`: a `package.json` whose `name` mirrors its
 *     directory under the scenario's Configured_Scope (and the barrel `main`/
 *     `types` a common member owes, or the `scripts.build` a spa member owes),
 *     plus a one-line source. The added member is well-formed, so it introduces
 *     no diagnostic. The consuming property chooses a `category` the scenario's
 *     Expected_Diagnostic does not concern.
 *   * `relocate-roots` — rewrite the Project_Config_File's `roots` to the
 *     description's assignment, move each existing member directory from its old
 *     Discovery_Root to the new one, and rewrite the `workspaces` globs to match.
 *     The scenario's fault moves with its files, so its one diagnostic is
 *     unchanged.
 */
export function applyPerturbation(
  scenarioDir: string,
  perturbation: BehaviourPreservingPerturbation,
): void {
  const manifestPath = join(scenarioDir, ROOT_MANIFEST_NAME);
  const configPath = join(scenarioDir, PROJECT_CONFIG_FILE_NAME);
  const manifest = readJsonIfPresent(manifestPath) ?? {};
  const config = readJsonIfPresent(configPath);

  switch (perturbation.kind) {
    case "permute-workspaces": {
      const entries = workspacesOf(manifest);
      if (entries.length <= 1) return; // nothing to reorder
      manifest["workspaces"] = seededPermutation(entries, perturbation.seed);
      writeJson(manifestPath, manifest);
      return;
    }

    case "add-package": {
      const roots = rootsOf(config);
      const scope = scopeOf(config);
      const memberDir = join(
        scenarioDir,
        ...roots[perturbation.category].split("/"),
        perturbation.dirName,
      );
      const memberManifest = wellFormedMemberManifest(
        perturbation.category,
        `${scope}/${perturbation.dirName}`,
      );
      writeJson(join(memberDir, ROOT_MANIFEST_NAME), memberManifest);
      const sourcePath = join(memberDir, "src", "index.ts");
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, "export const wellFormed = true;\n", "utf8");
      return;
    }

    case "relocate-roots": {
      relocateRoots(scenarioDir, manifest, config, perturbation.roots);
      return;
    }
  }
}

/** The well-formed `package.json` a member of `category` owes: a common member
 *  owes a barrel (`main`/`types`); a spa member owes `scripts.build`; a
 *  microservice owes neither. `name` mirrors its directory under the scenario's
 *  scope, so the member is well-formed and introduces no diagnostic. */
function wellFormedMemberManifest(
  category: PerturbationCategory,
  name: string,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name,
    version: "0.0.0",
    type: "module",
  };
  if (category === "common") {
    manifest["main"] = "./dist/index.js";
    manifest["types"] = "./dist/index.d.ts";
  } else if (category === "spa") {
    manifest["scripts"] = { build: "vite build" };
  }
  return manifest;
}

/** Move each existing member from its old Discovery_Root to the new one, rewrite
 *  the Project_Config_File's `roots`, and rewrite the Root_Manifest `workspaces`
 *  globs — all inside the clone directory. */
function relocateRoots(
  scenarioDir: string,
  manifest: Record<string, unknown>,
  config: Record<string, unknown> | undefined,
  newRoots: PerturbationRoots,
): void {
  const oldRoots = rootsOf(config);

  // Move each category's Discovery_Root directory (with its members) to its new
  // location. Node's rename is atomic within a filesystem and preserves the
  // subtree, including any nested member packages.
  for (const category of PERTURBATION_CATEGORIES) {
    const from = join(scenarioDir, ...oldRoots[category].split("/"));
    const to = join(scenarioDir, ...newRoots[category].split("/"));
    if (from === to) continue;
    // Only move a root that actually exists; a scenario may declare a category's
    // root without materialising any member under it.
    try {
      mkdirSync(dirname(to), { recursive: true });
      renameDir(from, to);
    } catch {
      // Absent source root: nothing to move for this category.
    }
  }

  // Rewrite the Project_Config_File `roots` to the new assignment, preserving
  // every other key the scenario declared. A scenario that declared no config
  // gains one carrying only `roots` — still an assignment the Config_Parser
  // accepts.
  const nextConfig: Record<string, unknown> = { ...(config ?? {}) };
  nextConfig["roots"] = {
    microservice: newRoots.microservice,
    common: newRoots.common,
    spa: newRoots.spa,
  };
  writeJson(join(scenarioDir, PROJECT_CONFIG_FILE_NAME), nextConfig);

  // Rewrite the `workspaces` globs: any entry that was a glob under an old root
  // is re-pointed at the corresponding new root. Non-glob entries (the
  // Entry_Root, the Framework_Singletons) are left as they are.
  const manifestPath = join(scenarioDir, ROOT_MANIFEST_NAME);
  const entries = workspacesOf(manifest);
  if (entries.length > 0) {
    manifest["workspaces"] = entries.map((entry) =>
      relocateWorkspaceEntry(entry, oldRoots, newRoots),
    );
    writeJson(manifestPath, manifest);
  }
}

/** Re-point one `workspaces` entry from an old Discovery_Root to the new one when
 *  it is a glob under that root; otherwise return it unchanged. */
function relocateWorkspaceEntry(
  entry: string,
  oldRoots: PerturbationRoots,
  newRoots: PerturbationRoots,
): string {
  for (const category of PERTURBATION_CATEGORIES) {
    const oldRoot = oldRoots[category];
    if (entry === `${oldRoot}/*` || entry.startsWith(`${oldRoot}/`)) {
      return newRoots[category] + entry.slice(oldRoot.length);
    }
  }
  return entry;
}

/** Rename a directory, falling back to a recursive copy-then-remove where a
 *  plain rename fails (e.g. across devices). Uses only `node:fs` operations
 *  scoped to the caller's clone directory. */
function renameDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true, dereference: false });
    rmSync(from, { recursive: true, force: true });
  }
}

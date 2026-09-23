// @microservices/build-tools/dist/testing — Fixture_Tier content generator.
//
// This module is a TEST-SUPPORT export only, imported by its compiled deep path
// (`@microservices/build-tools/dist/testing/index.js`). It exists because two
// packages' property suites need to synthesise plausible Fixture_Tier content:
// the additive-invariance property (Property 5 of that feature, R16.6) places
// generated content under the tier root inside a copy of this repository and
// asserts that the four Build_System derivations are unchanged by its presence.
//
// The generator MUST NOT spell the tier's directory-name token — this module
// lives under `packages/build-tools/src/`, and R1.7 forbids a Build_System
// source spelling that path literal (the `check:invariants` scope-of-source rule
// and the layout suite both scan this tree, comments included). So it yields a
// set of RELATIVE paths and their bytes, and the consuming test decides where to
// root them. The consumer roots them at the tier directory whose name it holds,
// never this module.
//
// What "plausible Fixture_Tier content" means here: an arbitrary directory tree
// of manifests and sources that, IF the Build_System could see it, would be
// hostile — deliberately-broken `package.json` manifests, a `scaffold.config.json`
// that is not even valid JSON, nested `packages/<name>/` directories that mirror
// the real Discovery_Root shapes, a `README.md`, and a nested projects workspace
// root. The property's whole point is that none of it perturbs a derivation,
// because the tier is discovered by nothing (R10.5, R10.6, R10.7). Generating
// content that WOULD be hostile if seen is what makes the invariance meaningful:
// benign content could pass vacuously.

import * as fc from "fast-check";

/** One generated file to materialise under a tier root: a tier-relative POSIX
 *  path (no leading slash, `/` its only separator) and the bytes to write. */
export interface FixtureContentFile {
  /** Path relative to the tier root, e.g. `trees/config--unparsable/package.json`. */
  readonly path: string;
  /** The file's exact bytes as UTF-8 text. */
  readonly contents: string;
}

/** A generated Fixture_Tier content set: the files to materialise under the
 *  tier root, and nothing else. Directories are implied by the file paths. */
export type FixtureContent = readonly FixtureContentFile[];

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A directory-name segment: 1 to 12 lowercase-alphanumeric-or-hyphen chars,
 *  always starting with a letter so it is a legible directory name. */
const arbSegment: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.stringMatching(/^[a-z0-9-]*$/).map((s) => s.slice(0, 11)),
  )
  .map(([head, tail]) => head + tail);

/**
 * A `package.json` manifest that would be HOSTILE if the Build_System ever read
 * it: it is either not valid JSON, or a valid manifest that violates a discovery
 * rule (no `name`, a name not mirroring its directory, a peer-microservice or
 * Overseer dependency, a Common_Package pointing at a microservice). The tier
 * makes such a manifest inert; the property proves the derivations do not read it.
 */
const arbHostileManifest: fc.Arbitrary<string> = fc.oneof(
  // Not valid JSON at all.
  fc.constantFrom("{", "not json", '{ "name": }', "{,}", ""),
  // Valid JSON, but a manifest a real discovery would reject. The scoped
  // dependency specifiers use the fixture-only scope `@fx`, never this project's
  // Scope_Default: this module lives under `packages/build-tools/src/`, where the
  // `[scope:literal]` check forbids spelling the default scope (R12.4). The tier
  // is discovered by nothing, so the specifier's scope is immaterial to the
  // invariance under test — a hostile-shaped manifest is hostile enough.
  fc.oneof(
    fc.constant('{ "private": true }'), // no name
    fc.constant('{ "name": "@fx/NOTMIRRORED" }'), // name/dir mismatch
    fc.constant(
      '{ "name": "@fx/broken", "dependencies": { "@fx/overseer": "*" } }',
    ),
    fc.constant(
      '{ "name": "@fx/common-bad", "main": "dist/index.js", "types": "dist/index.d.ts", "dependencies": { "@fx/microservice1": "*" } }',
    ),
    fc.constant('{ "name": "@fx/no-barrel", "type": "module" }'), // common w/o main/types
    fc.constant('{ "name": "@fx/spa-bad", "type": "module" }'), // spa w/o scripts.build
  ),
);

/** A `scaffold.config.json` that would be REJECTED if the Build_System searched
 *  the tier for one — unparsable, wrong-shaped, an invalid scope, an overlapping
 *  or framework-colliding root, or a reserved-path Entry_Root. The Build_System
 *  reads the config from the Project_Directory, never from under the tier, so
 *  this stays inert. */
const arbHostileConfig: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    "{ not json", // unparsable
    "[]", // not an object
    '{ "scope": 42 }', // wrong-typed scope
    '{ "scope": "no-at-sign" }', // invalid scope
    '{ "roots": "should-be-object" }', // wrong-typed roots
    '{ "roots": { "microservice": "packages/x", "common": "packages/x" } }', // overlap
    '{ "roots": { "microservice": "packages/contracts" } }', // framework collision
    '{ "entry": "packages" }', // entry overlap
    '{ "unknownKey": true }', // unknown key
  ),
);

/** A short arbitrary source or text file body. */
const arbFileBody: fc.Arbitrary<string> = fc.oneof(
  fc.constant("export const x = 1;\n"),
  fc.constant("import x from '../../escaping/peer';\n"), // an escaping import
  fc.constant("# a fixture readme\n"),
  fc.string({ maxLength: 40 }),
);

/**
 * One Fixture_Scenario-shaped directory: a `<partition>/<dirName>/` holding a
 * `fixture.json` Scenario_Manifest, a hostile Root_Manifest, an optional hostile
 * `scaffold.config.json`, and 0 to 3 nested member packages under `packages/`
 * (each with its own hostile manifest and a source file), mirroring the shapes a
 * real Tree_Fixture or Project_Fixture takes.
 */
function arbScenarioFiles(
  partition: "trees" | "projects",
): fc.Arbitrary<FixtureContentFile[]> {
  return fc
    .tuple(
      arbSegment, // scenario directory name
      arbHostileManifest, // the scenario's own root manifest
      fc.option(arbHostileConfig, { nil: undefined }),
      fc.array(
        fc.tuple(
          fc.constantFrom("microservices", "common", "spa"),
          arbSegment,
          arbHostileManifest,
          arbFileBody,
        ),
        { minLength: 0, maxLength: 3 },
      ),
    )
    .map(([dirName, rootManifest, config, members]) => {
      const base = `${partition}/${dirName}`;
      const files: FixtureContentFile[] = [
        {
          path: `${base}/fixture.json`,
          contents: `${JSON.stringify(
            {
              expectedDiagnostic: "[discovery:name]",
              entryPoint: "check-repo-invariants",
              fault: "a generated hostile scenario",
              partition: {
                kind: partition === "trees" ? "tree" : "project",
                justification: "generated content for the invariance property",
              },
            },
            null,
            2,
          )}\n`,
        },
        { path: `${base}/package.json`, contents: rootManifest },
      ];
      if (config !== undefined) {
        files.push({ path: `${base}/scaffold.config.json`, contents: config });
      }
      // Nested member packages, keyed by (category, name) so two members never
      // collide on the same path within one scenario.
      const seen = new Set<string>();
      for (const [category, memberName, manifest, body] of members) {
        const key = `${category}/${memberName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const memberBase = `${base}/packages/${category}/${memberName}`;
        files.push({ path: `${memberBase}/package.json`, contents: manifest });
        files.push({ path: `${memberBase}/src/index.ts`, contents: body });
      }
      return files;
    });
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * Generated Fixture_Tier content: the files a test materialises under a tier
 * root to exercise the additive-invariance property (Property 5 of that
 * feature, R16.6). Always includes a `README.md`; then 0 to 3 Tree_Fixture
 * scenarios under `trees/`, a nested `projects/` workspace root manifest and
 * lockfile, and 0 to 3 Project_Fixture scenarios under `projects/`.
 *
 * The returned paths are relative to the tier root (no tier-name literal here,
 * R1.7); the consuming test roots them at the tier directory it holds. Every
 * generated manifest and config is HOSTILE by construction, so the invariance
 * the property asserts is non-trivial: benign content could pass vacuously.
 *
 * The content is deliberately varied in breadth and depth rather than deep: the
 * property ranges over many DIFFERENT tier contents across its runs, and each
 * run only needs the content to be present and structurally tier-shaped.
 */
export function arbFixtureContent(): fc.Arbitrary<FixtureContent> {
  return fc
    .tuple(
      // The always-present tier files.
      fc.constant<FixtureContentFile>({
        path: "README.md",
        contents: "# Fixture_Tier (generated for the invariance property)\n",
      }),
      // The nested projects workspace root: its own manifest + lockfile, whose
      // presence must not turn the tier's `projects/` into a discovered anything.
      fc.constant<FixtureContentFile>({
        path: "projects/package.json",
        contents:
          '{ "private": true, "workspaces": ["*/packages/*"], "devDependencies": {} }\n',
      }),
      fc.constant<FixtureContentFile>({
        path: "projects/package-lock.json",
        contents: '{ "lockfileVersion": 3, "packages": {} }\n',
      }),
      fc.array(arbScenarioFiles("trees"), { minLength: 0, maxLength: 3 }),
      fc.array(arbScenarioFiles("projects"), { minLength: 0, maxLength: 3 }),
    )
    .map(([readme, projManifest, projLock, treeScenarios, projScenarios]) => {
      const all: FixtureContentFile[] = [readme, projManifest, projLock];
      for (const scenario of [...treeScenarios, ...projScenarios]) {
        all.push(...scenario);
      }
      // De-duplicate by path: two generated scenarios may have drawn the same
      // directory name. First write wins, matching a real filesystem where a
      // path is one file.
      const byPath = new Map<string, FixtureContentFile>();
      for (const file of all) {
        if (!byPath.has(file.path)) {
          byPath.set(file.path, file);
        }
      }
      return [...byPath.values()];
    });
}

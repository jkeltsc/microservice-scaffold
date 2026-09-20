// Property 14's two examples: the fresh-clone guarantee, and its named diagnostic.
//
// Feature: registry-inversion, Property 14: The fresh-clone guarantee and its
// named diagnostic hold over a materialized copy.
//
// **Validates: Requirements 5.4, 5.5, 13.14**
//
// Retiring the Registry_Template removed the thing that made an ungenerated
// registry compilable. Two behaviours replace it, and only a tree that has never
// generated a registry can show either one:
//
//   1. The Entry_Package's own `typecheck` script performs the
//      Registry_Generation_Step before invoking the compiler, so running it in
//      the Entry_Package's directory on a clone that has never generated a
//      registry exits zero and LEAVES a Generated_Registry at its path (R5.4).
//      The one proviso R5.4 states is that the Build_System itself is compiled,
//      which this suite satisfies explicitly in `beforeAll` — the registry
//      generator is compiled output, so the copy is bootstrapped before the
//      guarantee is exercised.
//   2. Compiling the Entry_Package with that Registry_Generation_Step SUPPRESSED
//      writes exactly one diagnostic naming the absent registry path and the
//      command that produces it, invokes no compiler, emits no compiled output
//      for the Entry_Package, and exits non-zero — rather than surfacing only the
//      compiler's unresolved-module error, which names a specifier and not the
//      command that fixes it (R5.5).
//
// --- This suite NEVER touches the real working tree -------------------------
// Both examples need a tree with NO Generated_Registry, and the second needs to
// remove one and to observe that no `dist/` appeared for the Entry_Package. Every
// one of those writes happens inside this suite's OWN copy of the tree,
// materialized by `pristineWorktree()` into an OS temp directory and torn down
// with `cleanup()`. The real working tree is read (to build that copy) and never
// written, and no git command undoes anything: there is nothing to undo.
//
// `pristineWorktree()` lists tracked plus untracked-but-not-gitignored files and
// tars them from disk, so the copy carries uncommitted edits exactly as they are
// while EXCLUDING the gitignored `dist/`, `*.tsbuildinfo`, and the Generated
// Registry. "A tree that has never generated a registry" is therefore what the
// copy is by construction rather than something this suite has to manufacture.
//
// One copy serves both examples, materialized once in `beforeAll`, because the
// `npm ci` inside it is the slowest thing this feature adds to the suite. When it
// is unavailable (no git, or the archive / `npm ci` failed for an environmental
// reason) each example reports the returned reason and returns: it asserts
// nothing against the checked-out repository in its place, and reports no
// failure. `pristineWorktree()` removes its own partial temp directory on every
// such path, and `afterAll` removes the successful one.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { generatedRegistryPath } from "@microservices/build-tools/dist/generate-registry.js";

import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

// The default Effective_Config — what this repository's absent Project_Config_File
// yields — and the two paths derived from it. Derived rather than written out, so
// this suite reads the same single derivation the generator and the guard read,
// and a relocated Entry_Root moves all three together.
const context = projectContext(defaultEffectiveConfig());
/** Project_Directory-relative POSIX path of the Generated_Registry. */
const REGISTRY_RELATIVE = generatedRegistryPath(context);
/** Project_Directory-relative POSIX path of the Entry_Package's directory. */
const ENTRY_RELATIVE = context.entryRoot;

/** The command the R5.5 diagnostic must name as the one that writes the registry. */
const GENERATOR_COMMAND =
  "node packages/build-tools/dist/bin/generate-registry.js";
/** The diagnostic tag R5.5's one line carries. */
const ABSENT_TAG = "[entry-registry:absent]";

/** The compiled generator bin whose presence is R5.4's stated proviso. */
const GENERATOR_BIN = `${context.framework.buildTools.packageDir}/dist/bin/generate-registry.js`;

/**
 * The Tsc_Projects the copy must have compiled before either example runs, as
 * Project_Directory-relative paths derived from the ProjectContext and the copy's
 * own filesystem rather than listed by hand.
 *
 * R5.4's proviso — "provided the Build_System itself is compiled" — is the
 * headline reason: the Registry_Generation_Step spawns compiled output, so
 * `build-tools` must be built or the Entry_Package's scripts report the shim's own
 * R5.9 diagnostic instead of exercising the guarantee. But the compilation that
 * follows resolves EVERY import specifier of the Generated_Registry (R2.9), and
 * those specifiers name the Selected_Microservices by scoped package name — so
 * each microservice's emitted `.d.ts`, and that of every Common_Package one of
 * them consumes, must exist too. Hence: the three shipping-or-tooling Framework
 * Singletons, plus every member of the common and microservice Discovery_Roots.
 *
 * Excluded deliberately: the Entry_Package, which is the subject and must stay
 * uncompiled with its registry ungenerated; the spa Discovery_Root, whose members
 * are Bundler_Projects and are reached only through a run-time module-resolution
 * call, never a static import; and `integration-tests`, which nothing here needs.
 */
function bootstrapProjects(base: string): readonly string[] {
  const members = (root: string): readonly string[] => {
    const absoluteRoot = inCopy(base, root);
    if (!existsSync(absoluteRoot)) {
      return [];
    }
    return readdirSync(absoluteRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(absoluteRoot, entry.name, "tsconfig.json")),
      )
      .map((entry) => `${root}/${entry.name}`)
      .sort();
  };
  return [
    context.framework.contracts.packageDir,
    context.framework.buildTools.packageDir,
    context.framework.overseer.packageDir,
    ...members(context.roots.common),
    ...members(context.roots.microservice),
  ];
}

/** The list {@link bootstrapProjects} produced for the copy, kept for reporting. */
let bootstrapList: readonly string[] = [];

/** The file name of the probe driver written into the copy for example 2. */
const PROBE_FILENAME = "entry-registry-guard-probe.mjs";

/**
 * The probe driver, written into the copy and run with the copy as its working
 * directory.
 *
 * It is how "the Registry_Generation_Step suppressed" is arranged. Every shipped
 * path that compiles the Entry_Package generates the registry first — the image
 * build's CLI does it as its own step, and the Entry_Package's `build` script
 * does it through the `&&` chain — so no shipped command can be asked to skip it.
 * The probe therefore calls the Build_System's own `executeBuildPlan` directly,
 * which is the function that carries the registry-presence guard immediately
 * ahead of its single `tsc --build`, and it calls it WITHOUT the generation step
 * its CLI performs first.
 *
 * Both of `executeBuildPlan`'s injectable effects are replaced with recorders
 * that announce themselves on stdout, so "invokes no compiler" and "stages
 * nothing" are observable as the ABSENCE of those markers rather than inferred.
 * `PROBE_REACHED_END` marks a return that never happened — the guard exits the
 * process — so its absence is what a passing example sees.
 */
const PROBE_SOURCE = `// Written by packages/integration-tests/tests/entry-fresh-clone.test.ts.
// Drives executeBuildPlan with the Registry_Generation_Step suppressed, and with
// the compiler and the staging step replaced by recorders, so an invocation of
// either is observable on stdout (registry-inversion R5.5).
import { requireProjectContext } from "./packages/build-tools/dist/config-loader.js";
import { buildPlan } from "./packages/build-tools/dist/build-plan.js";
import { executeBuildPlan } from "./packages/build-tools/dist/image-tree.js";

const context = requireProjectContext();
const plan = buildPlan(context, process.env.MICROSERVICES);

executeBuildPlan(
  context,
  plan,
  process.env.PROBE_OUT_DIR ?? "probe-out",
  (command, args) => {
    process.stdout.write(\`PROBE_RUNNER_INVOKED \${command} \${args.join(" ")}\\n\`);
  },
  () => {
    process.stdout.write("PROBE_STAGE_INVOKED\\n");
  },
);

process.stdout.write("PROBE_REACHED_END\\n");
`;

/** `npm ci` in a fresh temp tree plus the bootstrap compile of three projects. */
const SETUP_TIMEOUT_MS = 900_000;
/** Each example spawns one build-tool process in the copy. */
const EXAMPLE_TIMEOUT_MS = 300_000;

let pristine: PristineWorktreeResult | undefined;
/** The bootstrap compile's result, kept so a failure reports its own output. */
let bootstrap: SpawnSyncReturns<string> | undefined;

/** Join a Project_Directory-relative POSIX path onto the copy's root. */
function inCopy(base: string, relativePosixPath: string): string {
  return join(base, ...relativePosixPath.split("/"));
}

/**
 * The skip guard. Returns the copy's root when it is usable, or `undefined` after
 * reporting the reason `pristineWorktree()` gave. A skipping example asserts
 * nothing and fails nothing.
 */
function copyRootOrSkip(): string | undefined {
  if (pristine === undefined || pristine.available !== true) {
    console.warn(
      `SKIP entry-fresh-clone: ${pristine?.reason ?? "pristine tree unavailable"}`,
    );
    return undefined;
  }
  return pristine.dir;
}

beforeAll(() => {
  // One copy for both examples: the `npm ci` inside it is the slow step.
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    // No git, or the archive / `npm ci` failed for an environmental reason.
    // `pristineWorktree()` has already removed its own partial temp directory.
    return;
  }
  const base = pristine.dir;

  // R5.4's proviso, satisfied explicitly: compile everything the Entry_Package's
  // own compilation resolves, and nothing more. The local compiler binary is
  // invoked directly rather than through a package runner, so nothing reaches the
  // network.
  bootstrapList = bootstrapProjects(base);
  bootstrap = spawnSync(
    process.execPath,
    [
      join(base, "node_modules", "typescript", "bin", "tsc"),
      "--build",
      ...bootstrapList,
    ],
    { cwd: base, encoding: "utf8" },
  );
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  // Remove the copy. There is nothing to undo in the real working tree: every
  // write this suite made was inside the copy.
  if (pristine?.available === true) {
    pristine.cleanup();
    pristine = undefined;
  }
});

describe("Property 14: the fresh-clone guarantee and its named diagnostic (R5.4, R5.5, R13.14)", () => {
  it(
    "bootstraps the Build_System in the copy, as R5.4's proviso requires",
    () => {
      const base = copyRootOrSkip();
      if (base === undefined) return;

      const result = bootstrap as SpawnSyncReturns<string>;
      expect(bootstrapList.length).toBeGreaterThan(0);
      expect(
        bootstrapList,
        "the Entry_Package must not be bootstrapped: it is the subject",
      ).not.toContain(ENTRY_RELATIVE);
      expect(
        result.status,
        `compiling ${bootstrapList.join(", ")} in the pristine copy failed\n` +
          `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`,
      ).toBe(0);
      // The generator bin the Entry_Package's own scripts spawn now exists, and
      // the Entry_Package itself is still uncompiled with no registry generated.
      expect(existsSync(inCopy(base, GENERATOR_BIN))).toBe(true);
      expect(existsSync(inCopy(base, REGISTRY_RELATIVE))).toBe(false);
      expect(existsSync(inCopy(base, `${ENTRY_RELATIVE}/dist`))).toBe(false);
    },
    EXAMPLE_TIMEOUT_MS,
  );

  it(
    "the Entry_Package's own typecheck with no Generated_Registry present exits zero and leaves one at its path (R5.4)",
    () => {
      const base = copyRootOrSkip();
      if (base === undefined) return;
      expect((bootstrap as SpawnSyncReturns<string>).status).toBe(0);

      const registry = inCopy(base, REGISTRY_RELATIVE);
      // The copy excludes gitignored files, so the registry is absent by
      // construction. Removed anyway, inside the copy, so this example does not
      // depend on the order the examples run in.
      rmSync(inCopy(base, REGISTRY_RELATIVE), { force: true });
      expect(
        existsSync(registry),
        "the pristine copy must hold no Generated_Registry before the typecheck",
      ).toBe(false);

      const result = spawnSync("npm", ["run", "typecheck"], {
        cwd: inCopy(base, ENTRY_RELATIVE),
        encoding: "utf8",
      });

      expect(
        result.status,
        `\`npm run typecheck\` in ${ENTRY_RELATIVE} must exit zero on a tree that has never generated a registry\n` +
          `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`,
      ).toBe(0);
      expect(
        existsSync(registry),
        `the typecheck must leave a Generated_Registry at ${REGISTRY_RELATIVE}`,
      ).toBe(true);
    },
    EXAMPLE_TIMEOUT_MS,
  );

  it(
    "compiling the Entry_Package with the Registry_Generation_Step suppressed writes the R5.5 diagnostic, invokes no compiler, and exits non-zero",
    () => {
      const base = copyRootOrSkip();
      if (base === undefined) return;
      expect((bootstrap as SpawnSyncReturns<string>).status).toBe(0);

      const registry = inCopy(base, REGISTRY_RELATIVE);
      // Back to "never generated": the previous example generated one. Both
      // removals are inside the copy.
      rmSync(inCopy(base, REGISTRY_RELATIVE), { force: true });
      rmSync(inCopy(base, `${ENTRY_RELATIVE}/dist`), {
        recursive: true,
        force: true,
      });
      expect(existsSync(registry)).toBe(false);

      writeFileSync(inCopy(base, PROBE_FILENAME), PROBE_SOURCE);
      const result = spawnSync(
        process.execPath,
        [inCopy(base, PROBE_FILENAME)],
        { cwd: base, encoding: "utf8" },
      );

      // Non-zero, and not a crash: the guard exits deliberately rather than
      // throwing, so no stack trace reaches stderr alongside the diagnostic.
      expect(
        result.status,
        `the guard must terminate the run with a non-zero exit status\n` +
          `--- stdout ---\n${result.stdout ?? ""}\n--- stderr ---\n${result.stderr ?? ""}`,
      ).not.toBe(0);
      expect(result.status).not.toBeNull();

      // Exactly one diagnostic. Node's own `(node:NNN)` warnings, which are not
      // diagnostics of this run, are excluded before counting.
      const stderrLines = (result.stderr ?? "")
        .split("\n")
        .filter((line) => line.length > 0 && !/^\(node:\d+\)/.test(line));
      expect(
        stderrLines,
        `expected exactly one diagnostic on stderr, got:\n${result.stderr ?? ""}`,
      ).toHaveLength(1);

      const diagnostic = stderrLines[0] as string;
      expect(diagnostic).toContain(ABSENT_TAG);
      // It names the absent registry path...
      expect(diagnostic).toContain(REGISTRY_RELATIVE);
      // ...and the command that produces it, which is what the compiler's own
      // unresolved-module error would not have said.
      expect(diagnostic).toContain(GENERATOR_COMMAND);
      expect(diagnostic).not.toContain("error TS");

      // No compiler was invoked and nothing was staged: neither recorder fired,
      // and the call never returned.
      expect(result.stdout ?? "").not.toContain("PROBE_RUNNER_INVOKED");
      expect(result.stdout ?? "").not.toContain("PROBE_STAGE_INVOKED");
      expect(result.stdout ?? "").not.toContain("PROBE_REACHED_END");

      // No compiled output was emitted for the Entry_Package, and the guard
      // wrote no registry of its own — it reads, it does not repair.
      expect(existsSync(inCopy(base, `${ENTRY_RELATIVE}/dist`))).toBe(false);
      expect(existsSync(registry)).toBe(false);
    },
    EXAMPLE_TIMEOUT_MS,
  );
});

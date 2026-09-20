// Compiles the packages a build needs and copies them into the tree a
// container image ships.
//
// This is the tail of the build pipeline — steps 7 to 11 of design "Pipeline
// walkthrough / (b) The end-to-end build pipeline": the `tsc --build` pass, the
// per-SPA bundler builds, the build-output assertion, staging, and the
// integrity assertion. (Requirements R5.6, R5.8, R5.9, R5.10, R6.5, R6.8–R6.11,
// R7.3–R7.9, R7.11, R10.2.)
//
// The module executes a `BuildPlan` and derives nothing. What to build, in what
// order, and what to stage all come from `buildPlanFrom` (`build-plan.ts`). The
// watch-mode build path consumes the same `plan.tscRoots`, so the image's build
// roots and the watch-mode project list cannot disagree (R13.8).
//
// Every step that can fail runs before the first file is copied. That is why a
// failed build stages nothing and why there is no cleanup path: the only removal
// anywhere is the `rmSync` of `outDir` at the start of staging, and nothing
// after the first copy prunes or empties (R7.6). Minimality follows from the
// same shape — only the packages `plan.stage` justifies are ever compiled and
// copied.
//
// Third-party runtime dependencies are not staged here. A separate `prod-deps`
// Docker stage produces them with `npm ci --omit=dev`, and the runtime stage
// copies that `node_modules/` first, then overlays `/out` from the build stage.
//
// Target layout (relative to `outDir`):
//
//   node_modules/@microservices/contracts/    always staged, Framework_Singleton
//   node_modules/@microservices/overseer/     always staged, Framework_Singleton
//   node_modules/@microservices/<required>/   Required_Dependencies only
//   node_modules/@microservices/<selected>/   Selected_Microservices only
//   <Entry_Root>/                             package.json + dist
//
// Packages ship under `node_modules/@microservices/` because the generated
// registry and the Entry_Module import them by package name, and they are staged
// as real directories rather than workspace symlinks, which would dangle once
// `packages/…` is absent from the image. The Overseer_Library is one of them: the
// Entry_Module imports it by package name and no process invokes it by path, so
// it ships under the scope directory and no longer at its package directory
// (registry-inversion R3.7).
//
// The Entry_Package is the one package staged at a package directory, at the
// Entry_Root, because that is what makes the Entry_Point_Path
// `<Entry_Root>/dist/index.js` — the module the container `CMD` spawns — resolve
// inside the image (registry-inversion R9.6, R7.7). Its `src/` is not staged, so
// the Generated_Registry's source file reaches no Image_Tree while its compiled
// form ships inside that `dist` (R9.5).
//
// Paths are relative to cwd, which in the build stage is the repo root. Errors
// propagate: Node prints them and exits non-zero.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  buildPlanFrom,
  type BuildPlan,
  type StagedPackage,
} from "./build-plan.js";
import { requireProjectContext } from "./config-loader.js";
import { discoverPackages, readDependencySpecifiers } from "./discovery.js";
import { assertRegistryPresent } from "./entry-registry.js";
import { assertFrameworkDirectoriesPresent } from "./framework.js";
import { generateRegistry } from "./generate-registry.js";
import { type ProjectContext } from "./project-context.js";

/** The build-output directory every staged package contributes (R6.8). */
const DIST_DIR = "dist";

/**
 * Runs one external command and throws when it fails.
 *
 * {@link executeBuildPlan} calls a runner for the single `tsc --build` (step 7)
 * and for each SPA's `npm run build` (step 8). Production passes {@link run};
 * the parameter is a seam so a test can inject a recorder that captures the
 * invocation sequence, or one that fails a chosen step (R6.5, R6.9, R6.10).
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string },
) => void;

/**
 * Runs a command with inherited stdio and throws on failure.
 *
 * The message names the working directory when one was given, so a failed
 * Spa_Package build reports the offending package directory and the observed
 * exit status (R6.9). A command that could not be spawned at all is reported
 * the same way, with the underlying error as its `cause`.
 */
export const run: CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): void => {
  const { cwd } = options;
  const { error, status } = spawnSync(command, [...args], {
    stdio: "inherit",
    ...(cwd === undefined ? {} : { cwd }),
  });
  const where = cwd === undefined ? "" : ` in "${cwd}"`;
  if (error) {
    throw new Error(
      `[image-tree] "${command} ${args.join(" ")}"${where} could not be executed`,
      { cause: error },
    );
  }
  if (status !== 0) {
    throw new Error(
      `[image-tree] "${command} ${args.join(" ")}"${where} failed with exit code ${String(status)}`,
    );
  }
};

/**
 * Copies one package's runtime surface into the image tree.
 *
 * That surface is the package's own `package.json` plus the complete contents of
 * its `dist/`, and nothing else from its source tree (R6.8).
 * {@link stageImageTree} calls this once per staged package, whatever its
 * category, so "manifest plus `dist/`" is one rule rather than one per
 * category.
 *
 * `dereference: true` is what makes the staged package a real directory rather
 * than a workspace symlink (R5.6), and what keeps the staged file set for
 * `contracts` byte-identical, `dist/testing/` included (R5.8).
 */
export function copyPackage(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));
  cpSync(join(sourceDir, DIST_DIR), join(targetDir, DIST_DIR), {
    recursive: true,
    dereference: true,
  });
}

/** Reports whether `path` is a directory holding at least one entry. */
export function isNonEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/**
 * Lists the direct entry names under an Image_Tree's `@microservices/` scope
 * directory.
 *
 * {@link assertImageTreeIntegrity} uses it to see what the tree actually
 * contains. Entries come back in ascending code-point order, and an absent
 * directory reads as an empty list. Every direct entry is reported, not just
 * directories, because a stray file or a dangling symlink under the scope is
 * exactly the leakage that assertion exists to catch.
 */
export function listScopedEntries(scopeDir: string): readonly string[] {
  try {
    return readdirSync(scopeDir).sort();
  } catch {
    return [];
  }
}

/** The repo-relative build output directory of a planned package. */
function distOf(sourceDir: string): string {
  return `${sourceDir}/${DIST_DIR}`;
}

/**
 * The Image_Tree scope directory this plan targets, read off the plan itself
 * rather than from any scope literal (R10.5).
 *
 * Every scoped staged package carries `targetDir === \`${scopeDir}/${scopedEntry}\``
 * (build-plan.ts's `scopedStage`), where `scopeDir` is the run's
 * `context.scopeDir`. Stripping the trailing `/<scopedEntry>` from the first such
 * entry recovers that directory, so the Integrity_Assertion enumerates exactly
 * the directory `build-plan.ts` targeted — under the run's configured scope, not
 * a hard-coded one. A plan with no scoped entry stages nothing under the scope,
 * so the returned value is unobservable; the module's own `DIST_DIR` sibling of a
 * default has no bearing here, so an empty string is returned and the absent
 * scope directory reads as an empty entry list.
 */
function scopeDirOf(plan: BuildPlan): string {
  for (const staged of plan.stage) {
    if (staged.scopedEntry !== undefined) {
      return staged.targetDir.slice(
        0,
        staged.targetDir.length - staged.scopedEntry.length - 1,
      );
    }
  }
  return "";
}

/** Sorted, quoted, comma-joined offender names for one failure message. */
function quote(entries: readonly string[]): string {
  return [...entries]
    .sort()
    .map((entry) => `"${entry}"`)
    .join(", ");
}

/**
 * Fails the build when a package the plan will stage produced no compiled
 * output (pipeline step 9; R5.9, R6.11).
 *
 * It runs before the first copy, so an offending build stages nothing. Every
 * offender is named, sorted by directory, so one run reports all of them rather
 * than only the first.
 *
 * There are two messages: R5.9 wants a Framework_Singleton's failure to say the
 * framework produced no compiled output, while R6.11 wants only the offending
 * directory and the missing output. The framework variant is raised first when
 * both have offenders, since a framework member with no output explains most of
 * the rest.
 *
 * The Entry_Package is one of the packages this ranges over, and its
 * `"entry-package"` justification is not `"framework-singleton"`, so it falls to
 * the `[image-tree:no-dist]` branch and is reported with the existing wording and
 * no new tag (registry-inversion R9.9).
 *
 * The two predicates are parameters so the function is pure and
 * property-testable against an in-memory layout; {@link stageImageTree} passes
 * `existsSync` and {@link isNonEmptyDir}.
 *
 * @param plan the plan whose `stage` members were just built.
 * @param exists true when the repo-relative path is present.
 * @param isNonEmptyDir true when the path is a directory holding an entry.
 * @throws `[image-tree:framework-output]` for a framework member with no
 *   `dist/` or an empty one; `[image-tree:no-dist]` otherwise.
 */
export function assertBuildOutputsPresent(
  plan: BuildPlan,
  exists: (path: string) => boolean,
  isNonEmptyDir: (path: string) => boolean,
): void {
  const offenders = plan.stage.filter((staged) => {
    const dist = distOf(staged.sourceDir);
    return !exists(dist) || !isNonEmptyDir(dist);
  });

  const isFramework = (
    justification: StagedPackage["justification"],
  ): boolean => justification === "framework-singleton";
  const dirsWhere = (framework: boolean): readonly string[] =>
    offenders
      .filter((staged) => isFramework(staged.justification) === framework)
      .map((staged) => staged.sourceDir)
      .sort();

  const framework = dirsWhere(true);
  if (framework.length > 0) {
    throw new Error(
      `[image-tree:framework-output] ${framework
        .map(
          (dir) =>
            `Framework_Singleton "${dir}" produced no compiled output: "${distOf(dir)}" is absent or empty`,
        )
        .join("; ")}`,
    );
  }

  const others = dirsWhere(false);
  if (others.length > 0) {
    throw new Error(
      `[image-tree:no-dist] ${others
        .map(
          (dir) =>
            `package "${dir}" has no build output: "${distOf(dir)}" is absent or empty`,
        )
        .join("; ")}`,
    );
  }
}

/**
 * Checks that the assembled Image_Tree holds exactly the packages the plan
 * staged (pipeline step 11; R7.7–R7.11).
 *
 * It enumerates the real direct entries under
 * `<outDir>/node_modules/@microservices/` and compares them with the entries
 * `plan.stage` justifies, so an entry nothing in the plan accounts for is still
 * caught (R7.9). Both directions are checked: every entry present must be
 * justified (R7.7, R7.8), and every justified entry must be present (R7.11).
 * Offenders are all named and sorted; an unjustified entry is reported before a
 * missing one.
 *
 * The justified set is the `scopedEntry` values of `plan.stage` — the
 * always-staged Framework_Singletons (`contracts` and the Overseer_Library), the
 * Required_Dependencies, and the selected microservices (R5.10, R7.3–R7.5,
 * registry-inversion R3.7). Reading it off the same list that drove the copying
 * keeps the check in step with staging: a package that leaves `plan.stage` stops
 * being copied and stops being expected at once.
 *
 * Two consequences of the Entry_Package's staging land here with no logic of
 * their own. The Entry_Package cannot be reported at all: its staged entry
 * carries `scopedEntry: undefined`, so it is neither enumerated by
 * {@link listScopedEntries} nor a member of the justified set, and
 * registry-inversion R9.7's "no diagnostic for the Entry_Package's
 * package-directory staging" holds because the check does not range over it
 * rather than because an exemption was written. And the Overseer_Library has
 * become subject to the check: at its package directory it sat outside the
 * enumerated directory, while at `node_modules/<Configured_Scope>/overseer` it is
 * both enumerated and justified, so an image that failed to stage it now fails
 * with `[image-tree:missing]` naming `overseer`.
 *
 * @param outDir the assembled Image_Tree root.
 * @param plan the plan that was just executed.
 * @param listScopedEntries lists the direct entry names of the scope directory,
 *   returning an empty list when it is absent. Injected so the assertion is
 *   property-testable over generated (plan, actual-entries) pairs.
 * @throws `[image-tree:unjustified]`, `[image-tree:missing]`.
 */
export function assertImageTreeIntegrity(
  outDir: string,
  plan: BuildPlan,
  listScopedEntries: (scopeDir: string) => readonly string[],
): void {
  const scopeDir = join(outDir, scopeDirOf(plan));
  const justified = new Set(
    plan.stage
      .map((staged) => staged.scopedEntry)
      .filter((entry): entry is string => entry !== undefined),
  );
  const present = new Set(listScopedEntries(scopeDir));

  const unjustified = [...present].filter((entry) => !justified.has(entry));
  if (unjustified.length > 0) {
    throw new Error(
      `[image-tree:unjustified] ${scopeDir} contains ${quote(unjustified)} — the Image_Tree must contain only the Selected_Microservices, the Required_Dependencies, and the always-staged Framework_Singletons`,
    );
  }

  const missing = [...justified].filter((entry) => !present.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `[image-tree:missing] ${scopeDir} is missing ${quote(missing)} — every selected microservice, every Required_Dependency, and every always-staged Framework_Singleton must be present`,
    );
  }
}

/**
 * Assembles the Image_Tree for one container build from a derived plan.
 *
 * The domain function of the image path (R1.9): it takes the run's
 * {@link ProjectContext} and the {@link BuildPlan} already derived for the
 * `MICROSERVICES` value, and runs pipeline steps 7 to 11 through
 * {@link executeBuildPlan} — the single `tsc --build`, the per-SPA bundler
 * builds, the build-output assertion, staging, and the Integrity_Assertion. It
 * derives nothing and reads no configuration: the config load, discovery,
 * registry generation and plan derivation are the CLI's business
 * ({@link runImageTreeCli}), so this function stays a pure executor a test can
 * drive with a synthesized context and plan.
 *
 * @param context the per-run derivation of this run's Effective_Config (R1.9).
 * @param plan the plan derived for the `MICROSERVICES` value.
 * @param outDir the Image_Tree root to assemble; defaults to the container
 *   build's `/out`.
 */
export function buildImageTree(
  context: ProjectContext,
  plan: BuildPlan,
  outDir = "/out",
): void {
  executeBuildPlan(context, plan, outDir);
}

/**
 * The CLI adapter of the image path, invoked from `bin/build-image-tree.ts`.
 *
 * It holds every effect the domain function does not: the config load (through
 * {@link requireProjectContext}, the one place a Config_Diagnostic reaches stderr
 * and the process exits over one, R1.10), the framework-directory presence check
 * (pipeline step 1, R10.7), discovery (steps 2 and 4–5), registry generation
 * (step 3, R14.2), and plan derivation (step 6). It then hands the context and
 * plan to {@link buildImageTree}.
 *
 * @param outDir the Image_Tree root; defaults to the container build's `/out`.
 */
export function runImageTreeCli(outDir = "/out"): void {
  const context = requireProjectContext(); // R1.10 — config load, exit on diagnostics
  assertFrameworkDirectoriesPresent(existsSync); // R10.7
  const discovery = discoverPackages(context); // R3.4–R3.6, R4 validation
  const selector = process.env.MICROSERVICES;
  generateRegistry(context, selector, discovery); // R14.2, unchanged output
  const plan = buildPlanFrom(
    context,
    selector,
    discovery,
    readDependencySpecifiers(context),
  );

  buildImageTree(context, plan, outDir);
}

/**
 * Runs the plan's builds and then stages the Image_Tree.
 *
 * Pipeline steps 7 to 11, split out of {@link buildImageTree} so a test can
 * drive them with an injected {@link CommandRunner} instead of a real
 * `spawnSync`. Step 7 is the Tsc_Build_Pass, step 8 the Bundler_Build_Phase,
 * and step 8 is entered only once step 7 exited zero (R6.4, R6.5).
 *
 * That order holds because a Spa_Package is a sink in the import graph — nothing
 * imports it by name — so it can never be a prerequisite of `tsc --build`
 * (R6.13), while a Common_Package a Spa_Package imports is a Tsc_Project whose
 * compiled `dist/` must exist before the bundler runs (R6.12).
 *
 * Both build phases precede staging and the runner throws on the first non-zero
 * exit, so a failed `tsc --build` (R6.10) or a failed Spa_Package build (R6.9)
 * leaves the Image_Tree untouched. `stage` is one injected step so a test can
 * assert it never ran.
 *
 * @param context the per-run derivation of this run's Effective_Config (R1.9),
 *   read by the registry-presence guard for the Generated_Registry's path.
 * @param plan the plan to execute.
 * @param outDir the Image_Tree root to assemble.
 * @param runner the command runner; defaults to the real {@link run}.
 * @param stage the staging step; defaults to {@link stageImageTree}.
 */
export function executeBuildPlan(
  context: ProjectContext,
  plan: BuildPlan,
  outDir: string,
  runner: CommandRunner = run,
  stage: (plan: BuildPlan, outDir: string) => void = stageImageTree,
): void {
  // The Entry_Package is one of `plan.tscRoots` (statement 6 of the
  // Build_Sequence), so this `tsc --build` compiles the Entry_Module and its
  // static import of the Generated_Registry. The guard runs first: an absent
  // registry is reported as the named diagnostic and the run ends here, with no
  // compiler invoked and no compiled output emitted, rather than surfacing the
  // compiler's unresolved-module error (registry-inversion R5.3, R5.5).
  assertRegistryPresent(context);

  runner("npx", ["tsc", "--build", ...plan.tscRoots]); // step 7 (R6.5)
  for (const spa of plan.spaBuilds) {
    runner("npm", ["run", "build"], { cwd: spa.packageDir }); // step 8 (R6.4)
  }

  stage(plan, outDir);
}

/**
 * Copies every package the plan stages into `outDir`.
 *
 * Pipeline steps 9 to 11, reached only once every build in
 * {@link executeBuildPlan} succeeded, so a build failure never gets here (R6.9,
 * R6.10). The `rmSync` targets `outDir` itself and is the only removal in the
 * assembler; nothing prunes or empties a staged package (R7.6).
 */
export function stageImageTree(plan: BuildPlan, outDir: string): void {
  assertBuildOutputsPresent(plan, existsSync, isNonEmptyDir); // R5.9, R6.11
  rmSync(outDir, { recursive: true, force: true });
  for (const staged of plan.stage) {
    copyPackage(staged.sourceDir, join(outDir, staged.targetDir)); // R6.8
  }
  assertImageTreeIntegrity(outDir, plan, listScopedEntries); // R7.7–R7.11
}

// This module holds the registry-presence guard: the policy that a `tsc`
// invocation whose roots include the Entry_Package is never started while the
// Generated_Registry the Entry_Module statically imports is absent
// (registry-inversion R5.3, R5.5).
//
// It is the replacement for what the retired Registry_Template used to buy. The
// template made an ungenerated registry a compilable stand-in; with the template
// gone, an ungenerated registry is an unresolved module specifier, and the
// compiler's own message for that names a specifier rather than the command that
// writes the file. So the guard runs first and says which file is absent and
// which command produces it.
//
// Two things it deliberately does NOT do.
//
// It reads no content — not of the registry, and not of the Entry_Module. It
// asks the filesystem one question: is there a file at
// `generatedRegistryPath(context)`? That is the whole mechanism behind
// registry-inversion R2.10's "the Build_System reads no content of the
// Entry_Module and applies no validation to its source": the Build_System knows
// the registry's path because it is the party that WRITES it, so it never has to
// discover the Entry_Module's dependency by inspecting the importer's source.
//
// It composes no path of its own. The path comes from `generatedRegistryPath`
// (generate-registry.ts), the single derivation every writer, every guard, and
// every test reads from, so the file this guard demands is exactly the file the
// generator wrote (registry-inversion R5.8).
//
// The policy half is pure over an injected existence probe, so both branches are
// testable without a tree; only `assertRegistryPresent` and the CLI below touch
// `node:fs`, stderr, and the exit status.

import { existsSync } from "node:fs";

import { requireProjectContext } from "./config-loader.js";
import { generatedRegistryPath } from "./generate-registry.js";
import { type ProjectContext } from "./project-context.js";

/**
 * The injected existence probe the guard is pure over. Production passes
 * `node:fs`'s `existsSync`; a test passes a predicate over a set of paths and
 * needs no filesystem at all.
 */
export type PathExists = (path: string) => boolean;

/**
 * The command that produces the Generated_Registry, named in the diagnostic so
 * an operator reading the failure knows what to run.
 *
 * The compiled generator bin rather than an npm script, because it is the one
 * invocation that writes the registry on every path that writes it — the ordered
 * repository build reaches it through the Entry_Package's own `build` script,
 * `npm start`, `npm run dev`, and the image build stage each spawn it directly —
 * and because it is unambiguous from the repository root regardless of which of
 * those paths was the one that skipped its Registry_Generation_Step.
 */
const GENERATOR_COMMAND =
  "node packages/build-tools/dist/bin/generate-registry.js";

/**
 * The R5.5 diagnostic text for an absent Generated_Registry — naming the absent
 * path and the command that produces it — or `undefined` when the file is
 * present.
 *
 * Pure and total: the probe is the only thing it consults, and it consults it
 * once, for the single path `generatedRegistryPath(context)` derives. It reads no
 * content of that path, so a present-but-empty or present-but-stale registry is
 * "present" here and is the compiler's business, not the guard's.
 *
 * The returned text is one line's worth, carrying no trailing newline: the caller
 * that writes it adds the terminator, which keeps "exactly one diagnostic" a
 * property of the writer rather than of the string.
 *
 * @param context the per-run derivation of this run's Effective_Config (R1.9).
 * @param exists the existence probe.
 */
export function absentRegistryDiagnostic(
  context: ProjectContext,
  exists: PathExists,
): string | undefined {
  const registryPath = generatedRegistryPath(context);
  if (exists(registryPath)) {
    return undefined;
  }

  return `[entry-registry:absent] the generated microservice registry is absent: "${registryPath}" does not exist, so the entry package cannot be compiled. Run \`${GENERATOR_COMMAND}\` from the repository root to generate it.`;
}

/**
 * The effectful guard, called immediately before every `tsc` invocation whose
 * roots include the Entry_Package: `executeBuildPlan`'s single `tsc --build`
 * (image-tree.ts) and the Dev_Supervisor's builder, ahead of its first pass
 * (dev-supervisor.ts).
 *
 * On an absent registry it writes {@link absentRegistryDiagnostic}'s one line to
 * stderr and exits 1 — so no compiler is invoked and no compiled output is
 * emitted for the Entry_Package, which is what distinguishes this failure from
 * the unresolved-module error the compiler would otherwise report (R5.5). On a
 * present registry it returns and the caller proceeds; it never writes anything
 * on that path.
 *
 * Exiting here rather than throwing is deliberate: a thrown error out of the
 * build path reaches Node's default handler, which prints a stack trace, and
 * "exactly one diagnostic" is easier to keep true of a single stderr write than
 * of a stack trace that happens to contain the message.
 *
 * @param context the per-run derivation of this run's Effective_Config (R1.9).
 * @param exists the existence probe; the real filesystem by default.
 */
export function assertRegistryPresent(
  context: ProjectContext,
  exists: PathExists = existsSync,
): void {
  const diagnostic = absentRegistryDiagnostic(context, exists);
  if (diagnostic !== undefined) {
    process.stderr.write(`${diagnostic}\n`);
    process.exit(1);
  }
}

/**
 * The CLI adapter of the guard, for a caller outside this process — a script or
 * a bin that wants the same check and the same diagnostic ahead of a compiler it
 * spawns itself.
 *
 * It holds the one effect {@link assertRegistryPresent} does not: the config
 * load, through {@link requireProjectContext}, the one place a Config_Diagnostic
 * reaches stderr and the process exits over one (R1.10). It invokes no compiler
 * either way.
 */
export function runAssertRegistryPresentCli(): void {
  const context = requireProjectContext(); // R1.10
  assertRegistryPresent(context, existsSync);
}

// This module is the effect shell over the total, filesystem-free Config_Parser
// in project-config.ts. It is the layer that (a) reads the Project_Config_File
// once per run and distinguishes absent from unreadable (R1.5, R1.12, R2.11,
// R2.12), (b) runs the Filesystem_Validations of Requirement 5 through an
// injected prober, and (c) — in `requireProjectContext` alone — touches the real
// filesystem, stderr, and the process exit status (R1.10).
//
// The whole point of the split is that everything above the CLI adapter is pure
// over its injected effects: `loadProjectConfig` and `validateDiscoveryRoots`
// take reader and prober functions, so a test drives every branch of R1, R2 and
// R5 against synthesized outcomes with no real tree. Only
// `requireProjectContext` imports `node:fs` and `node:process`; the pure core
// above it does not, so "no filesystem access outside the adapter" is a fact
// about the module graph rather than a convention.
//
// The ordering rule "never probe a root the parser rejected" (R2.14, R5.6) is
// enforced structurally: `validateDiscoveryRoots` is the only function taking a
// ProbeRoot, and its first parameter is a branded {@link ParsedConfig}, which is
// constructible only by a successful `parseProjectConfig`. The inverted order
// does not compile.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { CONSUMER_CATEGORIES, type ConsumerCategory } from "./framework.js";
import {
  parseProjectConfig,
  renderDiagnostic,
  PROJECT_CONFIG_FILE,
  type ConfigDiagnostic,
  type ConfigTag,
  type Diagnostics,
  type EffectiveConfig,
  type ParsedConfig,
} from "./project-config.js";
import { projectContext, type ProjectContext } from "./project-context.js";

// ---------------------------------------------------------------------------
// Injected effects
// ---------------------------------------------------------------------------

/**
 * What reading the Project_Config_File yielded. Absence is a distinct outcome
 * from failure, which is exactly what R2.11 requires: an absent file is no
 * diagnostic (R1.5), an unreadable one is `[config:unreadable]` (R1.12, R2.12).
 */
export type ConfigFileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The injected config reader. Its only parameter is the config file path. */
export type ReadConfigFile = (configPath: string) => ConfigFileRead;

/**
 * What probing one Discovery_Root yielded. One call answers every
 * Filesystem_Validation of Requirement 5 for that root — including the
 * `package.json` question, carried by `holdsPackageJsonFile` — so R5.8's "probes
 * no path other than the three roots and the package.json inside each" holds by
 * the shape of the prober rather than by inspection of its callers.
 */
export type RootProbe =
  | { readonly kind: "absent" }
  | { readonly kind: "not-directory" }
  | { readonly kind: "directory"; readonly holdsPackageJsonFile: boolean }
  | { readonly kind: "failed"; readonly reason: string };

/** The injected prober of R5.8. Its only parameter is a Discovery_Root path. */
export type ProbeRoot = (rootPath: string) => RootProbe;

/** The result of a whole load: the Effective_Config, or a non-empty list of
 *  Config_Diagnostics that Requirement 1.10 turns into a terminated run. */
export type LoadOutcome =
  | { readonly kind: "loaded"; readonly config: EffectiveConfig }
  | { readonly kind: "rejected"; readonly diagnostics: Diagnostics };

// ---------------------------------------------------------------------------
// Diagnostic construction and Filesystem_Validation ordering
// ---------------------------------------------------------------------------

/** Builds a Config_Diagnostic, asserting all four parts non-empty at
 *  construction so a diagnostic with a blank part cannot exist (R2.13). */
function diagnostic(
  tag: ConfigTag,
  at: string,
  found: string,
  reason: string,
): ConfigDiagnostic {
  if (
    tag.length === 0 ||
    at.length === 0 ||
    found.length === 0 ||
    reason.length === 0
  ) {
    throw new Error(
      "internal error: a ConfigDiagnostic part was empty; every part must be non-empty (R2.13)",
    );
  }
  return { tag, at, found, reason };
}

/** The rank of a Consumer_Category in `microservice, common, spa` order, for the
 *  Filesystem_Validation comparator's primary key (R5.5). */
const CATEGORY_RANK: Readonly<Record<ConsumerCategory, number>> = {
  microservice: 0,
  common: 1,
  spa: 2,
};

/**
 * Orders Filesystem_Validation diagnostics by ascending Consumer_Category (in
 * `microservice, common, spa` order) and then by ascending code-point
 * comparison of tag (R5.5).
 *
 * This is deliberately a different rule from the parser's tag-then-`at`
 * comparator: R5.5 names the category first because a reader debugging three
 * roots wants a category's problems together. The two diagnostic sets never
 * appear in one run (R5.6), so no cross-component comparator is needed.
 *
 * Each Filesystem_Validation carries the Consumer_Category in its `at` part, so
 * the comparator receives the category alongside the diagnostic.
 */
function sortFilesystemDiagnostics(
  entries: readonly {
    readonly category: ConsumerCategory;
    readonly diagnostic: ConfigDiagnostic;
  }[],
): ConfigDiagnostic[] {
  return [...entries]
    .sort((a, b) => {
      const rankDiff = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
      if (rankDiff !== 0) return rankDiff;
      if (a.diagnostic.tag < b.diagnostic.tag) return -1;
      if (a.diagnostic.tag > b.diagnostic.tag) return 1;
      return 0;
    })
    .map((entry) => entry.diagnostic);
}

function rejected(diagnostics: Diagnostics): LoadOutcome {
  return { kind: "rejected", diagnostics };
}

function unreadableDiagnostic(configPath: string, reason: string): Diagnostics {
  return [
    diagnostic(
      "config:unreadable",
      configPath,
      reason,
      "the Project_Config_File exists but its contents could not be read as text; no default is substituted",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Filesystem_Validation (Requirement 5)
// ---------------------------------------------------------------------------

/**
 * The Filesystem_Validations of Requirement 5, and the ONLY function in the
 * layer that takes a prober. Its first parameter is a branded {@link
 * ParsedConfig}, so it cannot be called before the parser has succeeded: the
 * only way to obtain a ParsedConfig is to narrow a `ParseOutcome` to `parsed`,
 * which is exactly "the parser accepted this configuration" (R2.14, R5.6).
 *
 * It probes exactly three times, once per Consumer_Category in `microservice,
 * common, spa` order (R5.8), and answers the `package.json` question from the
 * returned RootProbe's `holdsPackageJsonFile` field rather than a second call.
 * It returns `{ kind: "loaded", config }` — not the ParsedConfig — so the brand
 * never leaks downstream (R5.5, R5.8).
 *
 * @param parsed a configuration the Config_Parser has already accepted.
 * @param probeRoot the injected prober of R5.8.
 */
export function validateDiscoveryRoots(
  parsed: ParsedConfig,
  probeRoot: ProbeRoot,
): LoadOutcome {
  const config = parsed.config;
  const found: {
    readonly category: ConsumerCategory;
    readonly diagnostic: ConfigDiagnostic;
  }[] = [];

  // Exactly three probes, in microservice, common, spa order (R5.8).
  for (const category of CONSUMER_CATEGORIES) {
    const rootPath = config.roots[category];
    const probe = probeRoot(rootPath);

    switch (probe.kind) {
      case "failed": {
        // R5.7 — a probe failure other than absence: one [config:root-unreadable]
        // for the category, suppressing every other Filesystem_Validation of it.
        found.push({
          category,
          diagnostic: diagnostic(
            "config:root-unreadable",
            category,
            probe.reason,
            `probing the '${category}' Discovery_Root '${rootPath}' failed`,
          ),
        });
        break;
      }
      case "absent": {
        // R5.1 — an absent microservice root is a failure; R5.2 — an absent
        // common or spa root yields zero packages and no diagnostic. The
        // root-is-package check (R5.4) is skipped for an absent root (R5.5).
        if (category === "microservice") {
          found.push({
            category,
            diagnostic: diagnostic(
              "config:root-missing",
              category,
              rootPath,
              "the microservice Discovery_Root must exist",
            ),
          });
        }
        break;
      }
      case "not-directory": {
        // R5.3 — an existing entry that is not a directory, for all three
        // categories. The root-is-package check is skipped for it (R5.5).
        found.push({
          category,
          diagnostic: diagnostic(
            "config:root-not-directory",
            category,
            rootPath,
            "a Discovery_Root must be a directory",
          ),
        });
        break;
      }
      case "directory": {
        // R5.4 — a directory that directly holds a package.json regular file is
        // itself a package. Only reached for a root that is present and a
        // directory, which is exactly where the skip of R5.5 does not apply.
        if (probe.holdsPackageJsonFile) {
          found.push({
            category,
            diagnostic: diagnostic(
              "config:root-is-package",
              category,
              rootPath,
              "a Discovery_Root is not itself a package; it holds a package.json directly",
            ),
          });
        }
        break;
      }
    }
  }

  if (found.length === 0) {
    return { kind: "loaded", config };
  }

  // Ordered by Consumer_Category then tag (R5.5); non-empty by the guard above.
  const sorted = sortFilesystemDiagnostics(found);
  const [first, ...rest] = sorted;
  if (first === undefined) {
    throw new Error(
      "internal error: sortFilesystemDiagnostics returned empty for a non-empty input",
    );
  }
  return rejected([first, ...rest]);
}

// ---------------------------------------------------------------------------
// The whole load
// ---------------------------------------------------------------------------

/**
 * The whole load, pure over its two injected effects. Its four-statement shape
 * IS the ordering rule (R1.5, R1.6, R1.12, R2.12, R2.14, R5.6):
 *
 * 1. read the file once (R2.11);
 * 2. an unreadable file is terminal, with no default substituted (R1.12, R2.12);
 * 3. an absent file parses as `{}`, so absent and `{}` are equal by
 *    construction (R1.5, R1.6);
 * 4. a parser rejection is returned unchanged — no probe happens — and only a
 *    parser success reaches the Filesystem_Validations (R2.14, R5.6).
 *
 * @param readConfigFile the injected config reader (R2.11).
 * @param probeRoot the injected filesystem prober (R5.8).
 * @param configPath the Project_Directory-relative config path, defaulting to
 *   the one path R1.1 permits.
 */
export function loadProjectConfig(
  readConfigFile: ReadConfigFile,
  probeRoot: ProbeRoot,
  configPath: string = PROJECT_CONFIG_FILE,
): LoadOutcome {
  const read = readConfigFile(configPath);
  if (read.kind === "unreadable") {
    // R1.12, R2.12 — no default substituted for the unread file.
    return rejected(unreadableDiagnostic(configPath, read.reason));
  }
  const outcome =
    read.kind === "absent"
      ? // R1.5 — absence is not a diagnostic; R1.6 — `{}` and absent are equal.
        parseProjectConfig("{}", configPath)
      : parseProjectConfig(read.text, configPath);
  if (outcome.kind === "rejected") {
    // R2.14, R5.6 — a parser rejection is terminal; no probe happens.
    return { kind: "rejected", diagnostics: outcome.diagnostics };
  }
  return validateDiscoveryRoots(outcome.parsed, probeRoot);
}

// ---------------------------------------------------------------------------
// The CLI adapter (the ONLY place touching node:fs, node:process, stderr, exit)
// ---------------------------------------------------------------------------

/** Tells whether a filesystem error means "this path does not exist". */
function isAbsent(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real config reader: reads the Project_Config_File once, mapping an
 *  ENOENT/ENOTDIR to `absent` and every other failure to `unreadable` (R2.11). */
function readConfigFileFromDisk(configPath: string): ConfigFileRead {
  try {
    return { kind: "text", text: readFileSync(configPath, "utf8") };
  } catch (error) {
    if (isAbsent(error)) {
      return { kind: "absent" };
    }
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The real filesystem prober: one call answers every Filesystem_Validation of
 * Requirement 5 for one root, probing no path other than the root and the
 * `package.json` directly inside it (R5.8). Symbolic links are resolved
 * (`statSync` follows them), so a link whose target is absent reads as `absent`
 * (R5.1) and a link to a non-directory reads as `not-directory` (R5.3).
 */
function probeRootFromDisk(rootPath: string): RootProbe {
  let stats;
  try {
    stats = statSync(rootPath);
  } catch (error) {
    if (isAbsent(error)) {
      return { kind: "absent" };
    }
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!stats.isDirectory()) {
    return { kind: "not-directory" };
  }

  // R5.4 — the one package.json question, answered by a field. The entry must
  // resolve to a regular file; a directory named package.json does not count.
  let holdsPackageJsonFile: boolean;
  try {
    holdsPackageJsonFile = statSync(join(rootPath, "package.json")).isFile();
  } catch (error) {
    if (isAbsent(error)) {
      holdsPackageJsonFile = false;
    } else {
      return {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { kind: "directory", holdsPackageJsonFile };
}

/**
 * The CLI adapter, and the single place in the layer that touches `node:fs`,
 * `node:process`, stderr, and the process exit status (R1.10). It reads the one
 * Project_Config_File relative to the Project_Directory (the running process's
 * working directory, R1.1), and on any Config_Diagnostic writes every rendered
 * diagnostic to stderr and exits with a non-zero status, performing no discovery
 * (R1.10). On success it returns the per-run {@link ProjectContext} threaded
 * through every other Build_System component (R1.9).
 */
export function requireProjectContext(): ProjectContext {
  const outcome = loadProjectConfig(
    readConfigFileFromDisk,
    probeRootFromDisk,
    join(process.cwd(), PROJECT_CONFIG_FILE),
  );

  if (outcome.kind === "rejected") {
    for (const diag of outcome.diagnostics) {
      process.stderr.write(`${renderDiagnostic(diag)}\n`);
    }
    process.exit(1);
  }

  return projectContext(outcome.config);
}

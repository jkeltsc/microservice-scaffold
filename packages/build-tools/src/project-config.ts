// This module is the single declaration site for the project's scope and its
// three Discovery_Roots, and the total, filesystem-free Config_Parser and
// Config_Serializer over the Project_Config_File text.
//
// It is the only module in `packages/build-tools/src/` where the string
// `@microservices` or any Discovery_Root path appears as a literal (R1.8,
// R12.4). The four defaults live here and nowhere else; every other use derives
// from them.
//
// The parser is total: every input string yields exactly one of a ParsedConfig
// or a non-empty list of Config_Diagnostics, with no throw and no process exit
// (R2.1). `JSON.parse` is the only throwing call and is wrapped exactly once;
// every validation after it operates on an already-parsed `unknown` through type
// predicates. This module imports neither `node:fs` nor `node:process`, so
// R2.2's "no filesystem access" is a fact about the module graph, and it imports
// only the leaf `categories.ts` (for ConsumerCategory, CONSUMER_CATEGORIES, and
// the four Framework_Singleton directory names).
//
// It deliberately does NOT import `framework.ts`. framework.ts imports
// SCOPE_DEFAULT and ROOT_DEFAULTS from here and reads them at its own
// module-initialisation time (its transitional shims and `singleton()` calls).
// Were this module to import framework.ts back, that would be a cycle whose
// framework.ts -> project-config.ts edge is a value dependency at load: entering
// this module first would leave framework.ts's top-level shims reading
// ROOT_DEFAULTS in its dead zone. Taking the shared primitives from the leaf
// `categories.ts` instead removes the edge entirely, so no entry order can trip.

import {
  CONSUMER_CATEGORIES,
  FRAMEWORK_DIR_NAMES,
  PACKAGES_DIR,
  type ConsumerCategory,
} from "./categories.js";

/** The fully defaulted, validated configuration one run operates on. */
export interface EffectiveConfig {
  readonly scope: string;
  readonly roots: Readonly<Record<ConsumerCategory, string>>;
}

/** The only declaration of the Scope_Default in the repository (R1.8, R12.4). */
export const SCOPE_DEFAULT = "@microservices";

/** The only declaration of the three Root_Defaults (R1.8).
 *
 *  Spelled as whole literals, not composed from `PACKAGES_DIR`: a Discovery_Root
 *  is not required to live under `packages/` (R4.9), so treating `packages` as a
 *  shared prefix would encode a constraint the feature removes. */
export const ROOT_DEFAULTS: Readonly<Record<ConsumerCategory, string>> = {
  microservice: "packages/microservices",
  common: "packages/common",
  spa: "packages/spa",
};

/** The one path the config is read from, Project_Directory-relative (R1.1). */
export const PROJECT_CONFIG_FILE = "scaffold.config.json";

/**
 * The Effective_Config of a project that declares nothing (R1.5, R1.7).
 *
 * A function rather than a frozen constant so the absent-file path (R1.5) and
 * the `{}` path (R1.6) provably return equal values by construction: both call
 * it.
 */
export function defaultEffectiveConfig(): EffectiveConfig {
  return {
    scope: SCOPE_DEFAULT,
    roots: {
      microservice: ROOT_DEFAULTS.microservice,
      common: ROOT_DEFAULTS.common,
      spa: ROOT_DEFAULTS.spa,
    },
  };
}

/** The twelve diagnostic tags. Seven belong to the Config_Parser, five to the
 *  Config_Loader; no one run reports both sets. */
export type ConfigTag =
  | "config:unparsable"
  | "config:shape"
  | "config:unknown-key"
  | "config:scope"
  | "config:root-path"
  | "config:root-overlap"
  | "config:root-framework"
  | "config:unreadable"
  | "config:root-missing"
  | "config:root-not-directory"
  | "config:root-is-package"
  | "config:root-unreadable";

/** One reported problem, four parts, each non-empty (R2.13). */
export interface ConfigDiagnostic {
  readonly tag: ConfigTag;
  /** The JSON key path, Consumer_Category, or Project_Directory-relative file path. */
  readonly at: string;
  /** The offending value, the JSON type found, or the underlying failure text. */
  readonly found: string;
  /** Why the value is rejected. */
  readonly reason: string;
}

/** A non-empty list, in the type system rather than in a comment (R2.1). */
export type Diagnostics = readonly [ConfigDiagnostic, ...ConfigDiagnostic[]];

// Module-private brand, never exported. A real runtime symbol (not a bare
// `declare const`, which erases at emit and would leave the computed-property
// key below undefined at runtime): the brand is both a compile-time type and
// the value written into every ParsedConfig.
const PARSED: unique symbol = Symbol("ParsedConfig");

/** A configuration that HAS passed every parser validation of R2, R3 and R4.
 *  Constructible only by {@link parseProjectConfig}. */
export interface ParsedConfig {
  readonly [PARSED]: true;
  readonly config: EffectiveConfig;
}

export type ParseOutcome =
  | { readonly kind: "parsed"; readonly parsed: ParsedConfig }
  | { readonly kind: "rejected"; readonly diagnostics: Diagnostics };

// ---------------------------------------------------------------------------
// Diagnostic construction, collection, ordering
// ---------------------------------------------------------------------------

/** Builds a diagnostic, asserting all four parts non-empty at construction so a
 *  diagnostic with a blank part cannot exist (R2.13). */
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

/**
 * Collects diagnostics keyed by the tag-and-key-path pair, first write wins.
 *
 * The single structure discharges three requirements at once: collect
 * everything (R2.7), at most one per pair (R2.7, the key IS the pair), and a
 * total order on return (R2.8) — sorted by ascending code-point comparison of
 * tag then of `at`, which never ties because the key is that same pair.
 */
class DiagnosticCollector {
  private readonly byPair = new Map<string, ConfigDiagnostic>();

  add(d: ConfigDiagnostic): void {
    const key = `${d.tag}\u0000${d.at}`;
    if (!this.byPair.has(key)) {
      this.byPair.set(key, d);
    }
  }

  get isEmpty(): boolean {
    return this.byPair.size === 0;
  }

  /** The sorted, non-empty list; callers guard on {@link isEmpty} first. */
  sorted(): Diagnostics {
    const list = [...this.byPair.values()].sort((a, b) => {
      if (a.tag < b.tag) return -1;
      if (a.tag > b.tag) return 1;
      if (a.at < b.at) return -1;
      if (a.at > b.at) return 1;
      return 0;
    });
    // Non-empty by construction of every call site; assert for the type.
    const [first, ...rest] = list;
    if (first === undefined) {
      throw new Error("internal error: sorted() called on an empty collector");
    }
    return [first, ...rest];
  }
}

function rejected(diagnostics: Diagnostics): ParseOutcome {
  return { kind: "rejected", diagnostics };
}

// ---------------------------------------------------------------------------
// JSON shape helpers
// ---------------------------------------------------------------------------

/**
 * Renders a rejected string value for a diagnostic's `found` part, reproducing
 * it exactly as declared (R3.2, R4.2) while keeping the part non-empty (R2.13).
 *
 * Most rejected values are non-empty and their own text is the clearest
 * reproduction. But R3.3 and R4.3 both enumerate the empty string — and a
 * whitespace-only value — as rejectable, and an empty `found` would violate the
 * non-empty-parts invariant (and, for whitespace, would render invisibly). For
 * exactly those cases the value is reproduced in JSON-quoted form: `""` for the
 * empty string, `"   "` for whitespace, which reproduces the value reversibly
 * and unambiguously without ever being empty. A value that is both non-empty
 * and not whitespace-only is reproduced verbatim.
 */
function renderRejectedValue(value: string): string {
  if (value.length === 0 || value.trim().length === 0) {
    return JSON.stringify(value);
  }
  return value;
}

/** The JSON type name of a parsed value, for `[config:shape]` diagnostics. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "object" | "string" | "number" | "boolean"
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Scope validation (R3)
// ---------------------------------------------------------------------------

/** A Valid_Scope: `@` followed by one or more of [a-z], [0-9], or `-` (R3.1). */
const VALID_SCOPE = /^@[a-z0-9-]+$/;

function isValidScope(value: string): boolean {
  return VALID_SCOPE.test(value);
}

const SCOPE_CHARSET_REASON =
  "a scope must be '@' followed by one or more characters, each a lowercase ASCII letter, an ASCII digit, or a hyphen";

// ---------------------------------------------------------------------------
// Root-path validation (R4)
// ---------------------------------------------------------------------------

/** Every Valid_Root_Path condition a value violates, in a fixed order, or an
 *  empty list when the value is a Valid_Root_Path (R4.2, R4.3). */
function rootPathViolations(value: string): string[] {
  const violations: string[] = [];

  if (value.length === 0) {
    violations.push("must not be empty");
  }
  if (value.length > 0 && value.trim().length === 0) {
    violations.push("must not consist only of whitespace");
  }
  if (/^\s/.test(value)) {
    violations.push("must not begin with a whitespace character");
  }
  if (/\s$/.test(value)) {
    violations.push("must not end with a whitespace character");
  }
  if (value.startsWith("/")) {
    violations.push("must not begin with '/'");
  }
  if (value.length > 1 && value.endsWith("/")) {
    violations.push("must not end with '/'");
  }
  if (value.includes("\\")) {
    violations.push("must not contain a '\\' character");
  }
  if (value.includes("*") || value.includes("?")) {
    violations.push("must not contain a '*' or '?' character");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    violations.push("must not contain a '..' path segment");
  }
  if (segments.some((segment) => segment === ".")) {
    violations.push("must not contain a '.' path segment");
  }
  if (segments.some((segment) => segment.length === 0)) {
    violations.push("must not contain an empty path segment");
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Overlap and framework-collision checks (R4.5–R4.8)
// ---------------------------------------------------------------------------

/** True when `inner` lies strictly inside `outer`: `inner` begins with `outer`
 *  followed by a single `/`, compared code point for code point (R4.6). */
function liesInside(inner: string, outer: string): boolean {
  return inner.startsWith(`${outer}/`);
}

/** The four Framework_Singleton package directories, in FRAMEWORK_DIR_NAMES
 *  order, for the `[config:root-framework]` check (R4.7). Composed here from the
 *  leaf directory names — this module never imports the framework.ts records,
 *  which is what keeps the two modules cycle-free (see the file header). */
function frameworkDirectories(): readonly string[] {
  return FRAMEWORK_DIR_NAMES.map((dirName) => `${PACKAGES_DIR}/${dirName}`);
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const RECOGNISED_TOP_LEVEL_KEYS = ["roots", "scope"] as const;

/**
 * Turns config text into a ParsedConfig or a non-empty diagnostic list. Total
 * over every string, including "", non-JSON, and >= 1 MiB (R2.1). Performs no
 * filesystem, network, environment, clock or random access (R2.2): the module
 * imports neither `node:fs` nor `node:process`, so that is a compile-time fact.
 *
 * @param text the file's bytes as UTF-8 text, unmodified (R2.14).
 * @param configPath the Project_Directory-relative path diagnostics name (R2.2).
 */
export function parseProjectConfig(
  text: string,
  configPath: string,
): ParseOutcome {
  // R2.3 — unparsable JSON: exactly one diagnostic, nothing else.
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return rejected([
      diagnostic(
        "config:unparsable",
        configPath,
        error instanceof Error ? error.message : String(error),
        "the Project_Config_File must contain a single JSON object",
      ),
    ]);
  }

  // R2.4 — a non-object top level: exactly one diagnostic, no further validation.
  if (!isJsonObject(root)) {
    return rejected([
      diagnostic(
        "config:shape",
        configPath,
        jsonTypeOf(root),
        "the Project_Config must be a JSON object with recognised keys 'scope' and 'roots'",
      ),
    ]);
  }

  const diagnostics = new DiagnosticCollector();

  // R2.6 — unknown top-level keys, one per key; recognised keys still validated.
  for (const key of Object.keys(root)) {
    if (key !== "scope" && key !== "roots") {
      diagnostics.add(
        diagnostic(
          "config:unknown-key",
          key,
          key,
          `unrecognised top-level key; recognised keys are ${RECOGNISED_TOP_LEVEL_KEYS.map((k) => `'${k}'`).join(", ")}`,
        ),
      );
    }
  }

  // --- scope: one of declared-accepted, declared-rejected, undeclared -------
  let scope: string = SCOPE_DEFAULT;
  if ("scope" in root) {
    const raw = root["scope"];
    if (typeof raw !== "string") {
      // R3.4 — wrong-typed scope: `[config:shape]` alone, no `[config:scope]`.
      diagnostics.add(
        diagnostic(
          "config:shape",
          "scope",
          jsonTypeOf(raw),
          "'scope' must be a string",
        ),
      );
    } else if (!isValidScope(raw)) {
      // R3.2, R3.3 — one `[config:scope]` per rejected value.
      diagnostics.add(
        diagnostic(
          "config:scope",
          "scope",
          renderRejectedValue(raw),
          SCOPE_CHARSET_REASON,
        ),
      );
    } else {
      scope = raw; // R3.1 — character for character, no normalisation.
    }
  }

  // --- roots: per category, three states; only undeclared takes a default ----
  const roots: Record<ConsumerCategory, string> = {
    microservice: ROOT_DEFAULTS.microservice,
    common: ROOT_DEFAULTS.common,
    spa: ROOT_DEFAULTS.spa,
  };
  // A category's root participates in overlap/framework checks unless it was
  // declared and rejected (R4.10 keeps a rejected value out; R4.8 keeps a
  // defaulted value in).
  const rootRejected: Record<ConsumerCategory, boolean> = {
    microservice: false,
    common: false,
    spa: false,
  };

  if ("roots" in root) {
    const rawRoots = root["roots"];
    if (!isJsonObject(rawRoots)) {
      // R2.5, R3.4 shape rule for roots: one `[config:shape]`, no member checks.
      diagnostics.add(
        diagnostic(
          "config:shape",
          "roots",
          jsonTypeOf(rawRoots),
          "'roots' must be a JSON object",
        ),
      );
    } else {
      // R2.6 — unknown roots members, one per key.
      for (const key of Object.keys(rawRoots)) {
        if (
          key !== "microservice" &&
          key !== "common" &&
          key !== "spa"
        ) {
          diagnostics.add(
            diagnostic(
              "config:unknown-key",
              `roots.${key}`,
              key,
              "unrecognised 'roots' member; recognised members are 'common', 'microservice', 'spa'",
            ),
          );
        }
      }

      for (const category of CONSUMER_CATEGORIES) {
        if (!(category in rawRoots)) {
          continue; // undeclared: keeps its default, stays in the checks.
        }
        const rawValue = rawRoots[category];
        if (typeof rawValue !== "string") {
          // R2.5 — wrong-typed roots member: `[config:shape]`, excluded from
          // overlap/framework comparisons (R4.10).
          diagnostics.add(
            diagnostic(
              "config:shape",
              `roots.${category}`,
              jsonTypeOf(rawValue),
              `'roots.${category}' must be a string`,
            ),
          );
          rootRejected[category] = true;
          continue;
        }
        const violations = rootPathViolations(rawValue);
        if (violations.length > 0) {
          // R4.2, R4.3 — one `[config:root-path]` naming every violated
          // condition; excluded from later comparisons (R4.10).
          diagnostics.add(
            diagnostic(
              "config:root-path",
              `roots.${category}`,
              renderRejectedValue(rawValue),
              `not a valid relative POSIX path: ${violations.join("; ")}`,
            ),
          );
          rootRejected[category] = true;
          continue;
        }
        roots[category] = rawValue; // R4.1 — accepted, no normalisation.
      }
    }
  }

  // --- overlap and framework checks over accepted-or-defaulted roots ---------
  const checkable = CONSUMER_CATEGORIES.filter(
    (category) => !rootRejected[category],
  );

  // R4.5, R4.6 — one `[config:root-overlap]` per unordered category pair,
  // equality suppressing the nesting report; categories named in
  // microservice, common, spa order (CONSUMER_CATEGORIES order).
  for (let i = 0; i < checkable.length; i += 1) {
    for (let j = i + 1; j < checkable.length; j += 1) {
      const a = checkable[i]!;
      const b = checkable[j]!;
      const pathA = roots[a];
      const pathB = roots[b];
      if (pathA === pathB) {
        diagnostics.add(
          diagnostic(
            "config:root-overlap",
            `${a}, ${b}`,
            pathA,
            `the '${a}' and '${b}' Discovery_Roots are equal; a package directly inside a shared root would belong to two Consumer_Categories`,
          ),
        );
      } else if (liesInside(pathB, pathA)) {
        diagnostics.add(
          diagnostic(
            "config:root-overlap",
            `${a}, ${b}`,
            `${pathA}, ${pathB}`,
            `the '${b}' Discovery_Root lies inside the '${a}' Discovery_Root`,
          ),
        );
      } else if (liesInside(pathA, pathB)) {
        diagnostics.add(
          diagnostic(
            "config:root-overlap",
            `${a}, ${b}`,
            `${pathA}, ${pathB}`,
            `the '${a}' Discovery_Root lies inside the '${b}' Discovery_Root`,
          ),
        );
      }
    }
  }

  // R4.7 — one `[config:root-framework]` per offending category-and-directory
  // pair, at most four per category.
  const frameworkDirs = frameworkDirectories();
  for (const category of checkable) {
    const rootPath = roots[category];
    for (const dir of frameworkDirs) {
      let relation: string | undefined;
      if (rootPath === dir) {
        relation = "is equal to";
      } else if (liesInside(rootPath, dir)) {
        relation = "lies inside";
      } else if (liesInside(dir, rootPath)) {
        relation = "contains";
      }
      if (relation !== undefined) {
        diagnostics.add(
          diagnostic(
            "config:root-framework",
            `${category}, ${dir}`,
            rootPath,
            `the '${category}' Discovery_Root ${relation} the Framework_Singleton directory '${dir}'; a Framework_Singleton is known by name and is never a discovered package`,
          ),
        );
      }
    }
  }

  if (!diagnostics.isEmpty) {
    return rejected(diagnostics.sorted());
  }

  const config: EffectiveConfig = {
    scope,
    roots: {
      microservice: roots.microservice,
      common: roots.common,
      spa: roots.spa,
    },
  };
  return { kind: "parsed", parsed: { [PARSED]: true, config } };
}

/**
 * Renders an Effective_Config as JSON declaring all four values (R2.9).
 *
 * Two Effective_Configs equal in all four values render byte-identically: the
 * keys are written in a fixed order and the values are the config's own strings.
 */
export function serializeProjectConfig(config: EffectiveConfig): string {
  const shape = {
    scope: config.scope,
    roots: {
      microservice: config.roots.microservice,
      common: config.roots.common,
      spa: config.roots.spa,
    },
  };
  return `${JSON.stringify(shape, null, 2)}\n`;
}

/** `[tag] at — found; reason`, the one rendering of a diagnostic (R2.13). */
export function renderDiagnostic(diagnostic: ConfigDiagnostic): string {
  return `[${diagnostic.tag}] ${diagnostic.at} — ${diagnostic.found}; ${diagnostic.reason}`;
}

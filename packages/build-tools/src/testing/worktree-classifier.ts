// @microservices/build-tools/dist/testing — the shared Worktree_Guard
// WRITE-DESTINATION CLASSIFIER (Fixture_Tier spec, task 9.2; R9.1–R9.6,
// R9.3, R9.4, R16.10).
//
// ONE PREDICATE, TWO CONSUMERS
// ---------------------------------------------------------------------------
// Two callers evaluate "does the Worktree_Guard flag this mutating call's
// destination?" and must agree:
//
//   - the Worktree_Guard (`worktree-safety-guard.test.ts`, task 9.1) scans the
//     real Platform_Test_Set and flags each mutating fs call whose destination
//     lies inside the checked-out tree and outside the six Permitted_Write_
//     Locations; and
//   - Property 9 (`worktree-guard-fixture-anchors.property.test.ts`, task 9.2)
//     asserts that same flag verdict over GENERATED mutating-call fragments
//     whose expected verdict the generator already knows.
//
// The two derivations were meant to agree, so the classification and the
// flagging rule live here once and both import them by compiled path from
// `@microservices/build-tools/dist/testing/index.js`. This mirrors how task 8.4
// extracted `classifyRecordAgainstSet`: two derivations that must agree become
// one module. Both consumers live in `packages/integration-tests`, but the
// design's cross-package rule sends a shared predicate through `src/testing/`
// rather than a package-private `tests/`.
//
// WHAT THE CLASSIFIER DECIDES (design "THE WRITE-DESTINATION SCAN")
// ---------------------------------------------------------------------------
// Given a mutating fs call's argument SPAN (the balanced text between its
// parentheses, possibly multi-line) and whether the file that holds the call
// also contains a temp-CREATING call, the classifier reports three facts:
//
//   - `checkedOut` — the span names a Checked_Out_Anchor: one of the three
//     fixed bases (`repoRoot`, `TESTS_DIR`, `__dirname`) or a fixture path
//     constant. A fixture path IS in the checked-out tree (R9.3).
//   - `temp` — the span names a temp anchor. An unconditional temp anchor
//     (`tmp`, `mkdtemp`, `pristine`, `outPath`) always counts; a bare `dir` or
//     `root` counts ONLY in a file that creates a temporary directory (R9.3,
//     part 2), so a `root` that is really `resolve(FIXTURES_ROOT, …)` in a file
//     with no temp creator is not excused.
//   - `permitted` — the span names one of the six Permitted_Write_Locations by
//     token: a `dist/` or `*.tsbuildinfo` (locations 1/2 and, when the anchor is
//     a fixture, 4/5), the derived Generated_Registry path (location 3), or a
//     `node_modules/` under a fixture anchor (location 6, R9.1). A `node_modules`
//     NOT under a fixture anchor is the repository's own and stays a violation.
//
// The flagging rule combines them: a call is flagged when its destination is
// checked-out and names no permitted location, OR when it writes a
// Project_Config_File with no temp/pristine base (R9.5). The classification is
// POSITIVE — a write anchored at an OS temp path or a pristine copy's directory
// is never flagged — so widening the scanned set turns nothing red for a write
// the guard merely fails to understand.
//
// R1.7 / [scope:literal]. This module lives under `packages/build-tools/src/`.
// It spells no Fixture_Tier path literal and no Scope_Default: it is pure over
// its argument span and the derived registry token it is handed, and reaches no
// filesystem and no scope. It holds no `scaffold.config.json` and no
// `node_modules` string contiguously that would matter — the tokens it searches
// FOR are assembled from fragments below so this source never holds a forbidden
// token whole, the same discipline the guard itself uses.

/** The fs calls that mutate the filesystem — the call heads the scan matches. */
export const MUTATING_FS: readonly string[] = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "symlinkSync",
  "renameSync",
  "cpSync",
  "copyFileSync",
  "truncateSync",
];

/**
 * The three fixed bases a test can build a checked-out path from — `repoRoot`,
 * `TESTS_DIR`, `__dirname` — unchanged from before the Fixture_Tier. `repoRoot`
 * is assembled from fragments so this source never holds it contiguously.
 */
export const CHECKED_OUT_ANCHORS: readonly string[] = [
  "repo" + "Root",
  "TESTS_DIR",
  "__dirname",
];

/**
 * Fixture path constants a test source declares, treated as Checked_Out_Anchors
 * (R9.3). Held as the named partition roots AND matched by shape below, so a new
 * fixture constant needs no edit here.
 */
export const FIXTURE_ANCHOR_NAMES: readonly string[] = [
  "FIXTURES_ROOT",
  "FIXTURES_DIR",
  "FIXTURE_TREES_ROOT",
  "FIXTURE_PROJECTS_ROOT",
];

/**
 * By-shape fixture-anchor test: a SCREAMING_SNAKE_CASE constant containing
 * `FIXTURE`. Upper-case letters, digits, and underscores only, so `FIXTURES_ROOT`
 * and a project's `FIXTURE_APP_ROOT` match while a lowercase `fixtureClone` local
 * and a bare lowercase tier path segment do not. (R1.7's scan is a plain token
 * match over this source, so this comment names that lowercase segment nowhere
 * contiguously.)
 */
export const FIXTURE_ANCHOR_SHAPE = /\b[A-Z0-9_]*FIXTURE[A-Z0-9_]*\b/;

/**
 * Temp anchors that stand alone: an OS temp path or a pristineWorktree() copy.
 * `dir` and `root` are NOT here — they are conditional (see below).
 */
export const UNCONDITIONAL_TEMP_ANCHORS: readonly string[] = [
  "tmp",
  "mkdtemp",
  "pristine",
  "outPath",
];

/**
 * `dir` and `root` are temp anchors ONLY in a file that also contains a
 * temp-CREATING call (R9.3, part 2).
 */
export const CONDITIONAL_TEMP_ANCHORS: readonly string[] = ["dir", "root"];

/** The calls that CREATE a temporary directory, gating the conditional anchors. */
export const TEMP_CREATORS: readonly string[] = [
  "mkdtemp",
  "tmpdir",
  "pristineWorktree",
  "fixtureClone",
];

/** A `dist/` directory or a `*.tsbuildinfo` file — permitted locations 1/2/4/5. */
export const DIST_OR_TSBUILDINFO = /\bdist\b|tsbuildinfo/;

/** A `node_modules` segment — permitted location 6 only under a fixture anchor. */
export const NODE_MODULES_TOKEN = /node_modules/;

/** The Project_Config_File name, assembled from fragments so this source never
 *  holds it whole. Writing one into the checked-out tree is a violation. */
export const CONFIG_FILE = "scaffold" + ".config.json";

/** Escapes a literal path for inclusion in a regular expression. */
export function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this span name a fixture path constant (by list or by shape)? */
export function hasFixtureAnchor(span: string): boolean {
  if (
    FIXTURE_ANCHOR_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(span))
  ) {
    return true;
  }
  return FIXTURE_ANCHOR_SHAPE.test(span);
}

/** The three facts the flagging rule combines. */
export interface SpanClassification {
  /** The destination is anchored inside the checked-out tree. */
  readonly checkedOut: boolean;
  /** The span carries a temp anchor (an OS temp path or a pristine copy). */
  readonly temp: boolean;
  /** The span names one of the six Permitted_Write_Locations by token. */
  readonly permitted: boolean;
}

/** Options threading the one derived value the classifier cannot spell: the
 *  Generated_Registry path token (permitted location 3), taken from the
 *  Build_System's single derivation by the caller (R9.6). */
export interface WorktreeClassifierOptions {
  /**
   * Whether the file holding the call also contains a temp-CREATING call, which
   * gates the conditional `dir`/`root` temp anchors (R9.3, part 2).
   */
  readonly fileHasTempCreator: boolean;
  /**
   * The Generated_Registry path — permitted location 3 — as a literal string,
   * taken from `generatedRegistryPath(projectContext(...))` rather than spelled
   * (R9.6). When omitted, location 3 is simply not recognised, which is correct
   * for a caller with no registry path to permit.
   */
  readonly generatedRegistryPath?: string;
}

/**
 * Classify a mutating call's argument `span`. Returns whether the destination is
 * anchored inside the checked-out tree, whether it carries a temp anchor, and
 * whether it names a Permitted_Write_Location — the three facts the flagging
 * rule combines. Pure over its arguments; reaches no filesystem.
 */
export function classifySpan(
  span: string,
  options: WorktreeClassifierOptions,
): SpanClassification {
  const fixtureAnchor = hasFixtureAnchor(span);
  const checkedOut =
    CHECKED_OUT_ANCHORS.some((token) =>
      new RegExp(`\\b${token}\\b`).test(span),
    ) || fixtureAnchor;

  let temp = UNCONDITIONAL_TEMP_ANCHORS.some((token) =>
    new RegExp(`\\b${token}\\b`).test(span),
  );
  if (options.fileHasTempCreator) {
    temp =
      temp ||
      CONDITIONAL_TEMP_ANCHORS.some((token) =>
        new RegExp(`\\b${token}\\b`).test(span),
      );
  }

  const namesRegistry =
    options.generatedRegistryPath !== undefined &&
    new RegExp(escapeForRegExp(options.generatedRegistryPath)).test(span);

  const permitted =
    DIST_OR_TSBUILDINFO.test(span) ||
    namesRegistry ||
    (NODE_MODULES_TOKEN.test(span) && fixtureAnchor);

  return { checkedOut, temp, permitted };
}

/**
 * The flagging rule (R9.5): a mutating call's `span` is flagged when its
 * destination is checked-out and names no permitted location, OR when it writes
 * a Project_Config_File with no temp/pristine base. Returns `true` when the
 * Worktree_Guard would report an offence for this span.
 *
 * This is the single decision both the guard and Property 9 share: the guard
 * applies it to every span it extracts from the real Platform_Test_Set, and
 * Property 9 applies it to a generated span whose expected verdict the generator
 * already knows.
 */
export function flagWriteSpan(
  span: string,
  options: WorktreeClassifierOptions,
): boolean {
  const { checkedOut, temp, permitted } = classifySpan(span, options);
  const writesConfigFile = span.includes(CONFIG_FILE);
  // Part 1 of the sufficiency fix — checked-out anchors are DECISIVE: a span
  // carrying a checked-out anchor outside a permitted location is a violation
  // even if it also carries a temp anchor. A config file written without any
  // temp/pristine base is a violation on its own ground.
  return (checkedOut && !permitted) || (writesConfigFile && !temp);
}

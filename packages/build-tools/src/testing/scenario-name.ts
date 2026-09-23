// @microservices/build-tools/dist/testing — the Scenario_Directory_Name
// derivation pair (Fixture_Tier spec, task 3.5; R4.1, R4.2).
//
// A Fixture_Scenario's directory name encodes its Expected_Diagnostic. The
// derivation is deliberately reversible so a renamed directory and a stale
// Scenario_Manifest cannot disagree silently: the suites recover the tag from
// the name and assert it equals the tag the manifest declares.
//
// DERIVATION (R4.1). A Diagnostic_Tag has the form `[<category>:<detail>]`
// where both parts are lowercase letters and hyphens. To derive the name: drop
// the brackets, replace the single `:` with `--`, and — when a qualifier is
// given — append `.` and that qualifier.
//
//   scenarioDirectoryName("[build-order:cycle]", "nested") -> "build-order--cycle.nested"
//   scenarioDirectoryName("[config:root-overlap]")         -> "config--root-overlap"
//
// RECOVERY (R4.2). Discard any `.` qualifier (everything from the first `.`
// onward), split the remainder on the FIRST `--`, and rejoin the two halves
// with `:`, wrapping in brackets.
//
//   expectedDiagnosticOf("build-order--cycle.nested") -> "[build-order:cycle]"
//
// WHY THE HYPHEN IS DOUBLED. A tag's category may itself contain a single
// hyphen — `build-order`, `entry-registry`, `image-tree` are real categories.
// A single-hyphen separator would make `build-order-cycle` ambiguous
// (`build:order-cycle`, `build-order:cycle`, and `build-order-cycle:` all read
// alike). The doubled `--` keeps the split unambiguous: the category–detail
// part must contain EXACTLY ONE occurrence of the `--` substring. A name whose
// category–detail part holds no `--`, or more than one, is not recoverable, so
// `expectedDiagnosticOf` throws naming the directory rather than guessing.
//
// This module lives under `packages/build-tools/src/`, so R1.7 applies: it
// spells no Fixture_Tier path literal and reads no path — it is pure string
// arithmetic over a tag and a directory name.

/** The separator standing in for the single `:` of a Diagnostic_Tag. */
const SEPARATOR = "--";

/**
 * Derive a Scenario_Directory_Name from a Diagnostic_Tag and an optional
 * qualifier (R4.1).
 *
 * `tag` is the Expected_Diagnostic with its brackets — e.g.
 * `"[config:root-overlap]"`. The single `:` becomes `--`; when `qualifier` is
 * given it is appended after a `.`.
 *
 *   scenarioDirectoryName("[build-order:cycle]", "nested")
 *     -> "build-order--cycle.nested"
 *   scenarioDirectoryName("[config:root-overlap]")
 *     -> "config--root-overlap"
 */
export function scenarioDirectoryName(tag: string, qualifier?: string): string {
  const inner = stripBrackets(tag);
  const base = inner.replace(":", SEPARATOR);
  return qualifier === undefined ? base : `${base}.${qualifier}`;
}

/**
 * Recover the Expected_Diagnostic from a Scenario_Directory_Name (R4.2).
 *
 * Discards any `.` qualifier, splits the remaining category–detail part on the
 * FIRST `--`, and rejoins with `:` inside brackets.
 *
 *   expectedDiagnosticOf("build-order--cycle.nested") -> "[build-order:cycle]"
 *
 * Throws an Error NAMING the directory when the category–detail part holds no
 * `--`, or more than one — either is unrecoverable, so a name that cannot map
 * back to a single tag is a loud failure rather than a silent misreading.
 */
export function expectedDiagnosticOf(directoryName: string): string {
  // Discard any `.` qualifier: everything from the first `.` onward.
  const dotIndex = directoryName.indexOf(".");
  const base =
    dotIndex === -1 ? directoryName : directoryName.slice(0, dotIndex);

  // The category–detail part must contain the `--` substring exactly once.
  const occurrences = countOccurrences(base, SEPARATOR);
  if (occurrences !== 1) {
    throw new Error(
      `cannot recover a Diagnostic_Tag from Scenario_Directory_Name "${directoryName}": ` +
        `its name part "${base}" holds ${occurrences === 0 ? "no" : "more than one"} "${SEPARATOR}" ` +
        `(expected exactly one)`,
    );
  }

  // Split on the FIRST `--` and rejoin the two halves with `:`.
  const splitIndex = base.indexOf(SEPARATOR);
  const category = base.slice(0, splitIndex);
  const detail = base.slice(splitIndex + SEPARATOR.length);
  return `[${category}:${detail}]`;
}

/** Strip the surrounding `[` and `]` of a Diagnostic_Tag, tolerating a tag
 *  passed without them. */
function stripBrackets(tag: string): string {
  const start = tag.startsWith("[") ? 1 : 0;
  const end = tag.endsWith("]") ? tag.length - 1 : tag.length;
  return tag.slice(start, end);
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

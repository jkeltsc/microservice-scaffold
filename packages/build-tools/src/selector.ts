// Selector parsing and application for the MICROSERVICES build/runtime variable.
//
// Implements design "Selector parsing" / "Selector application" and Properties 2,
// 3, and 4 (Requirements R5.1, R5.2, R5.3, R5.4, R5.5, R6.1, R6.2, R6.4, R10.2,
// R10.3, R10.4). The parser is intentionally total: every possible input,
// including `undefined`, maps to a well-defined `Selector`.
//
// `resolveSelected` is the module's only export: it is what production calls
// (`generateRegistry`) and the only surface the properties are stated over.
// `parseSelector` and the unmatched-identifier error are implementation detail
// of that one function, so neither is exported and neither has a consumer that
// could depend on its shape. The parse semantics stay fully observable through
// the selection outcome; the error stays observable through its message, which
// is the operator-facing contract (see design "Error message shape").

/**
 * The parsed selector. Local to this module: the only consumer of the parse
 * result is `resolveSelected` below, so this is implementation detail rather
 * than a cross-package contract type.
 */
type Selector =
  { kind: "all" } | { kind: "list"; identifiers: readonly string[] };

/**
 * Parse a raw MICROSERVICES value: `{kind:"all"}` when the input is undefined,
 * blank, exactly `*`, or splits into zero non-empty entries; otherwise the
 * comma-separated entries, trimmed, in order.
 */
function parseSelector(input: string | undefined): Selector {
  const raw = input ?? "";
  if (raw.trim() === "*") {
    return { kind: "all" };
  }

  const identifiers = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return identifiers.length === 0
    ? { kind: "all" }
    : { kind: "list", identifiers };
}

/**
 * The unmatched-identifier error (R5.4, R6.4, R10.4). Nothing outside this
 * module can `instanceof` it any more, so it is a plain `Error` carrying the
 * documented message rather than a subclass with an inspectable field: the
 * message names the deduplicated, sorted set difference `L \ D(n)` and is the
 * whole of the contract.
 *
 * @param unmatched deduplicated and sorted by the caller.
 */
function unmatchedIdentifiersError(unmatched: readonly string[]): Error {
  const named = unmatched.map((id) => `"${id}"`).join(", ");
  return new Error(
    `[selector:unmatched] MICROSERVICES names unknown identifier(s): ${named}`,
  );
}

/**
 * Apply a selector to the candidate directory names discovered in the
 * Microservice_Namespace: every candidate in discovery order for an
 * all-selector, or the requested identifiers in selector order for a list.
 *
 * @throws `[selector:empty]` for an empty namespace under an all-selector
 *   (R5.5); `[selector:unmatched]` naming every unmatched identifier.
 */
export function resolveSelected(
  selector: string | undefined,
  directories: readonly string[],
): string[] {
  const parsed = parseSelector(selector);

  if (parsed.kind === "all") {
    if (directories.length === 0) {
      throw new Error(
        "[selector:empty] no candidate microservices found in the Microservice_Namespace",
      );
    }
    return [...directories];
  }

  const discovered = new Set(directories);
  const unmatched = parsed.identifiers.filter((id) => !discovered.has(id));
  if (unmatched.length > 0) {
    throw unmatchedIdentifiersError([...new Set(unmatched)].sort());
  }

  return [...parsed.identifiers];
}

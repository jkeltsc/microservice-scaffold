// This module turns the MICROSERVICES value into the list of microservices a
// build or a run includes.
//
// Step 4 of the build pipeline. `resolveSelected` is the only export; it is
// called by `buildPlanFrom` (build-plan.ts) and by `generateRegistry`
// (generate-registry.ts). The value is `*` for every microservice found, or a
// list such as `microservice1,microservice2`. Parsing is total: every input,
// `undefined` included, yields a selection or one of two documented errors.
// (R5.1–R5.5, R6.1, R6.2, R6.4, R10.2–R10.4)

/** The parsed form of the MICROSERVICES value. */
type Selector =
  { kind: "all" } | { kind: "list"; identifiers: readonly string[] };

/**
 * This function parses the raw MICROSERVICES value for `resolveSelected` below.
 *
 * Undefined, blank, `*`, and anything splitting into zero entries mean "all".
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
 * This function builds the error for identifiers naming no microservice.
 *
 * The `[selector:unmatched]` message wording is a preserved operator-facing
 * contract (R5.4, R6.4, R10.4).
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
 * This function picks the microservices a build includes.
 *
 * `directories` are the candidates discovery found in the
 * Microservice_Namespace. An all-selection returns them all in discovery order;
 * a list returns the named identifiers in the order given.
 *
 * @throws `[selector:empty]` when an all-selection finds no candidate (R5.5).
 * @throws `[selector:unmatched]` naming every unmatched identifier.
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

// @microservices/contracts/testing — shared fast-check arbitraries.
//
// This module is a TEST-SUPPORT export only. It is never imported by shipped
// runtime code; it exists so every package's property tests draw from the same
// well-behaved generators. Each arbitrary here maps to one or more of the
// Correctness Properties defined in the feature design document.
//
// The generators intentionally constrain themselves to the valid input space
// (smart generators) rather than filtering broadly, so that property tests
// spend their iterations on meaningful cases.

import * as fc from "fast-check";
import express, { type Router } from "express";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Microservice_Identifier strings.
 *
 * Matches `/^[a-z][a-z0-9-]*$/`: a lowercase letter followed by zero or more
 * lowercase-alphanumeric-or-hyphen characters. Always non-empty. The length is
 * bounded to keep generated paths and env-var names readable in counterexamples.
 */
export const arbIdentifier: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.stringMatching(/^[a-z0-9-]*$/).map((s) => s.slice(0, 31)),
  )
  .map(([head, tail]) => head + tail);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * A single path segment: one or more lowercase-alphanumeric-or-hyphen chars.
 * Segments never contain `/`, so joining them with `/` yields a well-formed path.
 */
const arbPathSegment: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")),
    fc.stringMatching(/^[a-z0-9-]*$/).map((s) => s.slice(0, 15)),
  )
  .map(([head, tail]) => head + tail);

/**
 * Microservice_Path strings.
 *
 * Starts with `/` and is composed of one or more path segments joined by `/`
 * (e.g. `/api`, `/api/microservice2`). Never has a trailing slash — callers
 * that need specific path overlaps should construct them explicitly.
 */
export const arbPath: fc.Arbitrary<string> = fc
  .array(arbPathSegment, { minLength: 1, maxLength: 4 })
  .map((segments) => "/" + segments.join("/"));

// ---------------------------------------------------------------------------
// Express routers and microservice modules
// ---------------------------------------------------------------------------

/**
 * Builds a valid `express.Router()` conforming to the R2 endpoint contract for
 * the given identifier/path:
 *
 * - `GET /`   → 200 application/json `{ "microservice-name": identifier, path }`
 * - `ALL /`   → 405 with `Allow: GET` (registered AFTER the GET, so only
 *               non-GET methods reach it)
 *
 * When `withConfigRoute` is true, an additional `GET /config` route is added
 * (matching microservice2's sub-endpoint, used by Property 1b).
 */
export function buildExpressRouter(
  identifier: string,
  path: string,
  withConfigRoute = false,
): Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("application/json")
      .json({ "microservice-name": identifier, path });
  });

  if (withConfigRoute) {
    router.get("/config", (_req, res) => {
      res.status(200).type("application/json").json({
        "microservice-name": identifier,
        path,
        config: { sampleSetting: "example-value" },
      });
    });
  }

  router.all("/", (_req, res) => {
    res.set("Allow", "GET").status(405).end();
  });

  return router;
}

// There is deliberately NO `arbMicroserviceModule` generator of whole
// `{ path, router }` values. Its only consumer was Property 5 back when that
// property validated the module's export *shape* at runtime. Shape is now a
// compile-time guarantee — the generated registry is type-checked against
// `MicroserviceModule` — so Property 5 narrowed to the path *value* and
// quantifies over plain strings, leaving the module generator with no consumer.
// Tests that need a module build it from `buildExpressRouter` with a controlled
// identifier/path pair, which is what registry-shaped properties (6, 8, 9, 10)
// require anyway. Two earlier generators, `arbIdentifiedMicroserviceModule` and
// `arbExpressRouter`, were removed the same way.

// ---------------------------------------------------------------------------
// Selector strings
// ---------------------------------------------------------------------------

/**
 * Arbitrary MICROSERVICES_Selector strings, including the awkward shapes the
 * parser must tolerate: `*`, the empty string, whitespace-only strings, and
 * comma-separated lists with stray spaces and empty entries.
 */
export const arbSelectorString: fc.Arbitrary<string> = fc.oneof(
  // The wildcard.
  fc.constant("*"),
  // Empty / whitespace-only forms.
  fc.constantFrom("", " ", "   ", "\t", " \t "),
  // Comma-only / empty-entry forms.
  fc.constantFrom(",", ",,,", " , , "),
  // Well-formed comma lists, optionally with surrounding/embedded whitespace
  // and stray empty entries.
  fc
    .array(arbIdentifier, { minLength: 1, maxLength: 5 })
    .chain((ids) =>
      fc
        .tuple(
          fc.constantFrom("", " ", "  "),
          fc.constantFrom("", " ", "  "),
          fc.boolean(),
        )
        .map(([lead, trail, addEmpty]) => {
          const parts = ids.map((id) => `${lead}${id}${trail}`);
          if (addEmpty) parts.push("");
          return parts.join(",");
        }),
    ),
);

// ---------------------------------------------------------------------------
// Namespace directories (for the registry generator / discovery)
// ---------------------------------------------------------------------------

/**
 * A simulated Microservice_Namespace: the set of direct subdirectory names it
 * contains. Discovery does not inspect directory contents, so a namespace state
 * is fully described by its directory names. Names are unique, matching the
 * filesystem invariant, and the list may be empty (the empty-namespace case).
 */
export const arbNamespaceDirectories: fc.Arbitrary<string[]> = fc.uniqueArray(
  arbIdentifier,
  { minLength: 0, maxLength: 6 },
);

// ---------------------------------------------------------------------------
// Environment (MICROSERVICE_*_ENABLED toggles)
// ---------------------------------------------------------------------------

/** The canonical accepted toggle tokens (case-insensitive at parse time). */
const ACCEPTED_TOGGLE_TOKENS = [
  "enabled",
  "disabled",
  "true",
  "false",
  "1",
  "0",
] as const;

/** Applies a random casing/whitespace variant to a toggle token. */
const arbToggleTokenValue: fc.Arbitrary<string> = fc.oneof(
  // Accepted tokens, verbatim.
  fc.constantFrom(...ACCEPTED_TOGGLE_TOKENS),
  // Accepted tokens with case flips and/or surrounding whitespace.
  fc
    .tuple(
      fc.constantFrom(...ACCEPTED_TOGGLE_TOKENS),
      fc.constantFrom("", " ", "  ", "\t"),
      fc.constantFrom("", " ", "  "),
      fc.boolean(),
    )
    .map(([token, lead, trail, upper]) => {
      const cased = upper ? token.toUpperCase() : mixedCase(token);
      return `${lead}${cased}${trail}`;
    }),
  // Deliberately invalid strings.
  fc.constantFrom("yes", "no", "on", "off", "enable", "", "maybe", "2"),
);

/** Flips the case of alternating characters, producing e.g. "eNaBlEd". */
function mixedCase(s: string): string {
  return s
    .split("")
    .map((ch, i) => (i % 2 === 0 ? ch.toLowerCase() : ch.toUpperCase()))
    .join("");
}

/** Turns an identifier into its toggle env-var name. */
export function toggleVarName(identifier: string): string {
  return `MICROSERVICE_${identifier.toUpperCase()}_ENABLED`;
}

/**
 * A partial mapping of `MICROSERVICE_*_ENABLED` variable names to arbitrary
 * string values. Values mix valid tokens (enabled/disabled/true/false/1/0) in
 * assorted casing and whitespace variants with outright invalid strings, so the
 * toggle validator's missing/invalid/phantom branches all get exercised.
 */
export const arbEnvironment: fc.Arbitrary<Record<string, string>> =
  fc.dictionary(
    arbIdentifier.map(toggleVarName),
    arbToggleTokenValue,
    { minKeys: 0, maxKeys: 8 },
  );

// ---------------------------------------------------------------------------
// HTTP methods
// ---------------------------------------------------------------------------

/**
 * An HTTP method drawn from the non-GET set, used to exercise the R2.4 405
 * contract ("any method other than GET").
 *
 * HEAD is intentionally excluded: HTTP semantics and Express's built-in
 * handling treat HEAD as a bodiless GET — a resource that answers GET also
 * answers HEAD (Express auto-routes HEAD through the registered GET handler).
 * HEAD therefore returns the 200 GET response (headers only) rather than 405,
 * so it is not subject to the 405/Allow:GET contract. The refined R2.4 contract
 * applies to POST/PUT/DELETE/PATCH/OPTIONS and other non-GET, non-HEAD methods.
 */
export const arbHttpMethodNonGet: fc.Arbitrary<string> = fc.constantFrom(
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
);

/**
 * An HTTP method drawn from the FULL set, GET and HEAD included.
 *
 * Both generators exist because the properties that draw from them ask
 * different questions:
 *
 * - The 405 method-policy property quantifies over the non-GET subset
 *   (`arbHttpMethodNonGet`), because the `Allow`-header contract only governs
 *   methods a served path does *not* answer. That generator already documents
 *   why HEAD is excluded from the subset: Express routes HEAD through the
 *   registered GET handler, so HEAD returns the 200 GET response (headers only)
 *   rather than 405 and is not subject to the 405/Allow contract.
 * - A method-agnostic 404 property and a router-totality property must instead
 *   cover the methods a router *does* serve as well — GET and HEAD included —
 *   because "answers 404 at every unserved path, for any method" and "the
 *   router is total over its Owned_Subtree, for any method" are only true if
 *   the served methods are in scope too. Those properties draw from
 *   `arbHttpMethod`.
 *
 * Keeping both as named generators means each property states, by its choice of
 * generator, exactly which method space it ranges over.
 */
export const arbHttpMethod: fc.Arbitrary<string> = fc.constantFrom(
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
);

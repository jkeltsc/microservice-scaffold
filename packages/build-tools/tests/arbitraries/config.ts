// Shared fast-check arbitraries for the Config_Parser / Config_Serializer
// property suite (Requirement 14).
//
// This is a PLAIN MODULE, not a `*.test.ts`, so Vitest does not collect it. It
// lives under `tests/arbitraries/` alongside the other shared generators; the
// point of putting the generators in one place is that two properties drawing
// from `configText()` (say) genuinely draw from the *same* inputs.
//
// Every generator here is aligned with `packages/build-tools/src/project-config.ts`
// — the single declaration site of the parser's actual validation. In
// particular:
//   - Valid_Scope is `@` followed by one or more of `[a-z0-9-]` (R3.1).
//   - Valid_Root_Path forbids empty, whitespace-only, leading/trailing
//     whitespace, a leading `/`, a trailing `/`, a `\`, a `*`/`?`, and the
//     `.` / `..` / empty path segments (R4.3).
//   - `packages/contracts` and `packages` appear in the overlap-prone pool
//     because a Framework_Singleton directory (`packages/contracts`) collides
//     under R4.7.
//   - an Entry_Root is a Valid_Root_Path held to the same predicate a `roots`
//     value is (registry-inversion R1.4), additionally colliding with none of
//     the eight reserved paths (registry-inversion R1.6).
//
// The generators are smart generators: they constrain themselves to the input
// space they mean to explore rather than filtering broadly, so that each
// property spends its iterations on meaningful cases. Where a `filter` is
// unavoidable it is a narrow guard on a constructively-built value, never the
// primary construction.

import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** The Valid_Scope character set: lowercase ASCII letters, digits, and hyphen. */
const SCOPE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");

/**
 * A Valid_Scope: `@` followed by 1 to 31 characters from `[a-z0-9-]`, giving
 * the 2-to-32-character total length Requirement 14.2 names.
 */
export function validScope(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...SCOPE_CHARS), { minLength: 1, maxLength: 31 })
    .map((chars) => `@${chars.join("")}`);
}

/**
 * A value the Config_Parser rejects as a scope.
 *
 * The pool is seeded with a constant for every spelling Requirement 3.3
 * enumerates. Seeding matters: without these as constants, a generator over
 * arbitrary strings would almost never produce a case like "leading `@` present
 * but one uppercase letter", so the enumerated rejections would go unexercised.
 * A tail of generated strings outside the Valid_Scope set is added so the
 * property is not limited to the hand-picked cases.
 */
export function invalidScope(): fc.Arbitrary<string> {
  const seeded = fc.constantFrom(
    "", // empty string
    "   ", // whitespace only
    " @scope", // leading whitespace
    "@scope ", // trailing whitespace
    "scope", // no leading '@'
    "@", // bare '@'
    "@sco@pe", // inner '@'
    "@Scope", // uppercase ASCII letter
    "@sco/pe", // contains '/'
    "@sco.pe", // contains '.'
    "@sco_pe", // contains '_'
  );

  // Generated strings that are guaranteed not to be a Valid_Scope: an arbitrary
  // string that contains at least one character outside the permitted set (or
  // is missing the leading `@`). Built constructively — a permitted body with
  // one guaranteed-offending character spliced in — and guarded by a filter so
  // a fluke Valid_Scope never leaks through.
  const generated = fc
    .tuple(
      fc.string({ maxLength: 8 }),
      fc.constantFrom(" ", "@", "/", ".", "_", "A", "Z", "!", "*", "\t"),
      fc.string({ maxLength: 8 }),
    )
    .map(([head, bad, tail]) => `@${head}${bad}${tail}`)
    .filter((value) => !/^@[a-z0-9-]+$/.test(value));

  return fc.oneof(seeded, generated);
}

// ---------------------------------------------------------------------------
// Root paths
// ---------------------------------------------------------------------------

/** Segment characters excluding `/`, `\`, `*`, `?`, whitespace, and the `.`/`..`
 *  segments (a single-char segment from this set is never `.`). */
const ROOT_SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");

/** A single valid path segment: 1 to 8 characters, never `.` or `..`. */
function validSegment(): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...ROOT_SEGMENT_CHARS), {
      minLength: 1,
      maxLength: 8,
    })
    .map((chars) => chars.join(""));
}

/**
 * A Valid_Root_Path: 1 to 4 segments joined by `/`, each segment 1 to 8
 * characters from a set excluding `/`, `\`, `*`, `?`, whitespace, and excluding
 * the `.` and `..` segments (R4.3, R4.9 — any number of segments is accepted,
 * this generator just bounds it for readable counterexamples).
 */
export function validRootPath(): fc.Arbitrary<string> {
  return fc
    .array(validSegment(), { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join("/"));
}

/**
 * A value the Config_Parser rejects as a Discovery_Root.
 *
 * Same pool-with-constants treatment as {@link invalidScope}: a seed for each
 * Valid_Root_Path condition of Requirement 4.3, plus deliberate two-condition
 * combinations so Requirement 4.2's "names every violated condition rather than
 * only the first" is actually exercised. A tail of constructively-built values
 * (a valid body with one offending character or segment spliced in) widens the
 * exploration beyond the hand-picked cases.
 */
export function invalidRootPath(): fc.Arbitrary<string> {
  const seeded = fc.constantFrom(
    // Single-condition seeds, one per Valid_Root_Path condition.
    "", // empty
    "   ", // whitespace only
    " packages/x", // leading whitespace
    "packages/x ", // trailing whitespace
    "/packages/x", // leading '/'
    "packages/x/", // trailing '/'
    "packages\\x", // contains '\'
    "packages/*", // contains '*'
    "packages/x?", // contains '?'
    "packages/../x", // contains '..' segment
    "packages/./x", // contains '.' segment
    "packages//x", // empty segment
    // Deliberate two-condition combinations (R4.2).
    "/packages/../x", // leading '/' AND '..' segment
    "packages/../x/", // trailing '/' AND '..' segment
    " packages\\x", // leading whitespace AND '\'
    "packages/*/", // '*' AND trailing '/'
    "//packages", // leading '/' AND empty segment
  );

  // Constructively-invalid generated values: a valid path body with one
  // guaranteed-offending element spliced in, guarded by a filter against the
  // parser's own acceptance shape so a fluke valid path never leaks through.
  const offender = fc.constantFrom(
    "..",
    ".",
    "", // empty segment
    "a\\b",
    "a*b",
    "a?b",
    " a", // leading-space segment (becomes leading/trailing whitespace)
    "a ",
  );
  const generated = fc
    .tuple(fc.array(validSegment(), { minLength: 1, maxLength: 3 }), offender)
    .map(([body, bad]) => [...body, bad].join("/"))
    .filter((value) => !isPlausiblyValidRootPath(value));

  return fc.oneof(seeded, generated);
}

/** A conservative mirror of the parser's Valid_Root_Path acceptance, used only
 *  as the guard filter above. Kept deliberately simple; it need only reject the
 *  same values the parser rejects for the constructed cases here. */
function isPlausiblyValidRootPath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.trim().length === 0) return false;
  if (/^\s/.test(value) || /\s$/.test(value)) return false;
  if (value.startsWith("/")) return false;
  if (value.length > 1 && value.endsWith("/")) return false;
  if (value.includes("\\")) return false;
  if (value.includes("*") || value.includes("?")) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

// ---------------------------------------------------------------------------
// Root triples
// ---------------------------------------------------------------------------

/** A triple of Discovery_Roots, in microservice, common, spa order. */
export type RootTriple = readonly [string, string, string];

/**
 * Three Valid_Root_Paths satisfying Requirements 4.5, 4.6, and 4.7: pairwise
 * unequal, none lying inside another at a `/` boundary, and none equal to,
 * inside, or containing a Framework_Singleton directory.
 *
 * Built CONSTRUCTIVELY, by prefixing each root with a distinct generated first
 * segment, rather than by filtering over three independent draws — a filter
 * here would reject a large fraction of draws and make shrinking slow and
 * noisy. Three distinct leading segments guarantee no two roots are equal and
 * neither nesting nor a framework relation can hold, because every root's first
 * segment differs and none of them is `packages` (the only prefix a
 * Framework_Singleton directory shares). One `filter` is retained purely as a
 * guard, so the construction's promise is checked rather than trusted.
 */
export function nonOverlappingRootTriple(): fc.Arbitrary<RootTriple> {
  return fc
    .tuple(
      distinctLeadSegments(),
      fc.array(validSegment(), { minLength: 0, maxLength: 3 }),
      fc.array(validSegment(), { minLength: 0, maxLength: 3 }),
      fc.array(validSegment(), { minLength: 0, maxLength: 3 }),
    )
    .map(([[m, c, s], mTail, cTail, sTail]): RootTriple => {
      const build = (lead: string, tail: readonly string[]): string =>
        [lead, ...tail].join("/");
      return [build(m, mTail), build(c, cTail), build(s, sTail)];
    })
    .filter(([m, c, s]) => nonOverlapping(m, c, s));
}

/** Three distinct leading segments, none of them `packages`, so no constructed
 *  root can collide with the sole shared prefix of a Framework_Singleton
 *  directory. */
function distinctLeadSegments(): fc.Arbitrary<
  readonly [string, string, string]
> {
  return fc
    .uniqueArray(validSegment(), { minLength: 3, maxLength: 3 })
    .map(([m, c, s]) => [m!, c!, s!] as const)
    .filter(
      ([m, c, s]) => m !== "packages" && c !== "packages" && s !== "packages",
    );
}

/** The four Framework_Singleton directories, spelled here only for the guard. */
const FRAMEWORK_DIRECTORIES = [
  "packages/contracts",
  "packages/overseer",
  "packages/build-tools",
  "packages/integration-tests",
] as const;

/** True when the three roots are pairwise unequal, none nested in another, and
 *  none in a nesting/equality relation with a Framework_Singleton directory. */
function nonOverlapping(m: string, c: string, s: string): boolean {
  const roots = [m, c, s];
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const a = roots[i]!;
      const b = roots[j]!;
      if (a === b) return false;
      if (b.startsWith(`${a}/`) || a.startsWith(`${b}/`)) return false;
    }
    for (const dir of FRAMEWORK_DIRECTORIES) {
      const root = roots[i]!;
      if (root === dir) return false;
      if (root.startsWith(`${dir}/`) || dir.startsWith(`${root}/`)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Three Discovery_Roots drawn from a deliberately NARROW pool, the opposite of
 * {@link nonOverlappingRootTriple}, so that equality, nesting at a `/`
 * boundary, the near-miss `a` versus `ab` (which shares a prefix but is not
 * nested), and the Framework_Singleton relations all occur among 100 runs. A
 * wide pool would make the overlap biconditional vacuously true because
 * collisions would essentially never arise.
 */
export function overlapProneRootTriple(): fc.Arbitrary<RootTriple> {
  const pool = fc.constantFrom(
    "a",
    "a/b",
    "a/b/c",
    "ab",
    "b",
    "packages/contracts",
    "packages",
  );
  return fc.tuple(pool, pool, pool);
}

// ---------------------------------------------------------------------------
// Entry_Root (registry-inversion R1.4, R1.6)
// ---------------------------------------------------------------------------

/**
 * The Root_Defaults, spelled here rather than imported from
 * `src/project-config.ts` on purpose: the properties these generators feed are
 * mirror-based, so their expectation must come from a statement of the rule
 * written in the test, not from the module under test. Same reason
 * {@link FRAMEWORK_DIRECTORIES} above is spelled out.
 */
const ROOT_DEFAULT_PATHS = [
  "packages/microservices",
  "packages/common",
  "packages/spa",
] as const;

/** The directory holding the Framework_Singletons. */
const PACKAGES_CONTAINER = "packages";

/**
 * The eight reserved paths an Entry_Root may neither equal, lie inside, nor
 * contain (R1.6): the three accepted-or-defaulted Discovery_Roots, the
 * `packages` container, and the four Framework_Singleton directories.
 *
 * @param roots the three Discovery_Roots in microservice, common, spa order, or
 *   `undefined` for the defaulted triple.
 */
export function reservedEntryPaths(
  roots?: RootTriple | undefined,
): readonly string[] {
  return [
    ...(roots ?? ROOT_DEFAULT_PATHS),
    PACKAGES_CONTAINER,
    ...FRAMEWORK_DIRECTORIES,
  ];
}

/** The reserved set of a project declaring no `roots` — the common case, and the
 *  default both entry generators take. */
export const DEFAULT_RESERVED_ENTRY_PATHS: readonly string[] =
  reservedEntryPaths();

/** True when `path` bears one of R1.6's three relations — equal to, lies inside,
 *  contains — to any reserved path, compared code point for code point. */
export function collidesWithReserved(
  path: string,
  reserved: readonly string[] = DEFAULT_RESERVED_ENTRY_PATHS,
): boolean {
  return reserved.some(
    (reservedPath) =>
      path === reservedPath ||
      path.startsWith(`${reservedPath}/`) ||
      reservedPath.startsWith(`${path}/`),
  );
}

/**
 * An Entry_Root the Config_Parser ACCEPTS: a Valid_Root_Path colliding with none
 * of the eight reserved paths (R1.4, R1.6).
 *
 * Built constructively — 1 to 4 valid segments whose lead segment is neither
 * `packages` nor a lead segment of a reserved path — rather than by filtering
 * `validRootPath()`, because at the defaults every reserved path begins
 * `packages`, so a distinct lead segment already rules out all three relations.
 * The one `filter` is a guard on the construction, not the construction itself,
 * and rejects a vanishing fraction of draws.
 *
 * @param reserved the reserved set to avoid; pass {@link reservedEntryPaths} of
 *   a declared root triple when the config under test declares `roots`.
 */
export function arbAcceptedEntryRoot(
  reserved: readonly string[] = DEFAULT_RESERVED_ENTRY_PATHS,
): fc.Arbitrary<string> {
  const reservedLeads = new Set(
    reserved.map((reservedPath) => reservedPath.split("/")[0]!),
  );
  return fc
    .tuple(
      validSegment().filter((segment) => !reservedLeads.has(segment)),
      fc.array(validSegment(), { minLength: 0, maxLength: 3 }),
    )
    .map(([lead, tail]) => [lead, ...tail].join("/"))
    .filter((path) => !collidesWithReserved(path, reserved));
}

/**
 * An Entry_Root the Config_Parser REJECTS, covering all three rejection shapes:
 * a value that is not a Valid_Root_Path (`[config:entry-path]`, R1.4), and each
 * of R1.6's three collision relations against each reserved path
 * (`[config:entry-overlap]`).
 *
 * The three collision shapes are built from the reserved set itself — a
 * reserved path verbatim is the "is equal to" case, a reserved path plus a
 * generated tail is "lies inside", and a proper `/`-boundary prefix of a
 * reserved path is "contains" — so all three occur among 100 runs instead of
 * depending on a wide generator stumbling into one. A single-segment reserved
 * path (`packages` at the defaults) contributes no "contains" case because no
 * shorter path exists at a `/` boundary; the seven multi-segment ones do.
 *
 * The trailing `filter` is a guard asserting the construction's promise: every
 * value is either not a Valid_Root_Path or collides.
 */
export function arbRejectedEntryRoot(
  reserved: readonly string[] = DEFAULT_RESERVED_ENTRY_PATHS,
): fc.Arbitrary<string> {
  const pool = fc.constantFrom(...reserved);

  // Shape 1 — invalid character or segment, shared with the `roots` generator so
  // both keys are held to the same Valid_Root_Path input space.
  const invalidPath = invalidRootPath();

  // Shape 2a — equal to a reserved path.
  const equalTo = pool;

  // Shape 2b — lies inside a reserved path.
  const liesInside = fc
    .tuple(pool, fc.array(validSegment(), { minLength: 1, maxLength: 2 }))
    .map(([reservedPath, tail]) => [reservedPath, ...tail].join("/"));

  // Shape 2c — contains a reserved path: a proper `/`-boundary prefix of one.
  const prefixes = [...new Set(reserved.flatMap(properBoundaryPrefixes))];

  const shapes: fc.Arbitrary<string>[] = [invalidPath, equalTo, liesInside];
  if (prefixes.length > 0) {
    shapes.push(fc.constantFrom(...prefixes));
  }

  return fc
    .oneof(...shapes)
    .filter(
      (path) =>
        !isPlausiblyValidRootPath(path) || collidesWithReserved(path, reserved),
    );
}

/** Every proper prefix of `path` ending at a `/` boundary: `packages/a/b` yields
 *  `packages` and `packages/a`. A single-segment path yields none. */
function properBoundaryPrefixes(path: string): string[] {
  const segments = path.split("/");
  const prefixes: string[] = [];
  for (let count = 1; count < segments.length; count += 1) {
    prefixes.push(segments.slice(0, count).join("/"));
  }
  return prefixes;
}

/**
 * Project_Config texts that ALWAYS declare `entry`, across the three spellings
 * the parser distinguishes: an accepted Valid_Root_Path clear of the reserved
 * set, a rejected string (bad path or a collision), and a wrong-typed JSON value
 * (R1.4, R1.5, R1.6).
 *
 * The roots are drawn FIRST and the accepted entry is then generated against
 * that triple's reserved set, so a text meant to be accepted is accepted whether
 * or not it declares `roots` — otherwise a declared root could shadow the entry
 * by accident and the accepted branch would quietly stop exercising acceptance.
 *
 * The text is always a well-formed JSON object with unique keys; member order is
 * rotated and the indentation varied so the consuming property sees the
 * insignificant-whitespace and member-order freedom JSON allows.
 */
export function arbEntryConfigText(): fc.Arbitrary<string> {
  const wrongTypedEntry: fc.Arbitrary<string> = fc.constantFrom(
    "42",
    "true",
    "null",
    "[]",
    "{}",
  );

  return fc
    .option(nonOverlappingRootTriple(), { nil: undefined })
    .chain((triple) => {
      const reserved = reservedEntryPaths(triple);
      const entryValue = fc.oneof(
        {
          arbitrary: arbAcceptedEntryRoot(reserved).map((v) =>
            JSON.stringify(v),
          ),
          weight: 2,
        },
        {
          arbitrary: arbRejectedEntryRoot(reserved).map((v) =>
            JSON.stringify(v),
          ),
          weight: 2,
        },
        { arbitrary: wrongTypedEntry, weight: 1 },
      );

      return fc
        .tuple(
          entryValue,
          fc.option(validScope(), { nil: undefined }),
          fc.nat({ max: 2 }), // member-order rotation
          fc.nat({ max: 3 }), // indentation width
        )
        .map(([entry, scope, rotation, indent]) => {
          const members: [string, string][] = [["entry", entry]];
          if (scope !== undefined) {
            members.push(["scope", JSON.stringify(scope)]);
          }
          if (triple !== undefined) {
            const [microservice, common, spa] = triple;
            members.push([
              "roots",
              renderObject([
                ["microservice", JSON.stringify(microservice)],
                ["common", JSON.stringify(common)],
                ["spa", JSON.stringify(spa)],
              ]),
            ]);
          }
          const shift = rotation % members.length;
          const ordered = [...members.slice(shift), ...members.slice(0, shift)];
          return renderObject(ordered, indent);
        });
    });
}

// ---------------------------------------------------------------------------
// Config text
// ---------------------------------------------------------------------------

/**
 * JSON object texts declaring any subset of the recognised keys with accepted
 * values, optionally mixing in unrecognised keys and wrong-typed values, with
 * varied member order and insignificant whitespace (Requirements 14.3, 14.4).
 *
 * The rendered text is a real JSON object (so it always parses as JSON); the
 * Config_Parser may still reject it on scope/root/overlap grounds, which the
 * consuming properties discard without failing.
 */
export function configText(): fc.Arbitrary<string> {
  const acceptedScopeMember = validScope().map((scope): [string, string] => [
    "scope",
    JSON.stringify(scope),
  ]);

  const acceptedRootsMember = fc
    .record({
      microservice: fc.option(validRootPath(), { nil: undefined }),
      common: fc.option(validRootPath(), { nil: undefined }),
      spa: fc.option(validRootPath(), { nil: undefined }),
    })
    .map((roots): [string, string] => {
      const entries = Object.entries(roots).filter(
        ([, value]) => value !== undefined,
      );
      return [
        "roots",
        renderObject(entries.map(([k, v]) => [k, JSON.stringify(v)])),
      ];
    });

  // Optional noise: unrecognised keys and wrong-typed recognised values.
  const unknownKeyMember: fc.Arbitrary<[string, string]> = fc
    .tuple(
      fc
        .stringMatching(/^[a-z]{1,8}$/)
        .filter((k) => k !== "scope" && k !== "roots"),
      fc.constantFrom("true", "42", '"x"', "null", "[]"),
    )
    .map(([key, value]) => [key, value]);

  const wrongTypedScope: fc.Arbitrary<[string, string]> = fc
    .constantFrom("42", "true", "null", "[]", "{}")
    .map((value) => ["scope", value]);

  return fc
    .tuple(
      fc.option(acceptedScopeMember, { nil: undefined }),
      fc.option(acceptedRootsMember, { nil: undefined }),
      fc.option(unknownKeyMember, { nil: undefined }),
      fc.option(wrongTypedScope, { nil: undefined }),
      fc.boolean(), // whether to shuffle member order
      fc.nat({ max: 3 }), // indentation width for insignificant whitespace
    )
    .chain(([scope, roots, unknown, wrongScope, shuffle, indent]) => {
      // `wrongScope` and the accepted `scope` both target the "scope" key; keep
      // at most one so the text stays a well-formed object with unique keys.
      const members: [string, string][] = [];
      if (scope !== undefined) members.push(scope);
      else if (wrongScope !== undefined) members.push(wrongScope);
      if (roots !== undefined) members.push(roots);
      if (unknown !== undefined) members.push(unknown);

      const ordering = shuffle
        ? fc.shuffledSubarray(members, {
            minLength: members.length,
            maxLength: members.length,
          })
        : fc.constant(members);

      return ordering.map((ordered) => renderObject(ordered, indent));
    });
}

/** Renders `[key, rawValueJson]` pairs as a JSON object with a chosen indent.
 *  `rawValueJson` is already-serialised JSON, spliced in verbatim. */
function renderObject(
  members: readonly [string, string][],
  indent = 0,
): string {
  if (members.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const body = members
    .map(([key, value]) => `${pad}${JSON.stringify(key)}: ${value}`)
    .join(indent > 0 ? ",\n" : ", ");
  return indent > 0 ? `{\n${body}\n}` : `{ ${body} }`;
}

/**
 * The totality pool of Requirement 14.1: the empty string, a whitespace-only
 * string, non-JSON strings, the JSON text of each of the six JSON types
 * (object, array, string, number, boolean, null), a JSON object text mixing
 * recognised and unrecognised keys with wrong-typed values, and exactly ONE
 * `fc.constant` of a 1,048,576-character string.
 *
 * The megabyte string is a single constant rather than a generator of megabyte
 * strings: varying the megabyte adds nothing, and minting 100 fresh megabytes
 * per property run would add seconds for no coverage.
 */
export function pathologicalText(): fc.Arbitrary<string> {
  const fixed = fc.constantFrom(
    "", // empty string
    "   \t\n ", // whitespace only
    "not json at all", // non-JSON
    "{ unquoted: 1 }", // non-JSON (invalid object)
    "{", // truncated JSON
    "{}", // object
    "[]", // array
    '"a string"', // string
    "42", // number
    "true", // boolean
    "null", // null
    '{ "scope": "@ok", "roots": true, "extra": 1 }', // mixed keys/types
  );

  const megabyte = fc.constant("x".repeat(1_048_576));

  return fc.oneof(fixed, megabyte);
}

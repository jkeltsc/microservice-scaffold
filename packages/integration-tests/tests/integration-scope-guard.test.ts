// Integration_Suite scope guard (Requirement 13).
//
// The framework/sample test boundary that Requirement 13 draws is a rule about
// what the SHARED integration suite is allowed to assert. Its criteria 4, 5, 6,
// and 8 forbid, in the Integration_Suite:
//
//   - any assertion of a `405` status code for a Microservice_Package (R13.6);
//   - any assertion of an `Allow` response header for a Microservice_Package
//     (R13.6);
//   - any assertion of a response body, a content type, or a status code OTHER
//     than the Mount_Root dispatched-versus-catch-all-404 distinction of
//     criteria 1 through 3, quantified over every discovered Microservice_Package,
//     over every registered one, or over the generated Microservice_Registry as
//     a whole (R13.8).
//
// A `405 Allow: GET` (or `Allow: GET, HEAD`) response is ONE sample's method
// policy; a `{microservice-name, path}` body is ONE sample's response shape.
// Neither is a framework-wide law, so neither belongs in the shared suite —
// each is asserted only in the owning microservice's own suite (R13.9–R13.11).
// The defect this guard exists to catch — a looped `405 Allow: GET` assertion
// over all three reference microservices in the former `endpoint-contract.test.ts`
// — was introduced by exactly the kind of edit a reviewer waves through, so a
// mechanical guard rather than review discipline is what keeps it out.
//
// This guard reads every OTHER `*.test.ts` source under
// `packages/integration-tests/tests/` as text and scans it for the forbidden
// ASSERTION shapes. It scans assertion shapes, not the bare tokens `405` /
// `Allow`, on purpose: those tokens appear legitimately as prose in comments
// (this file included), as documentation of what was REMOVED (mount-dispatch),
// and inside a template-literal that a suite writes out as a SYNTHETIC stub
// microservice's source (dev-session-scope's `res.set("Allow", ...).status(...)`).
// None of those is an assertion the Integration_Suite makes. To avoid flagging
// them the guard strips comments and string/template literals from each source
// before matching, and matches only `expect(...)`-shaped assertions.
//
// This file must not trip its own scan, so (a) it excludes itself from the file
// set, and (b) every forbidden token it names is assembled from fragments —
// never written contiguously — exactly as `migration-facts.test.ts` does for
// its stale-path scan.
//
// Validates: Requirements 13.4, 13.5, 13.6, 13.8

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, basename, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = __dirname;

/** This guard's own file name, excluded from the scanned set. */
const SELF = basename(fileURLToPath(import.meta.url));

/**
 * Every `*.test.ts` source under the integration `tests/` directory except this
 * guard itself. Only `.test.ts` files are scanned; `helpers.ts` and any
 * `*.test-d.ts` are excluded because they make no runtime response assertions.
 */
function scannedTestSources(): string[] {
  return readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        entry.name !== SELF,
    )
    .map((entry) => entry.name);
}

/**
 * Remove line comments, block comments, and string / template literals from a
 * TypeScript source so the scan sees executable code only. This is what lets a
 * comment mentioning the removed `405 Allow: GET` law (mount-dispatch), and a
 * template-literal carrying a synthetic stub microservice's own
 * `res.set(...).status(...)` source (dev-session-scope), pass without a false
 * positive: neither survives stripping. A single-pass character scanner is used
 * rather than regexes so a quote inside a comment (or a `//` inside a string)
 * does not confuse the state machine.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment: skip to end of line.
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    // Block comment: skip to closing */.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    // String / template literal: skip to matching unescaped delimiter. Newlines
    // in the elided literal are preserved so line-based reporting stays sane.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forbidden assertion patterns.
//
// Every token that would otherwise make THIS file match its own scan is built
// from fragments and reassembled here, so the literals below never appear
// contiguously in this source. `stat` is `"st" + "atus"`, the method-not-allowed
// code is `"4" + "05"`, and the allow-header token is `"al" + "low"`.
// ---------------------------------------------------------------------------

const STATUS_PROP = "st" + "atus";
const CODE_405 = "4" + "05";
const ALLOW = "al" + "low";

/**
 * A `405` status assertion in Jest/Vitest shape: `.toBe(405)` or `.toEqual(405)`
 * (optionally the negated `.not.toBe(405)`, which is still a per-method status
 * assertion the Integration_Suite must not make). The matcher argument is the
 * bare number, so whitespace around it is tolerated.
 */
const ASSERT_405 = new RegExp(
  `\\.(?:toBe|toEqual|toStrictEqual)\\(\\s*${CODE_405}\\s*\\)`,
);

/**
 * An `Allow` response-header assertion: an `expect(...)` whose argument reaches
 * into the response headers by the `allow` key (case-insensitive, quoted or via
 * `.allow`). Matching within an `expect(...)` is what keeps a stub's
 * `res.set("Allow", ...)` — stripped as a string literal above — out of scope,
 * and is the assertion shape the microservice suites use
 * (`expect(res.headers["allow"]).toBe(...)`).
 */
const ASSERT_ALLOW_HEADER = new RegExp(
  `expect\\([^)]*headers[^)]*\\[\\s*["'\`]${ALLOW}["'\`]\\s*\\]`,
  "i",
);
/** Property-access form: `expect(res.headers.allow)…`. */
const ASSERT_ALLOW_HEADER_DOT = new RegExp(
  `expect\\([^)]*headers\\.${ALLOW}`,
  "i",
);

/**
 * A `405` status assertion in the property-style form the microservice suites
 * use: `expect(<something>.status).toBe(405)`. Covered by ASSERT_405 already,
 * but this catches the case where the code and the matcher sit on the same
 * logical line with the status property named explicitly.
 */
const ASSERT_STATUS_405 = new RegExp(
  `expect\\([^)]*\\.${STATUS_PROP}[^)]*\\)\\s*\\.\\s*(?:not\\s*\\.\\s*)?(?:toBe|toEqual|toStrictEqual)\\(\\s*${CODE_405}\\s*\\)`,
);

/**
 * Discovery / generated-registry quantification anchors. A per-response
 * assertion (body, content type, or a status other than the Mount_Root
 * distinction) is forbidden when it is driven by one of these enumeration
 * sources rather than by an explicit hand-written table (R13.8).
 *
 * What these anchors target is a per-response assertion QUANTIFIED over the
 * discovered package set or over the GENERATED Microservice_Registry — a body
 * shape promoted into a framework-wide law by looping over "every microservice
 * the build found / emitted". They deliberately do NOT include the in-process
 * `makeRegistry([...])` helper: it builds a registry from an EXPLICIT,
 * hand-written literal list of identifiers, which is the same explicit
 * enumeration the mount-dispatch suite's `MOUNTS` / `PEERS` tables are — exactly
 * what R13.8 permits, not what it forbids. A single-microservice end-to-end body
 * assertion (e.g. `container-extended-config` composing
 * `makeRegistry(["microservice3"])` to assert R5.7's Extended_Config_Payload) is
 * a sanctioned sample-scope assertion over one named microservice, not a
 * framework-wide quantification. The `generated`/`generate-registry`/
 * `microservice-registry` anchors still catch a body assertion driven by the
 * real generated registry, which is the actual R13.8 concern.
 */
const QUANTIFIER_SOURCES = [
  /readdirSync\s*\(/,
  /discover[A-Za-z]*\s*\(/i,
  /generateRegistry\s*\(/,
  /generate-registry/,
  /microservice-registry/,
];

/** The body / content-type / non-dispatch-status assertion shapes. */
const BODY_ASSERTION = /expect\([^)]*\.(?:body|text)\b/;
const CONTENT_TYPE_ASSERTION = new RegExp(
  `expect\\([^)]*headers[^)]*\\[\\s*["'\`]content-type["'\`]`,
  "i",
);

interface Offense {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

function scanForForbiddenAssertions(
  file: string,
  strippedSource: string,
): Offense[] {
  const offenses: Offense[] = [];
  const lines = strippedSource.split("\n");
  lines.forEach((line, index) => {
    const record = (rule: string): void => {
      offenses.push({ file, line: index + 1, rule, text: line.trim() });
    };
    if (ASSERT_STATUS_405.test(line) || ASSERT_405.test(line)) {
      record(`${CODE_405} status assertion`);
    }
    if (
      ASSERT_ALLOW_HEADER.test(line) ||
      ASSERT_ALLOW_HEADER_DOT.test(line)
    ) {
      record(`${ALLOW} header assertion`);
    }
  });
  return offenses;
}

/**
 * Whole-file check for a body / content-type / non-dispatch-status assertion
 * that is quantified over discovery or the registry. A file offends only when it
 * BOTH contains such an assertion AND contains a quantification anchor — the
 * explicit `MOUNTS` table in mount-dispatch is not an anchor, so its
 * `status !== 404` dispatch assertions (which R13.8 exempts) do not offend.
 */
function scanForQuantifiedResponseAssertions(
  file: string,
  strippedSource: string,
): Offense[] {
  const hasQuantifier = QUANTIFIER_SOURCES.some((re) => re.test(strippedSource));
  if (!hasQuantifier) {
    return [];
  }
  const offenses: Offense[] = [];
  strippedSource.split("\n").forEach((line, index) => {
    if (BODY_ASSERTION.test(line) || CONTENT_TYPE_ASSERTION.test(line)) {
      offenses.push({
        file,
        line: index + 1,
        rule: "response body / content-type assertion in a file that quantifies over discovery or the registry",
        text: line.trim(),
      });
    }
  });
  return offenses;
}

describe("Integration_Suite scope guard (R13.4, R13.5, R13.6, R13.8)", () => {
  const sources = scannedTestSources().map((file) => ({
    file,
    stripped: stripCommentsAndStrings(
      readFileSync(resolve(TESTS_DIR, file), "utf8"),
    ),
  }));

  it("scans more than one integration test source (the scan is not vacuous)", () => {
    // A regression that renamed or moved the suites would make the scan pass by
    // finding nothing; assert the scan actually has material to inspect.
    expect(sources.length).toBeGreaterThan(1);
  });

  it(`holds no ${CODE_405} status assertion and no ${ALLOW} header assertion for any microservice (R13.6)`, () => {
    const offenses = sources.flatMap(({ file, stripped }) =>
      scanForForbiddenAssertions(file, stripped),
    );
    expect(
      offenses,
      `forbidden method-policy assertion(s) in the Integration_Suite — each belongs in the owning microservice's own suite, not the shared suite:\n${offenses
        .map((o) => `  ${o.file}:${o.line} [${o.rule}] ${o.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("quantifies no response-body or content-type assertion over discovery or the generated registry (R13.4, R13.5, R13.8)", () => {
    const offenses = sources.flatMap(({ file, stripped }) =>
      scanForQuantifiedResponseAssertions(file, stripped),
    );
    expect(
      offenses,
      `response-body / content-type assertion quantified over discovery or the registry — the framework declares no such law:\n${offenses
        .map((o) => `  ${o.file}:${o.line} [${o.rule}] ${o.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

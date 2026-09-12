/**
 * The Result_Formatter — a single pure module of the Demo_Spa exporting exactly
 * three functions, one per display field (R10.1): {@link formatRequestLine} for
 * the Request_Field, {@link formatStatus} for the Status_Field, and
 * {@link formatBody} for the Body_Field. Each returns a single string.
 *
 * Every function here is pure: it reads and writes no document, issues no
 * request, and uses no browser-provided global, so all three are callable in a
 * test environment that provides neither a DOM nor a browser global (R10.18).
 * None consults a clock, a random source, or any state outside its arguments,
 * so equal inputs yield character-identical output across calls (R10.16), and
 * each returns a string and raises no error for every input in the domain of
 * R10.15 (R10.17).
 */

/**
 * The Status_Field's settled-without-a-status-code prefix (R10.6, R10.7).
 * Kept as a named constant so branch S2's two outcomes share one wording.
 */
const SETTLED_WITHOUT_STATUS = "settled without a status code";

/**
 * The reason substituted when a request settled without a status code and with
 * no reported reason text — the transport-failure indication of R10.7.
 */
const TRANSPORT_FAILURE = "transport failure";

/**
 * The Body_Field's text when the response carried no body (R10.11).
 */
const NO_BODY = "the response carried no body";

/**
 * The Request_Field's text.
 *
 * Branchless: returns the Request_Line the Demo_Page composed, character for
 * character — no branch, no truncation, no normalisation, no substitution
 * (R10.3). For a Request_Line of 0 characters it returns the empty string,
 * which is a string as R10.17 requires; the Demo_Page composes a 0-character
 * Request_Line for no request (the trivial exception of R10.19).
 *
 * Satisfies R10.3, R10.19.
 *
 * @param requestLine - the composed Request_Line, a string of 0 to 2,048
 *   characters (R10.15).
 * @returns the Request_Line unchanged.
 */
export function formatRequestLine(requestLine: string): string {
  return requestLine;
}

/**
 * The Status_Field's text. Two branches, in evaluation order:
 *
 * - S1: a status code arrived. Returns the code in decimal, for **every** code
 *   from 100 to 599 inclusive, 2xx included (R10.5, R10.20).
 * - S2: no status code arrived. Returns text indicating the request settled
 *   without a status code, together with the reason character for character
 *   (whitespace included) when the reason holds 1 or more characters (R10.6),
 *   and a transport-failure indication when the reason is absent or a string of
 *   0 characters (R10.7). An empty string reports no text, so the two guards
 *   partition R10.15's domain with nothing between them.
 *
 * Satisfies R10.5, R10.6, R10.7, R10.8, R10.20.
 *
 * @param status - the received status code: absent, or an integer from 100 to
 *   599 inclusive (R10.15).
 * @param reason - the reported reason text: absent, or a string of 0 to 2,048
 *   characters (R10.15).
 * @returns the Status_Field text.
 */
export function formatStatus(
  status: number | undefined,
  reason: string | undefined,
): string {
  if (status !== undefined) {
    // S1 — the code in decimal, for every code in 100..599 (R10.5, R10.20).
    return `${status}`;
  }
  // S2 — settled without a status code (R10.6, R10.7).
  const detail =
    reason !== undefined && reason.length > 0 ? reason : TRANSPORT_FAILURE;
  return `${SETTLED_WITHOUT_STATUS}: ${detail}`;
}

/**
 * The Body_Field's text. Three branches, in evaluation order, and NO status
 * code parameter (R10.14): the body is this function's sole input, so a
 * microservice returning a JSON error body with a status outside 200 to 599 has
 * that body formatted as JSON rather than returned as unparsed text.
 *
 * - B1: body absent, or a string of 0 characters. Returns text indicating the
 *   response carried no body (R10.11).
 * - B2: body parses as JSON (`JSON.parse` succeeds). Returns that body
 *   serialised as JSON indented with two spaces (R10.12, R10.21). A bare number
 *   or `"null"` is valid JSON and is re-serialised the same way.
 * - B3: otherwise. Returns the body character for character, untruncated up to
 *   1,048,576 characters (R10.13).
 *
 * The only throwing call, `JSON.parse`, is wrapped in the try that selects
 * between B2 and B3; `JSON.stringify` of a value `JSON.parse` produced is never
 * `undefined`, so B2 always yields a string (R10.17).
 *
 * Satisfies R10.11, R10.12, R10.13, R10.14, R10.21.
 *
 * @param body - the response body: absent, or a string of 0 to 1,048,576
 *   characters (R10.15).
 * @returns the Body_Field text.
 */
export function formatBody(body: string | undefined): string {
  if (body === undefined || body.length === 0) {
    // B1 — no body arrived (R10.11).
    return NO_BODY;
  }
  try {
    // B2 — parseable as JSON: re-serialise with a two-space indent (R10.12).
    const parsed: unknown = JSON.parse(body);
    return JSON.stringify(parsed, null, 2);
  } catch {
    // B3 — not JSON: the body verbatim, untruncated (R10.13).
    return body;
  }
}

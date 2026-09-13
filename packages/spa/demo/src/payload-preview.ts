/**
 * The Payload_Preview — a single pure module of the Demo_Spa exporting exactly one
 * function (R3.1). It computes the Expected_Payload_Text: the Extended_Config_Payload
 * for a name and a path, serialised as JSON indented with two spaces (R3.2).
 *
 * The values come from @microservices/extended-config, imported by package name and
 * never restated as a literal here (R2.9), so the text is fixed when the Demo_Spa is
 * bundled — the bundler inlines the Common_Package and no request is issued (R3.3).
 *
 * Pure: it reads no `document`, `window`, `fetch`, `AbortController`, `setTimeout`,
 * clock, or random source, and performs no network, filesystem, or console access,
 * either when this module is evaluated or when the function is called (R3.3). That is
 * the whole of what makes it callable in the Vitest default `node` environment with no
 * DOM present (R3.7), and what makes equal arguments yield character-identical output
 * across calls and across processes (R3.4).
 *
 * The name and the path are ARGUMENTS, not literals. Two reasons: it is what gives
 * R3.8 and R3.10 something to quantify over, and it keeps every Microservice3-specific
 * literal in `main.ts`, beside the endpoint literals that already live there.
 */

import { buildExtendedConfigPayload } from "@microservices/extended-config";

/**
 * The JSON indent width R3.2 fixes. Module-private: R3.1 caps the module's export
 * list at exactly one function, so nothing else leaves this file.
 */
const JSON_INDENT = 2;

/**
 * The Expected_Payload_Text for one microservice name and Microservice_Path.
 *
 * `JSON.stringify` with a two-space indent and no replacer produces no leading
 * whitespace, no trailing whitespace, and no trailing newline (R3.2), and returns a
 * string for every pair of string arguments (R3.8) — the payload is a plain object of
 * strings, so there is no cyclic, `undefined`, or `BigInt` value to make it throw or
 * return `undefined`.
 *
 * The metamorphic relation of R3.6 and R3.10 holds by construction rather than by
 * coincidence: the Result_Formatter's `formatBody` computes
 * `JSON.stringify(JSON.parse(body), null, 2)` for a body that parses, and `JSON.parse`
 * preserves the insertion order of every key of this payload (none is integer-like),
 * so `formatBody(JSON.stringify(payload))` and this function agree character for
 * character. Neither function is written in terms of the other, which is what makes
 * the property a real check.
 *
 * @param name - the microservice name to echo into the payload.
 * @param path - the Microservice_Path to echo into the payload.
 * @returns the payload serialised as JSON, indented with two spaces.
 */
export function expectedPayloadText(name: string, path: string): string {
  return JSON.stringify(
    buildExtendedConfigPayload(name, path),
    null,
    JSON_INDENT,
  );
}

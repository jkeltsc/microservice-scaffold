/**
 * The Demo_Page's browser entry: the ONLY module of the Demo_Spa that touches a
 * browser-provided global (`document`, `window`, `fetch`, `AbortController`,
 * `setTimeout`). Its responsibilities, and nothing else: read the DOM once, own
 * the in-flight state, compose the Request_Line, perform the request, and assign
 * each of the Result_Formatter's three return values to its own field.
 *
 * Every text-computation rule lives in the Result_Formatter (R10.1); this module
 * computes only the browser-dependent inputs — the Request_Line and the reason
 * strings — and restates no formatter rule of its own.
 */

import {
  formatBody,
  formatRequestLine,
  formatStatus,
} from "./result-formatter.js";

/**
 * The two Service_Buttons keyed by their `index.html` id, each mapped to the
 * root-absolute, same-origin path it requests through the Overseer (R9.9, R9.10,
 * R9.11). The paths are deliberately NOT relative, unlike the asset references
 * (R6.7): a peer microservice is mounted at its own Microservice_Path by the
 * Overseer regardless of where Microservice1 is mounted. Nothing reads a host
 * from configuration.
 */
const ENDPOINTS = {
  "call-microservice2": "/microservice2/config",
  "call-microservice3": "/microservice3/config",
} as const;

/** The HTTP method every Service_Button request uses (R9.9, R9.10). */
const METHOD = "GET";

/** The 10-second request limit of R9.16, in milliseconds. */
const REQUEST_LIMIT_MS = 10_000;

/**
 * The Status_Field's in-flight text (R9.12). A constant here, NOT a fourth
 * Result_Formatter export, because R10.1 fixes the formatter's surface at exactly
 * three functions.
 */
const PENDING = "waiting for a response\u2026";

/** The reason reported when the request limit is reached (R9.16, R10.8). */
const LIMIT_REASON = "no response within the 10-second request limit";

/**
 * The single in-flight guard (R9.13, R9.15). While a request is in flight this is
 * `true`, both buttons are `disabled`, and an activation returns before touching
 * any field so all three field texts stay unchanged.
 */
let inFlight = false;

/**
 * Wire the Demo_Page: query the two buttons and three fields by id, then attach a
 * click handler to each button. On load both buttons are enabled and the three
 * fields already ship empty from `index.html` (R9.8), so this module clears
 * nothing at startup.
 */
function wireDemoPage(): void {
  const microservice2Button = document.getElementById("call-microservice2");
  const microservice3Button = document.getElementById("call-microservice3");
  const requestField = document.getElementById("request");
  const statusField = document.getElementById("status");
  const bodyField = document.getElementById("body");

  if (
    !(microservice2Button instanceof HTMLButtonElement) ||
    !(microservice3Button instanceof HTMLButtonElement) ||
    !(requestField instanceof HTMLOutputElement) ||
    !(statusField instanceof HTMLOutputElement) ||
    !(bodyField instanceof HTMLTextAreaElement)
  ) {
    return;
  }

  const buttons = [microservice2Button, microservice3Button] as const;
  const fields = { requestField, statusField, bodyField } as const;

  microservice2Button.addEventListener("click", () => {
    void handleActivation(ENDPOINTS["call-microservice2"], buttons, fields);
  });
  microservice3Button.addEventListener("click", () => {
    void handleActivation(ENDPOINTS["call-microservice3"], buttons, fields);
  });
}

/**
 * The Demo_Page's three display fields, held for the lifetime of the page (R9.6).
 * The two `output` elements are written through `textContent` — `HTMLOutputElement`
 * exposes both `.value` and `.textContent`, and `.value` reflects `.textContent`;
 * assigning `.textContent` directly is what makes the text-node claim behind R9.3
 * concrete. The `textarea`'s content is its `.value`.
 */
interface DemoFields {
  readonly requestField: HTMLOutputElement;
  readonly statusField: HTMLOutputElement;
  readonly bodyField: HTMLTextAreaElement;
}

/**
 * Handle one Service_Button activation.
 *
 * - If a request is already in flight (R9.15): send no request and leave the
 *   Request_Field, Status_Field, and Body_Field texts each unchanged by returning
 *   before touching any of them.
 * - Otherwise (R9.12): compose the Request_Line, show it in the Request_Field, set
 *   the Status_Field to the pending indication, clear the Body_Field, disable both
 *   buttons (R9.13), and send exactly one request.
 * - On settlement (completion, transport failure, or the 10-second limit): re-enable
 *   both buttons within the finally, well inside the 1-second bound of R9.14.
 */
async function handleActivation(
  path: string,
  buttons: readonly HTMLButtonElement[],
  fields: DemoFields,
): Promise<void> {
  if (inFlight) {
    // R9.15 — an activation while a request is in flight sends nothing and
    // changes nothing.
    return;
  }

  const { requestField, statusField, bodyField } = fields;

  // R10.2 — compose the Request_Line here, where the browser dependence
  // (window.location.origin) lives: method + single space + absolute URL
  // (scheme + host + path). No HTTP protocol version — fetch does not expose the
  // negotiated version.
  const absoluteUrl = new URL(path, window.location.origin).href;
  const requestLine = `${METHOD} ${absoluteUrl}`;

  // R9.12 — three assignments, before the request is sent and before it can
  // settle. main.ts restates no rule of its own for the Request_Field text.
  requestField.textContent = formatRequestLine(requestLine);
  statusField.textContent = PENDING;
  bodyField.value = "";

  inFlight = true;
  setButtonsDisabled(buttons, true); // R9.13

  // R9.16, R10.8 — abandon the request at the 10-second limit.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REQUEST_LIMIT_MS);

  try {
    const response = await fetch(absoluteUrl, {
      method: METHOD,
      signal: controller.signal,
    });

    // R9.17, R10.9 — completion with a status code. Read the body as text so the
    // Result_Formatter's body function, not fetch, owns the JSON parse attempt.
    const bodyText = await response.text();
    statusField.textContent = formatStatus(response.status, undefined);
    bodyField.value = formatBody(bodyText);
  } catch (error) {
    // Two ways to reach here: the 10-second abort (R9.16, R10.8) and a transport
    // failure that settles without a status code (R10.10). Both are one instance
    // of the formatter's settled-without-a-status-code branch; the Body_Field is
    // left holding no text, no response body having arrived.
    const reason = controller.signal.aborted
      ? LIMIT_REASON
      : describeTransportFailure(error);
    statusField.textContent = formatStatus(undefined, reason);
  } finally {
    // R9.14 — re-enable both buttons on completion, transport failure, and abort
    // alike, well inside the 1-second bound.
    clearTimeout(timeoutId);
    inFlight = false;
    setButtonsDisabled(buttons, false);
  }
}

/** Set the `disabled` state of every Service_Button at once (R9.13, R9.14). */
function setButtonsDisabled(
  buttons: readonly HTMLButtonElement[],
  disabled: boolean,
): void {
  for (const button of buttons) {
    button.disabled = disabled;
  }
}

/**
 * Reduce a caught transport failure to a reason string for the Result_Formatter's
 * status function (R10.10). An empty reason lets the formatter fall back to its
 * transport-failure indication (R10.7).
 */
function describeTransportFailure(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

wireDemoPage();

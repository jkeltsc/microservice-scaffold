// Feature: scaffold-demo-samples — the Demo_Page's markup and the Demo_Spa's
// request/wiring behaviour.
//
// This is the deliberately WEAKER of the two treatments Requirement 11
// criterion 8 prescribes. Where the value-returning criteria of Requirement 10
// are covered by calling the Result_Formatter's three functions directly (the
// result-formatter suites), the DOM-mutation criteria of Requirement 9 and of
// Requirement 10 (R10.22, R10.23) are covered HERE — by parsing the committed
// `index.html` document and by reading the Demo_Spa's own sources (`main.ts`,
// `result-formatter.ts`) as text. It checks the WIRING — which formatter
// function's output lands in which field, which paths are fetched, that the
// buttons disable in-flight and re-enable on settlement — while the interesting
// CONTENT of each field is the property suite's subject. That trade is the
// whole point: it is what lets no test of the Demo_Spa require a DOM (R11.8).
//
// This file references NEITHER `document` NOR `window`, so it runs in Vitest's
// default Node environment (R11.3). It uses no jsdom / happy-dom and no browser
// global: `index.html` is parsed as a string, and the sources are read as text.
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10,
// 9.11, 9.12, 9.13, 9.14, 9.15, 9.17, 10.2, 10.4, 10.8, 10.9, 10.10, 10.22,
// 10.23, 11.8

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readFromPackage = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

const html = readFromPackage("index.html");
const mainSource = readFromPackage("src/main.ts");
const formatterSource = readFromPackage("src/result-formatter.ts");

/** `index.html` with its `<!-- ... -->` comments removed. */
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, "");

/**
 * `main.ts` with its comments removed, so a mention of a word in prose (e.g.
 * "enabled" in a doc comment) is never mistaken for a code branch. Strips
 * block comments and line comments; string literals in this module never
 * contain `//`, so a naive line-comment strip is safe here.
 */
const mainCode = mainSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// --- Minimal, DOM-free helpers over the committed HTML string --------------
//
// These parse the markup with regular expressions rather than a DOM. They are
// intentionally simple; the Demo_Page is a fixed, committed document, so a
// lightweight structural parse is enough to pin every markup fact R9 states.

interface Tag {
  readonly name: string;
  readonly attrs: string;
  /** Byte offset of the tag's `<` in the source, used only for ordering. */
  readonly index: number;
}

/** Every opening tag of the given name, in document order. */
function openingTags(name: string): Tag[] {
  const re = new RegExp(`<${name}(\\s[^>]*|)>`, "gi");
  const tags: Tag[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    tags.push({ name, attrs: match[1] ?? "", index: match.index });
  }
  return tags;
}

/** Read one attribute's value from an attribute string, or undefined. */
function attr(attrs: string, attribute: string): string | undefined {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  return match ? match[1] : undefined;
}

/** True if a boolean/valueless attribute is present. */
function hasAttr(attrs: string, attribute: string): boolean {
  return new RegExp(`\\b${attribute}\\b`, "i").test(attrs);
}

/** The text content of the first element `<name ...>text</name>`. */
function textOf(name: string, index: number): string {
  const close = html.indexOf(`</${name}>`, index);
  const open = html.indexOf(">", index);
  return html.slice(open + 1, close).trim();
}

describe("Demo_Page markup — Service_Buttons (R9.1, R9.7)", () => {
  const buttons = openingTags("button");

  it("has exactly two Service_Buttons", () => {
    expect(buttons).toHaveLength(2);
  });

  it("labels them 'Microservice 2' then 'Microservice 3' in document order (R9.1)", () => {
    expect(textOf("button", buttons[0].index)).toBe("Microservice 2");
    expect(textOf("button", buttons[1].index)).toBe("Microservice 3");
  });

  it("renders each as a native `button type=\"button\"` (R9.1, R9.7)", () => {
    for (const button of buttons) {
      expect(attr(button.attrs, "type")).toBe("button");
    }
  });

  it("gives each an accessible name equal to its text — no `aria-label` (R9.1)", () => {
    for (const button of buttons) {
      expect(hasAttr(button.attrs, "aria-label")).toBe(false);
    }
  });

  it("carries no `tabindex` on either button (R9.7)", () => {
    for (const button of buttons) {
      expect(attr(button.attrs, "tabindex")).toBeUndefined();
    }
  });
});

describe("Demo_Page markup — the three display fields (R9.2, R9.3, R9.4, R9.8)", () => {
  const buttons = openingTags("button");
  const outputs = openingTags("output");
  const textareas = openingTags("textarea");
  const lastButtonIndex = Math.max(...buttons.map((b) => b.index));

  it("has exactly two `output` elements and one `textarea` (R9.3, R9.4)", () => {
    expect(outputs).toHaveLength(2);
    expect(textareas).toHaveLength(1);
  });

  it("places all three fields after both Service_Buttons (R9.2)", () => {
    for (const field of [...outputs, ...textareas]) {
      expect(field.index).toBeGreaterThan(lastButtonIndex);
    }
  });

  it("orders the fields request -> status -> body (R9.2)", () => {
    const requestOutput = outputs.find((o) => attr(o.attrs, "id") === "request");
    const statusOutput = outputs.find((o) => attr(o.attrs, "id") === "status");
    const bodyTextarea = textareas[0];
    expect(requestOutput).toBeDefined();
    expect(statusOutput).toBeDefined();
    // Request (output) before Status (output) before Body (textarea).
    expect(requestOutput!.index).toBeLessThan(statusOutput!.index);
    expect(statusOutput!.index).toBeLessThan(bodyTextarea.index);
  });

  it("associates each `output` with a visibly rendered `<label for=...>` (R9.3)", () => {
    for (const output of outputs) {
      const id = attr(output.attrs, "id");
      expect(id).toBeTruthy();
      const label = openingTags("label").find((l) => attr(l.attrs, "for") === id);
      expect(label, `label[for="${id ?? ""}"] present`).toBeDefined();
      // Visibly rendered: the label carries non-empty text content.
      expect(textOf("label", label!.index).length).toBeGreaterThan(0);
    }
  });

  it("makes the Body_Field a `readonly` (not `disabled`) `textarea` with a visible label (R9.4)", () => {
    const textarea = textareas[0];
    expect(hasAttr(textarea.attrs, "readonly")).toBe(true);
    expect(hasAttr(textarea.attrs, "disabled")).toBe(false);
    const id = attr(textarea.attrs, "id");
    expect(id).toBeTruthy();
    const label = openingTags("label").find((l) => attr(l.attrs, "for") === id);
    expect(label, `label[for="${id ?? ""}"] present`).toBeDefined();
    expect(textOf("label", label!.index).length).toBeGreaterThan(0);
  });

  it("ships all three fields empty (R9.8)", () => {
    for (const output of outputs) {
      expect(textOf("output", output.index)).toBe("");
    }
    expect(textOf("textarea", textareas[0].index)).toBe("");
  });
});

describe("Demo_Page markup — no live-region announcement of the body (R9.5)", () => {
  it("declares no `aria-live` attribute anywhere in the document", () => {
    // R9.5: the Status_Field alone announces the outcome via its implicit
    // `status` role; no `aria-live` is declared on the Body_Field or any
    // ancestor — nor, as it happens, anywhere in the document. Checked against
    // the markup with comments stripped, so the prose mention of the attribute
    // in a comment does not count as a declared attribute.
    expect(/\baria-live\b/i.test(htmlNoComments)).toBe(false);
  });
});

describe("Demo_Page markup — persistent Request/Status elements (R9.6)", () => {
  it("holds the Request_Field and Status_Field as `output` elements in the loaded document", () => {
    const ids = openingTags("output").map((o) => attr(o.attrs, "id"));
    expect(ids).toContain("request");
    expect(ids).toContain("status");
  });
});

describe("Demo_Spa wiring — endpoint map (R9.9, R9.10, R9.11)", () => {
  it("maps the two buttons to exactly the two same-origin paths, verbatim", () => {
    expect(mainSource).toContain('"/microservice2/config"');
    expect(mainSource).toContain('"/microservice3/config"');
  });

  it("names no other origin and reads no host from configuration (R9.11)", () => {
    // No hard-coded scheme+host literal, and no config/env read.
    expect(/https?:\/\//.test(mainSource)).toBe(false);
    expect(/process\.env|import\.meta\.env/.test(mainSource)).toBe(false);
    // The absolute URL is derived from the page's own origin, not a literal.
    expect(mainSource).toContain("window.location.origin");
  });

  it("issues the requests with the GET method (R9.9, R9.10)", () => {
    expect(mainSource).toMatch(/METHOD\s*=\s*"GET"/);
  });
});

describe("Demo_Spa wiring — activation assignments and in-flight state (R9.12, R9.13, R9.15)", () => {
  it("sets the three fields via the Result_Formatter's three functions (R9.12)", () => {
    expect(mainSource).toContain("formatRequestLine(requestLine)");
    // The pending indication is a non-empty in-flight constant (R9.12).
    expect(mainSource).toMatch(/PENDING\s*=\s*"[^"]+/);
    expect(mainSource).toContain("statusField.textContent = PENDING");
    // The Body_Field is cleared before the request settles.
    expect(mainSource).toContain('bodyField.value = ""');
  });

  it("disables both buttons before the request and re-enables in a `finally` (R9.13, R9.14)", () => {
    expect(mainSource).toContain("setButtonsDisabled(buttons, true)");
    // The re-enable sits after `finally {` so it runs on every settlement path.
    const finallyIndex = mainSource.indexOf("finally {");
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(mainSource.indexOf("setButtonsDisabled(buttons, false)")).toBeGreaterThan(
      finallyIndex,
    );
  });

  it("guards concurrent requests by returning before any field is touched (R9.15)", () => {
    // The in-flight guard returns before the first field assignment.
    const guardReturn = mainSource.search(/if\s*\(\s*inFlight\s*\)\s*\{[\s\S]*?return;/);
    expect(guardReturn).toBeGreaterThan(-1);
    const firstAssignment = mainSource.indexOf("requestField.textContent");
    expect(guardReturn).toBeLessThan(firstAssignment);
  });
});

describe("Demo_Spa wiring — Request_Line composition (R10.2, R10.4)", () => {
  it("composes method + single space + absolute URL, with no HTTP version literal", () => {
    // method + " " + absolute URL.
    expect(mainSource).toMatch(/`\$\{METHOD\}\s\$\{absoluteUrl\}`/);
    expect(mainSource).toContain("new URL(path, window.location.origin).href");
    // No HTTP protocol version anywhere (e.g. "HTTP/1.1").
    expect(/HTTP\/\d/.test(mainSource)).toBe(false);
  });

  it("displays that composed Request_Line via formatRequestLine in the Request_Field (R10.4)", () => {
    expect(mainSource).toContain(
      "requestField.textContent = formatRequestLine(requestLine)",
    );
  });
});

describe("Demo_Spa wiring — request limit and settlement (R9.14, R9.16, R10.8, R10.9, R10.10)", () => {
  it("uses a 10-second AbortController limit (R9.16)", () => {
    expect(mainSource).toContain("new AbortController()");
    expect(mainSource).toMatch(/REQUEST_LIMIT_MS\s*=\s*10_?000/);
    expect(mainSource).toContain("controller.abort()");
  });

  it("names that limit as the reason passed to the status function (R10.8)", () => {
    // A non-empty limit-naming reason, supplied to formatStatus on abort.
    expect(mainSource).toMatch(/LIMIT_REASON\s*=\s*"[^"]+/);
    expect(mainSource).toContain("? LIMIT_REASON");
    expect(mainSource).toContain("formatStatus(undefined, reason)");
  });

  it("on completion sets status and body from the formatter (R10.9)", () => {
    expect(mainSource).toContain("formatStatus(response.status, undefined)");
    expect(mainSource).toContain("bodyField.value = formatBody(bodyText)");
  });

  it("on a status-less settlement sets status only, leaving the body untouched (R10.10)", () => {
    // The catch branch assigns only the Status_Field; it makes no Body_Field
    // assignment of its own.
    const catchIndex = mainSource.indexOf("} catch (error) {");
    const finallyIndex = mainSource.indexOf("} finally {");
    expect(catchIndex).toBeGreaterThan(-1);
    expect(finallyIndex).toBeGreaterThan(catchIndex);
    const catchBody = mainSource.slice(catchIndex, finallyIndex);
    expect(catchBody).toContain("statusField.textContent = formatStatus(undefined, reason)");
    expect(catchBody).not.toContain("bodyField.value");
  });
});

describe("Demo_Spa wiring — the body assignment is the formatter's alone (R9.17)", () => {
  it("sets the Body_Field only from formatBody's return value", () => {
    // The single Body_Field assignment on completion is formatBody(...);
    // main.ts restates no formatting rule of its own.
    const bodyAssignments = mainSource.match(/bodyField\.value\s*=\s*[^;]+/g) ?? [];
    // Two assignments exist: the "" clear (R9.12) and the formatBody result.
    const nonClear = bodyAssignments.filter((a) => !/=\s*""\s*$/.test(a.trim()));
    expect(nonClear).toHaveLength(1);
    expect(nonClear[0]).toContain("formatBody(bodyText)");
  });

  it("does not restate the formatter's rules (no JSON.stringify / JSON.parse in main.ts)", () => {
    expect(mainSource).not.toContain("JSON.stringify");
    expect(mainSource).not.toContain("JSON.parse");
  });
});

describe("Demo_Spa wiring — no branching on selector, toggle, or 404 (R10.22, R10.23)", () => {
  it("does not special-case a Selector-excluded or toggle-disabled outcome", () => {
    // R10.22 / R10.23: the 404 shown for an excluded or toggled-off microservice
    // is Microservice1's own response, surfaced by the SAME status/Request_Line
    // wiring as any other response — main.ts branches on no selector, toggle, or
    // status value. Checked against the CODE with comments stripped, so a prose
    // mention (e.g. "enabled" in a doc comment) is not read as a branch.
    expect(/\b404\b/.test(mainCode)).toBe(false);
    expect(/\bselector\b|\btoggle\b/i.test(mainCode)).toBe(false);
    // The status function is called with the received status unconditionally,
    // never behind a status-value branch.
    expect(mainSource).toContain("formatStatus(response.status, undefined)");
    expect(mainCode).not.toMatch(/if\s*\(\s*response\.status/);
  });
});

describe("Result_Formatter surface referenced by the wiring (sanity)", () => {
  it("exports exactly the three functions main.ts wires", () => {
    for (const fn of ["formatRequestLine", "formatStatus", "formatBody"]) {
      expect(formatterSource).toContain(`export function ${fn}`);
    }
  });
});

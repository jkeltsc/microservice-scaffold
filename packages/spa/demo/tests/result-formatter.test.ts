// Feature: scaffold-demo-samples — the Result_Formatter's three functions.
//
// This suite pins the BRANCH-OUTCOME criteria of Requirement 10 that are best
// stated as concrete examples: the exact text each formatter function returns
// for a representative input. The determinism, totality, purity, metamorphic,
// and round-trip properties (R10.16–R10.21) are covered separately as
// fast-check property tests (task 8.4) and are NOT duplicated here.
//
// Per Requirement 11 criterion 8, every value-returning branch-outcome
// criterion of Requirement 10 is covered by at least one automated test that
// calls the formatter function directly. This file references neither
// `document` nor `window`, so it runs in Vitest's default Node environment
// (R11.3, R11.8).
//
// Validates: Requirements 10.3, 10.5, 10.6, 10.7, 10.11, 10.12, 10.13, 10.14, 10.20

import { describe, expect, it } from "vitest";

import {
  formatBody,
  formatRequestLine,
  formatStatus,
} from "../src/result-formatter.js";

describe("formatRequestLine — Request_Field (R10.3)", () => {
  it("returns a typical Request_Line character for character", () => {
    // A composed method + space + absolute URL, carrying no protocol version.
    const requestLine = "GET http://localhost:3000/microservice2/config";
    expect(formatRequestLine(requestLine)).toBe(requestLine);
  });

  it("returns the empty string unchanged (the trivial 0-character case)", () => {
    expect(formatRequestLine("")).toBe("");
  });
});

describe("formatStatus — Status_Field with a status code (R10.5, R10.20)", () => {
  // A status code present as an integer in 100..599 is returned as text
  // containing that code in decimal, for EVERY code in the range including 2xx.
  it("contains 200 for a 2xx code", () => {
    expect(formatStatus(200, undefined)).toContain("200");
  });

  it("contains 404 for a not-found code", () => {
    expect(formatStatus(404, undefined)).toContain("404");
  });

  it("contains 100 for the low end of the range", () => {
    expect(formatStatus(100, undefined)).toContain("100");
  });

  it("contains 599 for the high end of the range", () => {
    expect(formatStatus(599, undefined)).toContain("599");
  });

  it("reports the code in decimal regardless of any supplied reason", () => {
    // A reason may accompany a present code; the decimal code is still present.
    expect(formatStatus(503, "ignored")).toContain("503");
  });
});

describe("formatStatus — settled without a status code (R10.6, R10.7)", () => {
  it("R10.6: no code + a reason (1–2048 chars) reports settled-without-a-code and the reason char-for-char", () => {
    const reason = "request abandoned at the 10-second limit";
    const text = formatStatus(undefined, reason);
    // Indicates the request settled without a status code...
    expect(text).toContain("settled without a status code");
    // ...together with that reason text, character for character.
    expect(text).toContain(reason);
  });

  it("R10.6: preserves reason whitespace and punctuation character for character", () => {
    const reason = "  DNS lookup failed: ENOTFOUND api.example.internal  ";
    const text = formatStatus(undefined, reason);
    expect(text).toContain("settled without a status code");
    expect(text).toContain(reason);
  });

  it("R10.7: no code + no reason reports settled-without-a-code AND a transport failure", () => {
    const text = formatStatus(undefined, undefined);
    expect(text).toContain("settled without a status code");
    expect(text).toContain("transport failure");
  });

  it("R10.7: an empty-string reason reports no text, so it takes the transport-failure branch", () => {
    const text = formatStatus(undefined, "");
    expect(text).toContain("settled without a status code");
    expect(text).toContain("transport failure");
  });
});

describe("formatBody — absent or empty body (R10.11)", () => {
  it("returns the no-body text for an absent body", () => {
    expect(formatBody(undefined)).toBe("the response carried no body");
  });

  it("returns the no-body text for a string of 0 characters", () => {
    expect(formatBody("")).toBe("the response carried no body");
  });
});

describe("formatBody — body parseable as JSON (R10.12)", () => {
  it("re-serialises an object with a two-space indent", () => {
    const body = '{"name":"microservice2","path":"/microservice2"}';
    expect(formatBody(body)).toBe(
      JSON.stringify(JSON.parse(body), null, 2),
    );
    // And the concrete shape, so the indent is pinned literally.
    expect(formatBody(body)).toBe(
      '{\n  "name": "microservice2",\n  "path": "/microservice2"\n}',
    );
  });

  it("re-serialises an array with a two-space indent", () => {
    const body = "[1,2,3]";
    expect(formatBody(body)).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("re-serialises a bare number", () => {
    expect(formatBody("123")).toBe("123");
  });

  it("re-serialises the JSON literal null", () => {
    // `null` is valid JSON; JSON.stringify(null, null, 2) is "null".
    expect(formatBody("null")).toBe("null");
  });

  it("re-serialises a JSON string literal", () => {
    // The body is the JSON text '"hi"' (a quoted string), which parses to "hi"
    // and re-serialises back to the quoted form.
    expect(formatBody('"hi"')).toBe('"hi"');
  });
});

describe("formatBody — non-JSON string (R10.13)", () => {
  it("returns a short non-JSON string character for character", () => {
    const body = "Internal Server Error";
    expect(formatBody(body)).toBe(body);
  });

  it("returns a moderately long non-JSON string with no truncation", () => {
    // Not parseable as JSON (a bare unquoted sentence repeated); returned verbatim.
    const body = "the upstream service is unavailable — ".repeat(500);
    const result = formatBody(body);
    expect(result).toBe(body);
    expect(result.length).toBe(body.length);
  });
});

describe("formatBody — sole input is the body, no status code (R10.14)", () => {
  it("takes exactly one declared parameter (arity 1)", () => {
    // The body function receives no status code: its signature is (body) only.
    expect(formatBody.length).toBe(1);
  });

  it("formats a JSON error body as JSON regardless of any status code", () => {
    // A microservice returning a JSON error body with a status outside 200..299
    // still has that body formatted as JSON, because the body function consults
    // no status code. formatBody is called with the body alone.
    const errorBody = '{"error":"not found","code":404}';
    expect(formatBody(errorBody)).toBe(
      JSON.stringify(JSON.parse(errorBody), null, 2),
    );
    expect(formatBody(errorBody)).toBe(
      '{\n  "error": "not found",\n  "code": 404\n}',
    );
  });
});

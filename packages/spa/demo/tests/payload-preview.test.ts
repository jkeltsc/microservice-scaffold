// Feature: spa-common-consumption — the Payload_Preview's concrete assertions.
//
// This suite pins the example-and-edge criteria of Requirement 3 that are best
// stated as concrete assertions: the exact Expected_Payload_Text the module
// computes for the Microservice3 name/path pair, the shape of that text (no
// surrounding whitespace, no trailing newline), the export surface, the
// `extendedSetting` substring, and the static half of purity. The round-trip,
// metamorphic, determinism, and purity PROPERTIES (R3.4, R3.5, R3.6, R3.8,
// R3.10) are covered separately as fast-check property tests and are NOT
// duplicated here.
//
// The Expected_Payload_Text is NEVER restated as a literal: every value
// assertion computes it from `buildExtendedConfigPayload`, imported by package
// name (R2.9). This file references neither `document` nor `window`, so it runs
// in Vitest's default `node` environment with no DOM implementation present
// (R3.7).
//
// Validates: Requirements 3.1, 3.2, 3.7, 3.9

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildExtendedConfigPayload } from "@microservices/extended-config";
import { describe, expect, it } from "vitest";

import * as payloadPreviewModule from "../src/payload-preview.js";
import { expectedPayloadText } from "../src/payload-preview.js";

// The Microservice3 identity the Expected_Payload_Field previews. These live
// here (not in the SUT) because the SUT takes them as arguments (R3.1).
const MICROSERVICE3_NAME = "microservice3";
const MICROSERVICE3_PATH = "/microservice3";

describe("expectedPayloadText — export surface (R3.1)", () => {
  it("exposes exactly one export, and it is a function", () => {
    const exportNames = Object.keys(payloadPreviewModule);
    expect(exportNames).toEqual(["expectedPayloadText"]);
    expect(typeof payloadPreviewModule.expectedPayloadText).toBe("function");
  });

  it("declares exactly two parameters (a name and a path)", () => {
    expect(expectedPayloadText.length).toBe(2);
  });
});

describe("expectedPayloadText — the Expected_Payload_Text (R3.2)", () => {
  // The expected value is COMPUTED from the package, never restated (R2.9).
  const expected = JSON.stringify(
    buildExtendedConfigPayload(MICROSERVICE3_NAME, MICROSERVICE3_PATH),
    null,
    2,
  );

  it("equals the Extended_Config_Payload serialised with a two-space indent", () => {
    expect(expectedPayloadText(MICROSERVICE3_NAME, MICROSERVICE3_PATH)).toBe(
      expected,
    );
  });

  it("returns a string of one or more characters", () => {
    const text = expectedPayloadText(MICROSERVICE3_NAME, MICROSERVICE3_PATH);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("has no leading whitespace, no trailing whitespace, and no trailing newline", () => {
    const text = expectedPayloadText(MICROSERVICE3_NAME, MICROSERVICE3_PATH);
    // No leading or trailing whitespace of any kind.
    expect(text).toBe(text.trim());
    // Explicitly no trailing newline (JSON.stringify appends none).
    expect(text.endsWith("\n")).toBe(false);
    // And no leading whitespace character.
    expect(/^\s/.test(text)).toBe(false);
  });
});

describe("expectedPayloadText — the extendedSetting substring (R3.9)", () => {
  it("contains the value the Extended_Config_Package exports as extendedSetting", () => {
    // The value is read from the package, not restated as a literal.
    const { extendedSetting } = buildExtendedConfigPayload(
      MICROSERVICE3_NAME,
      MICROSERVICE3_PATH,
    ).config;
    const text = expectedPayloadText(MICROSERVICE3_NAME, MICROSERVICE3_PATH);
    expect(text).toContain(extendedSetting);
  });
});

describe("payload-preview.ts — static half of purity (R3.3)", () => {
  // Read the module SOURCE and assert it names none of the forbidden globals.
  // This is the static complement to the runtime purity property test.
  const sourcePath = fileURLToPath(
    new URL("../src/payload-preview.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  // Strip block and line comments so the doc comment's mention of the forbidden
  // globals (it documents WHY they are absent) does not trip the check; only
  // real references in code should count.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const forbidden = [
    "document",
    "window",
    "fetch",
    "AbortController",
    "setTimeout",
    "Date",
    "Math.random",
    "performance",
  ];

  for (const token of forbidden) {
    it(`references no ${token} in module code`, () => {
      expect(code).not.toContain(token);
    });
  }

  it("contains no fetch anywhere in the module code", () => {
    expect(code).not.toContain("fetch");
  });
});

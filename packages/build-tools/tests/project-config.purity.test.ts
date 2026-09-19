// Task 2.13 — the Config_Parser is a pure function of its declared inputs
// (R2.2, R4.11).
//
// R2.2 requires the Config_Parser to perform no filesystem access, no network
// access, no environment-variable read, no clock read, and no random-source
// read, so that its result is a function of its declared inputs alone — the
// input string and the Project_Directory-relative Project_Config_File path it
// names in its Config_Diagnostics. R4.11 requires the identical list of
// Config_Diagnostics for one input string whether or not each named
// Discovery_Root exists on the filesystem, so that every Requirement 4
// validation is decided by the input string alone.
//
// The strongest structural guarantee behind R2.2 is a fact about the module
// graph: `project-config.ts` imports neither `node:fs` nor `node:process`. If
// it imported neither, it cannot read the filesystem or the environment, so
// "no filesystem access" and "no environment read" hold by construction rather
// than by discipline. This test asserts that fact directly by reading the
// module's own import list — the same technique the thin-wrapper bin test uses
// (`build-workspaces-bin.test.ts`), and precise here because an ES module's
// imports are exactly its top-level `import`/`export … from` declarations.
//
// The behavioural half asserts the observable consequence: `parseProjectConfig`
// returns deep-equal outcomes across repeated calls, and its outcome does not
// change when `process.env` or `process.cwd` change beneath it — a filesystem
// or environment read would let the surrounding process leak into the result.
//
// An example test rather than a property test: R2.2's structural claim is a
// single fixed file's import list, and the determinism claim is exercised over
// a fixed, deliberately varied set of representative inputs (accepted,
// rejected, and unparsable). The exhaustive input-space coverage lives in the
// totality property test.
//
// Validates: Requirements 2.2, 4.11

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseProjectConfig,
  PROJECT_CONFIG_FILE,
  serializeProjectConfig,
  defaultEffectiveConfig,
} from "../src/project-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const sourcePath = resolve(__dirname, "..", "src", "project-config.ts");
const source = readFileSync(sourcePath, "utf8");

/**
 * Every module specifier the source statically imports from: the string in an
 * `import … from "X"`, a side-effect `import "X"`, or a re-exporting
 * `export … from "X"` declaration. Comments and strings that merely mention a
 * specifier (this file's own prose names `node:fs`) are excluded because the
 * match is anchored to a `from` clause of an `import`/`export` statement.
 */
function importedSpecifiers(moduleSource: string): string[] {
  // Strip block and line comments so a specifier named only in prose is not
  // mistaken for an import.
  const withoutBlockComments = moduleSource.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutComments = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const specifiers: string[] = [];

  // `import ... from "X"` and `export ... from "X"`.
  const fromClause = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  for (const match of withoutComments.matchAll(fromClause)) {
    specifiers.push(match[1]!);
  }

  // Side-effect imports: `import "X";` (no `from`).
  const sideEffect = /\bimport\s*["']([^"']+)["']/g;
  for (const match of withoutComments.matchAll(sideEffect)) {
    specifiers.push(match[1]!);
  }

  return specifiers;
}

describe("project-config.ts imports no filesystem or process module (R2.2)", () => {
  const specifiers = importedSpecifiers(source);

  it("imports neither node:fs nor node:process", () => {
    // Match both the bare `node:` form and any accidental unprefixed `fs`/
    // `process` specifier, and their submodules (`node:fs/promises`).
    const forbidden = specifiers.filter((specifier) =>
      /^(?:node:)?(?:fs|process)(?:\/|$)/.test(specifier),
    );
    expect(forbidden).toEqual([]);
  });

  it("imports only sibling modules under src/ (relative specifiers)", () => {
    // The declared dependency is `framework.ts` alone; every specifier is a
    // relative path into the package's own src/. This is the positive form of
    // the same fact: nothing built-in and nothing third-party is imported, so
    // no filesystem, environment, clock, or random source is reachable.
    const nonRelative = specifiers.filter(
      (specifier) => !specifier.startsWith("."),
    );
    expect(nonRelative).toEqual([]);
  });
});

describe("parseProjectConfig is a function of its declared inputs alone (R2.2, R4.11)", () => {
  // Representative inputs: an accepted full config, the empty object, a
  // partially declared config, a rejected scope, a rejected root, an
  // overlapping pair, an unparsable string, and a non-object top level.
  const inputs: readonly string[] = [
    serializeProjectConfig(defaultEffectiveConfig()),
    "{}",
    '{"scope":"@acme"}',
    '{"roots":{"microservice":"services"}}',
    '{"scope":"Invalid Scope"}',
    '{"roots":{"common":"../escape"}}',
    '{"roots":{"microservice":"packages/x","common":"packages/x"}}',
    // A root pointing at a Framework_Singleton directory — R4.7 territory,
    // decided by the string alone regardless of whether the path exists.
    '{"roots":{"common":"packages/contracts"}}',
    "not json at all",
    "[]",
    "",
  ];

  it("returns deep-equal outcomes for repeated calls on the same input", () => {
    for (const text of inputs) {
      const first = parseProjectConfig(text, PROJECT_CONFIG_FILE);
      const second = parseProjectConfig(text, PROJECT_CONFIG_FILE);
      expect(second).toEqual(first);
    }
  });

  it("names the configPath argument in diagnostics, taking it only from its input", () => {
    // The path a diagnostic carries is the argument, not a value read from the
    // environment or the filesystem: two different paths for the same rejected
    // text differ in exactly the `at` field.
    const rejectedText = "not json at all";
    const a = parseProjectConfig(rejectedText, "one/scaffold.config.json");
    const b = parseProjectConfig(rejectedText, "two/scaffold.config.json");
    expect(a.kind).toBe("rejected");
    expect(b.kind).toBe("rejected");
    if (a.kind !== "rejected" || b.kind !== "rejected") return;
    expect(a.diagnostics[0]!.at).toBe("one/scaffold.config.json");
    expect(b.diagnostics[0]!.at).toBe("two/scaffold.config.json");
    // Every part other than the path is identical: the outcome is a function
    // of (text, configPath) alone.
    expect({ ...a.diagnostics[0]!, at: "" }).toEqual({
      ...b.diagnostics[0]!,
      at: "",
    });
  });

  describe("its outcome is invariant under the surrounding process state", () => {
    const originalCwd = process.cwd;
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.cwd = originalCwd;
      process.env = { ...savedEnv };
    });

    it("does not change when process.cwd or process.env change", () => {
      const baseline = inputs.map((text) =>
        parseProjectConfig(text, PROJECT_CONFIG_FILE),
      );

      // Move the world beneath the parser: a different working directory and a
      // wholly replaced environment. A filesystem probe relative to cwd, or an
      // environment read, would change the result if either happened.
      process.cwd = () => "/nonexistent/elsewhere";
      process.env = {
        MICROSERVICES: "microservice1",
        SCAFFOLD_SCOPE: "@should-be-ignored",
      };

      const afterMutation = inputs.map((text) =>
        parseProjectConfig(text, PROJECT_CONFIG_FILE),
      );

      expect(afterMutation).toEqual(baseline);
    });
  });
});

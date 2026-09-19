// Task 12.3 — the Emit_Script's named failures (config-driven-discovery spec).
//
// Feature: config-driven-discovery, Requirement 11 (11.7, 11.10).
//
// Two families of failure, all asserting the same shape: a non-zero exit, a
// message naming the offending input, and NO generated Dockerfile written (a
// file already at the path is left byte-identical — modelled here as "no file
// appears", since each case writes to a fresh temp path).
//
//   R11.7 — a `roots` member whose value cannot be read as a single-line
//   unescaped JSON string. One case per rejected value SHAPE, every case a
//   `roots` member:
//     * value not `"`-delimited (a number);
//     * value split across more than one line;
//     * value carrying a `\` escape sequence;
//     * value containing a character outside the Valid_Root_Path set;
//     * `roots` itself not an object.
//   No case supplies a rejected `scope` value: the Emit_Script does not read the
//   scope at all (R11.12), so a bad scope is not its failure to report.
//
//   R11.10 — the two Selector failure paths:
//     * the Selector resolves to every microservice while no filesystem entry
//       exists at the configured microservice Discovery_Root;
//     * the Selector resolves to zero identifiers.
//
// --- This suite NEVER touches the real working tree -------------------------
// Every `scaffold.config.json` and every relocated directory is written ONLY
// inside a `pristineWorktree()` copy. NO `scaffold.config.json` is written into
// the checked-out repository. The copy's directory is the spawn cwd and the
// Project_Directory. Teardown removes the copy. Follows the pattern of
// `dev-error-recovery.test.ts` / `dev-session-scope.test.ts`.
//
// Validates: Requirements 11.7, 11.10

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pristineWorktree, type PristineWorktreeResult } from "./helpers.js";

const EMIT_SCRIPT = "scripts/emit-effective-dockerfile.sh";
const PRISTINE_TIMEOUT_MS = 600_000;

let pristine: PristineWorktreeResult | undefined;
let outCounter = 0;

interface EmitResult {
  readonly status: number;
  readonly stderr: string;
  readonly wroteFile: boolean;
}

/**
 * Write `configText` as the copy's `scaffold.config.json` and run the emit
 * script with the copy as cwd, `MICROSERVICES=selector`, and output redirected
 * to a FRESH temp path inside the copy. Returns the exit status, stderr, and
 * whether any Dockerfile was written (a failing run must write none).
 */
function emitWithConfig(
  dir: string,
  configText: string | undefined,
  selector: string | undefined,
): EmitResult {
  if (configText === undefined) {
    // No config file: remove any left by a prior case. (Each case sets its own.)
    writeFileSync(resolve(dir, "scaffold.config.json"), "");
  } else {
    writeFileSync(resolve(dir, "scaffold.config.json"), configText);
  }

  outCounter += 1;
  const outPath = resolve(dir, `Dockerfile.failcase.${outCounter}`);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EFFECTIVE_DOCKERFILE: outPath,
  };
  delete env.MICROSERVICES;
  if (selector !== undefined) {
    env.MICROSERVICES = selector;
  }

  const run = spawnSync("sh", [EMIT_SCRIPT], { cwd: dir, env, encoding: "utf8" });
  return {
    status: run.status ?? -1,
    stderr: run.stderr ?? "",
    wroteFile: existsSync(outPath),
  };
}

beforeAll(() => {
  pristine = pristineWorktree();
  if (pristine.available !== true) {
    return;
  }
  // A relocated microservice root with one member, so a VALID config (used by
  // the Selector-failure cases that need a resolvable-or-not microservice root)
  // has something to point at. The R11.10 "absent microservice root" case points
  // the config at a path that does NOT exist instead.
  const svcDir = resolve(pristine.dir, "services", "only");
  mkdirSync(svcDir, { recursive: true });
  writeFileSync(
    resolve(svcDir, "package.json"),
    JSON.stringify({ name: "@microservices/only", private: true }) + "\n",
  );
}, PRISTINE_TIMEOUT_MS);

afterAll(() => {
  if (pristine?.available === true) {
    pristine.cleanup();
    pristine = undefined;
  }
});

function guardSkip(): string | undefined {
  if (pristine === undefined || pristine.available !== true) {
    return pristine?.reason ?? "pristine tree unavailable";
  }
  return undefined;
}

describe("emit-effective-dockerfile.sh rejects an unreadable roots member (R11.7)", () => {
  // Each case names the `roots` member the script could not read. The message
  // names the Project_Config_File and the key path.
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly config: string;
    readonly key: string;
  }> = [
    {
      label: "value is not a `\"`-delimited string (a number)",
      config: `{ "roots": { "microservice": 3 } }\n`,
      key: "roots.microservice",
    },
    {
      label: "value spans more than one line",
      config: `{\n  "roots": {\n    "common": "libs\nmore"\n  }\n}\n`,
      key: "roots.common",
    },
    {
      label: "value carries a `\\` escape sequence",
      config: `{ "roots": { "spa": "we\\u0062" } }\n`,
      key: "roots.spa",
    },
    {
      label: "value contains a character outside the Valid_Root_Path set (a `*`)",
      config: `{ "roots": { "microservice": "svc*" } }\n`,
      key: "roots.microservice",
    },
    {
      label: "`roots` itself is not an object (an array)",
      config: `{ "roots": [] }\n`,
      key: "roots",
    },
  ];

  it.each(cases)(
    "fails, names the key, and writes no Dockerfile when the $label",
    ({ config, key }) => {
      const reason = guardSkip();
      if (reason !== undefined) {
        console.warn(`SKIP emit-dockerfile-failures: ${reason}`);
        return;
      }
      const dir = (pristine as { dir: string }).dir;
      // A non-empty selector so selector resolution never masks the config
      // failure with a selector failure.
      const result = emitWithConfig(dir, config, "microservice1");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("scaffold.config.json");
      expect(result.stderr).toContain(`"${key}"`);
      expect(result.wroteFile).toBe(false);
    },
  );
});

describe("emit-effective-dockerfile.sh rejects unresolvable Selectors (R11.10)", () => {
  it("fails and writes no Dockerfile when `*` finds no configured microservice root", () => {
    const reason = guardSkip();
    if (reason !== undefined) {
      console.warn(`SKIP emit-dockerfile-failures: ${reason}`);
      return;
    }
    const dir = (pristine as { dir: string }).dir;
    // Point the microservice root at a path that does NOT exist in the copy, and
    // resolve `*` — which must list that root and therefore fail (R11.10).
    const result = emitWithConfig(
      dir,
      `{ "roots": { "microservice": "no-such-root" } }\n`,
      "*",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no-such-root");
    expect(result.wroteFile).toBe(false);
  });

  it("fails and writes no Dockerfile when the Selector resolves to zero identifiers", () => {
    const reason = guardSkip();
    if (reason !== undefined) {
      console.warn(`SKIP emit-dockerfile-failures: ${reason}`);
      return;
    }
    const dir = (pristine as { dir: string }).dir;
    // Point the microservice root at an EXISTING but EMPTY directory and resolve
    // `*`: the root lists cleanly (no absent-root failure) but yields zero
    // members, so the Selector resolves to zero identifiers (R11.10).
    const emptyRoot = resolve(dir, "empty-services");
    mkdirSync(emptyRoot, { recursive: true });
    const result = emitWithConfig(
      dir,
      `{ "roots": { "microservice": "empty-services" } }\n`,
      "*",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolved to no microservices");
    expect(result.wroteFile).toBe(false);
  });
});

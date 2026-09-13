// Feature: unified-build-order — the `[workspaces:order-source]` check (2.10, 2.15).
//
// `checkBuildOrderSource` is the fourth of `repo-invariants.ts`'s checks: it
// fails on the one thing that would silently revert this fix — a repository
// script that derives a build order from the Declared_Array_Sequence by
// invoking a build with `--workspaces`. After the fix the Build_Sequence is the
// sole Ordering_Mechanism, so `npm run build --workspaces` reappearing in any
// script value or any `scripts/*.js` source puts `npm start` (and any other
// path) back on the array (2.10). This check catches that reappearance (2.15).
//
// These are EXAMPLE tests over the exported pure function, kept in a focused
// file so the existing bin (`check-repo-invariants.test.ts`) and pure-function
// property (`repo-invariants.property.test.ts`) suites stay undisturbed. The
// function returns messages rather than throwing, so each case is a direct
// comparison of the returned list. The interesting surface is entirely one of
// examples: which invocation shapes match and which the narrow pattern must
// leave alone.
//
// Validates: Requirements 2.10, 2.15, 3.10

import { describe, expect, it } from "vitest";

import {
  checkBuildOrderSource,
  type ScriptSource,
} from "../src/repo-invariants.js";

const ORDER_SOURCE = "[workspaces:order-source]";

/** The message the check emits for a source named `source`. */
function message(source: string): string {
  return `${ORDER_SOURCE} "${source}" invokes a build with \`--workspaces\`; the build order comes from the Build_Sequence, so no script may derive it from the "workspaces" array`;
}

/** A `ScriptSource` naming a root package.json script. */
function script(name: string, text: string): ScriptSource {
  return { source: `root package.json script "${name}"`, text };
}

/** A `ScriptSource` naming a `scripts/*.js` file. */
function file(path: string, text: string): ScriptSource {
  return { source: path, text };
}

describe("checkBuildOrderSource reports a build traversing the workspaces array (2.10, 2.15)", () => {
  it("reports a root script whose shell string runs `npm run build --workspaces`", () => {
    const scripts = [script("build", "npm run build --workspaces")];

    expect(checkBuildOrderSource(scripts, [])).toEqual([
      message('root package.json script "build"'),
    ]);
  });

  it("reports a `scripts/*.js` source that spawns the build in the array/spawn form", () => {
    // The spawn form: an argv array like ["run", "build", "--workspaces"], as it
    // reads on disk in a `spawnSync("npm", [...])` call.
    const sources = [
      file(
        "scripts/start.js",
        [
          "import { spawnSync } from 'node:child_process';",
          'spawnSync("npm", ["run", "build", "--workspaces"], { stdio: "inherit" });',
          "",
        ].join("\n"),
      ),
    ];

    expect(checkBuildOrderSource([], sources)).toEqual([
      message("scripts/start.js"),
    ]);
  });

  it("reports the `--workspaces=<value>` traversal form too", () => {
    const scripts = [script("build", "npm run build --workspaces=packages/*")];

    expect(checkBuildOrderSource(scripts, [])).toEqual([
      message('root package.json script "build"'),
    ]);
  });

  it("names each offending source once and sorts the messages by source", () => {
    // Deliberately supplied out of source order to pin the reproducible sort.
    const scripts = [
      script("start", "npm run build --workspaces"),
      script("build", "npm run build --workspaces"),
    ];
    const sources = [
      file("scripts/start.js", 'spawnSync("npm", ["run", "build", "--workspaces"]);'),
    ];

    expect(checkBuildOrderSource(scripts, sources)).toEqual([
      message('root package.json script "build"'),
      message('root package.json script "start"'),
      message("scripts/start.js"),
    ]);
  });
});

describe("checkBuildOrderSource is silent on a clean repository (3.10)", () => {
  it("returns no message when no source invokes a build with `--workspaces`", () => {
    // The post-fix repository shape: `build` and `start` spawn the ordered bin
    // rather than traversing the array, and the `--workspaces` runs that remain
    // are non-build (test/lint/typecheck), covered in the narrowness suite.
    const scripts = [
      script("build", "node scripts/build.js"),
      script("start", "dotenvx run -- node scripts/start.js"),
    ];
    const sources = [
      file(
        "scripts/build.js",
        'spawnSync(process.execPath, ["packages/build-tools/dist/bin/build-workspaces.js"]);',
      ),
    ];

    expect(checkBuildOrderSource(scripts, sources)).toEqual([]);
  });

  it("returns no message for the empty inputs", () => {
    expect(checkBuildOrderSource([], [])).toEqual([]);
  });
});

describe("checkBuildOrderSource is narrow: only a build traversal matches (2.15)", () => {
  it("does not report `test`, `lint`, or `typecheck` runs with `--workspaces`", () => {
    // These are the legitimate `--workspaces` runs `npm run ci` uses; none is a
    // build, so none is an order source.
    const scripts = [
      script("test", "npm run test --workspaces"),
      script("lint", "npm run lint --workspaces"),
      script("typecheck", "npm run typecheck --workspaces"),
    ];

    expect(checkBuildOrderSource(scripts, [])).toEqual([]);
  });

  it("does not report when `--workspaces` belongs to a later command, not the build", () => {
    // `npm run build && npm run typecheck --workspaces`: the flag belongs to
    // typecheck, reached only across `&&` and a second `run`, so the build here
    // does NOT traverse the array.
    const scripts = [
      script("ci", "npm run build && npm run typecheck --workspaces"),
    ];

    expect(checkBuildOrderSource(scripts, [])).toEqual([]);
  });

  it("does not report the single-package `--workspace=<name>` flag", () => {
    const scripts = [script("build:one", "npm run build --workspace=@microservices/contracts")];

    expect(checkBuildOrderSource(scripts, [])).toEqual([]);
  });

  it("does not report a `--workspaces-foo` token that only starts with the flag", () => {
    const scripts = [script("build", "npm run build --workspaces-foo")];

    expect(checkBuildOrderSource(scripts, [])).toEqual([]);
  });
});

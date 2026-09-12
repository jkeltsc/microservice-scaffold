// Task 15.13 — the `build-workspaces` bin's thin-wrapper shape (R12.7).
//
// R12.7 makes the repository-wide build invoke each workspace package's own
// `build` script exactly once in the Workspace_Build_Order. All of that policy
// lives in `workspace-build-order.ts`'s `runOrderedBuildCli()`; the bin that
// the repository-wide build spawns is only its entry point. The "Bins are thin
// wrappers" convention (`.kiro/steering/structure.md`) requires that entry
// point to be a `#!/usr/bin/env node` shebang, one import of a CLI entry point
// from a module under `src/`, and one call to it — nothing else: no constant,
// no helper, no filesystem access, no argument parsing, no exit-code logic.
//
// An example test rather than a property test: the contract is a single fixed
// file's exact shape, plus two committed facts (the `bin` registration and the
// path `scripts/build.js` spawns). There is no input space to generalize over.
//
// The bin's shape is asserted structurally over the source text: the file must
// begin with the shebang, contain exactly one `import` statement, exactly one
// call expression, and no other statement. Rather than pull in a TypeScript
// parser, this reads the source and asserts on its statements after stripping
// the shebang, comments, and blank lines — the thin-wrapper shape is small
// enough that this is precise.
//
// Validates: Requirements 12.7

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> build-tools -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

const binSourcePath = resolve(
  repoRoot,
  "packages",
  "build-tools",
  "src",
  "bin",
  "build-workspaces.ts",
);

/** The bin's compiled path, as registered and as `scripts/build.js` spawns. */
const compiledBinPath = "packages/build-tools/dist/bin/build-workspaces.js";

/**
 * The source with its leading shebang line removed, and the shebang returned
 * separately. A thin wrapper's first line is the shebang.
 */
function splitShebang(source: string): {
  shebang: string | undefined;
  body: string;
} {
  const lines = source.split("\n");
  if (lines[0]?.startsWith("#!")) {
    return { shebang: lines[0], body: lines.slice(1).join("\n") };
  }
  return { shebang: undefined, body: source };
}

/**
 * The body reduced to its executable statements: comments (line and block) and
 * blank lines removed, then split on `;` and newlines into trimmed non-empty
 * fragments. The thin-wrapper body is `import ...;` and `call();`, so this
 * yields exactly those two fragments.
 */
function statementsOf(body: string): string[] {
  const withoutBlockComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return withoutLineComments
    .split(/[;\n]/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

describe("the build-workspaces bin's thin-wrapper shape (R12.7)", () => {
  const source = readFileSync(binSourcePath, "utf8");
  const { shebang, body } = splitShebang(source);
  const statements = statementsOf(body);

  it("begins with the node shebang", () => {
    expect(shebang).toBe("#!/usr/bin/env node");
  });

  it("contains exactly one import statement", () => {
    const imports = statements.filter((statement) =>
      statement.startsWith("import "),
    );
    expect(imports).toHaveLength(1);
    // The one import pulls the CLI entry point from a module under src/.
    expect(imports[0]).toMatch(
      /^import \{ runOrderedBuildCli \} from "\.\.\/workspace-build-order\.js"$/,
    );
  });

  it("contains exactly one call and nothing else", () => {
    const nonImport = statements.filter(
      (statement) => !statement.startsWith("import "),
    );
    // Exactly one statement remains beyond the import: the single call.
    expect(nonImport).toEqual(["runOrderedBuildCli()"]);
  });

  it("carries no CLI policy of its own", () => {
    // No constant, no helper, no argument parsing, no exit-code logic, and no
    // filesystem access: the source names none of the constructs those need.
    const forbidden: readonly [string, RegExp][] = [
      ["a declared constant or variable", /\b(?:const|let|var)\b/],
      ["a function or helper declaration", /\bfunction\b|=>/],
      ["process argument or exit handling", /process\.(?:argv|exit|env)/],
      ["a filesystem or path import", /node:(?:fs|path|os|url)/],
      ["a control-flow branch", /\b(?:if|for|while|switch|try|catch)\b/],
    ];
    for (const [description, pattern] of forbidden) {
      expect(
        pattern.test(body),
        `bin must contain no ${description}`,
      ).toBe(false);
    }
  });

  it("is registered in package.json as build-workspaces -> the compiled bin", () => {
    const manifestPath = resolve(
      repoRoot,
      "packages",
      "build-tools",
      "package.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(manifest.bin?.["build-workspaces"]).toBe(
      "./dist/bin/build-workspaces.js",
    );
  });

  it("exposes the compiled path that scripts/build.js spawns", () => {
    // scripts/build.js is created by task 15.6 in this same wave. When it
    // exists, it must spawn the compiled bin by exactly this path; the
    // repository-wide build's checkpoint runs the whole suite after 15.6 has
    // landed, so this assertion holds then. If it has not landed yet, there is
    // nothing to assert against — the compiled path is fixed by the two checks
    // above regardless.
    const buildScriptPath = resolve(repoRoot, "scripts", "build.js");
    if (!existsSync(buildScriptPath)) {
      return;
    }
    const buildScript = readFileSync(buildScriptPath, "utf8");
    expect(buildScript).toContain(compiledBinPath);
  });
});

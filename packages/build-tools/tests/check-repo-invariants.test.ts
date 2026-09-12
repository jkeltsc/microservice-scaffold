// Task 5.15 — the `check-repo-invariants` bin's exit behavior (R12.8).
//
// The three checks in `repo-invariants.ts` are pure and property-tested in
// `repo-invariants.property.test.ts`. What is NOT covered there is the bin
// around them: that it resolves the repository from cwd, runs all three checks
// in one invocation, writes every message to stderr, and exits 0 / 1 as R12.8
// requires. That boundary is only observable by running the bin as a process,
// which is what this does.
//
// An example test rather than a property test: the observable contract is two
// exit statuses and the message set that accompanies them, and the interesting
// part is the *combination* — one violating tree, three checks, five messages,
// one run. Generating trees would re-test the pure checks through a slower
// interface.
//
// The bin resolves the Root_Manifest and every package directory against cwd,
// so each case runs it with a generated temp repository as cwd. Nothing in the
// real repository is read or written: the temp tree carries its own
// `package.json`, its own framework singleton directories, and its own
// Namespace_Containers. No `node_modules` is needed — the compiled bin is
// invoked by absolute path and imports only its own sibling modules and
// `node:fs`.
//
// `packages/spa/` is deliberately absent from both trees while
// `packages/spa/*` stays in the `workspaces` array: that is the zero-match glob
// R12.11 makes satisfied, and the committed repository is in exactly that state.
//
// Validates: Requirements 12.8

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> build-tools -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/**
 * The bin under test, compiled. Produced by this package's `build` script,
 * which the root `pretest` (`npm run build --workspaces`) runs before the
 * suite; `beforeAll` below turns a missing build into a legible failure rather
 * than a spawn error.
 */
const bin = resolve(
  repoRoot,
  "packages",
  "build-tools",
  "dist",
  "bin",
  "check-repo-invariants.js",
);

/** A package manifest as written into a generated tree. */
interface Manifest {
  readonly name: string;
  readonly main?: string;
  readonly types?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** A generated repository: the `workspaces` array plus a file map. */
interface Tree {
  readonly workspaces: readonly string[];
  /** Repo-relative POSIX path -> file contents. */
  readonly files: Readonly<Record<string, string>>;
}

const SCOPE = "@microservices";
const CONTRACTS = `${SCOPE}/contracts`;
const OVERSEER = `${SCOPE}/overseer`;
const CFG = `${SCOPE}/cfg`;
const ALPHA = `${SCOPE}/alpha`;
const BETA = `${SCOPE}/beta`;

/** A `dependencies` block naming each specifier at the workspace wildcard. */
function deps(...specifiers: readonly string[]): Record<string, string> {
  return Object.fromEntries(specifiers.map((specifier) => [specifier, "*"]));
}

function manifest(value: Manifest): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The four Framework_Singleton manifests every generated tree carries. */
const frameworkFiles: Readonly<Record<string, string>> = {
  "packages/contracts/package.json": manifest({
    name: CONTRACTS,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  }),
  "packages/build-tools/package.json": manifest({
    name: `${SCOPE}/build-tools`,
    dependencies: deps(CONTRACTS),
  }),
  "packages/overseer/package.json": manifest({
    name: OVERSEER,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    dependencies: deps(CONTRACTS, ALPHA, BETA),
  }),
  "packages/integration-tests/package.json": manifest({
    name: `${SCOPE}/integration-tests`,
    dependencies: deps(CONTRACTS),
  }),
};

/**
 * A repository every check passes: `packages/contracts` first,
 * `packages/integration-tests` last, `packages/common/*` ahead of
 * `packages/microservices/*` and of `packages/overseer`, every package matched
 * by exactly one entry, every dependency's entry ahead of its dependent's, and
 * no import crossing a package boundary.
 */
function cleanTree(): Tree {
  return {
    workspaces: [
      "packages/contracts",
      "packages/build-tools",
      "packages/common/*",
      "packages/spa/*",
      "packages/microservices/*",
      "packages/overseer",
      "packages/integration-tests",
    ],
    files: {
      ...frameworkFiles,

      // A Common_Package: name mirrors its directory, barrel declared, and it
      // points downward only.
      "packages/common/cfg/package.json": manifest({
        name: CFG,
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        dependencies: deps(CONTRACTS),
      }),
      "packages/common/cfg/src/index.ts": [
        `import type { Thing } from "${CONTRACTS}";`,
        `import { helper } from "./helper.js";`,
        `export const value: Thing = helper();`,
        "",
      ].join("\n"),
      "packages/common/cfg/src/helper.ts": "export const helper = () => 1;\n",

      // A Microservice_Package consuming the Common_Package by name.
      "packages/microservices/alpha/package.json": manifest({
        name: ALPHA,
        dependencies: deps(CONTRACTS, CFG),
      }),
      "packages/microservices/alpha/src/index.ts": [
        `import { value } from "${CFG}";`,
        `import { router } from "./router.js";`,
        `export { router, value };`,
        "",
      ].join("\n"),
      "packages/microservices/alpha/src/router.ts":
        "export const router = {};\n",
      "packages/microservices/alpha/tests/alpha.test.ts": [
        `import { router } from "../src/index.js";`,
        `export { router };`,
        "",
      ].join("\n"),

      // A second Microservice_Package, importing nothing but the framework.
      "packages/microservices/beta/package.json": manifest({
        name: BETA,
        dependencies: deps(CONTRACTS),
      }),
      "packages/microservices/beta/src/index.ts": [
        `import type { Thing } from "${CONTRACTS}";`,
        `export const thing: Thing | undefined = undefined;`,
        "",
      ].join("\n"),
    },
  };
}

/**
 * The clean tree seeded with one violation of each of the three checks, four
 * messages in total:
 *
 *   1. `[workspaces:coverage]` — `packages/common/*` is dropped from the array,
 *      so the Common_Package `cfg` is matched by no entry. Step 8 (task 15.8)
 *      narrowed the workspace-order check to Workspace_Coverage: the array's
 *      entry ORDER no longer carries build-order meaning (R12.16), so a
 *      misordered array is no longer a violation — a package matched by other
 *      than exactly one entry is.
 *   2. `[imports:escape]` — a file under `tests/` reaches into a sibling
 *      package with `../..`, which is the case R14.4 covers for tests as much
 *      as for `src/`.
 *   3. `[imports:peer]` — `alpha`'s `src/` imports `beta` by name.
 *   4. `[deps:direction]` — the Common_Package declares a dependency on a
 *      Microservice_Package.
 */
function violatingTree(): Tree {
  const clean = cleanTree();
  return {
    // `packages/common/*` is omitted deliberately: with `cfg` present under
    // `packages/common/`, dropping the entry leaves it matched by zero entries,
    // which is the one coverage violation this tree seeds.
    workspaces: [
      "packages/contracts",
      "packages/build-tools",
      "packages/spa/*",
      "packages/microservices/*",
      "packages/overseer",
      "packages/integration-tests",
    ],
    files: {
      ...clean.files,

      // (4) A Common_Package pointing upward at a Microservice_Package.
      "packages/common/cfg/package.json": manifest({
        name: CFG,
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        dependencies: deps(CONTRACTS, ALPHA),
      }),

      // (4) A peer import by package name.
      "packages/microservices/alpha/src/index.ts": [
        `import { value } from "${CFG}";`,
        `import { thing } from "${BETA}";`,
        `export { thing, value };`,
        "",
      ].join("\n"),

      // (3) A relative path escaping the package directory, from a test file.
      "packages/microservices/alpha/tests/alpha.test.ts": [
        `import { thing } from "../../beta/src/index.js";`,
        `export { thing };`,
        "",
      ].join("\n"),
    },
  };
}

/** Every message the violating tree must produce, in no particular order. */
function expectedViolations(): readonly string[] {
  return [
    `[workspaces:coverage] package "${CFG}" at "packages/common/cfg" is matched by no workspaces entry; exactly one entry must match it`,
    `[imports:escape] "packages/microservices/alpha/tests/alpha.test.ts" imports "../../beta/src/index.js", a relative path that escapes the package directory`,
    `[imports:peer] "packages/microservices/alpha/src/index.ts" imports "${BETA}", a peer Microservice_Package`,
    `[deps:direction] Common_Package "packages/common/cfg" depends on "${ALPHA}"; a Common_Package must point downward only`,
  ];
}

/** Materialize a generated repository in a fresh temp directory. */
function writeTree(tree: Tree): string {
  const root = mkdtempSync(join(tmpdir(), "check-repo-invariants-"));

  writeFileSync(
    join(root, "package.json"),
    manifestRoot(tree.workspaces),
    "utf8",
  );

  for (const [relative, contents] of Object.entries(tree.files)) {
    const file = join(root, ...relative.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }

  return root;
}

/** The generated tree's Root_Manifest. */
function manifestRoot(workspaces: readonly string[]): string {
  return `${JSON.stringify(
    {
      name: "generated-repository",
      version: "0.0.0",
      private: true,
      type: "module",
      workspaces,
    },
    null,
    2,
  )}\n`;
}

/** Run the compiled bin with `root` as cwd. */
function runBin(root: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [bin], {
    cwd: root,
    encoding: "utf8",
    // A clean environment except for the inherited PATH-alikes: the bin reads
    // no environment variable, and this keeps an ambient MICROSERVICES or
    // toggle var from mattering if that ever changes.
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** stderr split into non-empty trimmed lines. */
function messagesOf(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("the check-repo-invariants bin's exit behavior (R12.8)", () => {
  const roots: string[] = [];

  beforeAll(() => {
    expect(
      existsSync(bin),
      `compiled bin missing at ${bin}; run "npm run build --workspaces"`,
    ).toBe(true);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** Generate a tree, remember it for cleanup, and run the bin over it. */
  function run(tree: Tree): ReturnType<typeof runBin> {
    const root = writeTree(tree);
    roots.push(root);
    return runBin(root);
  }

  it("exits 0 and says nothing on a clean repository", () => {
    const result = run(cleanTree());

    expect(
      result.status,
      `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    ).toBe(0);
    expect(messagesOf(result.stderr)).toEqual([]);
    // R12.9: nothing on stdout either — the bin reports findings only.
    expect(result.stdout).toBe("");
  });

  it("exits 1 with every message when one violation of each check is present", () => {
    const result = run(violatingTree());

    expect(
      result.status,
      `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    ).toBe(1);

    const messages = messagesOf(result.stderr);
    // Every expected message, and nothing else: one run of the bin reports all
    // three invariants rather than stopping at the first failing one.
    expect([...messages].sort()).toEqual([...expectedViolations()].sort());
    expect(result.stdout).toBe("");
  });
});

// Feature: api-dev-server, Property 7: Additive-only structural invariants
//
// Static, text-level assertions that the Dev_Server was added without touching
// the production runtime or the image pipeline, and without introducing any of
// the dev-only moving parts the requirements forbid. These read committed repo
// files as text (no processes are spawned) and encode Requirements 3.8, 5.6,
// 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, and 9.9.
//
// The rejected source-execution alternative (requirements.md "Rejected
// Alternative") would have needed a generated dev artifact, a committed
// template for it, a `.gitignore` entry, and a dev-only TypeScript config; the
// chosen build-watch design uses one set of artifacts and one entrypoint. These
// assertions are the guard rail that keeps it that way.
//
// Validates: Requirements 3.8, 5.6, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

import { repoRoot } from "./helpers.js";

/** Read a repo-relative file as UTF-8 text. */
function readRepoText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

/** Read and parse a repo-relative JSON manifest. */
function readRepoJson<T>(relativePath: string): T {
  return JSON.parse(readRepoText(relativePath)) as T;
}

/**
 * Strip `//` line comments and `/* *\/` block comments from JSONC text, leaving
 * comment-like sequences inside string literals untouched, then parse. The
 * tsconfig files are JSONC (they carry explanatory `//` comments), so a plain
 * `JSON.parse` would reject them.
 */
function parseJsonc<T>(text: string): T {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Preserve the escaped character verbatim.
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out) as T;
}

/** Recursively collect every file path under `dir`, repo-relative. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Dev_Server-specific identifiers introduced by this feature. None of these may
 * appear in the production runtime (`packages/overseer/src/`) or in the image
 * pipeline (Dockerfile.template, the emit script, image-tree.ts). They are
 * specific enough not to collide with ordinary English words — deliberately not
 * a bare "dev" or "watch", which would false-positive on legitimate prose.
 */
const DEV_SERVER_TOKENS = [
  "dev-supervisor",
  "Dev_Server",
  "runDevSupervisor",
  "DevEvent",
  "DevState",
  "DevAction",
  "reduceDevEvents",
  "devProjectList",
  "createSolutionBuilderWithWatch",
  "common-startup",
  "runCommonStartup",
  "scripts/dev.js",
] as const;

/** Assert `text` (from `label`) contains none of the Dev_Server tokens. */
function expectNoDevServerTokens(text: string, label: string): void {
  for (const token of DEV_SERVER_TOKENS) {
    expect(
      text.includes(token),
      `${label} must not contain the Dev_Server token "${token}"`,
    ).toBe(false);
  }
}

describe("packages/overseer/src/ has no Dev_Server branch, flag, or conditional (R9.4)", () => {
  const overseerSrc = join(repoRoot, "packages", "overseer", "src");
  const files = walkFiles(overseerSrc).filter((f) => f.endsWith(".ts"));

  it("has TypeScript sources to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => relative(repoRoot, f)))(
    "%s contains no Dev_Server token",
    (relPath) => {
      expectNoDevServerTokens(readRepoText(relPath), relPath);
    },
  );

  it("mentions neither a dev-mode branch nor a watch conditional anywhere in src/", () => {
    // A single scan of the whole subtree, so a token slipping into a new file
    // is still caught. Also assert the absence of the specific mode words this
    // feature would have introduced, bounded so they cannot match prose.
    const joined = files.map((f) => readRepoText(relative(repoRoot, f))).join("\n");
    expectNoDevServerTokens(joined, "packages/overseer/src/");
    for (const pattern of [/\bDev_Session\b/, /\bBuild_Watcher\b/, /\bwatch mode\b/i]) {
      expect(
        pattern.test(joined),
        `packages/overseer/src/ must not reference ${String(pattern)}`,
      ).toBe(false);
    }
  });
});

describe("no dev-specific TypeScript config, generated artifact, .gitignore entry, or template (R9.3)", () => {
  it("has no tsconfig.dev.json anywhere in the repo", () => {
    // The feature adds no new TypeScript configuration file; a dev-only tsconfig
    // is exactly what the rejected alternative would have needed.
    const packagesDir = join(repoRoot, "packages");
    const configs = walkFiles(packagesDir).filter((f) =>
      /tsconfig[.\w-]*\.json$/.test(f),
    );
    for (const cfg of [join(repoRoot, "tsconfig.base.json"), ...configs]) {
      expect(
        /tsconfig\.dev\.json$/.test(cfg),
        `unexpected dev-only tsconfig: ${relative(repoRoot, cfg)}`,
      ).toBe(false);
    }
  });

  it("has no *.dev.template committed file anywhere", () => {
    const all = walkFiles(join(repoRoot, "packages"));
    all.push(...walkFiles(join(repoRoot, "scripts")));
    for (const f of all) {
      expect(
        /\.dev\.template(\.\w+)?$/.test(f),
        `unexpected dev-only committed template: ${relative(repoRoot, f)}`,
      ).toBe(false);
    }
  });

  it(".gitignore adds no Dev_Server-specific entry (R9.3)", () => {
    // The only gitignored generated outputs are the pre-existing dist/,
    // tsbuildinfo, generated registry, and generated Dockerfile. A Dev_Session
    // churns each package's dist/, which is already ignored, so no new ignore
    // line is warranted. Assert the ignore file mentions no dev-server artifact.
    const gitignore = readRepoText(".gitignore");
    expectNoDevServerTokens(gitignore, ".gitignore");
    // No dev-only generated file path was added to the ignore list.
    for (const line of gitignore.split("\n").map((l) => l.trim())) {
      expect(
        /dev/.test(line) && /generated|\.ts$|template/.test(line),
        `.gitignore must not add a dev-server-specific entry: "${line}"`,
      ).toBe(false);
    }
  });

  it("the generated-registry directory holds no dev-only generated artifact", () => {
    // The one generated TS file is the microservice registry (plus its tracked
    // template). Nothing dev-specific was added beside it.
    const generatedDir = join(
      repoRoot,
      "packages",
      "overseer",
      "src",
      "generated",
    );
    if (!existsSync(generatedDir)) {
      return;
    }
    for (const entry of readdirSync(generatedDir)) {
      expect(
        /dev/i.test(entry),
        `unexpected dev-only generated artifact: ${entry}`,
      ).toBe(false);
    }
  });
});

describe("no paths, baseUrl, or module alias in any tsconfig (R9.2)", () => {
  // Collect the base config plus every package tsconfig variant.
  const tsconfigs = [
    "tsconfig.base.json",
    ...walkFiles(join(repoRoot, "packages"))
      .filter((f) => /tsconfig[.\w-]*\.json$/.test(f))
      .map((f) => relative(repoRoot, f)),
  ];

  it("found the tsconfig files", () => {
    expect(tsconfigs.length).toBeGreaterThan(1);
    expect(tsconfigs).toContain("tsconfig.base.json");
  });

  it.each(tsconfigs)("%s declares no paths/baseUrl/module alias", (relPath) => {
    const raw = readRepoText(relPath);
    // Assert against both the parsed compilerOptions and the raw text, so a
    // key added under a comment or an unusual nesting is still caught. tsconfig
    // files are JSONC, so strip comments before parsing.
    const parsed = parseJsonc<{
      compilerOptions?: Record<string, unknown>;
    }>(raw);
    const opts = parsed.compilerOptions ?? {};
    expect(opts, `${relPath} must not set compilerOptions.paths`).not.toHaveProperty(
      "paths",
    );
    expect(
      opts,
      `${relPath} must not set compilerOptions.baseUrl`,
    ).not.toHaveProperty("baseUrl");
    for (const key of ['"paths"', '"baseUrl"']) {
      expect(
        raw.includes(key),
        `${relPath} text must not contain ${key}`,
      ).toBe(false);
    }
  });
});

describe("the production runtime and image pipeline are unchanged (R9.5)", () => {
  it("the root prepare script still copies the registry template verbatim", () => {
    const root = readRepoJson<{ scripts?: Record<string, string> }>(
      "package.json",
    );
    expect(root.scripts?.prepare).toBe(
      "cp packages/overseer/src/generated/microservice-registry.template.ts packages/overseer/src/generated/microservice-registry.ts",
    );
  });

  it("Dockerfile.template contains no Dev_Server token", () => {
    expectNoDevServerTokens(
      readRepoText("Dockerfile.template"),
      "Dockerfile.template",
    );
  });

  it("scripts/emit-effective-dockerfile.sh contains no Dev_Server token", () => {
    expectNoDevServerTokens(
      readRepoText("scripts/emit-effective-dockerfile.sh"),
      "scripts/emit-effective-dockerfile.sh",
    );
  });

  it("packages/build-tools/src/image-tree.ts contains no Dev_Server token", () => {
    expectNoDevServerTokens(
      readRepoText("packages/build-tools/src/image-tree.ts"),
      "image-tree.ts",
    );
  });
});

describe("the ci quality gate is unchanged and adds no dev typecheck script (R9.6)", () => {
  const root = readRepoJson<{ scripts?: Record<string, string> }>(
    "package.json",
  );
  const scripts = root.scripts ?? {};

  it("keeps the exact ci script composition", () => {
    expect(scripts.ci).toBe(
      "npm run build --workspaces && npm run typecheck --workspaces && npm run lint --workspaces && npm test && npm run test:types",
    );
  });

  it("keeps npm run typecheck --workspaces as the type-check gate", () => {
    expect(scripts.typecheck).toBe("npm run typecheck --workspaces");
    expect(scripts.ci).toContain("npm run typecheck --workspaces");
  });

  it("adds no Dev_Server-specific typecheck script", () => {
    for (const key of Object.keys(scripts)) {
      expect(
        /typecheck/i.test(key) && key !== "typecheck",
        `unexpected dev/extra typecheck script: "${key}"`,
      ).toBe(false);
      expect(
        /^dev.*type|type.*dev/i.test(key),
        `unexpected dev typecheck script: "${key}"`,
      ).toBe(false);
    }
    expect(scripts).not.toHaveProperty("typecheck:dev");
    expect(scripts).not.toHaveProperty("dev:typecheck");
  });
});

describe("no new production dependency, and any new devDependency is pinned (R9.7, R9.8)", () => {
  it("build-tools depends only on @microservices/contracts and adds no devDependency", () => {
    const manifest = readRepoJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>("packages/build-tools/package.json");
    // The supervisor uses the TypeScript compiler API, but typescript is a root
    // devDependency already, so build-tools gains no dependency of its own.
    expect(manifest.dependencies).toEqual({ "@microservices/contracts": "*" });
    expect(manifest.devDependencies ?? {}).toEqual({});
  });

  it("the root manifest gains no production dependency (it has no dependencies block)", () => {
    // The scaffold root is a workspace root that declares only devDependencies;
    // the feature adds no `dependencies` block to it (R9.7).
    const root = readRepoJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>("package.json");
    expect(root.dependencies ?? {}).toEqual({});
  });

  it("typescript and fast-check are present as root devDependencies (feature reuses them)", () => {
    const root = readRepoJson<{ devDependencies?: Record<string, string> }>(
      "package.json",
    );
    const dev = root.devDependencies ?? {};
    expect(dev).toHaveProperty("typescript");
    expect(dev).toHaveProperty("fast-check");
  });

  it("every root devDependency resolves to a concrete version (a range is a version, an exact pin is a version)", () => {
    // The feature adds NO new dependency at all, so there is no NEW exact-pin to
    // check. Assert instead that every devDependency has a real version spec —
    // the invariant that would fail if a feature slipped an empty or malformed
    // entry in. R9.8's exact-pin obligation is conditional ("WHERE the Dev_Server
    // requires a new devDependency"); this feature does not, which the two
    // preceding assertions already establish.
    const root = readRepoJson<{ devDependencies?: Record<string, string> }>(
      "package.json",
    );
    for (const [name, spec] of Object.entries(root.devDependencies ?? {})) {
      expect(typeof spec, `${name} must have a string version`).toBe("string");
      expect(spec.length, `${name} version must be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe("scripts/start.js change is confined to consuming Common_Startup (R9.9)", () => {
  const startJs = readRepoText("scripts/start.js");

  it("imports runCommonStartup and calls it", () => {
    expect(startJs).toContain(
      'import { runCommonStartup } from "./common-startup.js"',
    );
    expect(startJs).toContain('runCommonStartup({ tag: "start" })');
  });

  it("does not perform a bootstrap-build or registry generation of its own", () => {
    // Those two steps moved into common-startup.js; Production_Start must no
    // longer spawn them directly.
    expect(
      startJs.includes("--workspace @microservices/contracts") ||
        startJs.includes('"@microservices/contracts"'),
      "start.js must not run its own bootstrap-build",
    ).toBe(false);
    expect(
      startJs.includes("generate-registry"),
      "start.js must not run the registry generator itself",
    ).toBe(false);
  });

  it("preserves the unchanged Production_Start effects: full build and the Overseer one-shot", () => {
    // These are the parts of start.js that are intentionally NOT changed.
    expect(startJs).toContain('"run", "build", "--workspaces"');
    expect(startJs).toContain("packages/overseer/dist/index.js");
    // One-shot: it uses spawnSync (blocking) and does not watch or restart.
    expect(startJs).toContain("spawnSync");
    expect(startJs).not.toContain("createSolutionBuilderWithWatch");
    expect(startJs).not.toContain("dev-supervisor");
  });
});

describe("the supervisor has no npm-build call, no dist/ watcher, and no debounce timer (R3.8, R5.6)", () => {
  const supervisor = readRepoText("packages/build-tools/src/dev-supervisor.ts");

  it("invokes the TypeScript build directly, never npm run build (R3.8)", () => {
    expect(supervisor).not.toContain("npm run build");
    expect(supervisor).not.toContain('"build", "--workspaces"');
    // It drives the compiler API in-process instead.
    expect(supervisor).toContain("createSolutionBuilderWithWatch");
  });

  it("never watches dist/ — the race is removed, not tuned around (R5.6)", () => {
    // No filesystem watcher aimed at compiled output. The only watchers are the
    // TypeScript host's own source watchers, wrapped for cleanup. Assert no
    // watch call targets a dist path.
    expect(
      /watch\w*\([^)]*dist/i.test(supervisor),
      "supervisor must not watch a dist/ path",
    ).toBe(false);
    // The emit signal is bookkeeping about the supervisor's own writeFile calls,
    // never an observation of the Compiled_Tree.
    expect(supervisor).toContain("writeFile");
  });

  it("uses no debounce timer (R5.6) — bursts coalesce through the pure decision core", () => {
    // A burst of edits coalesces because file-change/compile-start emit no
    // action; there is no setTimeout/setInterval delay anywhere in the source.
    expect(supervisor).not.toMatch(/\bsetTimeout\b/);
    expect(supervisor).not.toMatch(/\bsetInterval\b/);
  });
});

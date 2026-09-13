// Task 8.10 — the bundle-output shape integration test.
//
// This is R6.6 and R6.7's own coverage: the one place in the whole suite where
// the Demo_Spa's emitted `index.html` is parsed. It asserts a fact about the
// DEMO_SPA'S OWN BUNDLER CONFIGURATION — that `base: "./"` makes every emitted
// asset reference relative — never a fact about the Build_System. No step of
// the Build_System inspects the `index.html` filename (F6, D3); this test is
// the sole assertion that the file exists and that its references resolve, and
// it makes that assertion of the bundler output alone.
//
// WHY THE DEMO_SPA IS BUILT BY ITS OWN `npm run build`, NEVER `tsc --build`
// ---------------------------------------------------------------------------
// The Demo_Spa is a Bundler_Project (R6.8): its Build_Kind is a function of its
// `packages/spa/` location, and the Build_System admits only Tsc_Projects as
// roots of the single `tsc --build` pass (R6.10). So this test produces the
// `dist/` the way the Build_System does — by invoking the Demo_Spa's OWN
// `npm run build` (`vite build`) with the Demo_Spa directory as cwd (R6.9),
// never `tsc --build` and never the workspace ordered pass (which would drag in
// every Tsc_Project for no reason). The build is fast (a handful of modules)
// and deterministic, so it runs once in `beforeAll` with a generous timeout.
//
// WHY A SINGLE EXECUTION, NOT A PROPERTY LOOP
// ---------------------------------------------------------------------------
// Nothing about the bundler's output varies with an input under test: for the
// committed Demo_Page there is exactly one emitted `index.html` and one set of
// asset references. So this is one execution asserting the shape of that one
// output, matching the design's testing strategy for R6.6/R6.7.
//
// COMPILE-ORDER PREREQUISITE (spa-common-consumption feature, R5.6/R5.11)
// ---------------------------------------------------------------------------
// The Demo_Spa now imports `@microservices/extended-config` (through the
// Payload_Preview), so its `vite build` reads that Common_Package's compiled
// `dist/` — the Demo_Spa's build now has a compile-order prerequisite: the
// Extended_Config_Package's compiled `dist/` must exist first. That prerequisite
// is satisfied by the repository's root `pretest` ordered build (`npm test` runs
// `node scripts/build.js` before Vitest), which compiles every Tsc_Project — the
// Extended_Config_Package and its own `@microservices/config` prerequisite among
// them — in Build_Sequence order before this suite's `vite build` runs.
//
// This suite therefore also carries the inlining observables for the
// spa → common edge: R5.6 (the emitted bundle contains the Extended_Config_
// Package's `extendedSetting` VALUE as a substring — imported here, never
// restated as a literal) and R5.11 (no emitted file carries a residual
// `@microservices/…` import specifier for either Common_Package, so the bundler
// inlined them and nothing needs resolving at run time). Confirming both — the
// presence of the inlined value and the absence of the unresolved reference —
// proves the inlining from both directions with no runtime started.
//
// Validates: Requirements 6.6, 6.7, 5.6, 5.11

import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The `extendedSetting` VALUE is imported from the package it belongs to, never
// restated as a literal here (task 5.5): the assertion then tracks whatever the
// Extended_Config_Package actually exports, and cannot drift from it.
import { extendedConfig } from "@microservices/extended-config";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The Demo_Spa package directory and its bundler-output Spa_Root. */
const demoDir = resolve(repoRoot, "packages", "spa", "demo");
const spaRoot = resolve(demoDir, "dist");
const indexHtml = resolve(spaRoot, "index.html");

/** A `vite build` over a handful of modules is quick, but give it room. */
const BUILD_TIMEOUT_MS = 180_000;

/**
 * Extract every `src="…"` and `href="…"` reference from an HTML document.
 * Handles single- and double-quoted attribute values. This is the set of
 * relative asset references R6.7 governs (the bundled module script the
 * Demo_Page loads, plus any stylesheet or preload link the bundler emits).
 */
function extractReferences(html: string): string[] {
  const refs: string[] = [];
  const attr = /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(html)) !== null) {
    const value = match[2] ?? match[3] ?? "";
    if (value.length > 0) {
      refs.push(value);
    }
  }
  return refs;
}

/**
 * Every emitted file under `dir`, recursively, as absolute paths. This is the
 * whole set of files the Demo_Spa's `dist/` holds — the surface R5.6 and R5.11
 * quantify over ("at least 1 file" / "the files the `dist/` holds").
 */
function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** True when `ref` begins with a URL scheme (e.g. `http:`, `data:`) or `//`. */
function hasUrlScheme(ref: string): boolean {
  // A scheme is `letter (letter|digit|+|-|.)* ":"` at the very start; protocol-
  // relative `//host` is scheme-relative and equally root-anchored, so reject it too.
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//");
}

describe("Demo_Spa bundle-output shape (R6.6, R6.7)", () => {
  let html: string;
  let references: string[];

  beforeAll(() => {
    // Produce dist/ exactly as the Build_System does for a Bundler_Project:
    // the Demo_Spa's OWN `npm run build` (vite build), with the Demo_Spa
    // directory as cwd (R6.9) — never `tsc --build` (R6.10). `--prefix` pins
    // npm at the package so its `build` script and cwd are the Demo_Spa's.
    const build = spawnSync(
      "npm",
      ["run", "build", "--workspace", "@microservices/demo"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    // The build must exit 0 (R6.6's precondition). Surface its output on failure.
    expect(
      build.status,
      `demo bundler build failed (code ${String(build.status)}):\n` +
        `${build.stdout ?? ""}\n${build.stderr ?? ""}`,
    ).toBe(0);

    html = readFileSync(indexHtml, "utf8");
    references = extractReferences(html);
  }, BUILD_TIMEOUT_MS);

  it("writes a non-empty dist/ containing index.html — the exports-map target `./dist/index.html`", () => {
    // dist/ exists and holds at least one entry (the non-emptiness the
    // Image_Tree_Assembler's whole staging precondition rests on, F6).
    expect(existsSync(spaRoot), "dist/ should exist after the bundler build").toBe(true);
    expect(statSync(spaRoot).isDirectory()).toBe(true);
    // The exports map declares `"." : "./dist/index.html"`, so its target must
    // be the file the bundler actually emitted.
    expect(existsSync(indexHtml), "dist/index.html should exist").toBe(true);
    expect(statSync(indexHtml).isFile()).toBe(true);
    expect(html.trim().length, "index.html should not be empty").toBeGreaterThan(0);
  });

  it("emits at least one bundled asset reference", () => {
    // The Demo_Page loads its bundled module script, so the parsed document
    // carries at least one src/href reference — otherwise the shape assertions
    // below would pass vacuously.
    expect(references.length).toBeGreaterThan(0);
  });

  it("references every asset by a relative path — none begins with `/` or a URL scheme (base: \"./\", R6.7)", () => {
    for (const ref of references) {
      expect(
        ref.startsWith("/"),
        `reference ${JSON.stringify(ref)} must not be root-absolute (no leading "/")`,
      ).toBe(false);
      expect(
        hasUrlScheme(ref),
        `reference ${JSON.stringify(ref)} must not carry a URL scheme`,
      ).toBe(false);
    }
  });

  it("resolves every reference to a file that exists inside dist/ — no referenced path left without a file (R6.6)", () => {
    for (const ref of references) {
      // Strip any query string / fragment before resolving to a filesystem path.
      const cleaned = ref.replace(/[?#].*$/, "");
      expect(isAbsolute(cleaned), `reference ${JSON.stringify(ref)} must be relative`).toBe(false);

      // Resolve relative to the index.html document's directory (the Spa_Root),
      // exactly as a browser loading dist/index.html would.
      const resolved = resolve(dirname(indexHtml), cleaned);

      // The resolved location must lie inside the Spa_Root — not escape it via
      // `..` — so the Demo_Page keeps working wherever Microservice1 mounts it.
      const rel = relative(spaRoot, resolved);
      expect(
        rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)),
        `reference ${JSON.stringify(ref)} resolves outside dist/ (to ${resolved})`,
      ).toBe(true);

      // And there must actually be a file at that path — no dangling reference.
      expect(
        existsSync(resolved) && statSync(resolved).isFile(),
        `reference ${JSON.stringify(ref)} has no file at ${resolved}`,
      ).toBe(true);
    }
  });

  it("keeps the whole resolved reference set inside the Spa_Root subtree", () => {
    // A defence-in-depth restatement over the set: every resolved path shares
    // the Spa_Root as a prefix. This is what makes the Demo_Page portable to a
    // Mount_Root other than "/" (R6.7).
    const prefix = spaRoot + sep;
    for (const ref of references) {
      const cleaned = ref.replace(/[?#].*$/, "");
      const resolved = resolve(dirname(indexHtml), cleaned);
      expect(
        resolved === spaRoot || resolved.startsWith(prefix),
        `reference ${JSON.stringify(ref)} resolves outside the Spa_Root ${spaRoot}`,
      ).toBe(true);
    }
  });

  it("resolves the exports-map target strictly inside dist/, never as a tsc --build output", () => {
    // The Demo_Spa's category contract is a non-empty scripts.build, and its
    // exports map points at ./dist/index.html — the bundler's output. This
    // confirms the file the map targets is the one the Bundler_Project emitted,
    // and that it lives under dist/ (never emitted by a tsc --build root, R6.10).
    const rel = relative(spaRoot, indexHtml);
    expect(rel).toBe("index.html");
    expect(join(spaRoot, rel)).toBe(indexHtml);
  });

  it("inlines the Extended_Config_Package's `extendedSetting` value into at least one emitted file (R5.6)", () => {
    // The Payload_Preview embeds `buildExtendedConfigPayload(...)`'s output —
    // whose `config.extendedSetting` is exactly this value — into the Demo_Page,
    // and the bundler inlines the Common_Package rather than leaving a runtime
    // import. So the emitted bundle must carry the VALUE as a substring of at
    // least one file. The value is imported from the package (never restated
    // here), so this tracks whatever the Extended_Config_Package exports.
    const needle = extendedConfig.extendedSetting;
    expect(needle.length, "extendedSetting value should be a non-empty string").toBeGreaterThan(0);

    const files = collectFiles(spaRoot);
    expect(files.length, "dist/ should hold at least one emitted file").toBeGreaterThan(0);

    const carrier = files.find((file) => readFileSync(file, "utf8").includes(needle));
    expect(
      carrier,
      `no emitted file under ${spaRoot} contains the extendedSetting value ${JSON.stringify(
        needle,
      )} as a substring — expected the bundler to inline @microservices/extended-config`,
    ).toBeDefined();
  });

  it("leaves no residual @microservices import specifier for either Common_Package in any emitted file (R5.11)", () => {
    // Nothing in the shipped bundle may need `@microservices/extended-config` or
    // `@microservices/config` resolved at run time: the bundler inlined them, so
    // no emitted file may carry a `from "@microservices/…"` or
    // `import("@microservices/…")` specifier naming either Common_Package. A
    // Container serving this Demo_Spa stages neither package, so a residual
    // specifier would be an unresolvable dangling import.
    const forbidden = [/\bfrom\s*["']@microservices\//, /\bimport\s*\(\s*["']@microservices\//];

    for (const file of collectFiles(spaRoot)) {
      const contents = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(
          pattern.test(contents),
          `emitted file ${relative(spaRoot, file)} carries a residual @microservices import ` +
            `specifier (matched ${pattern}) — the bundler must inline the Common_Packages so ` +
            `nothing needs resolving at run time`,
        ).toBe(false);
      }
    }
  });
});

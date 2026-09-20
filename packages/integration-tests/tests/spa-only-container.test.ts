// Task 7.6 (spa-common-consumption spec) — the Spa_Only_Container end to end.
//
// This is the interesting packaging case of the whole feature: the Selector
// `microservice1`, where NO Selected_Microservice imports either Common_Package
// directly. The build must reach the Config_Package and the Extended_Config_
// Package THROUGH the Demo_Spa (a Bundler_Project) or fail, compile them so the
// bundler can inline them, build the Demo_Spa's bundle, and stage only the
// Demo_Spa — never its two libraries. This suite assembles that once and asserts,
// across the reused assembly:
//
//   1. The six Tsc_Build_Pass roots are exactly `contracts`, `config`,
//      `extended-config`, `microservice1`, `overseer`, and the Entry_Package, in
//      Build_Sequence order, with no other Microservice_Package among them, and
//      each root's `dist/` non-empty once the pass has exited 0 (R5.1). The
//      Entry_Package is the Build_Sequence's statement-6 member since the registry
//      inversion (registry-inversion R8.1).
//
//   2. A recording CommandRunner over the real plan records exactly one
//      `npm run build` with cwd `packages/spa/demo`, ordered AFTER the single
//      `npx tsc --build` invocation and BEFORE the first copy into the Image_Tree
//      (R5.2).
//
//   3. The assembled scope directory holds exactly `contracts`, `demo`,
//      `microservice1`, `overseer` as real (non-symlink) directories — the
//      Overseer is now a library the Entry_Package imports by name
//      (registry-inversion R9.4) — the Entry_Package is present at its Entry_Root,
//      and `packages/overseer` and `packages/microservices` are both absent
//      (R5.4). The assembly
//      completing without throwing IS the Integrity_Assertion's own result — it
//      runs inside `stageImageTree` and throws on any unjustified or missing
//      entry — so a clean assembly is the R5.5 observable.
//
//   4. An in-process Overseer with `microservice1` mounted answers `GET /` with
//      200 and a body byte-identical to the `dist/index.html` the Demo_Spa's
//      build wrote (R5.7).
//
// --- This suite NEVER mutates the CHECKED-OUT tree --------------------------
//
// Staging targets an OS temp `outDir` (mkdtemp), removed in `afterAll` — never
// the checked-out tree. The two writes the assembly does make in place are the
// gitignored generated output the repository already treats as churn and that
// `.kiro/steering/tech.md` explicitly sanctions: each Tsc_Project's `dist/` and
// `*.tsbuildinfo` (written by `npx tsc --build`), and the Demo_Spa's own `dist/`
// (written by its `vite build`). The generated microservice registry is written
// by `generateRegistry` inside `buildImageTree` — but this suite drives
// `buildPlan` + `executeBuildPlan` directly and does NOT call `buildImageTree`,
// so it regenerates no registry and touches that file not at all. No git command
// runs anywhere in this file.
//
// The Demo_Spa's `dist/index.html` that the assembly's `vite build` writes lands
// at the REAL workspace path `packages/spa/demo/dist/index.html` (the build runs
// with the Demo_Spa's own directory as cwd). That is exactly the file the
// in-process Microservice1 resolves and serves: `resolveSpaRoot()` resolves the
// bare `@microservices/demo` specifier through the workspace symlink to
// `packages/spa/demo/dist`, so the body of `GET /` is the same bytes on disk that
// the build just wrote — which is what makes the byte-identity assertion exact.
//
// Validates: Requirements 5.1, 5.2, 5.4, 5.5, 5.7

import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import request from "supertest";

import { buildPlan } from "@microservices/build-tools/dist/build-plan.js";
import {
  executeBuildPlan,
  isNonEmptyDir,
  run,
  stageImageTree,
  type CommandRunner,
} from "@microservices/build-tools/dist/image-tree.js";
import type { BuildPlan } from "@microservices/build-tools/dist/build-plan.js";
import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";

import { buildApp, makeRegistry, makeToggleMap } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The Demo_Spa package directory and the `index.html` its bundler build writes. */
const demoDistIndexHtml = resolve(
  repoRoot,
  "packages",
  "spa",
  "demo",
  "dist",
  "index.html",
);

/**
 * The assembly runs a real `tsc --build` over five roots plus a real `vite
 * build`; give the whole `beforeAll` generous room.
 */
const ASSEMBLE_TIMEOUT_MS = 300_000;

/** The Spa_Only_Container Selector under test. */
const SELECTOR = "microservice1";

/** This repository's Entry_Root. Unconfigured, so the Entry_Root_Default `app`. */
const ENTRY_ROOT = projectContext(defaultEffectiveConfig()).entryRoot;

/**
 * The six Tsc_Build_Pass roots R5.1 fixes, in Build_Sequence order:
 * statement 1 (`contracts`), statement 3 (the required Common_Packages in
 * dependency order — `config` before `extended-config`), statement 4 (the
 * Selected_Microservice), statement 5 (the Overseer), statement 6 (the
 * Entry_Package, which the registry inversion placed strictly after both —
 * registry-inversion R8.1). No Spa_Package is a root, and no Microservice_Package
 * other than `microservice1`.
 */
const EXPECTED_TSC_ROOTS: readonly string[] = [
  "packages/contracts",
  "packages/common/config",
  "packages/common/extended-config",
  "packages/microservices/microservice1",
  "packages/overseer",
  ENTRY_ROOT,
];

/** One recorded event in the build/stage sequence. */
type BuildEvent =
  | { readonly kind: "run"; readonly command: string; readonly args: readonly string[]; readonly cwd?: string }
  | { readonly kind: "stage" };

/**
 * Run `fn` with cwd pinned to the repo root and MICROSERVICES set, restoring
 * both afterward. `buildPlan` resolves repo-relative paths against cwd and reads
 * the selector from env; `executeBuildPlan` runs `tsc --build` and each SPA's
 * `npm run build` relative to cwd.
 */
function withRepoRootAndSelector<T>(selector: string, fn: () => T): T {
  const previousSelector = process.env.MICROSERVICES;
  const previousCwd = process.cwd();
  try {
    process.chdir(repoRoot);
    process.env.MICROSERVICES = selector;
    return fn();
  } finally {
    process.chdir(previousCwd);
    if (previousSelector === undefined) {
      delete process.env.MICROSERVICES;
    } else {
      process.env.MICROSERVICES = previousSelector;
    }
  }
}

// One assembly for the whole suite, reused across every case.
let plan: BuildPlan;
let outDir: string;
let events: BuildEvent[];

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "spa-only-container-"));
  events = [];

  withRepoRootAndSelector(SELECTOR, () => {
    plan = buildPlan(projectContext(defaultEffectiveConfig()), SELECTOR);

    // A recording runner that DELEGATES to the real `run`, so a real
    // `tsc --build` and a real `vite build` actually execute (the roots' `dist/`
    // must end up non-empty and the Demo_Spa's `dist/index.html` must be the
    // file the in-process Overseer serves), while the invocation sequence is
    // captured for the ordering assertions.
    const recordingRunner: CommandRunner = (command, args, options) => {
      events.push({
        kind: "run",
        command,
        args: [...args],
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      });
      run(command, args, options);
    };

    // A recording stage step that records the staging boundary, then performs
    // the REAL staging (which ends by running the Integrity_Assertion). Its
    // completing without throwing is R5.5's observable.
    const recordingStage = (p: BuildPlan, dir: string): void => {
      events.push({ kind: "stage" });
      stageImageTree(p, dir);
    };

    executeBuildPlan(
      projectContext(defaultEffectiveConfig()),
      plan,
      outDir,
      recordingRunner,
      recordingStage,
    );
  });
}, ASSEMBLE_TIMEOUT_MS);

afterAll(() => {
  if (outDir !== undefined) {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R5.1 — the five Tsc_Build_Pass roots, in order, each with a non-empty dist/
// ---------------------------------------------------------------------------

describe("Tsc_Build_Pass roots for Selector microservice1 (R5.1)", () => {
  it("holds exactly [contracts, config, extended-config, microservice1, overseer, <Entry_Root>] in Build_Sequence order", () => {
    expect(plan.tscRoots).toEqual(EXPECTED_TSC_ROOTS);
  });

  it("includes no Microservice_Package other than microservice1 among the roots", () => {
    const microservicePackageRoots = plan.tscRoots.filter((rootDir) =>
      rootDir.startsWith("packages/microservices/"),
    );
    expect(microservicePackageRoots).toEqual([
      "packages/microservices/microservice1",
    ]);
  });

  it("includes no Spa_Package among the roots (the Demo_Spa is a Bundler_Project)", () => {
    expect(plan.tscRoots).not.toContain("packages/spa/demo");
  });

  it("leaves each of the six roots' dist/ non-empty once the pass has exited 0", () => {
    for (const rootDir of EXPECTED_TSC_ROOTS) {
      const distDir = resolve(repoRoot, rootDir, "dist");
      expect(
        isNonEmptyDir(distDir),
        `${rootDir}/dist should hold compiled output after tsc --build`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R5.2 — one demo bundler build, ordered after tsc --build and before staging
// ---------------------------------------------------------------------------

describe("BUILD/STAGE ordering for Selector microservice1 (R5.2)", () => {
  it("runs exactly one npx tsc --build invocation, and it is the first event", () => {
    const tscEvents = events.filter(
      (e) => e.kind === "run" && e.command === "npx" && e.args[0] === "tsc",
    );
    expect(tscEvents).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "run", command: "npx" });
    expect((events[0] as { args: readonly string[] }).args.slice(0, 2)).toEqual([
      "tsc",
      "--build",
    ]);
  });

  it("runs exactly one `npm run build` with cwd packages/spa/demo", () => {
    const demoBuilds = events.filter(
      (e) =>
        e.kind === "run" &&
        e.command === "npm" &&
        e.args[0] === "run" &&
        e.args[1] === "build" &&
        e.cwd === "packages/spa/demo",
    );
    expect(demoBuilds).toHaveLength(1);
  });

  it("orders the demo build AFTER the tsc --build invocation and BEFORE staging", () => {
    const tscIndex = events.findIndex(
      (e) => e.kind === "run" && e.command === "npx" && e.args[0] === "tsc",
    );
    const demoIndex = events.findIndex(
      (e) =>
        e.kind === "run" &&
        e.command === "npm" &&
        e.args[1] === "build" &&
        e.cwd === "packages/spa/demo",
    );
    const stageIndex = events.findIndex((e) => e.kind === "stage");

    expect(tscIndex).toBeGreaterThanOrEqual(0);
    expect(demoIndex).toBeGreaterThan(tscIndex);
    expect(stageIndex).toBeGreaterThan(demoIndex);
  });
});

// ---------------------------------------------------------------------------
// R5.4 / R5.5 — the Image_Tree holds exactly what the Selector justifies
// ---------------------------------------------------------------------------

describe("Image_Tree contents for Selector microservice1 (R5.4, R5.5)", () => {
  const scopeRoot = (): string =>
    join(outDir, "node_modules", "@microservices");

  it("holds exactly [contracts, demo, microservice1, overseer] under node_modules/@microservices/, each a real directory", () => {
    // The "holds" half: each justified package is present as a real
    // (non-symlink) directory. Asserted per named package via `lstatSync` so no
    // directory-enumeration anchor is needed. `overseer` joined this set with the
    // registry inversion: it is a library the Entry_Package imports BY NAME, so it
    // stages under the scope root like any other imported-by-name package
    // (registry-inversion R3.7, R9.4).
    for (const name of ["contracts", "demo", "microservice1", "overseer"]) {
      const st = lstatSync(join(scopeRoot(), name));
      expect(st.isDirectory(), `${name} should be a directory`).toBe(true);
      expect(
        st.isSymbolicLink(),
        `${name} must be a real directory, not a workspace symlink`,
      ).toBe(false);
    }

    // The "and nothing else" half, asserted anchor-free: every package the
    // Selector does NOT justify must be absent from the scope root. `config`
    // and `extended-config` are reached only through the Demo_Spa's bundle and
    // are never staged; `microservice2`/`microservice3` are unselected.
    for (const name of [
      "config",
      "extended-config",
      "microservice2",
      "microservice3",
    ]) {
      expect(
        () => lstatSync(join(scopeRoot(), name)),
        `@microservices/${name} must be absent from the scope root`,
      ).toThrow();
    }
  });

  it("stages the Entry_Package at its Entry_Root, with no packages/overseer and no packages/microservices entry", () => {
    // The single package-directory staging in the tree is the Entry_Package's:
    // the entrypoint is invoked by path (registry-inversion R9.6).
    const entryDir = join(outDir, ENTRY_ROOT);
    const entryStat = lstatSync(entryDir);
    expect(entryStat.isDirectory()).toBe(true);
    expect(entryStat.isSymbolicLink()).toBe(false);
    expect(lstatSync(join(entryDir, "package.json")).isFile()).toBe(true);
    expect(lstatSync(join(entryDir, "dist")).isDirectory()).toBe(true);
    expect(
      () => lstatSync(join(entryDir, "src")),
      "the Entry_Package ships its manifest and compiled dist, never its src",
    ).toThrow();

    expect(
      () => lstatSync(join(outDir, "packages", "overseer")),
      "the Overseer is staged under the scope root, never at packages/overseer/",
    ).toThrow();
    expect(
      () => lstatSync(join(outDir, "packages", "microservices")),
      "packages/microservices/ must be absent from the Image_Tree",
    ).toThrow();
  });

  it("completed the assembly without throwing — the Integrity_Assertion reported no unjustified or missing entry (R5.5)", () => {
    // If the assembly had produced an unjustified or missing scope entry,
    // `stageImageTree`'s `assertImageTreeIntegrity` would have thrown inside
    // `beforeAll` and this suite would never have run. Reaching here, with a
    // materialised outDir, is that assertion's own passing result.
    expect(outDir.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R5.7 — GET / answers 200 with the demo's built index.html, byte-identical
// ---------------------------------------------------------------------------

describe("Spa_Only_Container serves the Demo_Spa at / (R5.7)", () => {
  let server: Server;

  beforeAll(async () => {
    // One persistent listened server, reused across requests, matching the
    // sibling in-process Overseer suites (container-extended-config,
    // specific-container-404, mount-dispatch).
    server = buildApp(
      makeRegistry(["microservice1"]),
      makeToggleMap({ microservice1: true }),
    ).listen(0);
    await new Promise<void>((resolvePromise) =>
      server.on("listening", resolvePromise),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((err) => (err ? reject(err) : resolvePromise())),
    );
  });

  it("GET / -> 200 with a body byte-identical to the demo's built dist/index.html", async () => {
    const res = await request(server).get("/").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);

    // The bytes the Demo_Spa's `vite build` just wrote — read from disk, never
    // restated as a literal — are exactly what the Container serves.
    const expected = readFileSync(demoDistIndexHtml);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(expected)).toBe(true);
  });
});

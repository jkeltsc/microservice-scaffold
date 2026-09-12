// CI-wiring example test.
//
// The root `package.json` now derives its repository-wide build from the
// Workspace_Build_Order rather than from the `workspaces` array's entry order:
// `build` and `pretest` each invoke `node scripts/build.js`, and the `ci`
// script's leading build step is `npm run build` (no longer
// `npm run build --workspaces`). No root script contains
// `npm run build --workspaces` at all — visiting order is derived, not taken
// from the manifest's entry order (R12.21).
//
// The repo-invariants check still ships as a compiled bin
// (`packages/build-tools/dist/bin/check-repo-invariants.js`) and must run as
// part of the root `ci` quality gate. Because the bin is compiled output, it
// runs after the build step, and it is placed before the slower
// typecheck/lint/test gates so an ordering mistake fails fast. This example
// test pins that wiring against the committed root `package.json`: the `ci`
// script's first `&&`-separated segment is exactly `npm run build`, it then
// invokes `check:invariants` ordered after that build step and before
// `typecheck --workspaces`, and the `check:invariants` script points at the
// compiled `.js` bin under `dist/` (not a `src/` `.ts` path).
//
// Validates: Requirements 12.21, 14.8, 14.10
//
// ---------------------------------------------------------------------------
// scaffold-demo-samples task 12.6 additions (R11.4, R11.5, R11.6, R12.6)
//
// The blocks below extend this suite to pin how the Demo_Spa — the first
// Spa_Package, `@microservices/demo` at `packages/spa/demo` — reaches its own
// `build` script during the repository-wide build, and how that build's
// position and its exit status relate to the first test and the Overseer spawn.
//
// The honest seam is deliberately NOT "does an index.html exist in the
// Spa_Root". Per R11.5 / R6.6 (recorded in tasks.md 12.6), what this suite
// asserts is the Demo_Spa `build` SCRIPT's exit status and its POSITION
// relative to the first test and the Overseer spawn. The bundler's output
// filename is the bundler's obligation, checked only in
// spa-bundle-output.test.ts; no Build_System step inspects it.
//
// Two facts compose the seam:
//
//   * scripts/build.js (the root `build` and `pretest`) spawns the compiled
//     `build-workspaces` bin, whose CLI runs `runOrderedBuild` over the
//     Workspace_Build_Order. `runOrderedBuild` invokes each package's own
//     `npm run build --workspace <name>` exactly once, in order, and a
//     Bundler_Project (the Demo_Spa) is built by that same `npm run build`
//     rather than as a `tsc --build` root. It throws `[build-order:failed]`
//     naming the failed package's DIRECTORY on the first non-zero exit and
//     builds no subsequent package. This is the same recording seam
//     repository-build.test.ts drives.
//   * The root scripts wire that ordered build ahead of the two observers:
//     `pretest` (node scripts/build.js) runs before `npm test`'s Vitest run,
//     and scripts/start.js runs the build before it spawns the Overseer.
//
// The dev path is the complement (R11.6): `devProjectList()` returns
// `buildPlanFrom(...).tscRoots` verbatim, which excludes every Bundler_Project,
// so `npm run dev` invokes no Spa build. Asserted here over the real tree.
//
// Validates: Requirements 11.4, 11.5, 11.6, 12.6

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  discoverPackages,
  readDependencySpecifiers,
} from "@microservices/build-tools/dist/discovery.js";
import {
  runOrderedBuild,
  workspaceBuildOrder,
  workspaceNodesFrom,
  type CommandRunner,
} from "@microservices/build-tools/dist/workspace-build-order.js";
import { devProjectList } from "@microservices/build-tools/dist/dev-supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The Demo_Spa's workspace name and its repo-relative package directory. */
const DEMO_NAME = "@microservices/demo";
const DEMO_DIR = "packages/spa/demo";

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as Manifest;

describe("the root package.json builds in the Workspace_Build_Order", () => {
  const scripts = manifest.scripts ?? {};

  it("build and pretest each invoke node scripts/build.js", () => {
    expect(scripts.build ?? "").toContain("node scripts/build.js");
    expect(scripts.pretest ?? "").toContain("node scripts/build.js");
  });

  it("the ci script's leading build step is exactly `npm run build`", () => {
    const ci = scripts.ci ?? "";
    const firstSegment = ci.split("&&")[0]?.trim() ?? "";
    expect(firstSegment).toBe("npm run build");
  });

  it("no root script contains `npm run build --workspaces`", () => {
    for (const [name, value] of Object.entries(scripts)) {
      expect(
        value.includes("npm run build --workspaces"),
        `script "${name}" must not contain \`npm run build --workspaces\``,
      ).toBe(false);
    }
  });
});

describe("the root ci script wires in the repo-invariants check", () => {
  const scripts = manifest.scripts ?? {};

  it("ci invokes check:invariants", () => {
    const ci = scripts.ci ?? "";
    expect(ci).toContain("check:invariants");
  });

  it("orders check:invariants after the build step and before typecheck --workspaces", () => {
    const ci = scripts.ci ?? "";
    // Anchor on the leading build segment rather than a substring match, so
    // the position keys off `npm run build &&` and not an incidental
    // occurrence of "npm run build" elsewhere.
    expect(ci.startsWith("npm run build &&")).toBe(true);
    const buildPos = 0;
    const invariantsPos = ci.indexOf("check:invariants");
    const typecheckPos = ci.indexOf("typecheck --workspaces");

    expect(invariantsPos).toBeGreaterThanOrEqual(0);
    expect(typecheckPos).toBeGreaterThanOrEqual(0);

    expect(buildPos).toBeLessThan(invariantsPos);
    expect(invariantsPos).toBeLessThan(typecheckPos);
  });

  it("check:invariants points at the compiled bin under dist/", () => {
    const checkInvariants = scripts["check:invariants"] ?? "";
    expect(checkInvariants).toContain(
      "packages/build-tools/dist/bin/check-repo-invariants.js",
    );
  });
});

// ---------------------------------------------------------------------------
// scaffold-demo-samples task 12.6 — the Demo_Spa build within the ordered pass
// ---------------------------------------------------------------------------

/** One recorded `runOrderedBuild` invocation, exactly as passed to the runner. */
interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

/** The `--workspace <name>` value of a recorded invocation, or undefined. */
function workspaceNameOf(invocation: Invocation): string | undefined {
  const flag = invocation.args.indexOf("--workspace");
  return flag >= 0 ? invocation.args[flag + 1] : undefined;
}

describe("the ordered build reaches the Demo_Spa's own build script (R11.4, R11.5)", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    // discoverPackages()/readDependencySpecifiers resolve repo-relative.
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  /**
   * Drive `runOrderedBuild` over the real-tree order with a recording runner
   * that returns status 0 for every invocation, capturing the invocation
   * sequence. This is the same seam repository-build.test.ts uses: the ordered
   * pass IS what the repository-wide build (scripts/build.js -> the compiled
   * `build-workspaces` bin) runs, so recording it observes the real build
   * without spawning one.
   */
  function recordOrderedBuild(): Invocation[] {
    const recorded: Invocation[] = [];
    const runner: CommandRunner = (command, args) => {
      recorded.push({ command, args: [...args] });
      return { status: 0 };
    };

    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);
    expect(() => runOrderedBuild(order, runner)).not.toThrow();
    return recorded;
  }

  it("invokes the Demo_Spa's build as its own `npm run build --workspace @microservices/demo`", () => {
    const recorded = recordOrderedBuild();

    // The Demo_Spa is reached exactly once, by workspace name, through the same
    // `npm run build --workspace <name>` every workspace package is built with.
    // A Bundler_Project is built by its OWN `npm run build`, not as a
    // `tsc --build` root — and the ordered pass expresses that uniformly:
    // Microservice1 declares `@microservices/demo`, so the Demo_Spa is a
    // Required_Dependency and therefore a node in the ordered build.
    const demoInvocations = recorded.filter(
      (invocation) => workspaceNameOf(invocation) === DEMO_NAME,
    );
    expect(demoInvocations).toHaveLength(1);

    const demo = demoInvocations[0]!;
    expect(demo.command).toBe("npm");
    expect(demo.args).toEqual(["run", "build", "--workspace", DEMO_NAME]);
  });

  it("observes the Demo_Spa's build exit 0 within a complete, all-zero ordered pass, before it returns", () => {
    // A clean return over an all-zero run IS the "exit 0" evidence:
    // `runOrderedBuild` throws `[build-order:failed]` on any non-zero exit and
    // emits nothing on success. The pass visiting every workspace node exactly
    // once is what places the Demo_Spa's build inside a complete pass rather
    // than an isolated invocation.
    const recorded = recordOrderedBuild();

    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);
    expect(recorded).toHaveLength(order.length);
    expect(
      recorded.some((invocation) => workspaceNameOf(invocation) === DEMO_NAME),
    ).toBe(true);
  });

  it("stops at the Demo_Spa on a non-zero exit: throws [build-order:failed] naming its directory and builds nothing after it (R11.5, R11.14)", () => {
    // Drive the same seam, but return non-zero for the Demo_Spa's invocation.
    // `runOrderedBuild` must throw naming the Demo_Spa's package DIRECTORY (not
    // its name, and not an index.html), and record no invocation after it — the
    // "no subsequent package was built" half of the fail-fast rule. On the
    // wired paths this is what makes `npm test` run no test and `npm start`
    // start no Overseer when the Demo_Spa's build fails.
    const failStatus = 2;
    const recorded: Invocation[] = [];
    const runner: CommandRunner = (command, args) => {
      recorded.push({ command, args: [...args] });
      const flag = args.indexOf("--workspace");
      const name = flag >= 0 ? args[flag + 1] : undefined;
      return { status: name === DEMO_NAME ? failStatus : 0 };
    };

    const nodes = workspaceNodesFrom(discoverPackages(), readDependencySpecifiers);
    const order = workspaceBuildOrder(nodes);

    expect(() => runOrderedBuild(order, runner)).toThrow(
      `[build-order:failed] "npm run build" for "${DEMO_DIR}" failed with exit code ${String(
        failStatus,
      )}; no subsequent package was built`,
    );

    // The Demo_Spa was the last invocation recorded: nothing after it ran.
    const demoIndex = recorded.findIndex(
      (invocation) => workspaceNameOf(invocation) === DEMO_NAME,
    );
    expect(demoIndex).toBeGreaterThanOrEqual(0);
    expect(demoIndex).toBe(recorded.length - 1);
  });
});

describe("the ordered build precedes the first test and the Overseer spawn (R11.4, R11.5)", () => {
  const scripts = manifest.scripts ?? {};

  it("pretest runs the ordered build before `npm test`'s Vitest run", () => {
    // npm runs `pretest` before `test`, so wiring the ordered build into
    // `pretest` is what makes the Demo_Spa's build (a node of that pass) run
    // before the first test executes (R11.4). The build is scripts/build.js.
    expect(scripts.pretest ?? "").toContain("node scripts/build.js");
    // The test run itself is the Vitest invocation `pretest` gates.
    expect(scripts.test ?? "").toContain("vitest --run");
  });

  it("start.js runs the ordered build before it spawns the Overseer (R11.5)", () => {
    // scripts/start.js is a straight-line script: it must invoke the build
    // before it spawns the Overseer entrypoint, so the Demo_Spa's build (part
    // of that build) is observed to exit 0 before the Overseer process starts.
    const startSource = readFileSync(
      resolve(repoRoot, "scripts", "start.js"),
      "utf8",
    );
    // Strip comments so the ordering is asserted over executable statements
    // only — the file documents the Overseer entrypoint path in a comment.
    const code = startSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const buildPos = code.indexOf('"build"');
    const overseerSpawnPos = code.indexOf("packages/overseer/dist/index.js");

    expect(buildPos).toBeGreaterThanOrEqual(0);
    expect(overseerSpawnPos).toBeGreaterThanOrEqual(0);
    // The build step precedes the Overseer spawn textually and, this being a
    // straight-line script, logically.
    expect(buildPos).toBeLessThan(overseerSpawnPos);
  });
});

describe("`npm run dev` invokes no Demo_Spa build (R11.6)", () => {
  const originalCwd = process.cwd();

  beforeAll(() => {
    process.chdir(repoRoot);
  });
  afterAll(() => {
    process.chdir(originalCwd);
  });

  it("the Demo_Spa is absent from the dev supervisor's project list for a selector that reaches it", () => {
    // The Dev_Supervisor compiles exactly `buildPlanFrom(...).tscRoots`, which
    // holds Tsc_Projects only — every Bundler_Project (the Demo_Spa) is
    // excluded. Use the `*` selector, which reaches Microservice1 and therefore
    // the Demo_Spa in the BUILD set; the Demo_Spa is still not in the dev list,
    // because the dev list is the `tsc --build` roots, never a Spa build.
    const projectList = devProjectList("*");
    expect(projectList).not.toContain(DEMO_DIR);
    // A concrete selector that reaches Microservice1 (and so the Demo_Spa)
    // holds the same: no Spa build on the dev path.
    expect(devProjectList("microservice1")).not.toContain(DEMO_DIR);
  });

  it("the dev project list holds only Tsc_Project directories, never packages/spa/*", () => {
    // Structural complement: no entry of the dev list is under packages/spa/,
    // so the supervisor's sole build action (the solution builder over this
    // list) can never invoke a Spa_Package's `npm run build` (R11.6).
    for (const dir of devProjectList("*")) {
      expect(
        dir.startsWith("packages/spa/"),
        `dev project "${dir}" must not be a Spa_Package directory`,
      ).toBe(false);
    }
  });
});

describe("every command the README quotes for the samples resolves to a declared script (R11.6, R12.6)", () => {
  // R12.6: every command the README quotes for the two samples must exit 0 on a
  // clean clone, which requires it to resolve to a declared script in the first
  // place. This asserts the resolvability half over the commands the README
  // currently quotes.
  //
  // NOTE ON SCOPE: at task 12.6's position in the plan, README.md does not yet
  // mention the samples by name — Step 8 task 14.1 adds the sample-specific
  // command `npm run build --workspace @microservices/demo` and the sample
  // narrative. This block therefore scopes to the `npm run <x>` / `npm <x>`
  // commands the README quotes today; 14.1 will add the Demo_Spa build command,
  // which resolves to `@microservices/demo`'s own `build` script (asserted to
  // exist below so the future README command is already backed).

  const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

  /** Every workspace package's scripts, keyed by workspace name. */
  function workspaceScripts(): Map<string, Readonly<Record<string, string>>> {
    const byName = new Map<string, Readonly<Record<string, string>>>();
    const discovery = (() => {
      const cwd = process.cwd();
      process.chdir(repoRoot);
      try {
        return discoverPackages();
      } finally {
        process.chdir(cwd);
      }
    })();
    for (const pkg of discovery.byName.values()) {
      const pkgManifest = JSON.parse(
        readFileSync(resolve(repoRoot, pkg.packageDir, "package.json"), "utf8"),
      ) as { name?: string; scripts?: Readonly<Record<string, string>> };
      if (pkgManifest.name) {
        byName.set(pkgManifest.name, pkgManifest.scripts ?? {});
      }
    }
    return byName;
  }

  /**
   * Extract the `npm run <script>` and `npm <script>` commands the README
   * quotes, returning the resolved-against target for each: a root script
   * name, or a `{ workspace, script }` pair when `--workspace <name>` is
   * present. Comments after `#` are stripped.
   */
  function quotedNpmCommands(): {
    raw: string;
    script: string;
    workspace: string | undefined;
  }[] {
    const results: {
      raw: string;
      script: string;
      workspace: string | undefined;
    }[] = [];
    // Match `npm run <script> [--workspace <name>]` and bare `npm <script>`
    // (start/test/install) inside fenced code blocks or the command table.
    const pattern =
      /npm\s+(?:run\s+([a-z0-9:_-]+)|(start|test|install|ci))((?:\s+--workspace\s+\S+)?)/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(readme)) !== null) {
      const script = (match[1] ?? match[2] ?? "").trim();
      if (script.length === 0) {
        continue;
      }
      const wsMatch = /--workspace\s+(\S+)/.exec(match[3] ?? "");
      results.push({
        raw: match[0].trim(),
        script,
        workspace: wsMatch ? wsMatch[1] : undefined,
      });
    }
    return results;
  }

  it("resolves each quoted npm command to a declared script", () => {
    const rootScripts = manifest.scripts ?? {};
    const wsScripts = workspaceScripts();
    const commands = quotedNpmCommands();

    // Sanity: the README does quote npm commands (dev, start, test, …).
    expect(commands.length).toBeGreaterThan(0);

    for (const { raw, script, workspace } of commands) {
      if (script === "install") {
        // `npm install` is a built-in, not a package script.
        continue;
      }
      if (workspace !== undefined) {
        // A `--workspace <name>` command resolves against that workspace's
        // scripts. Today the README quotes none; if 14.1 adds the Demo_Spa
        // build command this branch backs it.
        const scripts = wsScripts.get(workspace);
        expect(scripts, `README quotes "${raw}" for unknown workspace "${workspace}"`).toBeDefined();
        expect(
          scripts?.[script],
          `README command "${raw}" names no "${script}" script in ${workspace}`,
        ).toBeTruthy();
        continue;
      }
      // A `--workspaces` (plural) or root command resolves against the root
      // scripts. `--workspaces` fan-out commands (build/test/typecheck/lint)
      // are root scripts too here (the root declares them) OR are the npm
      // built-in fan-out of a per-workspace script; accept either.
      const isRoot = Boolean(rootScripts[script]);
      const isPerWorkspace = [...wsScripts.values()].every(
        (s) => script in s,
      );
      expect(
        isRoot || isPerWorkspace,
        `README command "${raw}" resolves to no declared "${script}" script (root or per-workspace)`,
      ).toBe(true);
    }
  });

  it("the Demo_Spa declares the `build` script task 14.1's README command will quote", () => {
    // Forward-looking backing for R12.6: `npm run build --workspace
    // @microservices/demo` (added to the README by task 14.1) must resolve to a
    // declared script. Assert the target script exists now, so 14.1's command
    // is already backed when it lands.
    const wsScripts = workspaceScripts();
    const demoScripts = wsScripts.get(DEMO_NAME);
    expect(demoScripts, `${DEMO_NAME} must be a discovered workspace`).toBeDefined();
    expect(demoScripts?.build, `${DEMO_NAME} must declare a build script`).toBeTruthy();
  });
});

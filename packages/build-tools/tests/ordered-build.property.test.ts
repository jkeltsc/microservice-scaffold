// Feature: unified-build-order, Property 9: A produced order over a
// violation-free layout invokes each package's `build` once, in order, stopping
// at the first failure — and every Spa_Package's `npm run build` invocation
// follows every Tsc_Project invocation.
//
// The property test for the EFFECTS half of the Workspace_Build_Order path:
// which `build` scripts `runOrderedBuild` invokes, in what sequence, and where
// the sequence stops. It is the counterpart to the pure DERIVATION suite
// (`workspaceBuildOrder`'s ordering, cycle rejection, and tie-breaking); this
// suite instead asserts a claim about effects and so is the one that needs an
// injected `CommandRunner`.
//
// `runOrderedBuild(order, runner)` is the seam. This suite drives it with a
// recording `CommandRunner` — capturing every invocation's command and args IN
// ORDER and returning a caller-chosen exit status — so nothing is spawned and no
// filesystem is touched, which is what lets the suite stay fast enough for
// `numRuns: 200`. Unlike the Image_Assembler's runner, this one RETURNS the
// observed status rather than throwing on a non-zero exit, so `runOrderedBuild`
// owns the stop-at-first-failure decision and frames it as `[build-order:failed]`
// (see `workspace-build-order.ts`).
//
// The order fed to `runOrderedBuild` is built by `workspaceBuildOrder` over
// synthetic nodes that include a `microservice -> spa -> common` shape. Under the
// Build_Sequence a Spa_Package is statement 7, the trailing phase, so it sits —
// in a REAL derived order, not a hand-arranged one — after every Tsc_Project. The
// "within the same single pass, with no phase boundary" reading of R12.9 no
// longer holds: statement 7 makes the bundlers a trailing phase (2.4). The claim
// inverts to "every Spa_Package's `npm run build` invocation follows every
// Tsc_Project invocation", checked against the same single invocation sequence
// the other assertions read.
//
// Validates: Requirements 2.4, 3.14, 3.15.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  runOrderedBuild,
  workspaceBuildOrder,
  type CommandRunner,
  type WorkspaceNode,
} from "../src/workspace-build-order.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";

/** Default-config context threaded into the Workspace_Build_Order derivation. */
const CONTEXT = projectContext(defaultEffectiveConfig());

/** One recorded runner invocation, captured before any status is returned. */
interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * A recording runner. Every invocation is pushed to `invocations` BEFORE the
 * status is returned, so the sequence up to and including a failing step is
 * observable. `failName` names the package whose invocation returns
 * `failStatus`; every other invocation returns 0. `runOrderedBuild` throws on
 * the first non-zero status, so a later invocation for the same name never
 * happens — but naming by package name keeps the failure choice independent of
 * the derived position.
 */
function recordingRunner(fail?: {
  name: string;
  status: number;
}): { run: CommandRunner; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const run: CommandRunner = (command, args) => {
    invocations.push({ command, args });
    if (fail && args[args.length - 1] === fail.name) {
      return { status: fail.status };
    }
    return { status: 0 };
  };
  return { run, invocations };
}

/** The declared name of a synthetic node, from its directory basename. */
function nameOf(packageDir: string): string {
  const base = packageDir.slice(packageDir.lastIndexOf("/") + 1);
  return `@microservices/${base}`;
}

/** A Tsc_Project node (framework / microservice / common tier). */
function tsc(
  packageDir: string,
  tier: WorkspaceNode["tier"],
  deps: readonly string[] = [],
): WorkspaceNode {
  return {
    packageDir,
    name: nameOf(packageDir),
    dependencySpecifiers: deps,
    tier,
  };
}

/** A Spa_Package node, positioned by its declared Tsc_Project dependencies. */
function spa(packageDir: string, deps: readonly string[]): WorkspaceNode {
  return {
    packageDir,
    name: nameOf(packageDir),
    dependencySpecifiers: deps,
    tier: "spa",
  };
}

// --- Generator: synthetic workspace-node sets with a spa shape -----------

/**
 * A synthetic node set whose derived order is realistic: the four
 * Framework_Singletons the Build_Sequence always emits (`contracts`,
 * `build-tools`, `overseer`, `integration-tests`), a Common_Package, a
 * Spa_Package that depends on the common (and contracts), and a microservice that
 * depends on the Spa_Package (and contracts). `workspaceBuildOrder` derives over
 * the FULL workspace — `buildTools` and `testOnly` both true — so statements 2, 5
 * and 6 always emit `build-tools`, `overseer` and `integration-tests`; the node
 * set must include them or the derived order names a package the set cannot map
 * back. `extra` unrelated microservices widen the order and exercise failures at
 * arbitrary positions.
 *
 * With the Build_Sequence putting Spa_Packages at statement 7 (the trailing
 * phase), the Spa node lands after every Tsc_Project — the shape 2.4 fixes.
 *
 * The nodes are yielded in a scrambled presentation order so the derivation, not
 * the input order, decides the sequence.
 */
const RESERVED_MICROSERVICE_NAMES = new Set([
  "contracts",
  "build-tools",
  "overseer",
  "integration-tests",
  "gateway",
]);

const nodeSetArb: fc.Arbitrary<readonly WorkspaceNode[]> = fc
  .uniqueArray(
    fc
      .string({ minLength: 1, maxLength: 6 })
      .filter((s) => /^[a-z][a-z0-9]*$/.test(s))
      .filter((s) => !RESERVED_MICROSERVICE_NAMES.has(s)),
    { minLength: 0, maxLength: 4 },
  )
  .chain((extraNames) => {
    const contracts = tsc("packages/contracts", "framework");
    const buildTools = tsc("packages/build-tools", "framework");
    const overseer = tsc("packages/overseer", "framework");
    const integrationTests = tsc("packages/integration-tests", "framework");
    const common = tsc("packages/common/config", "common", [
      "@microservices/contracts",
    ]);
    const theSpa = spa("packages/spa/dashboard", [
      "@microservices/contracts",
      "@microservices/config",
    ]);
    const consumer = tsc("packages/microservices/gateway", "microservice", [
      "@microservices/contracts",
      "@microservices/dashboard",
    ]);
    const extras = extraNames.map((n) =>
      tsc(`packages/microservices/${n}`, "microservice", [
        "@microservices/contracts",
      ]),
    );
    const all = [
      contracts,
      buildTools,
      overseer,
      integrationTests,
      common,
      theSpa,
      consumer,
      ...extras,
    ];
    // Scramble presentation order: the derivation must be order-invariant.
    return fc.shuffledSubarray(all, {
      minLength: all.length,
      maxLength: all.length,
    });
  });

const NUM_RUNS = { numRuns: 200 } as const;

describe("Property 9: the ordered build invokes each package's own build once, in order, stopping at the first failure", () => {
  it("an all-zero run invokes every package exactly once, in the Workspace_Build_Order, as `npm run build --workspace <name>`, with every Spa_Package after every Tsc_Project (2.4, 3.14)", () => {
    fc.assert(
      fc.property(nodeSetArb, (nodes) => {
        const order = workspaceBuildOrder(CONTEXT, nodes);
        const { run, invocations } = recordingRunner();

        runOrderedBuild(order, run);

        // Exactly one invocation per package, none twice, in order.
        expect(invocations).toHaveLength(order.length);
        for (let i = 0; i < order.length; i++) {
          expect(invocations[i].command).toBe("npm");
          expect(invocations[i].args).toEqual([
            "run",
            "build",
            "--workspace",
            order[i].name,
          ]);
        }
        const names = invocations.map((inv) => inv.args[inv.args.length - 1]);
        expect(new Set(names).size).toBe(order.length);
        expect(names).toEqual(order.map((n) => n.name));

        // 2.4: the bundlers are a trailing phase (statement 7), so every
        // Spa_Package's `npm run build` invocation follows every Tsc_Project
        // invocation — no Tsc_Project is built after any Spa_Package. Read the
        // invocation positions of the two groups from the single invocation
        // sequence above and require the last Tsc_Project to precede the first
        // Spa_Package.
        const posOf = (name: string): number => names.indexOf(name);
        const spaPositions = order
          .filter((n) => n.tier === "spa")
          .map((n) => posOf(n.name));
        const tscPositions = order
          .filter((n) => n.tier !== "spa")
          .map((n) => posOf(n.name));
        // The generator always plants exactly one Spa_Package and several
        // Tsc_Projects, so both groups are non-empty.
        expect(spaPositions.length).toBeGreaterThan(0);
        expect(tscPositions.length).toBeGreaterThan(0);
        const firstSpa = Math.min(...spaPositions);
        const lastTsc = Math.max(...tscPositions);
        expect(lastTsc).toBeLessThan(firstSpa);
      }),
      NUM_RUNS,
    );
  });

  it("a failing run invokes each package up to and including the first failure, none after, and throws [build-order:failed] naming its directory and status (R12.8)", () => {
    fc.assert(
      fc.property(
        nodeSetArb,
        fc.integer({ min: 1, max: 255 }),
        fc.nat(),
        (nodes, status, pick) => {
          const order = workspaceBuildOrder(CONTEXT, nodes);
          const failIndex = pick % order.length;
          const failNode = order[failIndex];

          const { run, invocations } = recordingRunner({
            name: failNode.name,
            status,
          });

          expect(() => runOrderedBuild(order, run)).toThrow(
            `[build-order:failed] "npm run build" for "${failNode.packageDir}" failed with exit code ${String(status)}; no subsequent package was built`,
          );

          // Exactly the packages up to and including the first failing one,
          // once each, in order — and NONE after it.
          expect(invocations).toHaveLength(failIndex + 1);
          for (let i = 0; i <= failIndex; i++) {
            expect(invocations[i].args).toEqual([
              "run",
              "build",
              "--workspace",
              order[i].name,
            ]);
          }
          const invokedNames = invocations.map(
            (inv) => inv.args[inv.args.length - 1],
          );
          expect(new Set(invokedNames).size).toBe(invocations.length);
          // No package following the failing one was invoked.
          const afterFailure = order
            .slice(failIndex + 1)
            .map((n) => n.name);
          for (const later of afterFailure) {
            expect(invokedNames).not.toContain(later);
          }
        },
      ),
      NUM_RUNS,
    );
  });
});

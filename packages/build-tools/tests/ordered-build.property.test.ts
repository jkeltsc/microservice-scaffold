// Feature: package-categories, Property 34: The ordered build invokes each package's own `build` once, in order, and stops at the first failure
//
// The property test for the EFFECTS half of the Workspace_Build_Order path:
// which `build` scripts `runOrderedBuild` invokes, in what sequence, and where
// the sequence stops. It is the counterpart to Property 33, which owns the pure
// DERIVATION (`workspaceBuildOrder`'s ordering, cycle rejection, and
// tie-breaking); this suite instead asserts a claim about effects and so is the
// one that needs an injected `CommandRunner`.
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
// synthetic nodes that include a `microservice -> spa -> common` shape, so the
// Spa_Package sits — in a REAL derived order, not a hand-arranged one — after
// every Tsc_Project it declares a Dependency_Specifier resolving to. That lets
// the "a Spa_Package's invocation follows every Tsc_Project it depends on,
// within the same single pass and with no phase boundary" claim (R12.9) be
// checked against the same single, unbroken invocation sequence the other
// assertions read.
//
// Validates: Requirements R12.7, R12.8, R12.9.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  runOrderedBuild,
  workspaceBuildOrder,
  type CommandRunner,
  type WorkspaceNode,
} from "../src/workspace-build-order.js";

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
 * A synthetic node set whose derived order is realistic: a `contracts`-like
 * framework root every other node depends on, a Common_Package, a Spa_Package
 * that depends on the common (and contracts), and a microservice that depends on
 * the Spa_Package (and contracts). This produces a derived order in which the
 * Spa node sits after both Tsc_Projects it names, WITHIN one pass — the shape
 * R12.9 is about. `extra` unrelated microservices widen the order and exercise
 * failures at arbitrary positions.
 *
 * The nodes are yielded in a scrambled presentation order so the derivation, not
 * the input order, decides the sequence.
 */
const nodeSetArb: fc.Arbitrary<readonly WorkspaceNode[]> = fc
  .uniqueArray(
    fc.string({ minLength: 1, maxLength: 6 }).filter((s) => /^[a-z][a-z0-9]*$/.test(s)),
    { minLength: 0, maxLength: 4 },
  )
  .chain((extraNames) => {
    const contracts = tsc("packages/contracts", "framework");
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
    const all = [contracts, common, theSpa, consumer, ...extras];
    // Scramble presentation order: the derivation must be order-invariant.
    return fc.shuffledSubarray(all, {
      minLength: all.length,
      maxLength: all.length,
    });
  });

const NUM_RUNS = { numRuns: 200 } as const;

describe("Property 34: the ordered build invokes each package's own build once, in order, stopping at the first failure", () => {
  it("an all-zero run invokes every package exactly once, in the Workspace_Build_Order, as `npm run build --workspace <name>` (R12.7, R12.9)", () => {
    fc.assert(
      fc.property(nodeSetArb, (nodes) => {
        const order = workspaceBuildOrder(nodes);
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

        // R12.9: the Spa_Package is invoked after every Tsc_Project it declares
        // a specifier resolving to — within this same single pass, with no phase
        // boundary. The whole sequence above is one unbroken run of `npm run
        // build` invocations, so "no phase boundary" holds by construction.
        const spaNode = order.find((n) => n.tier === "spa");
        expect(spaNode).toBeDefined();
        if (spaNode) {
          const posOf = (name: string): number =>
            names.indexOf(name);
          const spaPos = posOf(spaNode.name);
          for (const specifier of spaNode.dependencySpecifiers) {
            const dep = order.find((n) => n.name === specifier);
            expect(dep).toBeDefined();
            if (dep) {
              expect(posOf(dep.name)).toBeLessThan(spaPos);
            }
          }
        }
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
          const order = workspaceBuildOrder(nodes);
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

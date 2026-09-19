// Feature: unified-build-order — the statement scaffold of the Build_Sequence
// (requirement 2.1), pinned by example.
//
// `buildSequence` runs the seven ordered statements of 2.1 literally and in
// order. The properties in the sibling suites quantify over that numbering — a
// statement's presence, its membership, its position — so this file pins the
// numbering itself by example: one example per statement whose presence or
// emptiness depends on the membership, plus statement 3's calculated
// `config`-before-`extended-config` order over the two real Common_Packages.
//
// Every assertion reads the returned `SequencedPackage.statement` value, not just
// the sequence position, so a package emitted by the wrong statement fails here
// even if it happens to land in the right slot. That is what keeps the property
// suites' quantification over statement numbers honest.
//
// Method: a fixed membership per example, the framework members named through
// `framework.ts`'s exported records (2.2) rather than restated as literals, and
// the two Common_Packages constructed as `ConsumerPackage` inputs from their real
// declared names and specifiers. Example tests carry no `numRuns`.
//
// Validates: Requirements 2.1, 2.3

import { describe, expect, it } from "vitest";

import type { ConsumerPackage } from "../src/discovery.js";
import {
  buildSequence,
  type SequenceMembership,
  type SequencedPackage,
} from "../src/build-sequence.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";

/** The per-run context every example threads through `buildSequence` (task 5.3).
 *  Its default scope and roots keep the pinned names byte-identical to baseline. */
const CONTEXT = projectContext(defaultEffectiveConfig());

// Per-category roots and the four Framework_Singletons (each with its
// scope-composed name) come from the run's context, not from framework.ts's
// scope-free surface (R3.7).
const NAMESPACE_CONTAINER = CONTEXT.roots;
const {
  contracts: CONTRACTS,
  overseer: OVERSEER,
  buildTools: BUILD_TOOLS,
  integrationTests: INTEGRATION_TESTS,
} = CONTEXT.framework;

/** The two real Common_Packages, as `discoverPackages` would report them:
 *  `extended-config` declares the single scoped specifier `@microservices/config`
 *  and `config` declares none of its peers (only `@microservices/contracts`,
 *  which is not a statement-3 member). The `config`-before-`extended-config`
 *  order must follow from that one declared edge, not from a rule (2.1 §3). */
const CONFIG: ConsumerPackage = {
  category: "common",
  dirName: "config",
  packageDir: "packages/common/config",
  name: "@microservices/config",
  dependencySpecifiers: ["@microservices/contracts"],
  buildKind: "tsc-project",
};

const EXTENDED_CONFIG: ConsumerPackage = {
  category: "common",
  dirName: "extended-config",
  packageDir: "packages/common/extended-config",
  name: "@microservices/extended-config",
  dependencySpecifiers: ["@microservices/config"],
  buildKind: "tsc-project",
};

/** A membership with every optional statement absent and every loop empty; each
 *  example widens exactly the one axis it is pinning. */
const EMPTY_MEMBERSHIP: SequenceMembership = {
  common: [],
  microservices: [],
  spa: [],
  buildTools: false,
  testOnly: false,
};

/** The `{ packageDir, name, statement }` triple a framework member emits, used to
 *  assert both identity and the emitting statement in one shot. */
function entryOf(
  singleton: { readonly packageDir: string; readonly name: string },
  statement: SequencedPackage["statement"],
): SequencedPackage {
  return { packageDir: singleton.packageDir, name: singleton.name, statement };
}

/** Finds the produced entry for one package directory, or `undefined`. */
function at(
  order: readonly SequencedPackage[],
  packageDir: string,
): SequencedPackage | undefined {
  return order.find((entry) => entry.packageDir === packageDir);
}

describe("buildSequence: statement 1 — contracts, always first", () => {
  it("emits contracts at statement 1 as the first entry, for every membership", () => {
    const order = buildSequence(CONTEXT, EMPTY_MEMBERSHIP);

    expect(order[0]).toEqual(entryOf(CONTRACTS, 1));
    // Statement 5 (Overseer) is unconditional too, so the barest membership is
    // exactly [contracts, overseer].
    expect(order).toEqual([entryOf(CONTRACTS, 1), entryOf(OVERSEER, 5)]);
  });
});

describe("buildSequence: statement 2 — build-tools, gated on membership.buildTools", () => {
  it("emits build-tools at statement 2 when buildTools is true", () => {
    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      buildTools: true,
    });

    expect(at(order, BUILD_TOOLS.packageDir)).toEqual(entryOf(BUILD_TOOLS, 2));
    // Immediately after contracts, before the Overseer.
    expect(order).toEqual([
      entryOf(CONTRACTS, 1),
      entryOf(BUILD_TOOLS, 2),
      entryOf(OVERSEER, 5),
    ]);
  });

  it("omits build-tools entirely when buildTools is false", () => {
    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      buildTools: false,
    });

    expect(at(order, BUILD_TOOLS.packageDir)).toBeUndefined();
    expect(order.some((entry) => entry.statement === 2)).toBe(false);
  });
});

describe("buildSequence: statement 3 — Common_Packages in calculated order", () => {
  it("orders config before extended-config as a consequence of the one declared specifier", () => {
    // Feed the two members in the order that would trip a naive pass — the
    // dependent first — so a passing result can only come from the declared edge
    // extended-config → @microservices/config, not from input order.
    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      common: [EXTENDED_CONFIG, CONFIG],
    });

    const config = at(order, CONFIG.packageDir);
    const extended = at(order, EXTENDED_CONFIG.packageDir);

    expect(config).toEqual(entryOf(CONFIG, 3));
    expect(extended).toEqual(entryOf(EXTENDED_CONFIG, 3));

    const configPos = order.findIndex(
      (entry) => entry.packageDir === CONFIG.packageDir,
    );
    const extendedPos = order.findIndex(
      (entry) => entry.packageDir === EXTENDED_CONFIG.packageDir,
    );
    expect(configPos).toBeLessThan(extendedPos);

    // The whole membership is exactly the two Common_Packages, both at
    // statement 3, framed by contracts (1) and the Overseer (5).
    expect(order).toEqual([
      entryOf(CONTRACTS, 1),
      entryOf(CONFIG, 3),
      entryOf(EXTENDED_CONFIG, 3),
      entryOf(OVERSEER, 5),
    ]);
  });
});

describe("buildSequence: statement 5 — the Overseer, always after every microservice", () => {
  it("emits the Overseer at statement 5 after every statement-4 microservice", () => {
    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      microservices: ["microservice1", "microservice2"],
    });

    const overseer = at(order, OVERSEER.packageDir);
    expect(overseer).toEqual(entryOf(OVERSEER, 5));

    const overseerPos = order.findIndex(
      (entry) => entry.packageDir === OVERSEER.packageDir,
    );
    for (const identifier of ["microservice1", "microservice2"]) {
      const microservicePos = order.findIndex(
        (entry) =>
          entry.packageDir ===
          `${NAMESPACE_CONTAINER.microservice}/${identifier}`,
      );
      expect(order[microservicePos]?.statement).toBe(4);
      expect(microservicePos).toBeLessThan(overseerPos);
    }
  });
});

describe("buildSequence: statement 6 — integration-tests, gated on membership.testOnly", () => {
  it("emits integration-tests at statement 6 when testOnly is true", () => {
    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      testOnly: true,
    });

    expect(at(order, INTEGRATION_TESTS.packageDir)).toEqual(
      entryOf(INTEGRATION_TESTS, 6),
    );
    // After the Overseer (statement 5).
    expect(order).toEqual([
      entryOf(CONTRACTS, 1),
      entryOf(OVERSEER, 5),
      entryOf(INTEGRATION_TESTS, 6),
    ]);
  });

  it("omits integration-tests entirely when testOnly is false", () => {
    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      testOnly: false,
    });

    expect(at(order, INTEGRATION_TESTS.packageDir)).toBeUndefined();
    expect(order.some((entry) => entry.statement === 6)).toBe(false);
  });
});

describe("buildSequence: statement 7 — the trailing Spa_Package phase", () => {
  it("emits no statement-7 entry when membership.spa is empty", () => {
    const order = buildSequence(CONTEXT, { ...EMPTY_MEMBERSHIP, spa: [] });

    expect(order.some((entry) => entry.statement === 7)).toBe(false);
  });

  it("emits a Spa_Package at statement 7 after every Tsc_Project when present", () => {
    const demo: ConsumerPackage = {
      category: "spa",
      dirName: "demo",
      packageDir: "packages/spa/demo",
      name: "@microservices/demo",
      dependencySpecifiers: [],
      buildKind: "bundler-project",
    };

    const order = buildSequence(CONTEXT, {
      ...EMPTY_MEMBERSHIP,
      buildTools: true,
      testOnly: true,
      spa: [demo],
    });

    const demoEntry = at(order, demo.packageDir);
    expect(demoEntry).toEqual({
      packageDir: "packages/spa/demo",
      name: "@microservices/demo",
      statement: 7,
    });

    // The trailing phase: the Spa_Package is the final entry, after contracts (1),
    // build-tools (2), the Overseer (5), and integration-tests (6).
    expect(order[order.length - 1]).toEqual(demoEntry);
  });
});

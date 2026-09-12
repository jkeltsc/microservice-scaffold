// Example cases for the single Integrity_Assertion, `assertImageTreeIntegrity`
// (Requirements R7.7, R7.8, R7.9, R7.11).
//
// The Image_Assembler establishes minimality by construction — only what
// `plan.stage` justifies is ever copied, and nothing is pruned afterwards — so
// under the real assembler this assertion can never fire. It is defense in
// depth: a regression that leaks an unjustified entry into the Image_Tree, or
// that drops a required one, must become a non-zero build failure locally and
// in CI.
//
// This file pins the two operator-facing message shapes and the direction the
// assertion checks in. It replaces the two old guards
// (`assertNoUnselectedMicroservice`, `assertNoNonRequiredSharedPackage`), each
// of which iterated a DISCOVERED set and probed for presence — a design that
// could express soundness only, and only for entries some set still knew about.
// The new assertion enumerates what is actually under the scope directory and
// compares it against the justified set read off `plan.stage`, so both
// directions are expressible: an entry belonging to no discovered category is
// still caught (R7.9), and an absent required entry is caught at all (R7.11).
//
// A real temp `outDir` is used rather than a stubbed lister: the entries are
// physically created under `<outDir>/node_modules/@microservices/` and the real
// exported `listScopedEntries` reads them back, so these cases also pin that
// the assertion and the lister agree on where the scope directory is. Generated
// coverage over plans × entry sets lives in
// `image-tree.integrity.property.test.ts` (Property 22); this file stays on
// examples.
//
// Validates: Requirements 7.7, 7.8, 7.9, 7.11

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SCOPE_DIR,
  type BuildPlan,
  type StagedPackage,
} from "../src/build-plan.js";
import {
  assertImageTreeIntegrity,
  listScopedEntries,
} from "../src/image-tree.js";

/** A staged package landing at `node_modules/@microservices/<entry>`. */
function scoped(
  entry: string,
  justification: StagedPackage["justification"],
): StagedPackage {
  return {
    sourceDir: `packages/${entry}`,
    targetDir: `${SCOPE_DIR}/${entry}`,
    scopedEntry: entry,
    justification,
  };
}

/**
 * A plan whose only field the Integrity_Assertion reads — `stage` — carries the
 * given members. The other fields are present because `BuildPlan` requires
 * them, not because the assertion consults them.
 */
function planStaging(stage: readonly StagedPackage[]): BuildPlan {
  return {
    selected: [],
    requiredDependencies: [],
    spaBuilds: [],
    tscRoots: [],
    stage,
  };
}

describe("assertImageTreeIntegrity", () => {
  let outDir: string;
  let scopeDir: string;

  /** Physically create `<outDir>/node_modules/@microservices/<entry>`. */
  function stageDir(entry: string): void {
    mkdirSync(join(scopeDir, entry), { recursive: true });
  }

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "image-tree-integrity-"));
    scopeDir = join(outDir, SCOPE_DIR);
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("accepts a tree whose entries are exactly the plan's justified entries", () => {
    const plan = planStaging([
      scoped("contracts", "framework-singleton"),
      scoped("config", "required-dependency"),
      scoped("microservice2", "selected-microservice"),
      // The Overseer ships at its own package directory, so it contributes no
      // scope entry and must not be demanded under the scope.
      {
        sourceDir: "packages/overseer",
        targetDir: "packages/overseer",
        scopedEntry: undefined,
        justification: "framework-singleton",
      },
    ]);

    stageDir("contracts");
    stageDir("config");
    stageDir("microservice2");

    expect(() =>
      assertImageTreeIntegrity(outDir, plan, listScopedEntries),
    ).not.toThrow();
  });

  it("rejects an unjustified entry, naming it and the scope directory", () => {
    const plan = planStaging([scoped("contracts", "framework-singleton")]);

    stageDir("contracts");
    stageDir("microservice3"); // never selected, never required

    expect(() =>
      assertImageTreeIntegrity(outDir, plan, listScopedEntries),
    ).toThrowError(
      `[image-tree:unjustified] ${scopeDir} contains "microservice3" — the Image_Tree must contain only the Selected_Microservices, the Required_Dependencies, and the always-staged Framework_Singletons`,
    );
  });

  it("names every unjustified entry, sorted, rather than only the first", () => {
    const plan = planStaging([scoped("contracts", "framework-singleton")]);

    stageDir("contracts");
    // Created out of order to pin that the message is sorted, not
    // directory-order.
    stageDir("stray-z");
    stageDir("stray-a");
    // A stray FILE under the scope is an offender too: the assertion enumerates
    // direct entries, not just directories (R7.9).
    writeFileSync(join(scopeDir, "LEAKED.txt"), "");

    expect(() =>
      assertImageTreeIntegrity(outDir, plan, listScopedEntries),
    ).toThrowError(
      `[image-tree:unjustified] ${scopeDir} contains "LEAKED.txt", "stray-a", "stray-z" — the Image_Tree must contain only the Selected_Microservices, the Required_Dependencies, and the always-staged Framework_Singletons`,
    );
  });

  it("rejects a justified entry that is absent, naming every absent package", () => {
    const plan = planStaging([
      scoped("contracts", "framework-singleton"),
      scoped("config", "required-dependency"),
      scoped("microservice2", "selected-microservice"),
    ]);

    // Only `contracts` made it into the tree.
    stageDir("contracts");

    expect(() =>
      assertImageTreeIntegrity(outDir, plan, listScopedEntries),
    ).toThrowError(
      `[image-tree:missing] ${scopeDir} is missing "config", "microservice2" — every selected microservice, every Required_Dependency, and every always-staged Framework_Singleton must be present`,
    );
  });

  it("treats an absent scope directory as every justified entry missing", () => {
    const plan = planStaging([scoped("contracts", "framework-singleton")]);

    // Nothing staged at all: the scope directory itself was never created.
    expect(() =>
      assertImageTreeIntegrity(outDir, plan, listScopedEntries),
    ).toThrowError(
      `[image-tree:missing] ${scopeDir} is missing "contracts" — every selected microservice, every Required_Dependency, and every always-staged Framework_Singleton must be present`,
    );
  });

  it("reports the unjustified entries first when the tree is both unsound and incomplete", () => {
    const plan = planStaging([
      scoped("contracts", "framework-singleton"),
      scoped("microservice1", "selected-microservice"),
    ]);

    stageDir("contracts");
    stageDir("microservice3"); // unjustified; `microservice1` never staged

    expect(() =>
      assertImageTreeIntegrity(outDir, plan, listScopedEntries),
    ).toThrowError(/^\[image-tree:unjustified\]/);
  });
});

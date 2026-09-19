// Stale-documentation guard over the steering docs and the README.
//
// This guard keeps the consumer-facing docs describing the CURRENT mechanism,
// not a retired one. It has two feature lineages:
//
//   * spa-common-consumption (design "Testing Strategy", R8.5): a negative
//     deny-list over `README.md` and `.kiro/steering/structure.md` for the five
//     phrases that feature retired when the Demo_Spa gained its
//     `@microservices/extended-config` dependency and the shipped configurations
//     became three.
//
//   * config-driven-discovery (Requirement 16, Step 10): the scope and the
//     discovery roots became configuration (`scaffold.config.json`) rather than
//     literals baked into the Build_System, and the Scope_Rename_Script retired.
//     The steering docs must now describe THAT — and must not describe the old
//     literal mechanism, the retired script, or any out-of-scope future work.
//
// The guard reads the docs and writes nothing to the tree.
//
// Validates: Requirements 8.5 (spa-common-consumption); Requirement 16
//            (config-driven-discovery)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

function readDoc(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// spa-common-consumption: the five retired phrases (R8.5)
// ---------------------------------------------------------------------------
//
// Each phrase is assembled from fragments so this source never contains a
// forbidden phrase as one contiguous literal. Matched case-insensitively over
// `README.md` and `.kiro/steering/structure.md`.

const SPA_COMMON_SCANNED_DOCS = [
  "README.md",
  ".kiro/steering/structure.md",
] as const;

const SPA_COMMON_FORBIDDEN_PHRASES = [
  `true ${"sink"}`,
  `dependency ${"sink"}`,
  `declares no ${"@microservices"}-scoped dependency`,
  `both shipped ${"Container"} configurations`,
  `two shipped ${"Container"} configurations`,
] as const;

describe("no retired phrase survives in the spa-common docs (R8.5)", () => {
  it.each(SPA_COMMON_SCANNED_DOCS)(
    "%s contains none of the forbidden phrases",
    (doc) => {
      const haystack = readDoc(doc).toLowerCase();

      const offenders = SPA_COMMON_FORBIDDEN_PHRASES.filter((phrase) =>
        haystack.includes(phrase.toLowerCase()),
      );

      expect(
        offenders,
        `${doc} retains retired phrase(s):\n${offenders.join("\n")}`,
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// config-driven-discovery: the steering docs describe the CONFIGURED mechanism
// (Requirement 16)
// ---------------------------------------------------------------------------

const TECH = ".kiro/steering/tech.md";
const STRUCTURE = ".kiro/steering/structure.md";
const STEERING_DOCS = [TECH, STRUCTURE] as const;

// The retired Scope_Rename_Script's name, assembled from fragments so this
// source never contains it contiguously. No steering doc may reference it (R16.7).
const RENAME_SCRIPT_NAME = "rename" + "-" + "scope";

// Out-of-scope future work the docs must NOT describe (R16.9). Each is a
// phrase drawn from the deferred behaviours of the feature.
const OUT_OF_SCOPE_PHRASES = [
  "published platform package",
  "registry inversion",
  "wiring generator",
] as const;

describe("the steering docs describe the config-driven mechanism (R16)", () => {
  it("neither steering doc references the retired Scope_Rename_Script (R16.7)", () => {
    const offenders = STEERING_DOCS.filter((doc) =>
      readDoc(doc).includes(RENAME_SCRIPT_NAME),
    );
    expect(
      offenders,
      `a steering doc still references the retired scope-rename script:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("tech.md documents the Project_Config_File and its recognised keys (R16.1)", () => {
    const tech = readDoc(TECH);
    expect(tech).toContain("scaffold.config.json");
    // Both recognised top-level keys and the three roots keys.
    expect(tech).toContain("`scope`");
    expect(tech).toContain("`roots`");
    for (const key of ["microservice", "common", "spa"]) {
      expect(tech).toContain(key);
    }
    // The four defaults appear as concrete values.
    expect(tech).toContain("@microservices");
    expect(tech).toContain("packages/microservices");
    expect(tech).toContain("packages/common");
    expect(tech).toContain("packages/spa");
  });

  it("tech.md states load-once-and-thread (R16.2)", () => {
    const tech = readDoc(TECH).toLowerCase();
    expect(tech).toContain("once per run");
    expect(tech).toContain("thread");
  });

  it("tech.md names the four Load_Bearing_Settings and the extends rule (R16.3, R16.4)", () => {
    const tech = readDoc(TECH);
    for (const setting of ["composite", "declaration", "outDir", "rootDir"]) {
      expect(tech).toContain(setting);
    }
    // A value inherited through `extends` satisfies the check.
    expect(tech.toLowerCase()).toContain("extends");
    // The reason outDir/rootDir stay in each package's own tsconfig.
    expect(tech).toContain("tsconfig.base.json");
  });

  it("tech.md states changing the scope is a scope-key edit (R16.7, R16.11)", () => {
    const tech = readDoc(TECH).toLowerCase();
    expect(tech).toContain("one-field edit");
    // A rejected config fails before discovery.
    expect(tech).toContain("before any package is discovered");
  });

  it("tech.md documents the WORKSPACE_SCOPE build argument (R16.12)", () => {
    const tech = readDoc(TECH);
    expect(tech).toContain("WORKSPACE_SCOPE");
    expect(tech).toContain("--build-arg");
  });

  it("structure.md presents roots as configured with defaults (R16.5, R16.6)", () => {
    const structure = readDoc(STRUCTURE);
    expect(structure).toContain("Discovery_Root");
    expect(structure).toContain("Root_Default");
    // Relocating a root requires the same-change workspaces update, reported by
    // check:invariants as a Workspace_Coverage mismatch.
    expect(structure).toContain("workspaces");
    expect(structure).toContain("check:invariants");
    expect(structure).toContain("Workspace_Coverage");
  });

  it("structure.md states the Emit_Script derives from the roots, not the scope (R16.8)", () => {
    const structure = readDoc(STRUCTURE);
    expect(structure).toContain("Exclusion_List");
    // The scope is NOT among the values the emit script reads.
    expect(structure.toLowerCase()).toContain(
      "scope is not among the values",
    );
  });

  it("structure.md states a Consumer_Package name is scope + directory name (R16.10)", () => {
    const structure = readDoc(STRUCTURE);
    expect(structure).toContain("Configured_Scope");
    expect(structure).toContain("Framework_Singleton");
  });

  it("no steering doc describes out-of-scope future work (R16.9)", () => {
    const offenders: string[] = [];
    for (const doc of STEERING_DOCS) {
      const haystack = readDoc(doc).toLowerCase();
      for (const phrase of OUT_OF_SCOPE_PHRASES) {
        if (haystack.includes(phrase.toLowerCase())) {
          offenders.push(`${doc}: ${phrase}`);
        }
      }
    }
    expect(
      offenders,
      `a steering doc describes out-of-scope future work:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

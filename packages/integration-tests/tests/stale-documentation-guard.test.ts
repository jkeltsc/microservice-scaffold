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
// ---------------------------------------------------------------------------
// registry-inversion: no consumer-facing document names the retired registry
// mechanism (R15.14)
// ---------------------------------------------------------------------------
//
// This feature moved the generated registry out of the Overseer's source tree
// and into the Entry_Package, and retired four things with it: the
// Registry_Template, the Template_Copy_Step (the root `prepare` script that
// copied it), the `[scope:template]` check, and the Retired_Testing_Specifier
// (the arbitraries' old home under `contracts`). A document that still names
// any of them describes a mechanism that no longer exists.
//
// Scope. The Steering_Documents are `.kiro/steering/tech.md` and
// `.kiro/steering/structure.md`; `README.md` is scanned alongside them because
// R7.9 puts it under the same naming obligation and the spa-common block above
// already scans it. `.kiro/steering/platform-split.md` is deliberately NOT
// scanned: it is a decision record describing the *programme of work*, so it
// legitimately narrates the retired arrangement as the history it is
// ("the root `prepare` script that copies the empty registry template retires
// with it", and the arbitraries' pre-move specifier). Requirement 15's open
// questions say that record is corrected when it is next revised and that
// nothing in this feature depends on its wording.
//
// Reporting. Unlike the two blocks above, this one scans line by line and names
// the offending document AND line, because that is the failure shape R15.14
// specifies.

const REGISTRY_INVERSION_SCANNED_DOCS = ["README.md", TECH, STRUCTURE] as const;

// Each needle is assembled from fragments so this source never contains a
// forbidden string contiguously.
const RETIRED_REGISTRY_DIR = "packages/" + "overseer" + "/src/generated";
const REGISTRY_TEMPLATE_BASENAME = "microservice-registry" + ".template";
const SCOPE_TEMPLATE_TAG = "[scope" + ":template]";
// Scope-independent: the Retired_Testing_Specifier is
// `<Configured_Scope>/contracts/testing`, so the scope-free tail is the needle.
const RETIRED_TESTING_SPECIFIER = "contracts" + "/testing";

interface RetiredMechanismRule {
  readonly what: string;
  readonly matches: (lowercasedLine: string) => boolean;
}

const RETIRED_MECHANISM_RULES: readonly RetiredMechanismRule[] = [
  {
    what: `the retired generated-registry path (${RETIRED_REGISTRY_DIR})`,
    matches: (line) => line.includes(RETIRED_REGISTRY_DIR),
  },
  {
    what: `the Registry_Template (${REGISTRY_TEMPLATE_BASENAME})`,
    matches: (line) => line.includes(REGISTRY_TEMPLATE_BASENAME),
  },
  {
    // The Template_Copy_Step is a *statement*, not a token, so it is matched as
    // a co-occurrence rather than by banning the word `prepare` outright: a
    // future document may legitimately mention npm's `prepare` lifecycle in
    // another context, and `Dockerfile.template` is named on many current
    // lines. What no longer exists is an install-time step touching the
    // registry or a template — so a single line naming the `prepare` script
    // together with either one is the retired claim.
    what:
      "the Template_Copy_Step (a line naming the `prepare` script together " +
      "with the registry or a template)",
    matches: (line) =>
      line.includes("prepare") &&
      (line.includes("registry") || line.includes("template")),
  },
  {
    what: `the retired ${SCOPE_TEMPLATE_TAG} check`,
    matches: (line) => line.includes(SCOPE_TEMPLATE_TAG),
  },
  {
    what: `the Retired_Testing_Specifier (…/${RETIRED_TESTING_SPECIFIER})`,
    matches: (line) => line.includes(RETIRED_TESTING_SPECIFIER),
  },
];

/**
 * Reports one `<doc>:<line>: <what>` entry per retired-mechanism mention, so a
 * failure names both the offending document and the offending line. Exported
 * shape kept simple on purpose: the teeth test below drives it over a synthetic
 * document rather than writing a file into the checked-out tree.
 */
function retiredMechanismOffenders(doc: string, text: string): string[] {
  const offenders: string[] = [];
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lowercased = lines[index]!.toLowerCase();
    for (const rule of RETIRED_MECHANISM_RULES) {
      if (rule.matches(lowercased)) {
        offenders.push(`${doc}:${index + 1}: ${rule.what}`);
      }
    }
  }

  return offenders;
}

describe("no document names the retired registry mechanism (R15.14)", () => {
  it.each(REGISTRY_INVERSION_SCANNED_DOCS)(
    "%s names none of the retired mechanisms",
    (doc) => {
      const offenders = retiredMechanismOffenders(doc, readDoc(doc));

      expect(
        offenders,
        `${doc} still names a retired mechanism:\n${offenders.join("\n")}`,
      ).toEqual([]);
    },
  );

  // The guard has teeth: each rule fires over a synthetic document held in
  // memory, and the report carries the line number. No file is written.
  const TEETH_CASES: readonly {
    readonly name: string;
    readonly line: string;
  }[] = [
    {
      name: "the retired generated-registry path",
      line: `The registry lives at ${RETIRED_REGISTRY_DIR}/microservice-registry.ts.`,
    },
    {
      name: "the Registry_Template",
      line: `A committed ${REGISTRY_TEMPLATE_BASENAME}.ts stands in for it.`,
    },
    {
      name: "the Template_Copy_Step",
      line: "The root `prepare` script copies the empty registry template.",
    },
    {
      name: "the [scope:template] check",
      line: `\`check:invariants\` performs the ${SCOPE_TEMPLATE_TAG} check.`,
    },
    {
      name: "the Retired_Testing_Specifier",
      line: `Import them from \`@microservices/${RETIRED_TESTING_SPECIFIER}\`.`,
    },
  ];

  it.each(TEETH_CASES)("fails on a document naming $name", ({ line }) => {
    // The offending line is line 3 of the synthetic document.
    const synthetic = ["# Heading", "", line, "", "Trailing prose."].join("\n");

    const offenders = retiredMechanismOffenders("synthetic.md", synthetic);

    expect(offenders.length).toBeGreaterThan(0);
    for (const offender of offenders) {
      expect(offender.startsWith("synthetic.md:3: ")).toBe(true);
    }
  });

  it("reports a clean synthetic document as clean", () => {
    const clean = [
      "# Heading",
      "",
      "The generated registry lives at `app/src/generated/microservice-registry.ts`.",
      "`Dockerfile.template` is committed source.",
      "The arbitraries live under `packages/build-tools/src/testing/`.",
    ].join("\n");

    expect(retiredMechanismOffenders("synthetic.md", clean)).toEqual([]);
  });
});

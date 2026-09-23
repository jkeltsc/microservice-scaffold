// Feature: platform-fixtures — the Fixture_Equivalent of the payload-coupled
// Emit_Script claim (design "the ordering argument").
//
// `effective-dockerfile.test.ts` (its "generates manifest COPY lines" and
// selector-pinning blocks) and `emit-dockerfile-config.test.ts` are the
// payload-coupled claims about the Emit_Script (`scripts/emit-effective-dockerfile.sh`):
// over THIS repository's committed tree they assert the emitted manifest `COPY`
// lines name each discovered non-excluded workspace and the Entry_Package, and
// the emitted `ENV MICROSERVICE_<ID>_ENABLED=enabled` toggle lines name each
// selector-resolved microservice. Every one of those assertions would change if
// a package of the Payload_Tree were renamed, relocated, or removed, so they are
// coupled to the payload. This suite is their Fixture_Equivalent (R13.1): it
// asserts the SAME claim — the emitted manifest `COPY` lines and the emitted
// toggle `ENV` lines — but over a fixture subject the platform is pointed at
// rather than over the committed `packages/` tree, and it asserts NO fact about
// the Payload_Tree (R13.7). The two passing together is the evidence that a
// fixture subject yields the Dockerfile the payload-coupled tests assert over the
// real tree.
//
// Why a materialised subject rather than a committed Tree_Fixture (R2.6). The
// Emit_Script is dependency-free POSIX sh + awk: its whole interface is a
// working directory holding a `Dockerfile.template`, an optional
// `scaffold.config.json`, and the workspace manifests under the configured roots
// (design "The Fixture_Tier is excluded from every platform mechanism", R10.9).
// The committed Tree_Fixtures under `fixtures/trees/` are hostile — each is built
// to provoke a config or discovery Diagnostic_Tag — and none carries a
// `Dockerfile.template`, so the Emit_Script's manifest/ENV emission has no
// subject there. This equivalent therefore builds a well-formed subject tree —
// a `Dockerfile.template`, a `scaffold.config.json`, and per-category manifests —
// inside an OS temporary directory, points the Emit_Script at it exactly as R2.6
// prescribes (the scenario's directory as the working directory of the spawned
// process), and derives every reported path from that directory. It is a fixture
// the same way the committed trees are, just one the Emit_Script can succeed
// over rather than fail over, so it is built rather than committed. This mirrors
// `emit-dockerfile.property.test.ts`, which drives the same real script over
// generated temp skeletons for the same reason.
//
// Derived-configuration discipline (R13.2): the subject's Configured_Scope, its
// three Discovery_Roots, and its Entry_Root are declared once in a description,
// and every path this suite reports is composed from that description through
// `projectContext(effectiveConfigOf(subject))` — never from a `packages/...`
// path literal or an `@microservices` scope literal of the suite's own. The
// subject deliberately uses a Configured_Scope OTHER than the Scope_Default and a
// set of Discovery_Roots ALL differing from their Root_Defaults, so the fixture
// subject does not silently re-import the assumptions the payload-coupled tests
// carried (R13.6). (The scope reaches the Emit_Script through neither the config
// nor an ENV — the Emit_Script never reads the scope; the COPY/ENV claim is about
// PATHS and identifiers, which the roots and directory names alone determine, so
// a non-default scope changes no emitted line and is asserted here only to keep
// the subject genuinely non-default.)
//
// Worktree discipline (R11.2, R11.3, R7.7): every byte this suite writes — the
// subject tree, the `Dockerfile.template` copied into it, and the generated
// Dockerfile the Emit_Script writes — lands inside ONE temporary root created in
// `beforeAll` and removed in `afterAll`, whether the assertions pass or fail. The
// Emit_Script is spawned with `cwd` pinned to the subject directory and
// `EFFECTIVE_DOCKERFILE` pointing inside it, so the repository's own gitignored
// `Dockerfile` is never touched. The `scripts/` directory the Emit_Script lives
// in is reached through a symlink into the real repository, so the script under
// test is the committed one, invoked as documented. Nothing is written into the
// checked-out tree, and no committed fixture is read or touched.
//
// Validates: Requirements 2.6, 13.1, 13.2, 13.3, 13.7

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultEffectiveConfig } from "@microservices/build-tools/dist/project-config.js";
import { projectContext } from "@microservices/build-tools/dist/project-context.js";
import { resolveSelected } from "@microservices/build-tools/dist/selector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root. The Emit_Script and the
// committed Dockerfile.template are read from the platform's OWN tree, reached
// from this file's location, never from the fixture subject.
const repoRoot = resolve(__dirname, "..", "..", "..");
const realScriptsDir = resolve(repoRoot, "scripts");
const committedTemplate = readFileSync(
  resolve(repoRoot, "Dockerfile.template"),
  "utf8",
);

// ---------------------------------------------------------------------------
// The subject fixture — a well-formed tree at a Configured_Scope OTHER than the
// default and with a set of Discovery_Roots ALL differing from their defaults
// (R13.6). Written as a fixed description so the claim is a deterministic
// example the way the payload-coupled emit test is a deterministic example — no
// `@microservices` literal and no default `packages/...` root appears in the
// suite's own assertions.
// ---------------------------------------------------------------------------

type ConsumerCategory = "microservice" | "common" | "spa";

interface SubjectPackage {
  readonly category: ConsumerCategory;
  readonly dirName: string;
}

interface Subject {
  readonly scope: string;
  readonly roots: Readonly<Record<ConsumerCategory, string>>;
  readonly entryRoot: string;
  /** Direct `packages/*` entries that are NOT a Discovery_Root container: each
   *  is a top-level package the manifest block must COPY (a well-formed
   *  Framework_Singleton-shaped directory, well outside any Discovery_Root). */
  readonly topLevelPackages: readonly string[];
  /** The per-category consumer packages, discovered under the roots below. */
  readonly packages: readonly SubjectPackage[];
}

const SUBJECT: Subject = {
  scope: "@acme",
  roots: {
    microservice: "services",
    common: "libs",
    spa: "frontends",
  },
  entryRoot: "entrypoint",
  // Two top-level packages under `packages/` that are not Discovery_Root
  // containers — the manifest block emits a COPY for each. One is named
  // `integration-tests`, the by-name Exclusion_List entry, so this subject also
  // exercises that exclusion: it must get NO COPY line while `keep` does.
  topLevelPackages: ["keep", "integration-tests"],
  packages: [
    { category: "microservice", dirName: "alpha" },
    { category: "microservice", dirName: "bravo" },
    { category: "microservice", dirName: "charlie" },
    { category: "common", dirName: "shared" },
    { category: "spa", dirName: "web" },
  ],
};

// The context threads the subject's OWN scope, roots and Entry_Root — no literal
// is substituted. Every path the assertions compose comes from it.
const subjectConfig = {
  scope: SUBJECT.scope,
  roots: { ...SUBJECT.roots },
  entry: SUBJECT.entryRoot,
};
const context = projectContext(subjectConfig);

/** The microservice identifiers of the subject, in ascending byte order — the
 *  order the Emit_Script's `LC_ALL=C` glob expansion produces, and the order
 *  `resolveSelected("*", …)` preserves. */
const subjectMicroserviceIds = SUBJECT.packages
  .filter((pkg) => pkg.category === "microservice")
  .map((pkg) => pkg.dirName)
  .sort();

// ---------------------------------------------------------------------------
// Oracle — the emitted lines the subject implies, composed from the subject's
// own configuration through the threaded context.
// ---------------------------------------------------------------------------

const MANIFEST_HEADER =
  "# --- manifest COPY (generated by scripts/emit-effective-dockerfile.sh) ---";
const ROOT_COPY = "COPY package.json package-lock.json ./";

function copyLine(packageDir: string): string {
  return `COPY ${packageDir}/package.json ${packageDir}/`;
}

/** The Manifest_Copy_Block the subject implies (R11.3, R11.4): the root
 *  manifests first, then one COPY per non-excluded top-level package in byte
 *  order, then one group per configured Discovery_Root in the fixed order
 *  microservice, common, spa (each group in byte order), and LAST the
 *  Entry_Package's own manifest — appended unconditionally. Every path is
 *  composed from the subject's roots via the context, so the block re-imports no
 *  default root. */
function expectedManifestBlock(): string[] {
  // Top-level `packages/<name>` entries, minus the by-name Exclusion_List entry
  // `integration-tests`; a Discovery_Root that pointed at `packages/<name>`
  // would also be excluded, but this subject's roots are OUTSIDE `packages/`, so
  // none of them collides with a top-level entry.
  const topLevel = [...SUBJECT.topLevelPackages]
    .filter((name) => name !== "integration-tests")
    .sort()
    .map((name) => copyLine(`packages/${name}`));

  const categoryOrder: readonly ConsumerCategory[] = [
    "microservice",
    "common",
    "spa",
  ];
  const groups = categoryOrder.flatMap((category) =>
    SUBJECT.packages
      .filter((pkg) => pkg.category === category)
      .map((pkg) => pkg.dirName)
      .sort()
      .map((dirName) => copyLine(`${SUBJECT.roots[category]}/${dirName}`)),
  );

  return [
    ROOT_COPY,
    ...topLevel,
    ...groups,
    // The Entry_Package's manifest, appended last (registry-inversion R7.4).
    copyLine(context.entryRoot),
  ];
}

/** The toggle-default ENV lines the subject implies for a selector: one
 *  `ENV MICROSERVICE_<ID>_ENABLED=enabled` per resolved microservice identifier,
 *  uppercased, in the resolved order (R11.6). */
function expectedEnvLines(selector: string | undefined): string[] {
  return resolveSelected(selector, subjectMicroserviceIds).map(
    (id) => `ENV MICROSERVICE_${id.toUpperCase()}_ENABLED=enabled`,
  );
}

// ---------------------------------------------------------------------------
// Subject materialisation
// ---------------------------------------------------------------------------

/** Write a minimal well-formed manifest at `<dir>/package.json`. */
function writeManifest(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name, version: "0.0.0", private: true })}\n`,
    "utf8",
  );
}

/**
 * Materialise the subject inside `baseDir` and return its root. The tree carries
 * a `Dockerfile.template` (the committed one, so the anchors and ENTRYPOINT the
 * Emit_Script keys off are the real ones), a `scaffold.config.json` declaring the
 * subject's non-default scope, roots, and entry, the root manifests, the
 * top-level packages, and one manifest per consumer package under its configured
 * Discovery_Root. A `scripts` symlink into the real repository lets the
 * Emit_Script be invoked exactly as documented with the subject as cwd.
 */
function materialiseSubject(baseDir: string): string {
  const root = mkdtempSync(join(baseDir, "emit-fixture-subject-"));

  writeFileSync(join(root, "Dockerfile.template"), committedTemplate, "utf8");
  writeFileSync(
    join(root, "scaffold.config.json"),
    `${JSON.stringify(subjectConfig, null, 2)}\n`,
    "utf8",
  );
  // Root manifests: the block's first COPY line names both unconditionally.
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "emit-fixture-subject", private: true })}\n`,
    "utf8",
  );
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  // Reach the committed Emit_Script through a symlink, so the script under test
  // is the platform's own, invoked with the subject as cwd.
  symlinkSync(realScriptsDir, join(root, "scripts"), "dir");

  // Top-level `packages/<name>` entries.
  for (const name of SUBJECT.topLevelPackages) {
    writeManifest(join(root, "packages", name), name);
  }

  // Consumer packages, each under its configured Discovery_Root, with a scoped
  // directory-mirroring name — the Emit_Script never reads the name, but a
  // well-formed one keeps the subject a faithful project.
  for (const pkg of SUBJECT.packages) {
    const rootDir = SUBJECT.roots[pkg.category];
    writeManifest(
      join(root, ...rootDir.split("/"), pkg.dirName),
      context.scopedName(pkg.dirName),
    );
  }

  return root;
}

// ---------------------------------------------------------------------------
// Running the Emit_Script over the subject
// ---------------------------------------------------------------------------

interface EmitResult {
  readonly status: number;
  readonly stderr: string;
  readonly out: string;
}

/**
 * Spawn the committed Emit_Script with the subject directory as its working
 * directory (R2.6) and the selector in `MICROSERVICES`. The generated Dockerfile
 * is written inside the subject (`EFFECTIVE_DOCKERFILE` relative to cwd), never
 * to the repository's own `Dockerfile`.
 */
function emit(subjectRoot: string, selector: string | undefined): EmitResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DOCKERFILE: "Dockerfile.template",
    EFFECTIVE_DOCKERFILE: "Dockerfile.generated",
  };
  delete env.MICROSERVICES;
  if (selector !== undefined) env.MICROSERVICES = selector;

  const run = spawnSync("sh", ["scripts/emit-effective-dockerfile.sh"], {
    cwd: subjectRoot,
    env,
    encoding: "utf8",
  });

  let out = "";
  try {
    out = readFileSync(join(subjectRoot, "Dockerfile.generated"), "utf8");
  } catch {
    // A failing run writes nothing; the caller asserts on status/stderr.
  }

  return { status: run.status ?? -1, stderr: run.stderr ?? "", out };
}

/** The Manifest_Copy_Block(s) in an emitted Dockerfile: each generated header
 *  line plus the run of `COPY` lines immediately following it. */
function manifestBlocks(emitted: string): string[][] {
  const lines = emitted.split("\n");
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== MANIFEST_HEADER) continue;
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith("COPY ")) {
      block.push(lines[j]);
      j += 1;
    }
    blocks.push(block);
  }
  return blocks;
}

/** The toggle-default ENV lines in an emitted Dockerfile, in source order. */
function envLines(emitted: string): string[] {
  return emitted
    .split("\n")
    .filter((line) => /^ENV MICROSERVICE_[A-Z0-9_]+_ENABLED=enabled$/.test(line));
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe("Feature: platform-fixtures: the Emit_Script's manifest COPY and toggle ENV lines over a fixture subject (Fixture_Equivalent of effective-dockerfile)", () => {
  let workDir: string;
  let subjectRoot: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "emit-dockerfile-fixture-"));
    subjectRoot = materialiseSubject(workDir);
  });

  afterAll(() => {
    // Runs whether the assertions passed or failed; removes the one temp root.
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it("uses a non-default Configured_Scope and non-default Discovery_Roots (R13.6)", () => {
    // Guards that the subject genuinely differs from the defaults, so the claims
    // below are not silently re-importing the payload-coupled test's assumptions.
    const defaults = projectContext(defaultEffectiveConfig());
    expect(context.scopedName("alpha")).not.toBe(defaults.scopedName("alpha"));
    expect(SUBJECT.roots.microservice).not.toBe(defaults.roots.microservice);
    expect(SUBJECT.roots.common).not.toBe(defaults.roots.common);
    expect(SUBJECT.roots.spa).not.toBe(defaults.roots.spa);
    expect(context.entryRoot).not.toBe(defaults.entryRoot);
  });

  it("emits, at both anchors, one manifest COPY line per discovered non-excluded workspace and the Entry_Package last (R13.1)", () => {
    const { status, stderr, out } = emit(subjectRoot, "*");
    expect(status, `emit stderr: ${stderr}`).toBe(0);

    const expected = expectedManifestBlock();
    const blocks = manifestBlocks(out);

    // One block per anchor, and the two are character-identical.
    expect(blocks).toHaveLength(2);
    expect(blocks[0].join("\n")).toBe(blocks[1].join("\n"));

    // Exact content AND exact order — the whole reported block, not a subset.
    expect(blocks[0]).toEqual(expected);

    // The by-name Exclusion_List entry contributes no COPY line at all, while a
    // sibling top-level package does — over the subject's own paths.
    expect(out).not.toContain(
      "COPY packages/integration-tests/package.json",
    );
    expect(out).toContain(copyLine("packages/keep"));

    // A consumer package under a NON-default Discovery_Root is COPYed at that
    // relocated path — no default `packages/microservices/...` path appears.
    expect(out).toContain(
      copyLine(`${SUBJECT.roots.microservice}/alpha`),
    );
    expect(out).not.toContain("packages/microservices/alpha/package.json");
  });

  it("emits, for the all-selector, one toggle ENV line per discovered microservice (R13.1)", () => {
    const { status, stderr, out } = emit(subjectRoot, "*");
    expect(status, `emit stderr: ${stderr}`).toBe(0);

    // `*` resolves to every discovered microservice, in byte order.
    expect(envLines(out)).toEqual(expectedEnvLines("*"));
  });

  it("emits, for a comma-separated list selector, exactly the named microservices' toggle ENV lines in the list's order (R13.1)", () => {
    // A list in an order that is genuinely not the discovery order, so "the
    // order the identifiers appear in the list" is a real claim.
    const selector = "charlie,alpha";
    const { status, stderr, out } = emit(subjectRoot, selector);
    expect(status, `emit stderr: ${stderr}`).toBe(0);

    expect(envLines(out)).toEqual(expectedEnvLines(selector));
    // The manifest block is selector-independent: it still names every
    // discovered workspace, not just the selected microservices.
    expect(manifestBlocks(out)[0]).toEqual(expectedManifestBlock());
  });
});

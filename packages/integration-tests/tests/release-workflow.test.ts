// Narrow structural assertions on .github/workflows/release.yml (and the
// permissions block of ci.yml).
//
// WHY THIS TEST IS DELIBERATELY SMALL
//
// The obvious version of this test asserts everything in the YAML: that the
// checkout step exists, that buildx is set up, that each matrix leg carries
// the right selector. All of that is worthless. Every pull request runs
// release.yml for real: it builds both images via `docker build`, and the
// image-tree assembler's own integrity check verifies no unselected
// microservice leaked into the staged tree. A YAML assertion that those steps
// exist adds nothing a green run does not already prove, and it turns every
// harmless refactor of the workflow into a test failure.
//
// What a static test uniquely guards is the set of clauses whose failure is
// INVISIBLE or DEFERRED — things a green PR run cannot tell you:
//
//   * over-broad `permissions` never fails at runtime, it just grants too much;
//   * "did not publish on a PR" is an absence, and absences do not turn a run red;
//   * the tag rules only take effect on a push to main or a semver tag, i.e.
//     never on the PR that broke them;
//   * a deleted trigger produces silence, not a failure.
//
// So those four, plus the image-suffix naming rule that keeps the two shipped
// configurations from colliding in GHCR, are exactly what is asserted here —
// and nothing else.
//
// Validates: Requirements R11.2, R11.4, R11.5, R11.6, R11.7

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { load } from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The slice of a workflow document these assertions read. */
interface WorkflowStep {
  readonly id?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface Workflow {
  readonly on?: {
    readonly push?: { readonly branches?: string[]; readonly tags?: string[] };
    readonly pull_request?: { readonly branches?: string[] };
    // `workflow_dispatch:` with no body parses as null, so presence is what
    // matters, not the value.
    readonly workflow_dispatch?: unknown;
  };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<
    Record<
      string,
      {
        readonly strategy?: {
          readonly matrix?: {
            readonly include?: ReadonlyArray<Readonly<Record<string, string>>>;
          };
        };
        readonly steps?: readonly WorkflowStep[];
      }
    >
  >;
}

function loadWorkflow(name: string): Workflow {
  const path = resolve(repoRoot, ".github", "workflows", name);
  return load(readFileSync(path, "utf8")) as Workflow;
}

const release = loadWorkflow("release.yml");
const ci = loadWorkflow("ci.yml");

const releaseJob = release.jobs?.["build-and-publish"];

/** A step by `id`, failing loudly rather than returning undefined. */
function step(id: string): WorkflowStep {
  const found = releaseJob?.steps?.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`release.yml has no step with id "${id}"`);
  }
  return found;
}

/** The metadata-action `tags` input, split into non-empty lines. */
function tagRules(): string[] {
  const raw = step("meta").with?.tags;
  expect(typeof raw).toBe("string");
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("release.yml — clauses a workflow run cannot verify", () => {
  // R11.6. Excess permissions are not an error at runtime: the token simply
  // carries more authority than the job needs, and every run stays green. Only
  // a static check can hold the grant to its documented minimum.
  // id-token: write is required by the steering for OIDC federation readiness.
  it("grants exactly contents:read, packages:write, and id-token:write (R11.6)", () => {
    expect(release.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
    });
  });

  // R11.6, companion gate. ci.yml publishes nothing, so it must not be able to.
  it("keeps ci.yml read-only (R11.6)", () => {
    expect(ci.permissions).toEqual({ contents: "read" });
  });

  // R11.7. A pull-request run that wrongly published would still be green — the
  // push would succeed. The absence of a publish is unobservable from the run's
  // result, so the guard has to live in the YAML.
  it("gates publishing on the event not being a pull request (R11.7)", () => {
    expect(step("build").with?.push).toBe(
      "${{ github.event_name != 'pull_request' }}",
    );
  });

  // R11.5. These rules are dormant on a pull request: `latest` is disabled and
  // no semver tag exists. A mistake here first shows up on a release, when it
  // is expensive.
  it("tags every publish with the commit SHA (R11.5a)", () => {
    const sha = tagRules().filter((rule) => rule.startsWith("type=sha"));
    expect(sha).toHaveLength(1);
    // No `enable=` — this tag applies to every publish, not a subset.
    expect(sha[0]).not.toContain("enable=");
  });

  it("tags with the branch ref (R11.5b)", () => {
    const branch = tagRules().filter(
      (rule) => rule === "type=ref,event=branch",
    );
    expect(branch).toHaveLength(1);
  });

  it("tags with the tag ref (R11.5c)", () => {
    const tag = tagRules().filter((rule) => rule === "type=ref,event=tag");
    expect(tag).toHaveLength(1);
  });

  it("applies `latest` only on the default branch (R11.5d)", () => {
    const latest = tagRules().filter((rule) =>
      rule.startsWith("type=raw,value=latest"),
    );
    expect(latest).toHaveLength(1);
    expect(latest[0]).toContain("is_default_branch");
  });

  // R11.2. A removed trigger makes the pipeline stop running, which looks
  // exactly like "no recent changes". Nothing goes red; the release just never
  // happens.
  it("declares all four triggers (R11.2)", () => {
    expect(release.on?.push?.branches).toContain("main");
    expect(release.on?.push?.tags).toContain("v*.*.*");
    expect(release.on?.pull_request?.branches).toContain("main");
    expect(release.on).toHaveProperty("workflow_dispatch");
  });

  // R11.4. Two legs sharing an `image_suffix` would publish to one GHCR
  // repository, so the second build would silently overwrite the first — both
  // legs still green. The suffix rule (`*` -> `generic`; a comma list -> the
  // identifiers lowercased and joined with `-`) is asserted inline: the former
  // `deriveImageSuffix` helper was deleted as dead code and is not coming back.
  it("gives each shipped configuration a distinct, rule-derived image suffix (R11.4)", () => {
    const legs = releaseJob?.strategy?.matrix?.include ?? [];
    expect(legs.length).toBeGreaterThanOrEqual(2);

    const suffixes = legs.map((leg) => leg.image_suffix);
    expect(new Set(suffixes).size).toBe(suffixes.length);

    for (const leg of legs) {
      const selector = leg.selector.trim();
      const derived =
        selector === "*"
          ? "generic"
          : selector
              .split(",")
              .map((identifier) => identifier.trim().toLowerCase())
              .join("-");
      expect(leg.image_suffix, `image_suffix for selector "${selector}"`).toBe(
        derived,
      );
    }
  });
});

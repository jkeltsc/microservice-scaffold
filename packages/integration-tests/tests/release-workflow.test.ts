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
//
// This suite pins the shape of the shipped set — a static clause a green run
// cannot verify: the release matrix must publish EXACTLY the three shipped
// configurations — the Generic Container (Selector `*`), the Specific Container
// (Selector `microservice1,microservice2`), and the Spa_Only_Container
// (Selector `microservice1`) — with every selector value unchanged. A dropped
// leg, an added fourth leg, or a mutated selector still builds green on a PR
// (the extra/wrong image just publishes, or a leg silently stops), so only a
// static check holds the set to these three. The existing suite asserts the
// legs' distinct image suffixes and the trigger set; the added clauses pin the
// three selector VALUES (which the suffix test does not — it derives a suffix
// from whatever selector it finds), the Spa_Only_Container's `microservice1`
// suffix, and the three cleanup prune steps.
//
// The spa-common-consumption feature adds the third leg (the Spa_Only_Container)
// and its cleanup prune step; the count and enumeration clauses below moved from
// two to three, and the unchanged legs, the `fail-fast: false`, the permissions
// block, the tag rules, and the publish gate keep their assertions.
//
// Validates (added): Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.13, 6.14, 6.15

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
  readonly name?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly "continue-on-error"?: unknown;
}

interface WorkflowJob {
  readonly needs?: unknown;
  readonly strategy?: {
    readonly "fail-fast"?: unknown;
    readonly matrix?: {
      readonly include?: ReadonlyArray<Readonly<Record<string, string>>>;
    };
  };
  readonly steps?: readonly WorkflowStep[];
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
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

function loadWorkflow(name: string): Workflow {
  const path = resolve(repoRoot, ".github", "workflows", name);
  return load(readFileSync(path, "utf8")) as Workflow;
}

const release = loadWorkflow("release.yml");
const ci = loadWorkflow("ci.yml");

const releaseJob = release.jobs?.["build-and-publish"];
const cleanupJob = release.jobs?.["cleanup"];

/** A step by `id`, failing loudly rather than returning undefined. */
function step(id: string): WorkflowStep {
  const found = releaseJob?.steps?.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`release.yml has no step with id "${id}"`);
  }
  return found;
}

/** A step by `name`, failing loudly rather than returning undefined. */
function stepByName(name: string): WorkflowStep {
  const found = releaseJob?.steps?.find((s) => s.name === name);
  if (found === undefined) {
    throw new Error(`release.yml has no step named "${name}"`);
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
    expect(legs.length).toBeGreaterThanOrEqual(3);

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

  // R6.1 / R6.2. The shipped set is exactly the three configurations: the
  // Generic Container (`*`), the Specific Container
  // (`microservice1,microservice2`), and the Spa_Only_Container
  // (`microservice1`), and no fourth. A green PR run does not reveal an added,
  // dropped, or mutated selector — the suffix test above only checks that
  // whatever selectors are present derive distinct suffixes, not that they are
  // these three. This pins the three values themselves.
  it("publishes exactly the three shipped configurations `*`, `microservice1,microservice2`, `microservice1` (R6.1)", () => {
    const legs = releaseJob?.strategy?.matrix?.include ?? [];

    // Exactly three legs — not "at least three". A fourth shipped configuration
    // is a product decision this feature does not make.
    expect(legs).toHaveLength(3);

    // The selector values are exactly `*`, `microservice1,microservice2`, and
    // `microservice1`, set-equal and each present once, trimmed of incidental
    // whitespace.
    const selectors = legs.map((leg) => leg.selector.trim());
    expect(new Set(selectors)).toEqual(
      new Set(["*", "microservice1,microservice2", "microservice1"]),
    );
    expect(selectors).toHaveLength(3);
  });

  // R6.2 / R6.3. Three pairwise-distinct suffixes, and the Spa_Only_Container
  // (Selector `microservice1`) carries the literal suffix `microservice1`. A
  // colliding suffix would silently overwrite an image in GHCR, and a suffix
  // for the spa-only leg other than `microservice1` still builds green.
  it("gives three distinct suffixes and pins the spa-only leg's suffix to `microservice1` (R6.2, R6.3)", () => {
    const legs = releaseJob?.strategy?.matrix?.include ?? [];

    const suffixes = legs.map((leg) => leg.image_suffix);
    expect(new Set(suffixes).size).toBe(3);
    expect(suffixes).toHaveLength(3);

    const spaOnly = legs.find((leg) => leg.selector.trim() === "microservice1");
    expect(spaOnly, "the leg whose selector is `microservice1`").toBeDefined();
    expect(spaOnly?.image_suffix).toBe("microservice1");
  });

  // R6.6 / R6.14. The cleanup job prunes untagged versions only after every leg
  // has published, so it must declare `needs: build-and-publish` and hold a
  // prune step for the Spa_Only_Container's image (`<repo>-microservice1`) with
  // the same 10-version retention the other two use. A missing prune step is an
  // absence a green run never surfaces.
  it("prunes the spa-only image `<repo>-microservice1` after a successful publish (R6.6, R6.14)", () => {
    expect(cleanupJob?.needs).toBe("build-and-publish");

    const steps = cleanupJob?.steps ?? [];
    const pruneSteps = steps.filter(
      (s) => s.uses === "dataaxiom/ghcr-cleanup-action@v1",
    );

    // Three prune steps — one per shipped image name.
    expect(pruneSteps).toHaveLength(3);

    // The spa-only prune step names the `<repo>-microservice1` package and
    // keeps 10 untagged versions.
    const spaOnlyPrune = pruneSteps.find(
      (s) => s.with?.package === "${{ github.event.repository.name }}-microservice1",
    );
    expect(
      spaOnlyPrune,
      "prune step for package `<repo>-microservice1`",
    ).toBeDefined();
    expect(spaOnlyPrune?.with?.["keep-n-untagged"]).toBe(10);

    // Every prune step keeps the same 10-version retention.
    for (const prune of pruneSteps) {
      expect(prune.with?.["keep-n-untagged"]).toBe(10);
    }
  });

  // R6.7. `fail-fast: false` keeps one failing leg from cancelling the others,
  // so all three configurations are always attempted. A run with the default
  // (`true`) would cancel siblings on the first failure — invisible until a leg
  // actually fails.
  it("keeps the matrix `fail-fast: false` so one failing leg cancels no other (R6.7)", () => {
    expect(releaseJob?.strategy?.["fail-fast"]).toBe(false);
  });

  // R6.13 / R6.15. Each leg wires its selector through `matrix.selector` — the
  // emit step's `MICROSERVICES` env and the image build's `MICROSERVICES`
  // build-arg — so the spa-only leg builds `microservice1` from the same
  // parameterised steps as the other legs. A hard-coded selector would build
  // the wrong image while staying green.
  it("wires each leg's selector through matrix.selector for emit env and build-args (R6.13, R6.15)", () => {
    const generate = stepByName("Generate Dockerfile");
    expect(generate.env?.MICROSERVICES).toBe("${{ matrix.selector }}");

    const build = step("build");
    const buildArgs = build.with?.["build-args"];
    expect(typeof buildArgs).toBe("string");
    expect(String(buildArgs)).toContain("MICROSERVICES=${{ matrix.selector }}");
  });

  // R6.7, companion. `continue-on-error: true` on a leg would let a failing
  // build report the run as green, hiding a broken configuration. No leg sets
  // it — every step is either explicitly `false` or omits it.
  it("sets `continue-on-error: true` on no leg (R6.7)", () => {
    for (const s of releaseJob?.steps ?? []) {
      expect(s["continue-on-error"]).not.toBe(true);
    }
  });
});

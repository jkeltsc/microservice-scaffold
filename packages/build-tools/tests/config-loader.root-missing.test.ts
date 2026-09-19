// The relocated absent-microservice-root failure (Requirement 5.1), replacing
// the retired `discovery-container-missing.test.ts`.
//
// Before this feature, an absent `packages/microservices/` was caught inside
// discovery, which threw `[discovery:container-missing]`. Now the Config_Loader
// catches it first: `validateDiscoveryRoots` probes the three Discovery_Roots
// and reports `[config:root-missing]` for an absent microservice root, failing
// the run BEFORE discovery is ever called. Requirement 5.1 preserves the
// *handling* — the run fails, no Effective_Config is yielded, and no discovery
// runs — not the tag; the message change is the feature's one intentional one.
//
// The subject under test is `loadProjectConfig(readConfigFile, probeRoot)` from
// `config-loader.ts`, with both the reader and the prober INJECTED, so no
// `scaffold.config.json` is written into the checked-out tree and no filesystem
// is touched (R13.6).
//
// The contrast R5.1 turns on is asserted alongside: the SAME configuration with
// the microservice root present-but-empty (a directory holding no package.json)
// loads cleanly. Absent and existing-but-empty are different outcomes — the
// empty root is a discovery result of zero packages, not a configuration
// failure — which is the whole point of the relocation.
//
// Validates: Requirements 5.1, 1.10

import { describe, expect, it } from "vitest";

import {
  defaultEffectiveConfig,
  ROOT_DEFAULTS,
} from "../src/project-config.js";
import {
  loadProjectConfig,
  type ConfigFileRead,
  type ProbeRoot,
  type RootProbe,
} from "../src/config-loader.js";

/** An absent file, so the loader parses `{}` and proceeds to the default roots. */
const ABSENT_FILE: ConfigFileRead = { kind: "absent" };

/**
 * A prober keyed by root path: the microservice root reports the given state,
 * the common and spa roots report benign directories. Every probed path is
 * recorded so a test can assert exactly which roots were probed.
 */
function proberFor(microservice: RootProbe): {
  readonly probeRoot: ProbeRoot;
  readonly probed: string[];
} {
  const probed: string[] = [];
  const benign: RootProbe = { kind: "directory", holdsPackageJsonFile: false };
  const byPath = new Map<string, RootProbe>([
    [ROOT_DEFAULTS.microservice, microservice],
    [ROOT_DEFAULTS.common, benign],
    [ROOT_DEFAULTS.spa, benign],
  ]);
  return {
    probed,
    probeRoot: (rootPath) => {
      probed.push(rootPath);
      return byPath.get(rootPath) ?? benign;
    },
  };
}

describe("Config_Loader — absent microservice Discovery_Root (R5.1)", () => {
  it("fails with one [config:root-missing] diagnostic naming the microservice category, yielding no Effective_Config", () => {
    const { probeRoot } = proberFor({ kind: "absent" });

    const outcome = loadProjectConfig(() => ABSENT_FILE, probeRoot);

    // The run fails: a rejection carries no `config` field, so no
    // Effective_Config is yielded (R1.10) — the same "no discovery result for
    // any category" the retired container-missing test asserted, now upstream.
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;

    // Exactly one diagnostic, under the relocated tag (R5.1). This is the
    // feature's one intentional message change from `[discovery:container-missing]`.
    expect(outcome.diagnostics).toHaveLength(1);
    const [diag] = outcome.diagnostics;
    expect(diag.tag).toBe("config:root-missing");
    // It names the microservice category, and carries the configured root path.
    expect(diag.at).toBe("microservice");
    expect(diag.found).toBe(ROOT_DEFAULTS.microservice);
    expect(diag.reason.length).toBeGreaterThan(0);
  });

  it("reports an absent common or spa root as no failure, so only microservice absence fails the run (R5.2)", () => {
    // Microservice present; common absent; spa absent. Only the microservice
    // root is required, so this loads cleanly — an absent common/spa root yields
    // zero packages for that category with no diagnostic.
    const probed: string[] = [];
    const byPath = new Map<string, RootProbe>([
      [
        ROOT_DEFAULTS.microservice,
        { kind: "directory", holdsPackageJsonFile: false },
      ],
      [ROOT_DEFAULTS.common, { kind: "absent" }],
      [ROOT_DEFAULTS.spa, { kind: "absent" }],
    ]);
    const probeRoot: ProbeRoot = (rootPath) => {
      probed.push(rootPath);
      return byPath.get(rootPath) ?? { kind: "absent" };
    };

    const outcome = loadProjectConfig(() => ABSENT_FILE, probeRoot);

    expect(outcome.kind).toBe("loaded");
    if (outcome.kind !== "loaded") return;
    expect(outcome.config).toEqual(defaultEffectiveConfig());
  });

  it("treats a present-but-empty microservice root as a clean load, not a failure (R5.1 contrast)", () => {
    // A directory holding no package.json is a valid Discovery_Root; discovery
    // over it later yields zero microservices, which is not a configuration
    // failure. This is the absent/empty distinction R5.1 preserves.
    const { probeRoot } = proberFor({
      kind: "directory",
      holdsPackageJsonFile: false,
    });

    const outcome = loadProjectConfig(() => ABSENT_FILE, probeRoot);

    expect(outcome.kind).toBe("loaded");
    if (outcome.kind !== "loaded") return;
    expect(outcome.config).toEqual(defaultEffectiveConfig());
  });
});

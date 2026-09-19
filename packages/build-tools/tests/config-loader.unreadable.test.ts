// Absent versus unreadable, and the guarantee that the unreadable branch
// substitutes NEITHER the Scope_Default NOR any Root_Default (Requirements 1.5,
// 1.12, 2.11, 2.12).
//
// The subject under test is `loadProjectConfig(readConfigFile, probeRoot,
// configPath?)` from `config-loader.ts`. Both the reader and the prober are
// INJECTED, so no `scaffold.config.json` is ever written into the checked-out
// tree — R13.6's "create no Project_Config_File inside the checked-out
// repository" holds by construction: this file touches no filesystem at all.
//
// Two example cases pin the absent/unreadable distinction R2.11 draws:
//
//   1. An absent file (reader yields `{ kind: "absent" }`) parses `{}`
//      successfully and loads the full defaults — `defaultEffectiveConfig()`,
//      i.e. Scope_Default + the three Root_Defaults — with NO diagnostic (R1.5).
//      Because the parse succeeds, this branch DOES probe the default roots; a
//      benign prober reporting each as a directory keeps it a clean load.
//   2. An unreadable file (reader yields `{ kind: "unreadable", reason }`) is a
//      rejection carrying exactly one `[config:unreadable]` diagnostic that
//      names the config path and carries the reason text, yields no
//      Effective_Config, and substitutes neither default (R1.12, R2.12).
//
// Case 2 also proves the prober is never called on the unreadable branch: the
// injected prober throws if invoked, so a rejected config that never probes is
// asserted structurally rather than by inspection (R2.12 — "no default
// substituted for the unread file" implies no discovery, hence no probe).
//
// Validates: Requirements 1.5, 1.12, 2.11, 2.12, 13.6

import { describe, expect, it } from "vitest";

import {
  defaultEffectiveConfig,
  SCOPE_DEFAULT,
  ROOT_DEFAULTS,
  PROJECT_CONFIG_FILE,
} from "../src/project-config.js";
import {
  loadProjectConfig,
  type ConfigFileRead,
  type ProbeRoot,
} from "../src/config-loader.js";

/** A prober that must never run on the unreadable branch. Calling it fails the
 *  test loudly, which is exactly the R2.12 guarantee — a rejected, unread config
 *  is never probed on the filesystem. */
const throwingProbe: ProbeRoot = (rootPath) => {
  throw new Error(
    `the prober must not be called on the unreadable branch; it was asked to probe '${rootPath}'`,
  );
};

/** A benign prober that reports every Discovery_Root as a plain directory (no
 *  `package.json` directly inside), which passes every Filesystem_Validation of
 *  Requirement 5. Used only on the absent branch, where the loader parses `{}`
 *  successfully and does proceed to probe the default roots. */
const directoryProbe: ProbeRoot = () => ({
  kind: "directory",
  holdsPackageJsonFile: false,
});

describe("Config_Loader — absent versus unreadable (R2.11)", () => {
  it("loads the full defaults with no diagnostic when the file is absent (R1.5)", () => {
    const absent: ConfigFileRead = { kind: "absent" };

    const outcome = loadProjectConfig(() => absent, directoryProbe);

    // R1.5 — an absent file is no diagnostic; it yields the Scope_Default and
    // the three Root_Defaults, which is exactly `defaultEffectiveConfig()`.
    expect(outcome.kind).toBe("loaded");
    if (outcome.kind !== "loaded") return;
    expect(outcome.config).toEqual(defaultEffectiveConfig());
    expect(outcome.config.scope).toBe(SCOPE_DEFAULT);
    expect(outcome.config.roots).toEqual(ROOT_DEFAULTS);
  });

  it("rejects an unreadable file with one [config:unreadable] diagnostic and substitutes no default (R1.12, R2.12)", () => {
    const reason = "EACCES: permission denied, open 'scaffold.config.json'";
    const unreadable: ConfigFileRead = { kind: "unreadable", reason };

    const outcome = loadProjectConfig(() => unreadable, throwingProbe);

    // R1.12, R2.12 — a rejection, NOT a loaded config that fell back to
    // defaults. There is no `config` field on a rejection, so the loader
    // yielded no Effective_Config: neither the Scope_Default nor any
    // Root_Default was substituted.
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;

    // Exactly one diagnostic, tagged `[config:unreadable]`.
    expect(outcome.diagnostics).toHaveLength(1);
    const [diag] = outcome.diagnostics;
    expect(diag.tag).toBe("config:unreadable");

    // It names the Project_Config_File path…
    expect(diag.at).toBe(PROJECT_CONFIG_FILE);
    // …and carries the underlying read-failure reason text.
    expect(diag.found).toBe(reason);
    // Every part is non-empty (R2.13).
    expect(diag.reason.length).toBeGreaterThan(0);
  });

  it("carries the injected config path in the diagnostic when one is supplied (R1.12)", () => {
    const reason = "EISDIR: illegal operation on a directory, read";
    const unreadable: ConfigFileRead = { kind: "unreadable", reason };
    const configPath = "some/other/scaffold.config.json";

    const outcome = loadProjectConfig(() => unreadable, throwingProbe, configPath);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.diagnostics).toHaveLength(1);
    const [diag] = outcome.diagnostics;
    expect(diag.tag).toBe("config:unreadable");
    expect(diag.at).toBe(configPath);
    expect(diag.found).toBe(reason);
  });
});

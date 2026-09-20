// The registry-presence guard's pure policy (registry-inversion R5.5, R2.10).
//
// The subject is `absentRegistryDiagnostic(context, exists)` from
// `entry-registry.ts` — the whole policy the effectful `assertRegistryPresent`
// wraps. It is pure over an INJECTED existence probe, so both branches are
// exercised here with no filesystem touched, no registry written, and nothing in
// the checked-out tree read or modified.
//
// Four things are asserted, being the four claims the guard makes:
//
//  1. Present registry → no diagnostic (and the caller proceeds to the compiler).
//  2. Absent registry → exactly one diagnostic, naming the absent path and the
//     command that produces it.
//  3. The probe is asked about the path `generatedRegistryPath(context)` derives
//     and about nothing else — no path under a Framework_Singleton, and not the
//     Entry_Module's own source, which is how "the Build_System reads no content
//     of the Entry_Module" (R2.10) is kept true: it asks about ONE path, and that
//     path is not the Entry_Module's.
//  4. A relocated Entry_Root moves the demanded path with it, because the path is
//     read from the single derivation rather than composed here (R5.8).
//
// Validates: Requirements 2.10, 5.5

import { describe, expect, it } from "vitest";

import {
  absentRegistryDiagnostic,
  type PathExists,
} from "../src/entry-registry.js";
import { generatedRegistryPath } from "../src/generate-registry.js";
import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";

/** A probe that answers true for exactly the paths given, recording every ask. */
function probe(present: readonly string[]): {
  readonly exists: PathExists;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const exists: PathExists = (path) => {
    asked.push(path);
    return present.includes(path);
  };
  return { exists, asked };
}

const defaultContext = projectContext(defaultEffectiveConfig());
const defaultRegistry = generatedRegistryPath(defaultContext);

describe("the registry-presence guard's policy", () => {
  it("reports nothing when the Generated_Registry is present", () => {
    const { exists, asked } = probe([defaultRegistry]);

    expect(absentRegistryDiagnostic(defaultContext, exists)).toBeUndefined();

    // Asked about the registry's path, and about nothing else — in particular
    // not about the Entry_Module's source (R2.10).
    expect(asked).toEqual([defaultRegistry]);
  });

  it("reports exactly one diagnostic naming the absent path and the command that produces it", () => {
    const { exists, asked } = probe([]);

    const diagnostic = absentRegistryDiagnostic(defaultContext, exists);

    expect(diagnostic).toBeDefined();
    // One diagnostic: one line's worth of text, no embedded newline, and the
    // writer supplies the terminator.
    expect(diagnostic).not.toMatch(/\n/);
    // The absent path…
    expect(diagnostic).toContain(defaultRegistry);
    // …and the command that produces it.
    expect(diagnostic).toContain(
      "node packages/build-tools/dist/bin/generate-registry.js",
    );

    expect(asked).toEqual([defaultRegistry]);
  });

  it("demands the registry under a relocated Entry_Root, reading the path from the single derivation", () => {
    const relocated = projectContext({
      ...defaultEffectiveConfig(),
      entry: "consumer/entry",
    });
    const relocatedRegistry = generatedRegistryPath(relocated);

    // The default context's registry being present does not satisfy a run whose
    // Entry_Root moved: the guard asks about the relocated path only.
    const { exists, asked } = probe([defaultRegistry]);

    const diagnostic = absentRegistryDiagnostic(relocated, exists);

    expect(diagnostic).toContain(relocatedRegistry);
    expect(asked).toEqual([relocatedRegistry]);

    // And it is satisfied by the relocated path.
    const satisfied = probe([relocatedRegistry]);
    expect(
      absentRegistryDiagnostic(relocated, satisfied.exists),
    ).toBeUndefined();
  });
});

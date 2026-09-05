// Task 11.3 — the supervisor CLI's verbatim Selector relay.
//
// `runDevSupervisorCli` derives the Project_List before it starts anything, and
// a Selector failure from that derivation reaches stderr VERBATIM: the message
// `devProjectList` / `projectListFrom` produced is already prefixed
// (`[selector:unmatched]`, `[selector:empty]`, `[shared:unresolved]`), so the
// CLI adds no prefix of its own. Re-wrapping one as `[dev] failed to start the
// build watcher: ...` would corrupt the contract R2.4 states — the dev path
// fails on a bad Selector with exactly the message an image build fails with.
//
// Every other test that pins `[selector:unmatched]` does so against
// `projectListFrom` / `resolveSelected` in-process (packages/build-tools'
// dev-project-list and registry-generator.unmatched property tests), and the
// `npm run dev` path fails earlier, in Common_Startup's registry generation,
// which frames its own `[dev] ...; refusing to start the Overseer` line. So the
// relay is only observable by invoking the supervisor bin directly, which is
// what this does — one assertion, on the one thing not pinned elsewhere.
//
// The bin exits before the Build_Watcher is built and before any Overseer is
// spawned, so this spawn costs a process start and nothing else.
//
// Validates: Requirements 2.4

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { repoRoot } from "./helpers.js";

/** The compiled supervisor bin, the CLI boundary under test. */
const supervisorBin = resolve(
  repoRoot,
  "packages",
  "build-tools",
  "dist",
  "bin",
  "dev-supervisor.js",
);

/** An identifier that is not a discovered candidate microservice. */
const UNKNOWN_IDENTIFIER = "does-not-exist";

describe("the supervisor CLI relays a Selector failure verbatim (R2.4)", () => {
  it("writes the unmodified [selector:unmatched] message to stderr", () => {
    const result = spawnSync(process.execPath, [supervisorBin], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MICROSERVICES: UNKNOWN_IDENTIFIER },
    });

    // Byte-for-byte the message the derivation produced: no `[dev]` framing, no
    // added prefix, nothing else on stderr.
    expect(
      (result.stderr ?? "").trim(),
      `exit status ${String(result.status)}; stdout:\n${result.stdout ?? ""}`,
    ).toBe(
      `[selector:unmatched] MICROSERVICES names unknown identifier(s): "${UNKNOWN_IDENTIFIER}"`,
    );
  });
});

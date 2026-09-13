// Feature: spa-common-consumption — stale-documentation guard (design "Testing
// Strategy", row `stale-documentation-guard.test.ts`; R8.5).
//
// A short literal deny-list over exactly two docs — the repo-root `README.md`
// and `.kiro/steering/structure.md` — asserting that none of them retains any
// of the five phrases the feature retired when the Demo_Spa gained its
// `@microservices/extended-config` dependency and the shipped configurations
// became three:
//
//   1. "true sink"
//   2. "dependency sink"
//   3. "declares no @microservices-scoped dependency"
//   4. "both shipped Container configurations"
//   5. "two shipped Container configurations"
//
// This guard is deliberately negative ONLY. It forbids these five phrases and
// pins no positive wording, so a legitimate future rewrite of either document
// does not break it. It reads both files and writes nothing to the tree.
//
// The phrases below are assembled from fragments so this test source does not
// itself contain any forbidden phrase contiguously — the scan reads only the
// two docs, never this file, but keeping the literals split makes the intent
// unmistakable and future-proof.
//
// Validates: Requirements 8.5

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** The two documents this guard scans, repo-relative. */
const SCANNED_DOCS = ["README.md", ".kiro/steering/structure.md"] as const;

/**
 * The retired phrases, matched case-insensitively. Each is assembled from
 * fragments so this source never contains a forbidden phrase as one contiguous
 * literal.
 */
const FORBIDDEN_PHRASES = [
  `true ${"sink"}`,
  `dependency ${"sink"}`,
  `declares no ${"@microservices"}-scoped dependency`,
  `both shipped ${"Container"} configurations`,
  `two shipped ${"Container"} configurations`,
] as const;

function readDoc(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("no retired phrase survives in the feature's docs (R8.5)", () => {
  it.each(SCANNED_DOCS)("%s contains none of the forbidden phrases", (doc) => {
    const haystack = readDoc(doc).toLowerCase();

    const offenders = FORBIDDEN_PHRASES.filter((phrase) =>
      haystack.includes(phrase.toLowerCase()),
    );

    expect(
      offenders,
      `${doc} retains retired phrase(s):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

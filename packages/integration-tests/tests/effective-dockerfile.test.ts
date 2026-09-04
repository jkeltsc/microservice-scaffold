// Pinning test: scripts/emit-effective-dockerfile.sh vs. resolveSelected().
//
// The emit script is dependency-free POSIX sh so CI can produce
// `Dockerfile.effective` without a Node install, which means it REIMPLEMENTS
// selector resolution. That duplication is only acceptable if the two
// implementations are pinned to each other, otherwise they drift silently and
// a container quietly gets the wrong set of baked toggle defaults.
//
// So: for a table of selectors, run the real script and compare the identifiers
// it derives (read back out of the emitted `ENV MICROSERVICE_<X>_ENABLED` lines)
// against `resolveSelected(selector, listMicroserviceDirectories())` from the
// compiled build-tools. Exact set equality, both directions.
//
// Every run points EFFECTIVE_DOCKERFILE at a temp file, so the test never
// touches a real `Dockerfile.effective` in the working tree.
//
// Validates: Requirements R5.1, R5.2, R5.3, R6.1, R6.2, R6.6

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// build-tools has no barrel: it is a bin-only tooling package whose interface is
// its two CLI entry points. This test reaches its compiled modules directly, the
// same way the suite already reaches the Overseer (`@scaffold/overseer/dist/...`).
import { resolveSelected } from "@scaffold/build-tools/dist/selector.js";
import { listMicroserviceDirectories } from "@scaffold/build-tools/dist/generate-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const script = "scripts/emit-effective-dockerfile.sh";
const baseDockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");

const workDir = mkdtempSync(join(tmpdir(), "effective-dockerfile-"));
let tempCounter = 0;

/** A fresh path inside the per-run temp directory (never written by default). */
function tempPath(label: string): string {
  tempCounter += 1;
  return join(workDir, `${label}-${tempCounter}`);
}

interface EmitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly out: string;
}

/**
 * Run the emit script with `MICROSERVICES` set to `selector` (omitted entirely
 * when `selector` is `undefined`) and the output redirected to a temp file.
 */
function emit(
  selector: string | undefined,
  options: { readonly dockerfile?: string } = {},
): EmitResult {
  const outPath = tempPath("Dockerfile.effective");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    EFFECTIVE_DOCKERFILE: outPath,
  };
  delete env.MICROSERVICES;
  if (selector !== undefined) {
    env.MICROSERVICES = selector;
  }
  if (options.dockerfile !== undefined) {
    env.DOCKERFILE = options.dockerfile;
  }

  const run = spawnSync("sh", [script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });

  let out = "";
  try {
    out = readFileSync(outPath, "utf8");
  } catch {
    // A failing run may not have produced a file at all; callers assert on
    // status/stderr in that case.
  }

  return {
    status: run.status ?? -1,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    out,
  };
}

/** The identifiers the script baked in, recovered from its ENV lines. */
function bakedIdentifiers(emitted: string): string[] {
  return [
    ...emitted.matchAll(/^ENV MICROSERVICE_([A-Z0-9_]+)_ENABLED=enabled$/gm),
  ]
    .map((match) => match[1].toLowerCase())
    .sort();
}

/** What the TypeScript selector logic resolves the same selector to. */
function expectedIdentifiers(selector: string | undefined): string[] {
  return resolveSelected(
    selector,
    listMicroserviceDirectories(resolve(repoRoot, "packages", "microservices")),
  )
    .map((id) => id.toLowerCase())
    .sort();
}

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("emit-effective-dockerfile.sh is pinned to resolveSelected()", () => {
  const selectors: ReadonlyArray<{ label: string; value: string | undefined }> =
    [
      { label: "all (*)", value: "*" },
      { label: "unset", value: undefined },
      { label: "empty", value: "" },
      { label: "whitespace only", value: "   " },
      { label: "single identifier", value: "microservice1" },
      { label: "two identifiers", value: "microservice1,microservice2" },
      { label: "stray whitespace", value: " microservice1 , microservice2 " },
      {
        label: "all three explicitly",
        value: "microservice1,microservice2,microservice3",
      },
    ];

  it.each(selectors)(
    "resolves $label the same way the TypeScript selector does",
    ({ value }) => {
      const result = emit(value);
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);

      expect(bakedIdentifiers(result.out)).toEqual(expectedIdentifiers(value));
    },
  );

  it("bakes every discovered microservice for an all-selector", () => {
    // Anchors the table above against reality: if the shell and the TS logic
    // ever agreed on the WRONG answer (e.g. both resolving `*` to nothing),
    // set equality alone would not catch it.
    const discovered = listMicroserviceDirectories(
      resolve(repoRoot, "packages", "microservices"),
    ).sort();
    expect(discovered.length).toBeGreaterThanOrEqual(3);
    expect(bakedIdentifiers(emit("*").out)).toEqual(discovered);
  });
});

describe("emit-effective-dockerfile.sh output structure", () => {
  it("injects the ENV lines before the last ENTRYPOINT", () => {
    const { out } = emit("microservice1,microservice2");
    const lines = out.split("\n");

    const envIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) =>
        /^ENV MICROSERVICE_[A-Z0-9_]+_ENABLED=enabled$/.test(line),
      )
      .map(({ index }) => index);
    const entrypointIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*ENTRYPOINT([\s[])/.test(line))
      .map(({ index }) => index);

    expect(envIndexes).toHaveLength(2);
    expect(entrypointIndexes.length).toBeGreaterThan(0);

    const lastEntrypoint = entrypointIndexes[entrypointIndexes.length - 1];
    for (const envIndex of envIndexes) {
      expect(envIndex).toBeLessThan(lastEntrypoint);
    }
  });

  it("emits an auto-generated header naming the selector", () => {
    const selector = "microservice1,microservice2";
    const { out, stdout } = emit(selector);

    expect(out.split("\n")[0]).toMatch(
      /^# AUTO-GENERATED from Dockerfile by scripts\/emit-effective-dockerfile\.sh\. Do not edit\.$/,
    );
    expect(out).toContain(`# Selector: ${selector}`);
    // The injected block also names the selector, next to the ENV lines it explains.
    expect(out).toMatch(
      new RegExp(
        `^# --- R6\\.6 toggle defaults .*selector: ${selector}\\) ---$`,
        "m",
      ),
    );
    expect(stdout).toContain(`for selector '${selector}'`);
  });

  it("preserves the original Dockerfile content verbatim", () => {
    const { out } = emit("microservice1");

    // Everything the script did not add must still be there, in order: strip
    // the two header lines and the injected block, and the remainder is the
    // base Dockerfile byte for byte.
    const remainder = out
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("# AUTO-GENERATED from ") &&
          !line.startsWith("# Selector: ") &&
          !line.startsWith("# --- R6.6 toggle defaults (generated by ") &&
          !/^ENV MICROSERVICE_[A-Z0-9_]+_ENABLED=enabled$/.test(line),
      )
      .join("\n");

    expect(remainder).toBe(baseDockerfile);
  });

  it("fails with a clear message when the Dockerfile has no ENTRYPOINT", () => {
    const noEntrypoint = tempPath("Dockerfile.no-entrypoint");
    writeFileSync(
      noEntrypoint,
      ["FROM node:22-alpine", "WORKDIR /app", "EXPOSE 8080", ""].join("\n"),
      "utf8",
    );

    const result = emit("microservice1", { dockerfile: noEntrypoint });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no ENTRYPOINT instruction");
    expect(result.out).toBe("");
  });
});

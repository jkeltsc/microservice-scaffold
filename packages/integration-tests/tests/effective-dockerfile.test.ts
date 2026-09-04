// Emit-script tests: scripts/emit-effective-dockerfile.sh.
//
// The emit script is dependency-free POSIX sh so CI (and a fresh clone) can
// produce the generated `Dockerfile` from the committed `Dockerfile.template`
// without a Node install. It does two things this suite covers:
//
//   1. Selector pinning. The script REIMPLEMENTS selector resolution to bake
//      the per-microservice toggle-default ENV lines. That duplication is only
//      acceptable if it is pinned to `resolveSelected()`; otherwise the two
//      drift and a container gets the wrong baked toggles. For a table of
//      selectors we run the script and compare the identifiers it derives (read
//      back out of the emitted `ENV MICROSERVICE_<X>_ENABLED` lines) against
//      `resolveSelected(selector, listMicroserviceDirectories())`.
//
//   2. Manifest COPY generation. The script fills the two
//      `# --- MANIFEST_COPY_* ---` anchors in the template with per-workspace
//      `package.json` COPY lines discovered from the filesystem, so the build
//      and prod-deps stages copy manifests before `npm ci` (install-layer
//      caching). We verify the discovered set, the exclusions, and that the
//      same block lands in both stages.
//
// Input is `Dockerfile.template`; every run redirects EFFECTIVE_DOCKERFILE to a
// temp file, so the test never touches the real generated `Dockerfile`.
//
// Validates: Requirements R5.1, R5.2, R5.3, R6.1, R6.2, R6.6, O6.2, O6.3, O8.3, O8.7

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// The base input is now the committed TEMPLATE; the emit script processes it
// into a generated `Dockerfile` (gitignored). Every emit() below redirects the
// output to a temp file so the real generated `Dockerfile` is never touched.
const baseTemplate = readFileSync(resolve(repoRoot, "Dockerfile.template"), "utf8");

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
  const outPath = tempPath("Dockerfile.generated");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Read the committed TEMPLATE as input, and always write to a temp path so
    // the real generated `Dockerfile` in the working tree is never touched. The
    // script's default output is `Dockerfile`; we deliberately override it here
    // rather than relying on that default.
    DOCKERFILE: options.dockerfile ?? "Dockerfile.template",
    EFFECTIVE_DOCKERFILE: outPath,
  };
  delete env.MICROSERVICES;
  if (selector !== undefined) {
    env.MICROSERVICES = selector;
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
      /^# AUTO-GENERATED from Dockerfile\.template by scripts\/emit-effective-dockerfile\.sh\. Do not edit\.$/,
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

  it("preserves the template's non-injected content in order", () => {
    const { out } = emit("microservice1");

    // The output is no longer byte-for-byte identical to the template: the two
    // `# --- MANIFEST_COPY_* ---` anchors are REPLACED by generated COPY blocks,
    // and the two header lines + the R6.6 ENV block are injected. To verify the
    // rest of the template survives verbatim and in order, normalise both sides:
    //
    //   output  -> drop the two header lines, drop the generated manifest COPY
    //              blocks, drop the injected R6.6 block; the anchors were
    //              replaced, so put a single placeholder where each block was.
    //   template -> replace each anchor line with the same placeholder.
    //
    // What remains must match line for line.
    const ANCHOR = "<<<MANIFEST>>>";

    const normalisedOut: string[] = [];
    let inManifestBlock = false;
    for (const line of out.split("\n")) {
      if (
        line.startsWith("# AUTO-GENERATED from ") ||
        line.startsWith("# Selector: ") ||
        line.startsWith("# --- R6.6 toggle defaults (generated by ") ||
        /^ENV MICROSERVICE_[A-Z0-9_]+_ENABLED=enabled$/.test(line)
      ) {
        continue;
      }
      if (
        line ===
        "# --- manifest COPY (generated by scripts/emit-effective-dockerfile.sh) ---"
      ) {
        // Start of a generated manifest block: collapse the whole block
        // (this comment + the COPY lines that follow) to a single placeholder.
        inManifestBlock = true;
        normalisedOut.push(ANCHOR);
        continue;
      }
      if (inManifestBlock) {
        if (/^COPY /.test(line)) {
          continue; // still inside the generated COPY block
        }
        inManifestBlock = false;
      }
      normalisedOut.push(line);
    }

    const normalisedTemplate = baseTemplate.split("\n").map((line) =>
      line === "# --- MANIFEST_COPY_BUILD ---" ||
      line === "# --- MANIFEST_COPY_PRODDEPS ---"
        ? ANCHOR
        : line,
    );

    expect(normalisedOut.join("\n")).toBe(normalisedTemplate.join("\n"));
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

describe("emit-effective-dockerfile.sh generates manifest COPY lines", () => {
  const packagesDir = resolve(repoRoot, "packages");
  const microservicesDir = resolve(packagesDir, "microservices");

  // The set of top-level packages/ entries the script scans, minus the two it
  // excludes by name: integration-tests (test-only, no production code) and
  // microservices (the namespace container, scanned separately).
  const EXCLUDED_TOPLEVEL = new Set(["integration-tests", "microservices"]);

  /** Direct subdirectories of a directory that contain a package.json. */
  function workspaceDirs(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(dir, name, "package.json")))
      .sort();
  }

  const topLevelPackages = workspaceDirs(packagesDir).filter(
    (name) => !EXCLUDED_TOPLEVEL.has(name),
  );
  const microserviceIds = workspaceDirs(microservicesDir);

  const manifestHeader =
    "# --- manifest COPY (generated by scripts/emit-effective-dockerfile.sh) ---";

  it("COPYs the root package.json and package-lock.json", () => {
    const { out } = emit("*");
    expect(out).toContain("COPY package.json package-lock.json ./");
  });

  it("COPYs a package.json for every discovered non-excluded workspace", () => {
    const { out } = emit("*");

    for (const name of topLevelPackages) {
      expect(
        out,
        `expected COPY for top-level package '${name}'`,
      ).toContain(`COPY packages/${name}/package.json packages/${name}/`);
    }
    for (const id of microserviceIds) {
      expect(
        out,
        `expected COPY for microservice '${id}'`,
      ).toContain(
        `COPY packages/microservices/${id}/package.json packages/microservices/${id}/`,
      );
    }
  });

  it("does NOT COPY the test-only integration-tests workspace", () => {
    const { out } = emit("*");
    expect(out).not.toContain("packages/integration-tests/package.json");
  });

  it("emits the manifest COPY block in both the build and prod-deps stages", () => {
    const { out } = emit("*");
    const occurrences = out.split(manifestHeader).length - 1;
    expect(occurrences).toBe(2);

    // Each block carries the same COPY lines: the count of a representative
    // COPY line should match the number of blocks.
    const rootCopies =
      out.split("COPY package.json package-lock.json ./").length - 1;
    expect(rootCopies).toBe(2);
  });

  it("emits identical COPY manifests in both stages", () => {
    const { out } = emit("*");
    const lines = out.split("\n");

    // Extract each manifest block: the header line plus the run of COPY lines
    // immediately following it.
    const blocks: string[][] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === manifestHeader) {
        const block: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith("COPY ")) {
          block.push(lines[j]);
          j += 1;
        }
        blocks.push(block);
      }
    }

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(blocks[1]);

    // The block content is exactly: root manifests, then one COPY per
    // top-level package, then one COPY per microservice, in that order.
    const expected = [
      "COPY package.json package-lock.json ./",
      ...topLevelPackages.map(
        (name) => `COPY packages/${name}/package.json packages/${name}/`,
      ),
      ...microserviceIds.map(
        (id) =>
          `COPY packages/microservices/${id}/package.json packages/microservices/${id}/`,
      ),
    ];
    expect(blocks[0]).toEqual(expected);
  });
});

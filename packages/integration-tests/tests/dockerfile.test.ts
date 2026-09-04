// Structural assertions on the repo-root Dockerfile.template.
//
// A real `docker build` is far too slow for this suite, but the template's
// shape is exactly what decides whether a Specific_Container ships only its
// selected microservices (the image-tree assembler's own post-assemble integrity
// check catches leaks at build time). These are cheap text-level guards on the
// parts that matter — most importantly that the runtime payload comes from the
// prod-deps node_modules plus the staged `/out` overlay, and that nothing copies
// `packages/microservices` into the image, which is precisely the way a
// "specific" image ends up carrying every microservice anyway.
//
// Validates: Requirements R6.1, R6.2, R6.3, R6.6

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> integration-tests -> packages -> repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile.template"), "utf8");
const lines = dockerfile.split("\n");

/** Instruction lines only — comments and blanks stripped. */
const instructions = lines
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("root Dockerfile structure", () => {
  it("declares the MICROSERVICES selector build arg before any stage", () => {
    const argIndex = instructions.indexOf("ARG MICROSERVICES=*");
    const firstFrom = instructions.findIndex((line) =>
      line.startsWith("FROM "),
    );

    expect(argIndex).toBeGreaterThanOrEqual(0);
    expect(firstFrom).toBeGreaterThan(argIndex);
  });

  it("defines exactly the build, prod-deps, and runtime stages", () => {
    const stages = instructions
      .filter((line) => line.startsWith("FROM "))
      .map((line) => {
        const match = line.match(/\bAS\s+(\S+)/i);
        return match ? match[1] : line;
      });

    expect(stages).toEqual(["build", "prod-deps", "runtime"]);
  });

  it("composes its runtime payload from the prod-deps node_modules and the staged tree", () => {
    const runtimeStart = instructions.findIndex((line) =>
      /^FROM\s+\S+\s+AS\s+runtime$/i.test(line),
    );
    expect(runtimeStart).toBeGreaterThanOrEqual(0);

    const runtimeCopies = instructions
      .slice(runtimeStart)
      .filter((line) => line.startsWith("COPY "));

    expect(runtimeCopies).toEqual([
      "COPY --from=prod-deps /app/node_modules ./node_modules",
      "COPY --from=build /out ./",
    ]);
  });

  it("never copies packages/microservices into any stage", () => {
    // Regression guard: the microservices reach the image only as
    // node_modules/@microservices/<id> entries staged by build-image-tree, so any
    // COPY naming the namespace would ship services the selector excluded.
    const offenders = instructions.filter(
      (line) =>
        line.startsWith("COPY ") && line.includes("packages/microservices"),
    );

    expect(offenders).toEqual([]);
  });

  it("exposes 8080 and boots the Overseer via dumb-init", () => {
    expect(instructions).toContain("EXPOSE 8080");
    expect(instructions).toContain('ENTRYPOINT ["dumb-init", "--"]');
    expect(instructions).toContain(
      'CMD ["node", "packages/overseer/dist/index.js"]',
    );
  });

  it("runs as the unprivileged node user", () => {
    expect(instructions).toContain("USER node");
  });

  it("installs dumb-init in the runtime stage", () => {
    const runtimeStart = instructions.findIndex((line) =>
      /^FROM\s+\S+\s+AS\s+runtime$/i.test(line),
    );
    const runtimeInstructions = instructions.slice(runtimeStart);
    expect(runtimeInstructions).toContain("RUN apk add --no-cache dumb-init");
  });

  it("uses BUILDPLATFORM for the build and prod-deps stages", () => {
    const buildFrom = instructions.find((line) =>
      /^FROM\s+.*\s+AS\s+build$/i.test(line),
    );
    expect(buildFrom).toBeDefined();
    expect(buildFrom).toContain("--platform=$BUILDPLATFORM");

    const prodDepsFrom = instructions.find((line) =>
      /^FROM\s+.*\s+AS\s+prod-deps$/i.test(line),
    );
    expect(prodDepsFrom).toBeDefined();
    expect(prodDepsFrom).toContain("--platform=$BUILDPLATFORM");
  });

  it("does not reference the removed build-tools entry points", () => {
    expect(dockerfile).not.toContain("emit-toggle-env");
    expect(dockerfile).not.toContain("container-build");
  });
});

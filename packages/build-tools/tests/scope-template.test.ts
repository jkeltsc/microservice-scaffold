// Feature: config-driven-discovery, task 10.1 — the `[scope:template]` check.
//
// Covers the three failure branches of checkRegistryTemplateScope through the
// INJECTED reader (a mismatched scope, no scoped specifier at all, and an
// unreadable template) plus one passing case over the committed Registry_Template
// (`packages/overseer/src/generated/microservice-registry.template.ts`) read
// through the real reader.
//
// Validates: Requirements 8.9, 8.10, 7.7, 7.8

import { describe, expect, it } from "vitest";

import { defaultEffectiveConfig } from "../src/project-config.js";
import { projectContext } from "../src/project-context.js";
import {
  checkRegistryTemplateScope,
  readRegistryTemplate,
  type ReadTemplate,
} from "../src/scope-checks.js";

const TEMPLATE_PATH =
  "packages/overseer/src/generated/microservice-registry.template.ts";

/** A reader that returns the given text for every path. */
function textReader(text: string): ReadTemplate {
  return () => ({ kind: "text", text });
}

describe("checkRegistryTemplateScope (R8.9, R8.10)", () => {
  const context = projectContext(defaultEffectiveConfig()); // scope @microservices

  it("passes when every scoped specifier carries the Configured_Scope", () => {
    const template = `import type { MicroserviceRegistry } from "@microservices/contracts";
export const microserviceRegistry: MicroserviceRegistry = [];`;
    expect(checkRegistryTemplateScope(context, textReader(template))).toEqual([]);
  });

  it("reports exactly one violation for a mismatched scope, naming the declared scope", () => {
    const template = `import type { MicroserviceRegistry } from "@acme/contracts";
export const microserviceRegistry: MicroserviceRegistry = [];`;
    const violations = checkRegistryTemplateScope(context, textReader(template));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("[scope:template]");
    expect(violations[0]).toContain(TEMPLATE_PATH);
    expect(violations[0]).toContain("@acme");
    expect(violations[0]).toContain("@microservices");
  });

  it("names the scope of the FIRST offending specifier in source order", () => {
    const template = `import type { A } from "@microservices/contracts";
import type { B } from "@wrong/thing";
import type { C } from "@other/thing";`;
    const violations = checkRegistryTemplateScope(context, textReader(template));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@wrong");
    expect(violations[0]).not.toContain("@other");
  });

  it("reports exactly one violation when the template declares no scoped specifier", () => {
    const template = `import { readFileSync } from "node:fs";
export const microserviceRegistry = [];`;
    const violations = checkRegistryTemplateScope(context, textReader(template));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("[scope:template]");
    expect(violations[0]).toContain("no scoped import specifier");
    expect(violations[0]).toContain("@microservices");
  });

  it("reports exactly one violation naming the reason when the template is unreadable", () => {
    const reader: ReadTemplate = () => ({
      kind: "unreadable",
      reason: "ENOENT: no such file",
    });
    const violations = checkRegistryTemplateScope(context, reader);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("[scope:template]");
    expect(violations[0]).toContain(TEMPLATE_PATH);
    expect(violations[0]).toContain("ENOENT: no such file");
  });

  it("does not inspect specifiers when the template is unreadable", () => {
    // A comment naming the wrong scope must not leak into a message; the
    // unreadable branch reports only the read reason.
    const reader: ReadTemplate = () => ({
      kind: "unreadable",
      reason: "permission denied",
    });
    const violations = checkRegistryTemplateScope(context, reader);
    expect(violations[0]).toContain("permission denied");
    expect(violations[0]).not.toContain("declares no scoped");
  });

  it("passes over the committed Registry_Template read through the real reader", () => {
    // The suite runs with cwd at the build-tools package; resolve the template
    // relative to the repo root so the real reader finds it.
    const originalCwd = process.cwd();
    // tests/ -> build-tools -> packages -> repo root
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    process.chdir(repoRoot);
    try {
      expect(
        checkRegistryTemplateScope(context, readRegistryTemplate),
      ).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

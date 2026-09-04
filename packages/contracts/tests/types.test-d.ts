// Feature: microservice-scaffold — compile-time type tests for the public
// module boundary (Task 2.6*).
//
// R8.4: the Overseer SHALL access a microservice module only through its declared
// exports (path, router) and SHALL NOT depend on any service-internal symbols.
// This file encodes that boundary as a set of compile-time assertions: the public
// MicroserviceModule contract exposes EXACTLY `path` and `router` with the
// documented types, and any attempt to type an internal / non-existent property
// is a type error. The identifier is not part of the module surface — the
// directory name is the authoritative identifier and the generated registry
// carries it on each RegistryEntry.
//
// Mechanism: vitest's type-testing API (`expectTypeOf`, `assertType`), which is
// checked when Vitest runs in `--typecheck` mode (the contracts package wires a
// `test:types` script for exactly this). The `describe`/`test` blocks are picked
// up by the type checker; the body assertions never execute at runtime — their
// value is entirely in whether `tsc`/vitest's type checker accepts them.
//
// Validates: Requirement R8.4

import { describe, test, expectTypeOf, assertType } from "vitest";
import type { Router } from "express";

import type { MicroserviceModule } from "../src/index.js";

describe("R8.4: MicroserviceModule public boundary", () => {
  test("exposes exactly path | router", () => {
    // The set of keys is EXACTLY these two — no more, no fewer. If a new
    // public field were added (or one removed), this equality fails to compile.
    expectTypeOf<keyof MicroserviceModule>().toEqualTypeOf<"path" | "router">();
  });

  test("path is a string; router is an express Router", () => {
    expectTypeOf<MicroserviceModule["path"]>().toEqualTypeOf<string>();
    expectTypeOf<MicroserviceModule["router"]>().toEqualTypeOf<Router>();
  });

  test("the whole module is assignable from exactly the two declared members", () => {
    // A value carrying precisely the two contract members is a valid module.
    const ok = {
      path: "/api",
      router: undefined as unknown as Router,
    };
    assertType<MicroserviceModule>(ok);
  });

  test("accessing an internal / non-existent property is a type error", () => {
    const m = undefined as unknown as MicroserviceModule;

    // The public contract has no such members. Each access below is a genuine
    // compile error, pinned with @ts-expect-error so the type test FAILS if the
    // property ever becomes typeable through the public boundary (R8.4). The
    // accesses are wrapped in `expectTypeOf(...)` calls so they are not bare,
    // "unused" expression statements (which lint forbids) — the type error
    // still originates at the property access itself.

    // @ts-expect-error — the identifier is not part of the module surface.
    expectTypeOf(m.identifier).toBeUnknown();
    // @ts-expect-error — no internal `handler` symbol is visible on the contract.
    expectTypeOf(m.handler).toBeUnknown();
    // @ts-expect-error — no internal `createRouter` factory is exposed.
    expectTypeOf(m.createRouter).toBeUnknown();
    // @ts-expect-error — no `config`/service-internal state on the contract.
    expectTypeOf(m.config).toBeUnknown();
    // @ts-expect-error — arbitrary internal symbol is not part of the boundary.
    expectTypeOf(m.internalState).toBeUnknown();

    // The declared members, by contrast, are all accessible with no error.
    expectTypeOf(m.path).toBeString();
    expectTypeOf(m.router).toEqualTypeOf<Router>();
  });

  test("MicroserviceModule does not structurally carry extra properties", () => {
    // `not.toHaveProperty` asserts the type does not expose the given key.
    expectTypeOf<MicroserviceModule>().not.toHaveProperty("identifier");
    expectTypeOf<MicroserviceModule>().not.toHaveProperty("handler");
    expectTypeOf<MicroserviceModule>().not.toHaveProperty("createRouter");
    expectTypeOf<MicroserviceModule>().not.toHaveProperty("internalState");
  });
});

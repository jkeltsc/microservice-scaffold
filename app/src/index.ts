// The Entry_Module — this project's own process entrypoint.
//
// This file is consumer-owned committed source. It is the ONLY module that:
//   - statically imports the Generated_Registry,
//   - writes to stderr,
//   - calls `process.exit`,
//   - binds the HTTP socket (via the Overseer_Library's `startServer`).
//
// The platform is a library this file calls, not a process that calls it: `boot`
// and `startServer` are imported from `@microservices/overseer` by package name,
// and nothing here reaches inside another package's `src` or `dist`.
//
// The Entry_Package's side of the contract with the Build_System: the
// Build_System reads no content of this file, writes nothing into it, and
// applies no validation to it beyond the checks every package of the repository
// gets (Workspace_Coverage, import discipline, Load_Bearing_Settings). What it
// does do is WRITE the Generated_Registry at
// `./generated/microservice-registry.ts` — inside this package, gitignored — and
// it knows that path because it is the party that writes it, never by inspecting
// this file. Generation therefore precedes compilation on every path that
// compiles or typechecks this package, this package's own `build` and
// `typecheck` scripts included; when the registry is absent, the guard ahead of
// the compiler names the absent path and the command that produces it.
//
// The static import is worth keeping static: the `microserviceRegistry`
// binding's type is DERIVED from the generated module rather than asserted over
// a dynamic `import()`, so a generator emitting a differently named export is a
// compile error here instead of a `Cannot read properties of undefined` at run
// time, and every microservice the registry imports is type-checked against
// `MicroserviceRegistry` by this package's own compilation.
//
// Accepted regression, carried over unchanged: when the generated file is absent
// at run time, Node fails with ERR_MODULE_NOT_FOUND before any of this code
// runs. Deliberate — the condition means the build did not complete, and Node's
// own error names the missing specifier plainly.

import { boot, startServer } from "@microservices/overseer";

import { microserviceRegistry } from "./generated/microservice-registry.js";

/**
 * Compose and start the Overseer:
 *   1. the generated registry is already loaded (static import above),
 *   2–5. run the pure `boot` pipeline (validate → collisions → toggles → build),
 *   6. bind the HTTP server.
 *
 * Any boot failure writes every offender-naming message to stderr and exits
 * non-zero BEFORE `listen` is called. A binding failure (e.g. EADDRINUSE) is
 * also fatal.
 */
async function main(): Promise<void> {
  const result = boot({ microserviceRegistry, env: process.env });

  if (!result.ok) {
    for (const message of result.messages) {
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
    return;
  }

  try {
    await startServer(result.app, result.config.port);
  } catch (error) {
    process.stderr.write(
      `[boot] failed to bind HTTP server on port ${result.config.port}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
    return;
  }

  // Log the full registered-microservice table (replaces the old introspection
  // endpoint — R6.3). Every microservice baked into the Container is listed
  // with its path and toggle state, regardless of whether it is enabled.
  process.stdout.write("[boot] registered microservices:\n");
  for (const ms of result.registeredMicroservices) {
    process.stdout.write(
      `  ${ms.identifier} ${ms.path} ${ms.enabled ? "enabled" : "disabled"}\n`,
    );
  }

  process.stdout.write(
    `[boot] Overseer listening on port ${result.config.port}\n`,
  );
}

void main();

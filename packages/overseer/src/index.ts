// @scaffold/overseer — process entrypoint.
//
// Implements design "Overseer Startup Sequence" step 1 (load the generated
// microservice registry), step 6 (bind the HTTP server), and the process-effect
// shell around the pure `boot` pipeline. This file is the ONLY place that:
//   - imports the generated microservice registry,
//   - writes to stderr,
//   - calls `process.exit`,
//   - binds the HTTP socket via `startServer`.
//
// The generated microservice registry (`./generated/microservice-registry.js`)
// is emitted by build-tools and gitignored, but the root `prepare` lifecycle
// copies a committed empty template into place after every `npm install`/
// `npm ci`, so a fresh clone has a valid file before anything compiles. That
// guarantee is what lets this be a plain static import, and the static form is
// worth having: the `microserviceRegistry` binding's type is DERIVED from the
// generated module rather than asserted over a dynamic `import()`. If the
// generator's template ever emitted a differently-named export, that is now a
// compile error here instead of a `Cannot read properties of undefined` at
// runtime.
//
// Accepted regression: when the generated file is absent at runtime, Node now
// fails with ERR_MODULE_NOT_FOUND before any Overseer code runs, so the previous
// `[boot] failed to load the generated registry…` message is gone. Deliberate —
// the condition means the build did not complete, and Node's own error names the
// missing specifier plainly.

import { boot } from "./boot.js";
import { microserviceRegistry } from "./generated/microservice-registry.js";
import { startServer } from "./server.js";

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

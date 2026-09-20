// @microservices/overseer — the Overseer_Library's barrel, and its sole stable
// public API.
//
// This file is a re-export barrel and nothing else. It performs no process
// effect: no `process.exit`, no write to stderr, no HTTP socket bind, and no
// import of a generated file (R3.4, R3.5). The process-effect shell that used to
// live here — the static import of the generated microservice registry, the
// stderr writes, the `process.exit` calls, and the `startServer` call — now
// belongs to the consumer's Entry_Module, which imports this package by name.
//
// What the barrel exports (R3.1, R3.2):
//   - `boot`        — the pure boot pipeline (validate → collisions → toggles →
//                     build), run against an injected registry, environment, and
//                     config,
//   - `startServer` — the HTTP listener binder,
//   - every type either function names in its signature, so a consumer can type
//     its own call sites without deep-importing a module of this package.
//
// `Express` and `http.Server` also appear in those signatures and are
// deliberately re-exported by neither: they are types of declared dependencies a
// consumer imports from `express` and `node:http` directly.
//
// Everything else — `loadConfig`, `buildApp`, `validateToggles`,
// `toggleVarName`, `parseToggle` — stays internal. The barrel is the package's
// whole public surface; nothing reached only by a relative path into `src/` is
// stable.

export { boot } from "./boot.js";
export { startServer } from "./server.js";
export type {
  BootOptions,
  BootResult,
  RegisteredMicroserviceInfo,
} from "./boot.js";
export type { AppConfig } from "./config.js";

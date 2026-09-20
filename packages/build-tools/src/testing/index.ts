// @microservices/build-tools/dist/testing — public entry point for shared test support.
//
// Re-exports the fast-check arbitraries used across the monorepo's property
// tests. This module is reached by its compiled deep path and is intended
// for test code only; nothing here is part of the shipped runtime contract.

export * from "./arbitraries.js";

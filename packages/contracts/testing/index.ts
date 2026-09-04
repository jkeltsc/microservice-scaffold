// @microservices/contracts/testing — public entry point for shared test support.
//
// Re-exports the fast-check arbitraries used across the monorepo's property
// tests. This sub-path is wired in package.json as `./testing` and is intended
// for test code only; nothing here is part of the shipped runtime contract.

export * from "./arbitraries.js";

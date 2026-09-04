# Product

The Microservice Scaffold is a template repository for building small, HTTP-based Node.js microservices behind a single routing frontend (the Overseer).

## Goals

- Keep each microservice a fully independent Node module: own `package.json`, own dependencies, no reach into peers.
- Make it trivial to add, remove, or rearrange microservices without touching unrelated ones.
- Support producing both generic containers (all registered microservices) and use-case-specific containers (a declared subset).
- Provide a per-microservice runtime toggle so operators can disable a service without a rebuild.

## Non-goals

- No cross-service communication patterns (message buses, service meshes, RPC frameworks) at this stage.
- No authn/authz layer; scope is limited to routing and lifecycle.
- No persistence; microservices in the scaffold are stateless by default.

## Success criteria

- Adding a fourth microservice requires: creating one module, registering one identifier, no changes to existing microservices.
- A minimal container image can be produced that ships only the microservices it needs.

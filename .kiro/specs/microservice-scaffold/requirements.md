# Requirements Document

## Introduction

The Microservice Scaffold provides a minimal, extensible pattern for composing HTTP microservices behind a single routing frontend. The scaffold ships with three reference "hello-world" microservices (microservice1, microservice2, microservice3), each packaged as its own Node module. An Overseer application loads microservice modules, mounts their declared paths, and exposes a per-microservice toggle to enable or disable individual services at runtime. Disabled or unknown paths return HTTP 404.

The scaffold also introduces the concept of a Microservice Registry that enumerates the microservices baked into a given build, and supports both generic Containers (bundling all microservices) and use-case-specific Containers (bundling a subset). Several composition-level decisions are deferred to the Design phase and are captured in the "Open Design Decisions" section below.

The Overseer mounts routes at the HTTP server root (`/`); each microservice declares its own full Microservice_Path (for example, `/auth`, `/api/microservice2`, or `/`), and the Overseer does not impose any hardcoded prefix. The Microservice_Registry that ships in a given Container is discovered from the filesystem at build time by scanning a single Microservice_Namespace and filtering the discovered candidates through a build-time MICROSERVICES_Selector. Runtime Toggle values for individual microservices are supplied to the Overseer as process environment variables at startup. Local development via `npm start` honors the same MICROSERVICES_Selector and generates the same Microservice_Registry as a Container build, so local runs behave identically to a produced Container for a given selector value. A GitHub Actions release pipeline builds the two shipped Container configurations and publishes them as OCI images to GitHub Container Registry (GHCR) on the repository's main branch and on tagged releases. The Overseer is built on Express; each microservice mounts an Express router at its declared Microservice_Path, so a single microservice can expose multiple related endpoints (for example, `GET /microservice2` plus `GET /microservice2/config`) under its mount point.

## Glossary

- **Microservice**: An independent Node module that declares its Microservice_Path and exposes an Express router mounted at that path, serving at least one HTTP endpoint — a GET at its declared Microservice_Path that identifies itself. Its Microservice_Identifier is its directory name under the Microservice_Namespace, not a module export. A Microservice MAY expose additional endpoints under its Microservice_Path subtree.
- **Microservice_Identifier**: The canonical string name of a microservice (e.g., `microservice1`). It IS the module's directory name under the Microservice_Namespace — the single source of truth — and is recorded in the Microservice_Registry by the Build_System rather than declared by the module itself. Also used as the identifier in the MICROSERVICES_Selector and as the value of the `microservice-name` response field. Must be unique across all microservices in a Container (directory names are necessarily unique within the Microservice_Namespace).
- **Microservice_Path**: The full HTTP request path (starting with `/`) at which a Microservice mounts its Express router. The Microservice owns the entire subtree rooted at this path — HTTP requests whose path equals the Microservice_Path or begins with the Microservice_Path followed by `/` are forwarded to the Microservice. Declared by the Microservice itself, not by the Overseer. Example values: `/auth`, `/api/microservice2`.
- **Microservice_Namespace**: The single filesystem location scanned at build time to discover microservices. Fixed as `packages/microservices/`; each direct subdirectory is a candidate microservice, and its directory name is its Microservice_Identifier. Candidate contents are not validated at discovery time — a malformed candidate fails the build when the generated Microservice_Registry's static import of it cannot be resolved.
- **MICROSERVICES_Selector**: A build-time value that selects which discovered microservices are included in a Container. Accepted values: `*` (include every candidate discovered in the Microservice_Namespace) or a comma-separated list of Microservice_Identifier values. An empty MICROSERVICES_Selector — meaning the value is not supplied, is the empty string, contains only whitespace, or parses to zero Microservice_Identifier entries — is treated as `*`.
- **Overseer**: The Node application, built on Express, that hosts the HTTP server, loads the microservice modules present in the current Container, applies runtime toggles, and mounts each enabled microservice's Express router at that microservice's declared Microservice_Path so the microservice owns its path subtree.
- **Microservice_Registry**: A build-time artifact enumerating the microservices baked into a given Container. Generated from a filesystem scan of the Microservice_Namespace filtered by the MICROSERVICES_Selector.
- **Container**: A deployable build artifact composed of the Overseer plus a specific set of microservice modules selected at build time.
- **Release_Pipeline**: The GitHub Actions workflow that builds the shipped Container configurations into OCI images and publishes them to GHCR. Defined in the repository under `.github/workflows/`.
- **Generic_Container**: A Container produced with MICROSERVICES_Selector `*`; includes every candidate microservice discovered in the Microservice_Namespace.
- **Specific_Container**: A Container produced with a comma-separated MICROSERVICES_Selector; includes exactly the named microservices and no others. The exclusion is physical, not merely a routing decision: a candidate microservice that the selector does not name is never built into the Container and is therefore absent from the produced artifact's filesystem.
- **Toggle**: A runtime configuration flag, one per microservice, that enables or disables routing to that microservice. Supplied as a process environment variable named `MICROSERVICE_<IDENTIFIER_UPPERCASED>_ENABLED`. The Overseer requires this variable to be set for every microservice present in the current Container. Shipped example Container images set image-level defaults for these variables (see Requirement 6); local developers supply them through their own environment (for example, a `.env` file loaded by their shell).
- **Build_System**: The tooling that produces a Container from the Overseer sources plus the microservice modules selected by the MICROSERVICES_Selector. The registry generator used by the Build_System is also invoked by `npm start` for local development runs, so local runs and Container builds share identical registry generation semantics.

## Open Design Decisions

The following points were raised as discussion items in the feature request. Requirements below are written so that any of the plausible resolutions can satisfy them.

### Open

1. **Loading vs routing for disabled microservices**: When a microservice is present in the Container but disabled by Toggle, should its module be loaded into the process and simply not routed, or should loading be skipped entirely? This affects startup time, memory footprint, and the failure mode when a disabled module has import-time side effects.

### Resolved

2. **Container composition strategy** — *Resolved*: The scaffold ships two example Container build configurations: a Generic_Container containing all reference microservices, and a Specific_Container containing exactly `microservice1` and `microservice2`. Both remain producible via the MICROSERVICES_Selector; see Requirement 6.
3. **Registry representation** — *Resolved*: The Microservice_Registry is a build-time generated TypeScript module. The Build_System scans the Microservice_Namespace, filters the discovered candidates by the MICROSERVICES_Selector, and emits a TypeScript manifest that statically imports each selected microservice module. See Requirement 5.
4. **Toggle source** — *Resolved*: Toggle values are supplied to the Overseer as process environment variables at startup, one environment variable per microservice. See Requirement 4.

## Requirements

### Requirement 1: Reference Microservices

**User Story:** As a developer evaluating the scaffold, I want three working hello-world microservices, so that I can see the pattern end-to-end without writing my own service first.

#### Acceptance Criteria

1. THE Microservice_Scaffold SHALL provide exactly three reference microservices, one distinct microservice per identifier, with Microservice_Identifier values `microservice1`, `microservice2`, and `microservice3`.
2. THE Microservice_Scaffold SHALL package each reference microservice as an independent Node module with its own `package.json`.
3. THE Microservice_Scaffold SHALL list the three reference microservices in the Microservice_Registry under the Microservice_Identifier values `microservice1`, `microservice2`, and `microservice3`.

### Requirement 2: Microservice Endpoint Contract

**User Story:** As a client of the scaffold, I want each microservice to respond identically to a simple GET at its declared mount path, so that I can verify routing without service-specific knowledge, while allowing individual microservices to expose additional endpoints under their own subtree.

#### Acceptance Criteria

1. WHEN a GET request is received whose path equals a Microservice's Microservice_Path, THE Microservice SHALL respond with HTTP status 200.
2. WHEN a GET request is received whose path equals a Microservice's Microservice_Path, THE Microservice SHALL respond with a body that is a JSON object containing exactly two fields and no additional fields: a field named `microservice-name` whose value is a JSON string equal to that Microservice's Microservice_Identifier, and a field named `path` whose value is a JSON string equal to that Microservice's Microservice_Path. (The Microservice_Identifier here is the module's directory name under the Microservice_Namespace, not a declared module export, so the expected value of `microservice-name` is well-defined without the module exporting it.)
3. WHEN a GET request is received whose path equals a Microservice's Microservice_Path, THE Microservice SHALL set the response `Content-Type` header to `application/json`.
4. IF a request whose method is not GET is received at a path equal to a Microservice's Microservice_Path, THEN THE Microservice SHALL respond with HTTP status 405 and set the `Allow` response header to `GET`.
5. A Microservice MAY expose additional HTTP endpoints at paths strictly beginning with its Microservice_Path followed by `/`; the contracts of those endpoints are microservice-specific and not constrained by this requirement.
6. THE reference microservice `microservice2` SHALL expose, in addition to its Microservice_Path root endpoint, a GET endpoint at the sub-path `<Microservice_Path>/config` that responds with HTTP status 200, `Content-Type: application/json`, and a JSON object body demonstrating a microservice-owned sub-endpoint (the exact payload shape is at the reference microservice's discretion, though it must be a JSON object).

### Requirement 3: Overseer Routing

**User Story:** As an operator, I want a single HTTP entry point that dispatches to the correct microservice, so that clients only need to know one host and one base path.

#### Acceptance Criteria

1. THE Overseer SHALL expose a single HTTP server, bound at startup to a port determined by runtime configuration, that serves as the sole ingress for all microservices in the current Container.
2. WHEN an HTTP request is received whose request path either equals the Microservice_Path of a microservice, or begins with that Microservice_Path followed by `/`, and that microservice is present in the current Container and enabled by Toggle, THE Overseer SHALL forward the request to that Microservice's Express router preserving the HTTP method, request headers, query string, and request body, and return the Microservice's response status code, response headers, and response body to the client unchanged.
3. IF an HTTP request is received whose request path is not covered by clause 2 (that is, the path does not equal, and is not a path-segment descendant of, the Microservice_Path of any microservice present in the current Container and enabled by Toggle), THEN THE Overseer SHALL respond with HTTP status 404.

### Requirement 4: Per-Microservice Runtime Toggle

**User Story:** As an operator, I want to enable or disable individual microservices without rebuilding, so that I can respond to incidents or gradually roll out services.

#### Acceptance Criteria

1. THE Overseer SHALL accept one Toggle value per microservice present in the Container, supplied via a process environment variable at Overseer startup. The environment variable name for a microservice whose Microservice_Identifier is `X` SHALL be `MICROSERVICE_X_ENABLED`, where `X` is the Microservice_Identifier uppercased. Each Toggle value SHALL be a case-insensitive token drawn from the set `enabled`, `disabled`, `true`, `false`, `1`, `0`, with `enabled`, `true`, and `1` mapping to enabled and `disabled`, `false`, and `0` mapping to disabled.
2. IF an HTTP request is received whose request path is covered by the Microservice_Path subtree of a microservice that is present in the current Container but whose Toggle is set to disabled, THEN THE Overseer SHALL respond with HTTP status 404.
3. IF the Overseer starts and any `MICROSERVICE_X_ENABLED` environment variable is not set for a Microservice_Identifier `X` present in the current Container, THEN THE Overseer SHALL abort startup before accepting HTTP requests, exit with a non-zero process exit code, and emit an error identifying every missing `MICROSERVICE_X_ENABLED` variable.
4. THE Overseer SHALL evaluate all Toggle values exactly once at process startup and SHALL treat those evaluated Toggle values as fixed for the lifetime of the Overseer process.
5. IF a Toggle value provided at Overseer startup is not one of the accepted tokens `enabled`, `disabled`, `true`, `false`, `1`, `0` (case-insensitive), THEN THE Overseer SHALL fail startup and emit an error identifying the microservice and the rejected Toggle value.

### Requirement 5: Microservice Registry

**User Story:** As a build engineer, I want a single source of truth for which microservices exist in a given build, so that Container builds and toggle configuration can be validated against a known list.

#### Acceptance Criteria

1. THE Build_System SHALL discover candidate microservices by listing the direct subdirectories of the Microservice_Namespace and treating each such subdirectory as a candidate microservice whose Microservice_Identifier is the subdirectory name, without inspecting the subdirectory's contents. (A subdirectory that is not a usable microservice module is therefore not skipped at discovery time; it surfaces as a build failure when the generated Microservice_Registry's static import of that module cannot be resolved.)
2. THE Build_System SHALL accept a MICROSERVICES_Selector supplied at build invocation. THE Build_System SHALL treat the value `*` and any empty MICROSERVICES_Selector (not supplied, empty string, whitespace-only, or parsing to zero Microservice_Identifier entries) as selecting every candidate microservice discovered in the Microservice_Namespace. Otherwise, THE Build_System SHALL select the candidate microservices whose Microservice_Identifier appears in the comma-separated list after trimming surrounding whitespace and ignoring empty entries.
3. WHEN the Build_System produces a Container, THE Build_System SHALL emit a generated Microservice_Registry as a TypeScript module that statically imports each selected microservice's module and enumerates the Microservice_Identifier and Microservice_Path of each.
4. IF the MICROSERVICES_Selector names a Microservice_Identifier for which no matching candidate exists in the Microservice_Namespace, THEN THE Build_System SHALL terminate without producing a Container artifact and emit an error identifying the unmatched Microservice_Identifier.
5. IF the Microservice_Namespace is unreadable, or contains no candidate microservices when the MICROSERVICES_Selector is `*`, THEN THE Build_System SHALL terminate without producing a Container artifact and emit an error identifying the condition. (Two candidates cannot declare the same Microservice_Identifier at discovery time, because the identifier is the — necessarily unique — directory name, and the Build_System emits one registry entry per directory. Identifier uniqueness therefore holds by construction end-to-end and is not verified at Overseer startup either; see Requirement 9.1.)

### Requirement 6: Container Composition

**User Story:** As a build engineer, I want to produce both a full-featured build and slimmer use-case-specific builds, so that deployments can carry only the microservices they need.

#### Acceptance Criteria

1. THE Build_System SHALL treat a build invocation with MICROSERVICES_Selector `*`, or with an empty MICROSERVICES_Selector, as producing a Generic_Container that includes every candidate microservice discovered in the Microservice_Namespace.
2. THE Build_System SHALL treat a build invocation with a comma-separated MICROSERVICES_Selector as producing a Specific_Container whose contents are exactly the microservices named in the selector. THE Build_System SHALL produce that Specific_Container such that the set of microservices present in the produced artifact's filesystem equals the set named by the selector: a candidate microservice discovered in the Microservice_Namespace but not named by the selector SHALL NOT be present in the produced artifact in any form.
3. WHEN the Overseer starts, THE Overseer SHALL log at startup the set of Microservice_Identifier, Microservice_Path, and Toggle state for every microservice present in the current Container.
4. IF the MICROSERVICES_Selector for a Specific_Container names a Microservice_Identifier for which no matching candidate exists in the Microservice_Namespace, THEN THE Build_System SHALL abort the build without producing a Container artifact and emit an error identifying the unknown Microservice_Identifier.
5. THE Microservice_Scaffold SHALL ship two example Container build configurations: one that produces a Generic_Container by invoking the Build_System with MICROSERVICES_Selector `*`, and one that produces a Specific_Container by invoking the Build_System with a MICROSERVICES_Selector containing exactly `microservice1` and `microservice2`.
6. EACH example Container build configuration shipped under Requirement 6 criterion 5 SHALL be built from an image build configuration derived from that configuration's MICROSERVICES_Selector, which sets `MICROSERVICE_X_ENABLED=enabled` as an image-level default for exactly the Microservice_Identifier values baked into that image, such defaults being overridable by any deploy-time environment configuration.

### Requirement 7: Toggling a Microservice Absent From the Container

**User Story:** As an operator, I want to be told immediately when I enable a microservice that isn't in this build, so that I don't discover the misconfiguration through a client 404.

#### Acceptance Criteria

1. IF the Overseer starts with one or more `MICROSERVICE_X_ENABLED` environment variables set to a value that maps to enabled for a Microservice_Identifier `X` not present in the current Container, THEN THE Overseer SHALL abort startup before accepting HTTP requests and exit with a non-zero process exit code.
2. IF a `MICROSERVICE_X_ENABLED` environment variable is set to a value that maps to disabled for a Microservice_Identifier `X` not present in the current Container, THEN THE Overseer SHALL not emit an error for that Toggle and SHALL treat that Toggle as absent for routing purposes.
3. WHEN the Overseer aborts startup under criterion 1, THE Overseer SHALL emit to its process error output an error message that names every Microservice_Identifier that triggered the abort.

### Requirement 8: Independent Microservice Modules

**User Story:** As a microservice author, I want each service to live in its own Node module, so that services can evolve independently and be reused across Containers.

#### Acceptance Criteria

1. THE Microservice_Scaffold SHALL define each Microservice as a standalone Node module that exports two values: a string constant equal to that Microservice's Microservice_Path, and an Express router whose route table satisfies Requirement 2 for that Microservice. THE Microservice_Identifier SHALL NOT be a module export: it is the module's directory name under the Microservice_Namespace, which the Build_System records in the Microservice_Registry.
2. THE Overseer SHALL support depending on any subset of microservice modules drawn from the Microservice_Registry without requiring source-code changes to microservices outside that subset.
3. THE Microservice_Scaffold SHALL require each microservice module to declare and own its runtime dependencies independently of other microservice modules.
4. THE Overseer SHALL access a microservice module only through its two declared exports (the Microservice_Path string and the Express router) and SHALL NOT depend on any service-internal symbols of that module. THE Overseer SHALL read a microservice's Microservice_Identifier from its Microservice_Registry entry, not from the module.
5. THE Build_System SHALL enforce the presence and types of a microservice module's two declared exports (Microservice_Path string and Express router) when it compiles the Microservice_Registry, such that a module missing either export, or declaring either with the wrong type, fails the build and cannot reach the Overseer. WHEN the Overseer starts, THE Overseer SHALL verify only what the type system cannot express: that each microservice module's Microservice_Path value is non-empty and begins with `/`. IF any loaded microservice module declares a Microservice_Path that is empty or does not begin with `/`, THEN THE Overseer SHALL fail startup and emit an error identifying the module and the invalid export, and SHALL report every offending module in a single startup attempt rather than stopping at the first.

### Requirement 9: Startup Collision Detection

**User Story:** As an operator, I want the Overseer to refuse to start when two microservices in the same Container share a path, so that I don't ship a container with ambiguous routing.

#### Acceptance Criteria

1. THE Microservice_Scaffold SHALL define a Microservice_Identifier as the name of a microservice's directory under the Microservice_Namespace, and THE Build_System SHALL emit exactly one Microservice_Registry entry per discovered directory, such that two entries in a generated Microservice_Registry cannot share a Microservice_Identifier. THE Overseer SHALL therefore perform no runtime verification of Microservice_Identifier uniqueness: uniqueness holds by construction and there is nothing left to verify.
2. WHEN the Overseer starts, THE Overseer SHALL, before accepting HTTP requests, verify that every microservice present in the current Container has a Microservice_Path value distinct from every other microservice's Microservice_Path in that Container.
3. WHERE a Microservice_Identifier is the directory name that the Build_System reads from the Microservice_Namespace, and a filesystem directory cannot contain two children of the same name, THE Microservice_Scaffold SHALL treat a Microservice_Identifier collision as an unrepresentable state rather than a startup failure mode, and THE Overseer SHALL emit no Microservice_Identifier collision diagnostic.
4. IF any two microservices in the current Container share a Microservice_Path, THEN THE Overseer SHALL abort startup before accepting HTTP requests, exit with a non-zero process exit code, and emit an error identifying every colliding Microservice_Path and the Microservice_Identifier of each module that declared it.
5. THE Microservice_Scaffold SHALL define "distinct" for Microservice_Path values as follows: two Microservice_Path values `p1` and `p2` collide if and only if `p1` equals `p2`. Parent/child path overlaps (for example, `/api` and `/api/v2`) are a valid Express mount topology because the Overseer sorts mounts by path length descending, so the longer mount always wins for its subtree; they do not constitute a collision. The root path `/` is likewise permitted as a Microservice_Path — it does not collide with other paths that are not exact duplicates.

### Requirement 10: Local Development Parity

**User Story:** As a developer, I want `npm start` to run the Overseer with the same registry semantics as a produced Container, so that I can iterate locally without shipping to a container to see how a specific microservice selection behaves.

#### Acceptance Criteria

1. WHEN `npm start` is invoked from the repository root, THE Microservice_Scaffold SHALL read the `MICROSERVICES` environment variable, generate a Microservice_Registry from the Microservice_Namespace filtered by that value using the same registry generation logic used by a Container build, and start the Overseer using the generated Microservice_Registry.
2. THE Microservice_Scaffold SHALL apply identical registry generation semantics under `npm start` and under a Container build, such that for any given `MICROSERVICES` value and Microservice_Namespace contents the two produce Microservice_Registry values with the same set of Microservice_Identifier and Microservice_Path entries.
3. WHERE `npm start` is invoked with an empty `MICROSERVICES` environment variable — meaning the variable is not set, is the empty string, contains only whitespace, or parses to zero Microservice_Identifier entries — THE Microservice_Scaffold SHALL treat the MICROSERVICES_Selector as `*`.
4. IF the `MICROSERVICES` value supplied to `npm start` names a Microservice_Identifier for which no matching candidate exists in the Microservice_Namespace, THEN THE Microservice_Scaffold SHALL fail before the Overseer accepts HTTP requests, exit with a non-zero process exit code, and emit an error identifying the unmatched Microservice_Identifier.

### Requirement 11: GHCR Release Pipeline

**User Story:** As a release engineer, I want a GitHub Actions workflow that builds and publishes both shipped Container configurations to GHCR on merges to main and on tagged releases, so that deployable images are always available and traceable to a Git revision without manual steps.

#### Acceptance Criteria

1. THE Microservice_Scaffold SHALL include a Release_Pipeline defined in a GitHub Actions workflow file under `.github/workflows/` in the repository.
2. THE Release_Pipeline SHALL trigger on: (a) pushes to the `main` branch, (b) pushes of Git tags matching the semver pattern `v*.*.*`, and (c) manual invocation via `workflow_dispatch`.
3. WHEN the Release_Pipeline runs on a triggering event, THE Release_Pipeline SHALL build both example Container configurations shipped under Requirement 6 criterion 5 — the Generic_Container (MICROSERVICES_Selector `*`) and the Specific_Container (MICROSERVICES_Selector containing exactly `microservice1` and `microservice2`) — using the same Build_System invocations described in Requirement 6. THE Build_System SHALL verify at build time that the assembled image tree contains only the microservices named by the selector, failing the build if an unselected microservice is present.
4. WHEN the Release_Pipeline builds a Container image, THE Release_Pipeline SHALL publish that image to GHCR under a repository path derived from the GitHub repository owner and name, distinguishing the two shipped configurations by distinct image name suffixes so their images do not collide.
5. WHEN the Release_Pipeline publishes an image, THE Release_Pipeline SHALL apply the following image tags: (a) a short Git commit SHA on every publish; (b) the tag `latest` when the trigger is a push to `main`; and (c) the semver value (with the leading `v` stripped) when the trigger is a push of a tag matching `v*.*.*`.
6. THE Release_Pipeline SHALL authenticate to GHCR using the workflow-provided `GITHUB_TOKEN` and SHALL request the minimum permissions required to publish: `contents: read`, `packages: write`, and `id-token: write` (for OIDC federation readiness).
7. WHEN the Release_Pipeline runs on a pull request targeting `main`, THE Release_Pipeline SHALL build both Container configurations but SHALL NOT publish any image, so that build breakage is caught before merge without polluting GHCR.
8. IF any Container build step in the Release_Pipeline exits with a non-zero status, THEN THE Release_Pipeline SHALL fail the workflow run without publishing any image from that run.
9. THE Release_Pipeline SHALL record in each publish step the exact MICROSERVICES_Selector value used to produce the corresponding image, so the association between an image and its selector is visible in the workflow logs.

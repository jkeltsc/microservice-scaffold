# Requirements Document

## Introduction

The Microservice Scaffold today supports exactly one shared library: `packages/contracts`, which is special-cased everywhere it matters. The registry generator and the image-tree assembler hard-code `contracts` by name, the Overseer imports it directly, and the Dockerfile emit script bakes it in through the general `packages/*` scan. There is no supported way for a scaffold user to add a *second* shared library that several microservices depend on and have it build in the right order, typecheck, and ship correctly (and minimally) inside container images.

This feature generalizes the notion of a shared package: a plain, non-microservice npm workspace under the `@microservices` scope that one or more microservices import by package name. The Build_System must discover these packages, keep the workspace build order topological, stage the shared packages a selected microservice actually needs into the container image (as real `node_modules/@microservices/<name>` directories), and preserve image minimality so that a Specific_Container never ships a shared package none of its selected microservices consume.

To prove the mechanism concretely rather than only enabling it abstractly, this feature also ships a Sample_Shared_Package. The `config` concern currently inline in `microservice2` (the `GET /config` sub-endpoint body) is relocated into a new Shared_Package under the `@microservices` scope, and both `microservice2` and `microservice3` consume it. This exercises the multi-consumer sharing goal end to end: two independent microservices depend on one leaf library by package name, the library builds ahead of them, ships into images only when a consumer is selected, and the existing `microservice2` `/config` behavior is preserved.

The scope is limited to enabling shared *libraries* consumed at build/runtime by microservices. It does not add cross-service communication, and it does not change what a microservice is or how it is routed.

## Glossary

- **Build_System**: The collection of tooling that discovers packages, generates the Microservice_Registry, orders the workspace build, and assembles the container image tree. Concretely the code in `packages/build-tools/` plus `scripts/emit-effective-dockerfile.sh`.
- **Shared_Package**: A non-microservice npm workspace under `packages/` (outside `packages/microservices/`) whose public API is imported by package name (`@microservices/<name>`) by one or more microservices and/or the Overseer. `packages/contracts` is the existing reference Shared_Package.
- **Shared_Package_Location**: The single filesystem location the Build_System treats as the home for Shared_Packages.
- **Sample_Shared_Package**: The concrete Shared_Package this feature ships as a reference, owning the `config` concern relocated out of `microservice2`, consumed by both `microservice2` and `microservice3`. Its package name is under the `@microservices` scope (e.g. `@microservices/config`).
- **Config_Payload**: The JSON body `microservice2` currently returns from its `GET /config` sub-endpoint: an object carrying `microservice-name`, `path`, and a `config` object with `sampleSetting` and `description` fields.
- **Microservice**: A package under `packages/microservices/<identifier>/` that exports a Microservice_Path and an Express router, as defined by the existing scaffold conventions.
- **Microservice_Identifier**: The directory name of a Microservice under `packages/microservices/`.
- **Selector**: The `MICROSERVICES` build/runtime variable value (`*` for all discovered microservices, or a comma-separated list of Microservice_Identifiers).
- **Selected_Microservices**: The set of Microservices resolved from the Selector.
- **Required_Shared_Packages**: The set of Shared_Packages that the Selected_Microservices (and the Overseer) depend on, directly or transitively, through their `dependencies`.
- **Overseer**: The routing frontend application at `packages/overseer/`.
- **Image_Tree**: The staging tree assembled by `packages/build-tools/` (`/out`) that the container runtime stage overlays.
- **Generic_Container**: A container image built with Selector `*` (every discovered Microservice).
- **Specific_Container**: A container image built with a comma-separated Selector (a declared subset of Microservices).
- **Workspace_Build_Order**: The order of the `workspaces` array in the root `package.json`, which is also the topological order npm visits packages in.
- **Root_Manifest**: The root `package.json`.

## Requirements

### Requirement 1: Define where Shared_Packages live

**User Story:** As a scaffold user, I want a single, documented location for shared libraries, so that I can add one without guessing where it belongs or how the tooling will find it.

#### Acceptance Criteria

1. THE Build_System SHALL treat a Shared_Package as a workspace located directly under `packages/` that is neither the `packages/microservices/` namespace container nor a test-only package.
2. THE Build_System SHALL recognize a Shared_Package without requiring any per-package registration entry beyond the package's own `package.json` and its presence under the Shared_Package_Location.
3. WHERE a Shared_Package is added under the Shared_Package_Location, THE Build_System SHALL require no changes to any existing Microservice, to `Dockerfile.template`, or to the registry generator source in order to discover the Shared_Package.

### Requirement 2: Shared_Package package conventions

**User Story:** As a scaffold user, I want shared libraries to follow the same package conventions as the rest of the repo, so that they build, typecheck, lint, and test the same way.

#### Acceptance Criteria

1. THE Shared_Package SHALL declare a `package.json` with `"type": "module"`, a `"name"` under the `@microservices` scope in kebab-case that mirrors the directory name, `"main"` pointing at compiled output under `dist/`, and a `"types"` field.
2. THE Shared_Package SHALL provide a `tsconfig.json` that extends `../../tsconfig.base.json`.
3. THE Shared_Package SHALL expose the `build`, `test`, `lint`, and `typecheck` npm scripts that every package in the repository exposes.
4. THE Shared_Package SHALL limit its stable public API to what its barrel (`index.ts`) re-exports.
5. WHEN a Microservice depends on a Shared_Package, THE Microservice SHALL declare the dependency in its `package.json` `dependencies` by the Shared_Package's `@microservices/<name>` package name.
6. THE Microservice SHALL import a Shared_Package only by its `@microservices/<name>` package name, not by relative path into the Shared_Package's source or `dist`.

### Requirement 3: Preserve microservice independence rules

**User Story:** As a maintainer, I want shared packages to be the only new sharing mechanism, so that microservice independence is preserved.

#### Acceptance Criteria

1. THE Microservice SHALL depend on other code outside its own package only through Shared_Packages or third-party dependencies.
2. THE Microservice SHALL NOT import from any peer Microservice package. (Negative statement retained: this is an existing structural prohibition the feature must not weaken.)
3. THE Microservice SHALL NOT import from the Overseer package. (Negative statement retained for the same reason.)
4. THE Shared_Package SHALL NOT import from any Microservice package or from the Overseer package. (Negative statement retained: a Shared_Package is a leaf library and must not depend upward.)

### Requirement 4: Keep the workspace build order topological

**User Story:** As a scaffold user, I want adding a shared package to keep the workspace build order correct, so that `npm run <script> --workspaces` builds every consumer after its dependency on any machine, including a fresh clone.

#### Acceptance Criteria

1. THE Root_Manifest `workspaces` array SHALL list every Shared_Package before every Microservice that depends on the Shared_Package and before the Overseer WHERE the Overseer depends on the Shared_Package.
2. WHEN `npm run build --workspaces` runs on a fresh clone, THE Build_System SHALL compile each Shared_Package before any package that depends on the Shared_Package.
3. IF a Shared_Package is listed in the `workspaces` array after a package that depends on the Shared_Package, THEN THE feature documentation SHALL identify this ordering as the cause of a fresh-clone build failure. (Documentation obligation; the ordering itself is enforced by the array.)

### Requirement 5: Shared_Packages are not discovered as Microservices

**User Story:** As a maintainer, I want the registry generator to keep discovering only microservices, so that adding a shared library never registers a route or a microservice entry.

#### Acceptance Criteria

1. THE registry generator SHALL discover Microservices only by scanning `packages/microservices/`.
2. WHEN the registry generator runs, THE registry generator SHALL exclude every Shared_Package from the generated Microservice_Registry.
3. WHERE a Shared_Package exists under the Shared_Package_Location, THE generated Microservice_Registry SHALL contain no entry, import, or route for the Shared_Package.

### Requirement 6: Stage Required_Shared_Packages into the Image_Tree

**User Story:** As a scaffold user, I want the shared libraries my selected microservices depend on to be present in the container image, so that the image runs without a missing-module failure.

#### Acceptance Criteria

1. WHEN the Image_Tree is assembled for a Selector, THE Build_System SHALL stage every Required_Shared_Package into the Image_Tree as a real directory at `node_modules/@microservices/<name>` containing the Shared_Package's `package.json` and compiled `dist/` output.
2. THE Build_System SHALL stage each Required_Shared_Package as a real directory rather than as a workspace symlink into `packages/`.
3. WHEN the selective TypeScript build runs during Image_Tree assembly, THE Build_System SHALL compile every Required_Shared_Package before compiling the Microservices that depend on the Required_Shared_Package.
4. IF a Selected_Microservice declares a dependency on a Shared_Package that cannot be resolved, THEN THE Build_System SHALL fail the image build with a non-zero exit status.

### Requirement 7: Preserve image minimality for Specific_Containers

**User Story:** As an operator, I want a use-case-specific image to ship only the shared libraries its microservices actually need, so that image minimality is preserved.

#### Acceptance Criteria

1. WHEN a Specific_Container is built, THE Build_System SHALL stage a Shared_Package into the Image_Tree only WHERE the Shared_Package is a Required_Shared_Package of the Selected_Microservices or of the Overseer.
2. IF a Shared_Package that is not a Required_Shared_Package for the current Selector is present in the Image_Tree after assembly, THEN THE Build_System SHALL fail the image build with a non-zero exit status and a message naming the offending Shared_Package.
3. WHEN a Generic_Container is built, THE Build_System SHALL stage every Shared_Package that any discovered Microservice or the Overseer depends on.
4. THE Build_System SHALL establish image minimality by construction, staging only compiled Required_Shared_Packages rather than staging all Shared_Packages and pruning afterward.

### Requirement 8: Dockerfile manifest handles Shared_Packages

**User Story:** As a scaffold user, I want the generated Dockerfile to copy the manifests for shared libraries, so that the layered `npm ci` install resolves them the same way it resolves microservices and contracts.

#### Acceptance Criteria

1. WHEN `scripts/emit-effective-dockerfile.sh` runs, THE Build_System SHALL emit a manifest `COPY` line for each Shared_Package's `package.json` into both the build stage and the prod-deps stage manifest blocks.
2. THE Build_System SHALL discover Shared_Package manifests through the existing glob-style listing of `packages/*/package.json` rather than through a hard-coded per-package list.
3. WHERE a package under `packages/` is a test-only package named in the emit script's top-level exclusion list, THE Build_System SHALL omit that package from the generated manifest `COPY` lines.
4. THE generated `Dockerfile` SHALL carry the existing `# AUTO-GENERATED` header and remain gitignored.

### Requirement 9: Add a fourth microservice consuming a shared package requires no changes elsewhere

**User Story:** As a scaffold user, I want the documented "add" workflows to keep working, so that adding a shared library and consuming it is a bounded, local change.

#### Acceptance Criteria

1. WHERE a scaffold user adds a Shared_Package and makes one Microservice consume the Shared_Package, THE required changes SHALL be limited to: creating the Shared_Package workspace, adding the Shared_Package to the `workspaces` array in topological position, and adding the dependency to the consuming Microservice's `package.json`.
2. THE feature SHALL require no change to any Microservice that does not consume the newly added Shared_Package.
3. THE feature SHALL require no change to `Dockerfile.template` in order to add a Shared_Package.

### Requirement 10: Documentation and existing behavior

**User Story:** As a scaffold user, I want the shared-package workflow documented and the existing `contracts` behavior preserved, so that I can follow a clear pattern without regressions.

#### Acceptance Criteria

1. THE feature documentation SHALL describe the Shared_Package_Location, the package conventions, the required `workspaces` ordering, and how a Microservice declares and imports a Shared_Package dependency.
2. WHEN the feature is applied, THE existing `packages/contracts` Shared_Package SHALL continue to build, typecheck, and ship in the Image_Tree exactly as before, whether treated as a general Shared_Package or as a documented special case.
3. WHEN `npm run ci` runs after the feature is applied, THE quality gate SHALL pass with the Sample_Shared_Package present and consumed by at least one Microservice.

### Requirement 11: Ship a Sample_Shared_Package as the reference shared library

**User Story:** As a scaffold user, I want a concrete example shared library in the repository, so that I can copy a working pattern instead of assembling one from documentation alone.

#### Acceptance Criteria

1. THE feature SHALL provide a Sample_Shared_Package located directly under the Shared_Package_Location (under `packages/`, outside `packages/microservices/`).
2. THE Sample_Shared_Package SHALL satisfy every Shared_Package convention defined in Requirement 2, including `"type": "module"`, an `@microservices`-scoped kebab-case `"name"` mirroring the directory name, `"main"` and `"types"` fields, a `tsconfig.json` extending `../../tsconfig.base.json`, the `build`, `test`, `lint`, and `typecheck` scripts, and a barrel (`index.ts`) that defines the stable public API.
3. THE Sample_Shared_Package SHALL export the config data, shape, and helper needed to construct the Config_Payload.
4. THE Sample_Shared_Package SHALL comply with Requirement 3: the Sample_Shared_Package SHALL NOT import from any Microservice package or from the Overseer package.
5. THE Root_Manifest `workspaces` array SHALL list the Sample_Shared_Package before `microservice2`, before `microservice3`, and before any other package that depends on the Sample_Shared_Package, in accordance with Requirement 4.
6. WHEN the registry generator runs, THE generated Microservice_Registry SHALL contain no entry, import, or route for the Sample_Shared_Package, in accordance with Requirement 5.

### Requirement 12: Relocate the config concern out of microservice2 into the Sample_Shared_Package

**User Story:** As a maintainer, I want microservice2's config concern to live in the shared library, so that the relocation demonstrates sharing without changing the observable behavior of microservice2.

#### Acceptance Criteria

1. THE microservice2 package SHALL declare a dependency on the Sample_Shared_Package in its `package.json` `dependencies` by the Sample_Shared_Package's `@microservices/<name>` package name.
2. THE microservice2 package SHALL import the config data, shape, or helper from the Sample_Shared_Package only by its `@microservices/<name>` package name, not by relative path into the Sample_Shared_Package's source or `dist`.
3. WHEN a `GET /config` request is received at the microservice2 mount subtree, THE microservice2 router SHALL return a `200` response with `Content-Type: application/json` whose body is equivalent to the Config_Payload microservice2 returned before the relocation.
4. THE microservice2 package SHALL construct the `GET /config` response body using the config data, shape, or helper exported by the Sample_Shared_Package rather than an inline literal duplicated in microservice2.
5. THE microservice2 package SHALL preserve its existing `GET /` identifier response and its `405` fallback behavior at the mount root unchanged.

### Requirement 13: Make microservice3 a second consumer of the Sample_Shared_Package

**User Story:** As a scaffold user, I want a second microservice to consume the same shared library, so that the multi-consumer sharing goal is concretely exercised.

#### Acceptance Criteria

1. THE microservice3 package SHALL declare a dependency on the Sample_Shared_Package in its `package.json` `dependencies` by the Sample_Shared_Package's `@microservices/<name>` package name.
2. THE microservice3 package SHALL import from the Sample_Shared_Package only by its `@microservices/<name>` package name, not by relative path into the Sample_Shared_Package's source or `dist`.
3. WHEN a `GET /config` request is received at the microservice3 mount subtree, THE microservice3 router SHALL return a `200` response with `Content-Type: application/json` whose body is constructed using the config data, shape, or helper exported by the Sample_Shared_Package.
4. THE microservice3 package SHALL preserve its existing `GET /` identifier response and its `405` fallback behavior at the mount root unchanged.
5. THE microservice3 package SHALL NOT import the config concern from microservice2 or from any other peer Microservice package, in accordance with Requirement 3.

### Requirement 14: The Sample_Shared_Package builds, ships, and stays minimal like any Shared_Package

**User Story:** As an operator, I want the sample library to behave exactly like a general shared package in the build and image pipeline, so that it proves the whole mechanism rather than a special case.

#### Acceptance Criteria

1. WHEN `npm run build --workspaces` runs on a fresh clone, THE Build_System SHALL compile the Sample_Shared_Package before compiling microservice2 and microservice3, in accordance with Requirement 4.
2. WHEN an Image_Tree is assembled for a Selector whose Selected_Microservices include microservice2 or microservice3, THE Build_System SHALL stage the Sample_Shared_Package into the Image_Tree as a real directory at `node_modules/@microservices/<name>` containing its `package.json` and compiled `dist/` output, in accordance with Requirement 6.
3. WHEN a Specific_Container is built for a Selector whose Selected_Microservices include neither microservice2 nor microservice3, AND neither the Overseer nor any other Selected_Microservice depends on the Sample_Shared_Package, THE Build_System SHALL NOT stage the Sample_Shared_Package into the Image_Tree, in accordance with Requirement 7.
4. WHEN `scripts/emit-effective-dockerfile.sh` runs, THE Build_System SHALL emit a manifest `COPY` line for the Sample_Shared_Package's `package.json` through the existing glob-style listing of `packages/*/package.json`, in accordance with Requirement 8.

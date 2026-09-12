# Requirements Document

## Introduction

This feature adds two demonstration samples to the Microservice Scaffold. Neither adds
framework capability; both exercise capability the scaffold already has, so that a user of
the template can see it working end to end.

**Example A — Common_Package dependency chain.** A second Common_Package,
`@microservices/extended-config`, depends on the existing `@microservices/config` and widens
the settings block it returns with one additional property. Microservice2 keeps returning the
base payload; Microservice3 switches to the extended one. This exercises the
Common_Package → Common_Package dependency edge, the transitive Required_Dependencies walk,
and selector-driven minimality: a Container that ships only Microservice2 must not carry
`extended-config`, while one that ships only Microservice3 must carry both packages.

**Example B — first Spa_Package.** A `Demo` SPA at `packages/spa/demo` becomes the first
member of the `spa` Consumer_Category, which ships empty today. Microservice1 gains a static
content server that serves the SPA's bundled output at Microservice1's own mount root — the
Microservice_Path `/`, which is the Overseer's base URL. The Demo_Page offers two buttons and
three display fields — a Request_Field, a Status_Field, and a Body_Field: activating a button
calls the corresponding microservice over HTTP through the Overseer and shows the request line,
the received status, and the response body in those three fields. This exercises the
Bundler_Project build kind, the staging-only `microservice → spa` dependency edge, and the
toggle/selector story a Specific_Container produces when a called microservice is absent.

### Recorded decision — three display fields instead of one result field

The Demo_Page shows the outcome of a request in three separate fields — Request_Field,
Status_Field, Body_Field — rather than in one combined result field. The decision dissolves a
conflict rather than resolving it.

The earlier single-field design forced two acceptance criteria into contradiction. One required
the displayed text always to contain the requested path; another required the text for a
successful JSON response to *be* that response body serialised as JSON with a two-space indent.
The demo payload carries a microservice's *mount* path (`/microservice2`), not the *requested*
path (`/microservice2/config`), so a body serialised verbatim does not contain the requested
path, and both criteria could not hold at once. The available fixes were to grant one criterion
an exception, or to stop making one string serve every purpose. Separating the three facts HTTP
itself distinguishes — request, status, body — removes the contention at its source, and every
property that previously needed an exception becomes unconditional.

The separation also decouples the body's formatting from the status code. The single field had
entangled the two only because one string had to serve every purpose: the JSON-formatting rule
was written as a rule about successful responses because that was the branch in which the body
was the whole text. With a field of its own, the Body_Field formats whatever body arrived, so a
microservice returning a JSON error body with a non-2xx status now gets that body formatted
rather than dumped as unparsed text.

One constraint is recorded deliberately: the Request_Field shows the HTTP method and the
absolute URL, and **not** the HTTP protocol version. `fetch` does not expose the negotiated
version, and the browser may well use HTTP/2, so any version string on the page would be a
fabrication. The method, scheme, host, and path are all obtainable, and are what the
Request_Field shows.

### Recorded decision — subtree ownership

A Microservice_Package owns the subtree rooted at its Mount_Root and answers every request in
that subtree itself, and never leaves a request in its own subtree unhandled so that the Overseer
answers instead. The Overseer's responsibilities are exactly two: mount the enabled
Selected_Microservices at their exported Microservice_Paths, and respond 404 for a path where no
mounted microservice matches. The Overseer is not a fallback handler for a path a microservice owns
but chose not to answer.

The reasoning, recorded so that a later reader does not have to rediscover it:

- The set of microservices in a Container is a build-time product decision, not a coincidence. A
  Container built with `MICROSERVICES=microservice1` is a different product from one built with
  `microservice1,microservice2`. In the first product there is no Microservice2 and no
  Microservice2 subtree: `/microservice2/config` is simply a path inside Microservice1's subtree,
  which Microservice1 owns. Reasoning about it as "a peer's subtree" imports a fact from a
  different product.
- Nothing sits between a microservice's router and the Overseer's 404 catch-all in the mount
  stack, so a microservice calling `next()` for a path in its own subtree defers to no other
  handler — the catch-all is the only possible outcome. It was an indirect way of emitting a 404
  while placing the decision somewhere else.
- Because a microservice's response contract is then fully determined by its own router, that
  microservice's own test suite can assert every response it gives without composing an Overseer.

Ownership is a framework obligation about *whether* a microservice answers, not about *what* it
answers. Which status a microservice returns for a path it does not serve, and for a method it
does not serve, stays that microservice's own choice: Microservice1 answering a method it does
not serve with `405 Allow: GET, HEAD` and Microservice2 answering one with `405 Allow: GET` are
two valid choices under one obligation.

One consequence is worth stating plainly. A microservice mounted at `/` owns the whole origin, so
in a Container that contains one the Overseer's 404 catch-all is unreachable. That is the intended
outcome of the principle rather than a defect, and Requirement 13 states it as something the test
suites assert rather than a gap they work around.

### Recorded decision — the framework/sample test boundary

The framework contract for a microservice is exactly two things: the Microservice_Path it
exports and the Express router it exports. `structure.md` states that the router's route table
is "defined by the microservice". Nothing in steering mandates what any microservice serves at
its mount root, what status it returns for a given method, or what shape its response body
takes. Those are sample behaviour, owned by the sample.

The shared integration suite conflated the two. `endpoint-contract.test.ts` loops over all
three reference microservices asserting an identical `{microservice-name, path}` body and an
identical `405 Allow: GET`, promoting one sample's behaviour into a framework-wide law the
framework never declared. Eight further integration tests reach into Microservice1's identifier
JSON, either as a liveness probe or as a source-mutation anchor.

The `405 Allow: GET` assertion in that same loop has the identical flaw as the body assertion,
and for the identical reason: nothing in steering says what a microservice does with a method it
does not serve. It is one sample's method policy, not a framework rule, and a template user must
not read Microservice2's 405 as an obligation on a microservice they add.

Serving the Demo_Page at Microservice1's mount root is therefore blocked by test scope, not by
framework design. This feature corrects the boundary as a precondition: framework-scope
assertions keep to mounting and reachability, and every response-body, content-type, and
method-handling assertion moves to the owning microservice's own suite. Requirement 13 covers
the correction. Microservice1 then makes its own method choice under that boundary: it answers a
method it does not serve with `405 Allow: GET, HEAD` (Requirement 7), which differs from
Microservice2's and Microservice3's `405 Allow: GET`. The two differ deliberately, so that a
template user reads a method policy as the owning microservice's own and not as a framework rule.

### Verified finding — no Overseer change is needed

`packages/overseer/src/router.ts` selects the enabled registry entries, sorts them by
Microservice_Path length descending (lexicographic tiebreak), registers one
`app.use(path, router)` per entry in that order, and registers an app-level empty-body 404
catch-all last. Microservice1's path `/` is the shortest, so its mount is registered after
every peer's. Consequently:

- While a peer is enabled, its subtree is matched by the peer's mount before Microservice1's
  `/` mount is reached, so Microservice1's static serving cannot shadow it.
- While a peer is disabled or unselected, it is not mounted at all, so its subtree reaches
  Microservice1's `/` mount, where it is a path inside the subtree Microservice1 owns.
  Microservice1 answers it by its own rules — 405 for a method it does not serve, 404 for a
  GET or HEAD naming no file inside the Spa_Root. That is the reason this document forbids an
  SPA-history `index.html` fallback outright: without that prohibition such a path would answer
  200 with the Demo_Page instead of 404.

Both outcomes hold with the Overseer exactly as it stands. No Overseer change is required, and
none is proposed.

### Re-examined exposure — intended behaviour, and one theoretical case

An earlier draft recorded a shadowing exposure premised on Microservice1 leaving a not-mounted
microservice's subtree unhandled. Under the ownership principle that premise is gone, so the
subsection is restated:

- Because Microservice1 is mounted at `/`, and because the Overseer mounts nothing for a
  microservice that the Selector excludes or that is registered but toggled off, a request inside
  such a microservice's subtree reaches Microservice1. In that product the path belongs to
  Microservice1, and Microservice1 answering it — 405 for a method it does not serve, 404 for a
  GET or HEAD naming no file inside the Spa_Root — is the intended behaviour, not an exposure
  (Requirement 7). No SPA-history `index.html` fallback and no directory listing is what keeps
  that answer a 404 rather than a 200 carrying the Demo_Page.
- The one theoretical case that survives runs the other way: a bundled asset path could coincide
  with the subtree of a peer that *is* mounted, in which case the peer's mount wins and the asset
  is unreachable. Nothing in the repository can trigger this — no bundler emits a directory named
  after a Microservice_Identifier — and this feature proposes no change for it.
- Constraining a Spa_Package's valid build output by the set of Microservice_Identifiers in the
  repository is explicitly not the remedy for that case: it would couple a consumer library to
  the microservice set, which is the coupling direction the scaffold forbids everywhere else. The
  Overseer stays out of scope either way.

### In scope, newly

- **The integration test suite** (`packages/integration-tests/`) and the per-microservice test
  suites are in scope. Serving the Demo_Page at Microservice1's mount root is incompatible with
  integration tests that assert Microservice1 serves identifier JSON there, and those
  assertions are at the wrong scope in the first place (see the recorded decision on the
  framework/sample test boundary above).
- The `microservice-scaffold` spec's Requirements R2.1–R2.3 are a **historical record of a past
  change**, not a live constraint. The steering documents are the standing authority. No past
  spec document is amended, rewritten, or contradicted by this feature; this document simply
  does not treat those criteria as binding on Microservice1's present behaviour.

### Out of scope

- No change to the Build_System (`packages/build-tools/`), to `Dockerfile.template`, to
  `scripts/emit-effective-dockerfile.sh`, or to the root `workspaces` array. Both samples are
  expected to be picked up by discovery, the Dependency_Resolver, and the emit script's globs
  as they stand. Any change proven necessary is a finding, recorded during design. The order of
  the two build phases was investigated during this feature's requirements work and resolved in
  favour of the existing code: the single `tsc --build` pass is the first phase and the required
  Spa bundler builds are the second, entered only after that pass exits zero. That order is
  normative in the `package-categories` spec and was established there deliberately, so no
  Build_System change is warranted and none is proposed; the affected criteria of this document
  and the stale ordering paragraph in `.kiro/steering/tech.md` are what change instead.
- No change to the Overseer package (`packages/overseer/`), including its mount ordering and
  its 404 catch-all. See the verified finding above.
- No change to `packages/overseer/tests/router.property.test.ts`. That suite builds its own
  synthetic stub microservice modules and never imports a reference microservice, so it is
  unaffected by any behaviour change in this document.
- No authentication, authorisation, or persistence. The Demo_Page is a read-only view over two
  existing GET endpoints.
- No new Container configuration. The two configurations the release workflow already
  publishes (Generic, and the Specific `microservice1,microservice2`) stay as they are.

## Glossary

Terms already defined by the steering documents (`product.md`, `tech.md`, `structure.md`) and
the `microservice-scaffold`, `shared-packages`, and `package-categories` specs are reused with
their existing meaning: Build_System, Build_Kind, Bundler_Project, Tsc_Project,
Common_Package, Consumer_Category, Container, Framework_Singleton, Generic_Container,
Image_Tree, Microservice_Identifier, Microservice_Package, Microservice_Path,
Namespace_Container, Overseer, Required_Dependencies, Selected_Microservices, Selector,
Spa_Package, Specific_Container, Staged_Dependencies.

Terms this document adds or narrows:

- **Config_Package**: the existing Common_Package `@microservices/config` at
  `packages/common/config`.
- **Sample_Config_Block**: the settings object the Config_Package exports, today
  `{ sampleSetting: "example-value", description: "demonstration sub-endpoint" }`.
- **Config_Payload**: the response body the Config_Package builds for a supplied microservice
  name and Microservice_Path — `microservice-name`, `path`, and a `config` member holding the
  Sample_Config_Block.
- **Extended_Config_Package**: the new Common_Package `@microservices/extended-config` at
  `packages/common/extended-config`.
- **Extended_Config_Block**: the settings object the Extended_Config_Package exports: the
  Sample_Config_Block plus the property `extendedSetting`.
- **Extended_Config_Payload**: the response body the Extended_Config_Package builds for a
  supplied microservice name and Microservice_Path — `microservice-name`, `path`, and a
  `config` member holding the Extended_Config_Block.
- **Microservice1**, **Microservice2**, **Microservice3**: the reference Microservice_Packages
  at `packages/microservices/microservice1`, `…/microservice2`, and `…/microservice3`.
- **Mount_Root**: the Microservice_Path a microservice exports, at which the Overseer mounts
  that microservice's router. Microservice1's Mount_Root is `/`; Microservice2's is
  `/microservice2`; Microservice3's is `/microservice3`.
- **Owned_Subtree**: for one Microservice_Package, the set of request paths consisting of that
  microservice's Mount_Root and every path below it.
- **Subtree_Ownership**: the obligation that a Microservice_Package answer every request in its
  own Owned_Subtree from its own router, leaving none unhandled for the Overseer's catch-all to
  answer. The obligation fixes *whether* the microservice answers; the status, headers, and body
  it answers with stay that microservice's own choice.
- **Demo_Spa**: the new Spa_Package `@microservices/demo` at `packages/spa/demo`.
- **Spa_Root**: the directory holding the Demo_Spa's bundled output — `dist/` inside the
  Demo_Spa package directory, wherever that package is resolved from.
- **Spa_Resolution_Pair**: the matched pair of a Spa_Package's manifest declaration and the
  specifier its consuming microservice passes to a run-time module-resolution call, by which
  that microservice locates the Spa_Root. Two pairs are workable and they are mutually
  exclusive; the choice belongs to the microservice and Spa_Package that form the pair, not to
  the framework.
- **Demo_Page**: the `index.html` entry document of the Demo_Spa together with its bundled
  script, as loaded in a browser from Microservice1's Mount_Root.
- **Service_Button**: one of the Demo_Page's two buttons, labelled `Microservice 2` and
  `Microservice 3`.
- **Request_Line**: the string formed by the HTTP method of a request, a single space, and the
  absolute URL requested — scheme, host, and path — for example
  `GET http://localhost:3000/microservice2/config`. It carries no HTTP protocol version.
- **Request_Field**: the Demo_Page's single-line output control, the first of the three display
  fields in document order, that displays the Request_Line of the most recent request.
- **Status_Field**: the Demo_Page's single-line output control, the second of the three display
  fields in document order, that displays the status code the most recent request received in
  decimal, or an indication that the request settled without a status code together with the
  reported reason.
- **Body_Field**: the Demo_Page's read-only multi-line text control, the third of the three
  display fields in document order, that displays the response body of the most recent request,
  formatted.
- **Result_Formatter**: the Demo_Spa module that computes the Request_Field, Status_Field, and
  Body_Field texts, exporting one pure function per field — one taking a Request_Line, one
  taking a status code and a reason text, and one taking a response body — each returning a
  single string and touching no document.
- **Dependency_Resolver**: `packages/build-tools/src/required-dependencies.ts`, which produces
  the Required_Dependencies and the Staged_Dependencies for a Selector.
- **Image_Tree_Assembler**: `packages/build-tools/src/image-tree.ts`, which compiles the
  planned packages and stages the Image_Tree.
- **Repo_Invariant_Checker**: the `check:invariants` gate
  (`packages/build-tools/src/repo-invariants.ts`), which checks workspace coverage, import
  discipline, and Common_Package dependency direction.
- **Dev_Supervisor**: the watch-mode supervisor behind `npm run dev`
  (`packages/build-tools/src/dev-supervisor.ts`).
- **Quality_Gate**: the root `npm run ci` script and its ordered steps.
- **Integration_Suite**: the shared cross-package test suite at
  `packages/integration-tests/tests/`.
- **Framework_Scope_Test**: a test whose assertions rest only on what the framework declares —
  that an enabled microservice's exported router is mounted at its exported Microservice_Path
  and reachable there, and that a path no mounted microservice matches receives the Overseer's
  catch-all 404. A Framework_Scope_Test belongs in the Integration_Suite.
- **Sample_Scope_Test**: a test whose assertions rest on what one particular microservice
  chooses to serve — its response bodies, its content types, and its per-method handling. A
  Sample_Scope_Test belongs in the owning microservice's own package test suite.
- **Liveness_Probe_Test**: an Integration_Suite test whose subject is a process-level or
  build-level behaviour (start parity, dev cold start, environment pass-through, warm tree,
  selector 404 behaviour) and which issues an HTTP request only to confirm that a running
  Overseer is serving.
- **Mutation_Anchor**: the exact source substring an Integration_Suite test string-replaces in
  a tracked microservice source file in order to force a recompile or to introduce a
  deliberate error.

## Requirements

### Requirement 1: Extended_Config_Package as a second Common_Package

**User Story:** As a user of the template, I want a Common_Package that depends on another
Common_Package, so that I can see how to layer shared libraries without touching a
microservice.

#### Acceptance Criteria

1. THE Extended_Config_Package SHALL be located at the directory
   `packages/common/extended-config`, a direct subdirectory of the `common`
   Namespace_Container, so that discovery classifies it as a Common_Package by location alone
   and no registration elsewhere is required.
2. THE Extended_Config_Package SHALL declare the package name `@microservices/extended-config`,
   mirroring its directory name `extended-config` exactly, character for character.
3. THE Extended_Config_Package SHALL declare `"type": "module"` and `main` and `types` fields
   that are each a non-empty string resolving to a file inside the package's own `dist/`
   directory — `main` to the compiled JavaScript emitted from the barrel module and `types` to
   the declaration file emitted from that same barrel module.
4. THE Extended_Config_Package SHALL expose its public API through a single barrel module at
   `src/index.ts`, which SHALL re-export every value and type its consumers use, and no other
   module of the package SHALL be reachable through `main` or `types`.
5. THE Extended_Config_Package SHALL declare `@microservices/config` in its `dependencies` with
   a version specifier that resolves to the workspace copy of the Config_Package, and SHALL
   declare no dependency naming a Microservice_Package or the Overseer, so that it stays a leaf
   library pointing downward only.
6. THE Extended_Config_Package SHALL reference the Config_Package in every import by the exact
   package name `@microservices/config`, with zero imports naming a path inside the
   Config_Package's `src/` or `dist/` and zero relative import specifiers that resolve outside
   the Extended_Config_Package's own directory.
7. THE Extended_Config_Package SHALL declare the four scripts `build`, `test`, `lint`, and
   `typecheck`, each a non-empty string, and each SHALL exit with status 0 when run in the
   package directory on a clean clone after `npm ci` and after the Config_Package is built.
8. THE Extended_Config_Package SHALL declare a `tsconfig.json` that extends
   `../../../tsconfig.base.json` and that compiles the sources under `src/` into the package's
   own `dist/`, emitting both JavaScript and declaration files, while its `dist/` output and its
   build-info file stay untracked by version control.
9. IF the Extended_Config_Package's manifest omits `main`, omits `types`, declares either as an
   empty string, or declares a `name` that does not mirror its directory name, THEN THE
   Build_System SHALL exit with a non-zero status and an error indicating the missing or
   mismatched manifest field together with the offending package's directory, and SHALL NOT
   silently omit the package from the build.
10. IF the Extended_Config_Package imports the Config_Package by a relative path, by a path into
    the Config_Package's `src/` or `dist/`, or names a Microservice_Package or the Overseer in
    its dependencies, THEN THE Repo_Invariant_Checker SHALL report that violation naming the
    Extended_Config_Package and the offending specifier, and SHALL exit with a non-zero status.

### Requirement 2: Extended_Config_Block and Extended_Config_Payload content

**User Story:** As a user of the template, I want the extended package to widen the shared
settings block rather than restate it, so that the dependency edge carries visible value.

#### Acceptance Criteria

1. THE Extended_Config_Block SHALL hold every own key of the Sample_Config_Block with a value
   equal to the value the Sample_Config_Block gives that key, obtained from the
   Sample_Config_Block value the Extended_Config_Package imports from `@microservices/config`
   rather than by restating those values as literals in the Extended_Config_Package's sources.
2. THE Extended_Config_Block SHALL hold the key `extendedSetting` with the string value
   `extended-example-value`, compared character for character.
3. THE Extended_Config_Block SHALL hold exactly the own keys of the Sample_Config_Block plus
   `extendedSetting` and no other key, so that its own-key count is exactly one greater than
   the Sample_Config_Block's own-key count.
4. THE Extended_Config_Package SHALL export from its barrel module an Extended_Config_Block
   type declared by extending the Sample_Config_Block type it imports from
   `@microservices/config`, such that every Extended_Config_Block value is assignable to the
   Sample_Config_Block type and an object lacking the `extendedSetting` key is rejected by the
   type-level assertion suite.
5. WHEN a caller supplies a microservice name of 1 to 64 characters and a Microservice_Path of
   1 to 128 characters beginning with `/`, THE Extended_Config_Package SHALL return an
   Extended_Config_Payload whose `microservice-name` equals the supplied name character for
   character, whose `path` equals the supplied Microservice_Path character for character with no
   trimming, normalisation, or defaulting applied, and whose `config` member equals the
   Extended_Config_Block key for key and value for value.
6. WHEN a caller supplies any name and Microservice_Path pair within the bounds of criterion 5,
   THE Extended_Config_Package SHALL return an Extended_Config_Payload whose `config` member
   with the `extendedSetting` key removed equals, key for key and value for value, the `config`
   member of the Config_Payload the Config_Package returns for the same pair, and whose
   `microservice-name` and `path` equal that Config_Payload's `microservice-name` and `path`
   (metamorphic property).
7. WHEN a caller supplies any name and Microservice_Path pair within the bounds of criterion 5,
   THE Extended_Config_Package SHALL return an Extended_Config_Payload whose `config` member
   holds exactly the own keys of the Extended_Config_Block and no others, and whose own keys are
   exactly `microservice-name`, `path`, and `config`.
8. IF a caller supplies an empty name, an empty Microservice_Path, or both, THEN THE
   Extended_Config_Package SHALL return an Extended_Config_Payload carrying those supplied empty
   values unchanged and SHALL NOT raise an error, substitute a default value, or return an error
   indication.
9. WHEN a caller requests an Extended_Config_Payload between 2 and 100 times with the same name
   and Microservice_Path pair, THE Extended_Config_Package SHALL return payloads that are
   pairwise equal key for key and value for value, and SHALL leave the Sample_Config_Block the
   Config_Package exports unchanged in every key and value.

### Requirement 3: Microservice2 and Microservice3 sub-endpoints

**User Story:** As a user of the template, I want two microservices returning two different
payloads from the same sub-endpoint path, so that I can compare a base and a layered shared
library side by side.

#### Acceptance Criteria

1. THE Microservice3 SHALL declare `@microservices/extended-config` in its `dependencies` and
   SHALL reference it by that package name in every import, using no relative import path that
   leaves the Microservice3 package directory.
2. THE Microservice3 SHALL declare exactly two `@microservices`-scoped runtime dependencies —
   `@microservices/contracts` and `@microservices/extended-config` — and SHALL declare no direct
   dependency on `@microservices/config`.
3. WHEN a GET request arrives at `/microservice3/config`, THE Microservice3 SHALL respond with
   status 200, content type `application/json`, and a body that equals the
   Extended_Config_Payload for the name `microservice3` and the path `/microservice3`, holding
   exactly the keys `microservice-name`, `path`, and `config` and no others.
4. WHEN a GET request arrives at `/microservice2/config`, THE Microservice2 SHALL respond with
   status 200, content type `application/json`, and a body that equals the Config_Payload for the
   name `microservice2` and the path `/microservice2`, holding exactly the keys
   `microservice-name`, `path`, and `config` and no others, with the `config` member holding no
   `extendedSetting` key.
5. THE Microservice2 SHALL declare `@microservices/config` in its `dependencies` and SHALL
   declare exactly two `@microservices`-scoped runtime dependencies — `@microservices/contracts`
   and `@microservices/config`.
6. WHEN a GET request arrives at `/microservice3`, THE Microservice3 SHALL respond with status
   200, content type `application/json`, and a body holding exactly the keys `microservice-name`
   and `path` and no others, whose values are the string `microservice3` and the string
   `/microservice3`.
7. IF a request with a method other than GET arrives at `/microservice3`, THEN THE Microservice3
   SHALL respond with status 405 and the header `Allow: GET`.
8. IF a request with a method other than GET arrives at `/microservice3/config`, THEN THE
   Microservice3 SHALL respond with status 405, the header `Allow: GET`, and a body carrying no
   Extended_Config_Payload.
9. IF a request with a method other than GET arrives at `/microservice2/config`, THEN THE
   Microservice2 SHALL respond with status 405, the header `Allow: GET`, and a body carrying no
   Config_Payload.
10. IF a request of any method arrives at a path under `/microservice3` that is neither
    `/microservice3` nor `/microservice3/config`, THEN THE Microservice3 SHALL respond from its
    own router with status 404 and SHALL leave no such request unhandled, so that no request in
    Microservice3's Owned_Subtree reaches the Overseer's catch-all.
11. IF a request of any method arrives at a path under `/microservice2` that is neither
    `/microservice2` nor `/microservice2/config`, THEN THE Microservice2 SHALL respond from its
    own router with status 404 and SHALL leave no such request unhandled, so that no request in
    Microservice2's Owned_Subtree reaches the Overseer's catch-all.
12. THE Microservice2 and THE Microservice3 SHALL each satisfy Subtree_Ownership over its own
    Owned_Subtree, answering every request in that Owned_Subtree from its own router — status 200
    at the two paths it serves for the GET method, status 405 with the header `Allow: GET` at
    those two paths for every other method, and status 404 at every other path in the
    Owned_Subtree — so that each microservice's response contract is determined by its own router
    alone and is assertable without composing an Overseer.

### Requirement 4: Repository invariants hold for the new Common_Package

**User Story:** As a maintainer, I want the new shared library to satisfy every repository
invariant without a Build_System change, so that the scaffold's discovery-by-location claim is
demonstrated rather than asserted.

#### Acceptance Criteria

1. THE Extended_Config_Package SHALL be matched by exactly one entry of the root `workspaces`
   array — the entry `packages/common/*` — while that array's entries and their relative order
   stay identical to the declaration in place before this feature, with no entry added, removed,
   renamed, or reordered.
2. WHEN the Build_System derives the workspace build order from the root `workspaces` array by
   expanding each glob entry, THE Build_System SHALL place the Config_Package at a lower
   position than the Extended_Config_Package.
3. WHEN the Build_System derives the workspace build order, THE Build_System SHALL place the
   Extended_Config_Package at a lower position than every package that declares a dependency on
   it, including the Microservice3.
4. WHEN `npm run build --workspaces` runs from the repository root on a clone in which no
   package has a `dist/` directory and no package has a `tsconfig.tsbuildinfo` file, THE
   Build_System SHALL complete the Config_Package's build before starting the
   Extended_Config_Package's build and SHALL exit with status 0.
5. THE Build_System SHALL assign the Extended_Config_Package the Build_Kind Tsc_Project on the
   grounds of its location under `packages/common/`, SHALL include it as a root of the single
   `tsc --build` pass whenever it is in the Required_Dependencies, and SHALL, on the Image build
   path — the plan-driven path that derives the `tsc --build` roots from the Required_Dependencies
   and invokes a package-local `build` script only for a Bundler_Project — compile it through that
   `tsc --build` pass and invoke no package-local `build` script for it. This criterion constrains
   the Image build path alone and states nothing about the repository-wide ordered build, which
   runs `npm run build --workspace <name>` for every workspace package, the Extended_Config_Package
   included.
6. WHEN the Repo_Invariant_Checker runs over the repository containing the
   Extended_Config_Package, THE Repo_Invariant_Checker SHALL check workspace coverage, import
   discipline, and Common_Package dependency direction, SHALL report zero violations, and SHALL
   exit with status 0, with no source change to `packages/build-tools/`.
7. THE Extended_Config_Package SHALL declare, across `dependencies`, `devDependencies`, and
   `peerDependencies` combined, exactly the `@microservices`-scoped dependencies
   `@microservices/config` and, at most, Framework_Singleton names, and SHALL name no
   Microservice_Package and not the Overseer in any of those three fields.
8. IF the Extended_Config_Package names a Microservice_Package or the Overseer in any dependency
   field, THEN THE Repo_Invariant_Checker SHALL report a violation naming the
   Extended_Config_Package, the named package, and the Common_Package dependency-direction
   invariant, SHALL exit with a non-zero status, and SHALL modify no file in the repository.
9. IF a source file of the Extended_Config_Package contains a relative import that resolves to a
   location outside the Extended_Config_Package's own directory, THEN THE Repo_Invariant_Checker
   SHALL report a violation naming the importing file and the import specifier, and SHALL exit
   with a non-zero status.
10. IF the derived workspace build order places any package at a lower position than a package it
    depends on, THEN THE Repo_Invariant_Checker SHALL report a violation naming the dependent
    package and its dependency, and SHALL exit with a non-zero status.

### Requirement 5: Selector-driven staging of the two Common_Packages

**User Story:** As an operator, I want a Specific_Container to carry only the shared libraries
its selected microservices actually reach, so that image minimality is observable.

#### Acceptance Criteria

1. WHERE the Selector is `microservice2`, WHEN the Image_Tree_Assembler has finished staging the
   Image_Tree, THE Image_Tree_Assembler SHALL have staged Common_Packages whose set of
   directory names is exactly `{ config }`, with no directory staged at
   `node_modules/@microservices/extended-config`.
2. WHERE the Selector is `microservice3`, WHEN the Image_Tree_Assembler has finished staging the
   Image_Tree, THE Image_Tree_Assembler SHALL have staged Common_Packages whose set of
   directory names is exactly `{ config, extended-config }`, the Config_Package being staged
   because the Extended_Config_Package reaches it transitively and no selected microservice
   declares it directly.
3. WHERE the Selector is `microservice1`, WHEN the Image_Tree_Assembler has finished staging the
   Image_Tree, THE Image_Tree_Assembler SHALL have staged Common_Packages whose set of
   directory names is empty, with no directory staged at `node_modules/@microservices/config`
   and none at `node_modules/@microservices/extended-config`.
4. WHERE the Selector is `*`, WHEN the Image_Tree_Assembler has finished staging the Image_Tree,
   THE Image_Tree_Assembler SHALL have staged Common_Packages whose set of directory names is
   exactly `{ config, extended-config }`.
5. WHERE the Selector is `microservice3`, WHEN the Dependency_Resolver produces the
   Required_Dependencies, THE Dependency_Resolver SHALL return a list whose Common_Package
   members are exactly the Config_Package and the Extended_Config_Package, with the
   Config_Package at a lower index than the Extended_Config_Package.
6. WHEN the Image_Tree_Assembler stages a Common_Package for any Selector, THE
   Image_Tree_Assembler SHALL stage it as a real directory — not a symbolic link into
   `packages/` — at `node_modules/@microservices/<name>`, where `<name>` is that package's
   directory name under `packages/common/`, holding that package's `package.json` and its
   compiled `dist/` directory with at least the compiled barrel module and its type
   declarations, and holding no `src/` directory.
7. WHEN a Container built with the Selector `microservice3` has reached its ready state and
   serves a GET request at `/microservice3/config`, THE Container SHALL respond with status 200,
   content type `application/json`, and the Extended_Config_Payload for the name
   `microservice3` and the path `/microservice3`.
8. THE Image_Tree_Assembler SHALL stage `@microservices/contracts` as a real directory at
   `node_modules/@microservices/contracts` for every Selector, and THE Dependency_Resolver
   SHALL exclude `@microservices/contracts` from the Required_Dependencies, so that the staged
   Common_Package sets stated in criteria 1 to 4 count no Framework_Singleton.
9. IF a Common_Package in the Staged_Dependencies has no `dist/` directory, or has an empty
   `dist/` directory, when the Image_Tree_Assembler reaches the staging step, THEN THE
   Image_Tree_Assembler SHALL exit with a non-zero status, emit an error message naming that
   package's directory under `packages/common/`, and stage no Image_Tree, so that no Container
   ships an uncompiled Common_Package.
10. WHEN the Dependency_Resolver runs repeatedly for one unchanged Selector over one unchanged
    repository, THE Dependency_Resolver SHALL return the same Required_Dependencies list and the
    same Staged_Dependencies list, element for element in the same order, on every run.

### Requirement 6: Demo_Spa as the first Spa_Package

**User Story:** As a user of the template, I want a working SPA in `packages/spa/`, so that I
can see how a bundler-built frontend joins the build without a Build_System change.

#### Acceptance Criteria

1. THE Demo_Spa SHALL be located at the directory `packages/spa/demo`.
2. THE Demo_Spa SHALL declare the package name `@microservices/demo`, equal to
   `@microservices/` followed by its own directory name.
3. THE Demo_Spa SHALL declare a `scripts.build` entry whose value is a string holding at least
   one non-whitespace character.
4. THE Demo_Spa SHALL declare the four scripts `build`, `test`, `lint`, and `typecheck`, each
   with a value holding at least one non-whitespace character.
5. THE Demo_Spa SHALL declare its bundler as a devDependency whose version specifier is a
   single exact version containing none of the range operators `^`, `~`, `*`, `>`, `<`, `=`, or
   `||`.
6. WHEN the Demo_Spa's `build` script runs with the Demo_Spa directory as its working directory
   and exits with status 0, THE Demo_Spa SHALL have written into its own `dist/` directory an
   `index.html` document and, at each relative path that document references, a file, leaving no
   referenced path without a file.
7. THE Demo_Page SHALL reference each of its bundled assets by a path that begins with neither
   `/` nor a URL scheme and that resolves, relative to the `index.html` document, to a location
   inside the Spa_Root, so that the Demo_Page keeps working if a user later mounts Microservice1
   at a Microservice_Path other than `/`.
8. THE Build_System SHALL assign the Demo_Spa the Build_Kind Bundler_Project.
9. WHEN the Build_System builds the Demo_Spa, THE Build_System SHALL invoke the Demo_Spa's own
   `npm run build` with the Demo_Spa directory as the working directory.
10. THE Build_System SHALL admit only Tsc_Projects as roots of the `tsc --build` pass, so that
    the Demo_Spa appears as no root of that pass and is built by its bundler alone.
11. WHEN a build runs whose planned packages include the Demo_Spa, THE Build_System SHALL
    complete the Demo_Spa's bundler build with status 0 before it stages the Image_Tree, the
    bundler build being the second of the two build phases and entered only after the
    `tsc --build` pass has exited with status 0, so that the Demo_Spa's bundler may read a
    Tsc_Project's compiled output while no Tsc_Project ever reads the Demo_Spa's output.
12. WHERE the Selector selects Microservice1, THE Image_Tree_Assembler SHALL stage the Demo_Spa
    as a real directory, and not a symlink, at `node_modules/@microservices/demo` holding
    exactly its `package.json` and the contents of its `dist/`, and holding no `src/`, `tests/`,
    or `node_modules/` directory.
13. WHERE the Selector selects no microservice that reaches `@microservices/demo` through its
    Required_Dependencies — for example the Selector `microservice2,microservice3` — THE
    Image_Tree_Assembler SHALL stage a Spa_Package set that is exactly the empty set and SHALL
    create no `node_modules/@microservices/demo` directory in the Image_Tree.
14. WHEN the Repo_Invariant_Checker runs over a repository containing the Demo_Spa, THE
    Repo_Invariant_Checker SHALL report zero violations for the Demo_Spa and exit with status 0.
15. IF the Demo_Spa's `build` script exits with a status other than 0, THEN THE Build_System
    SHALL exit with a non-zero status, SHALL stage no Image_Tree, and SHALL report an error
    naming the Demo_Spa's package directory and the failed build step.
16. IF the Demo_Spa's `package.json` declares no `scripts.build` with at least one
    non-whitespace character, or declares a `name` other than `@microservices/` followed by its
    directory name, THEN THE Build_System SHALL exit with a non-zero status and report an error
    naming the Demo_Spa's package directory and the unsatisfied category contract, leaving the
    Image_Tree unstaged.
17. WHEN the Build_System derives the workspace build order, THE Build_System SHALL place the
    Demo_Spa before Microservice1 while the root `workspaces` array stays as it is declared
    today, and SHALL match the Demo_Spa with exactly one entry of that array.

### Requirement 7: Microservice1 serves the Demo_Spa at its Mount_Root

**User Story:** As a user of the template, I want the demo page at the Overseer's base URL, so
that opening the scaffold in a browser shows a working frontend with no path to remember.

#### Acceptance Criteria

1. THE Microservice1 SHALL declare `@microservices/demo` in its `dependencies`.
2. THE Microservice1 SHALL export the Microservice_Path `/` and an Express router, so that its
   Mount_Root is `/` and the framework contract it satisfies is unchanged by this feature.
3. WHEN the Microservice1 module initialises, THE Microservice1 SHALL determine the Spa_Root
   exactly once, as the `dist/` directory inside the package directory that a run-time
   module-resolution call on the package name `@microservices/demo` reports, and SHALL evaluate
   the presence of the Spa_Root and of each requested file per request rather than at
   initialisation.
4. THE Microservice1 SHALL obtain the Spa_Root exclusively through a module-resolution call
   whose sole argument is the package name `@microservices/demo`, with no static import, no
   dynamic import, and no relative path leaving the Microservice1 package directory, so that
   the Repo_Invariant_Checker reports zero violations and exits with status 0 for the
   Microservice1 package.
5. WHEN a GET request arrives at Microservice1's Mount_Root `/`, THE Microservice1 SHALL respond
   with status 200, content type `text/html`, and a body byte-identical to the Spa_Root's
   `index.html`, so that the Demo_Page is the response the Overseer's base URL serves.
6. WHEN a GET request arrives at a path under Microservice1's Mount_Root that names a file inside
   the Spa_Root, THE Microservice1 SHALL respond with status 200, a body byte-identical to that
   file's contents, and a content type determined solely by the file's extension — `text/html`
   for `.html`, `application/octet-stream` for an extension with no mapping, and the same
   content type for every request naming a file with the same extension.
7. IF a GET or HEAD request arrives at a path under Microservice1's Mount_Root that is not the
   Mount_Root itself and that names no file inside the Spa_Root — including a path naming a
   directory inside the Spa_Root — THEN THE Microservice1 SHALL respond from its own router with
   status 404, emitting neither a directory listing nor the Spa_Root's `index.html`, and SHALL
   leave no such request unhandled.
8. IF a request path resolves to a location outside the Spa_Root — whether through `..` segments,
   through percent-encoded `..` segments, through an absolute path segment, or through a symbolic
   link whose target lies outside the Spa_Root — THEN THE Microservice1 SHALL respond with status
   404 and a body holding no content read from outside the Spa_Root.
9. WHEN a HEAD request arrives at Microservice1's Mount_Root, or at a path under it that names a
   file inside the Spa_Root, THE Microservice1 SHALL respond with the status and content type the
   corresponding GET request receives and with an empty body.
10. WHEN a GET or HEAD request arrives at Microservice1's Mount_Root, or at a path under it,
    carrying a query string, THE Microservice1 SHALL select the served file from the request path
    alone and SHALL return the same status, content type, and body it returns for the same path
    without a query string.
11. IF a request whose method is neither GET nor HEAD arrives at Microservice1's Mount_Root `/` or
    at any path under it, THEN THE Microservice1 SHALL respond from its own router with status 405
    and the header `Allow: GET, HEAD`, deciding on the method before performing any filesystem
    check, so that the response is the same whether or not the path names a file inside the
    Spa_Root and whether or not the path names a directory. The status and the `Allow` header are
    Microservice1's own method policy — Microservice2 and Microservice3 answer `Allow: GET` for
    the paths they serve — while answering rather than deferring is the framework obligation of
    Subtree_Ownership, and Microservice1's own test suite SHALL be the sole place this handling is
    asserted.
12. THE Microservice1 SHALL satisfy Subtree_Ownership over its own Owned_Subtree, answering every
    request at its Mount_Root `/` and at every path under it from its own router and leaving none
    unhandled, so that while Microservice1 is mounted no request reaches the Overseer's catch-all
    and Microservice1's response contract is assertable from its own router alone, without
    composing an Overseer.
13. WHILE a peer microservice is among the Selected_Microservices with its runtime toggle enabled,
    WHEN a request arrives at that peer's Mount_Root or at a path under it, THE Overseer SHALL
    dispatch that request to the peer's router, so that Microservice1's static serving answers no
    request inside an enabled peer's subtree.
14. WHERE a microservice other than Microservice1 is absent from the Selected_Microservices or has
    its runtime toggle disabled, WHEN a request arrives at that microservice's Microservice_Path or
    at a path under it, THE Microservice1 SHALL answer that request from its own router by criteria
    5 through 11 — status 405 with the header `Allow: GET, HEAD` for a method other than GET or
    HEAD, status 200 for a GET or HEAD naming a file inside the Spa_Root, and status 404 for a GET
    or HEAD naming no file inside the Spa_Root — the path being one Microservice1 owns in a
    Container that contains no such microservice, and SHALL answer a path naming no file inside the
    Spa_Root with neither status 200 nor the Spa_Root's `index.html`.
15. THE Demo_Spa and THE Microservice1 SHALL use one Spa_Resolution_Pair — the Demo_Spa declaring
    `"exports": { ".": "./dist/index.html" }` and the Microservice1 resolving the bare package
    name `@microservices/demo` as criterion 4 requires — so that the two halves match, and so
    that a further microservice and Spa_Package added to this template may use the other
    Spa_Resolution_Pair instead, the Build_System constraining neither half.

### Requirement 8: Behaviour when the Spa_Root is absent

**User Story:** As a developer running the scaffold in watch mode, I want a clear message when
the SPA has not been bundled yet, so that I am not left guessing at an empty page.

#### Acceptance Criteria

1. IF the Spa_Root is absent — the resolved Spa_Root directory does not exist, or exists and
   holds no `index.html` document — WHEN a GET or HEAD request arrives at Microservice1's
   Mount_Root `/`, THEN THE Microservice1 SHALL respond with status 503, content type
   `text/plain`, and a body naming both the resolved Spa_Root path and the command
   `npm run build --workspace @microservices/demo` that produces it.
2. IF the Spa_Root is absent WHEN a request whose method is neither GET nor HEAD arrives at
   Microservice1's Mount_Root `/`, THEN THE Microservice1 SHALL respond with status 405 and the
   header `Allow: GET, HEAD`, exactly as Requirement 7 criterion 11 states for a present Spa_Root,
   so that the absence of the Spa_Root changes no method handling.
3. WHILE the Spa_Root is absent, THE Microservice1 SHALL answer from its own router every request
   at a path under its Mount_Root other than the Mount_Root itself — status 405 with the header
   `Allow: GET, HEAD` for a method other than GET or HEAD, and status 404 for a GET or HEAD
   request, an absent Spa_Root holding no file that could be served — so that Microservice1's
   Mount_Root is the only path that answers with status 503.
4. WHILE the Spa_Root is absent, THE Overseer SHALL complete startup without exiting, SHALL respond
   with status 200 to a GET request at the Mount_Root of every enabled microservice other than
   Microservice1 — the Mount_Root being the probe point because a request dispatched to a mounted
   router there never yields 404 — and SHALL respond with the status 503 of criterion 1 at
   Microservice1's Mount_Root, so that Overseer startup does not depend on the Spa_Root.
5. WHEN the Spa_Root becomes present after a request has been answered under criterion 1, THE
   Microservice1 SHALL answer the first subsequent GET request at its Mount_Root with status 200,
   content type `text/html`, and the contents of the Spa_Root's `index.html`, with no restart of
   the Overseer process and no intervening request required.
6. IF the Spa_Root becomes absent again after the Demo_Page has been served, THEN THE
   Microservice1 SHALL answer the first subsequent GET request at its Mount_Root with the status
   503 response of criterion 1, with no restart of the Overseer process.
7. IF a Spa_Package in the Staged_Dependencies has no `dist/` directory, or has an empty `dist/`
   directory, when an Image build reaches the staging step, THEN THE Image_Tree_Assembler SHALL
   exit with a non-zero status, emit a message naming that package's directory under
   `packages/spa/`, and stage no `node_modules/@microservices/<name>` directory for it into the
   Image_Tree, so that no Container ships an unbuilt Spa_Package. THE Image_Tree_Assembler SHALL
   treat the existence of a non-empty `dist/` directory as the whole of its staging precondition
   for a Spa_Package, requiring no particular emitted filename and in particular no `index.html`
   document, a Spa_Package's category contract being a non-empty `scripts.build` alone: the
   Build_System therefore has no basis for enforcing one bundler's output shape, and a
   Spa_Package whose bundler emits a different entry document SHALL stage successfully. The
   `index.html` checks that Requirement 7 criteria 3 and 5 and Requirement 8 criteria 1 and 3
   place on Microservice1 are deliberately asymmetric with this criterion and SHALL stay: they
   are Microservice1's own knowledge of the one HTML-entry Spa_Package it serves, not a framework
   rule, so restoring symmetry in either direction would be a defect.

### Requirement 9: Demo_Page structure and request behaviour

**User Story:** As a user of the template, I want a page with two buttons and three display
fields — request, status, body — so that I can call two microservices from a browser and read
each fact of what came back where I expect it.

#### Acceptance Criteria

1. THE Demo_Page SHALL present exactly two Service_Buttons, the first in document order
   carrying the visible label `Microservice 2` and the second carrying the visible label
   `Microservice 3`, each Service_Button's accessible name equalling its visible label.
2. THE Demo_Page SHALL present exactly three display fields — the Request_Field, the
   Status_Field, and the Body_Field — in that order in the document order, with all three
   positioned after both Service_Buttons.
3. THE Request_Field and THE Status_Field SHALL each be a native `output` element that is
   programmatically associated with a label that is visibly rendered on the Demo_Page, so that
   each carries the ARIA `status` role its element type maps to — an implicit polite live
   region, which announces an update with no explicit `aria-live` attribute declared — and so
   that each field's content is a text node, which is the content assistive technology can
   announce, unlike the value of a `textarea`.
4. THE Body_Field SHALL be a multi-line text control — a `textarea` element — that is read-only
   rather than disabled, reachable by keyboard, and programmatically associated with a label
   that is visibly rendered on the Demo_Page, so that a response body larger than the control is
   scrollable and selectable.
5. THE Demo_Page SHALL rely on the Status_Field alone to announce the outcome of a request,
   declaring `aria-live` on neither the Body_Field nor any ancestor element of the Body_Field,
   so that the Body_Field's value is deliberately not announced: the Status_Field carries the
   outcome a screen-reader user needs, and announcing a multi-kilobyte JSON body would be
   hostile rather than helpful. The absence of that announcement is the intended outcome and not
   a limitation.
6. THE Demo_Page SHALL hold the Request_Field element and the Status_Field element in the
   initially loaded document and SHALL keep each of those two elements in the document, neither
   replaced nor removed, for as long as the Demo_Page is loaded, so that the live-region
   semantics of criterion 3 apply to every update of each field.
7. THE Demo_Page SHALL render each Service_Button as a native `button` element that is reachable
   by sequential keyboard navigation in the document order, carries no positive tab index, and
   performs the same request on `Enter` activation, on `Space` activation, and on pointer
   activation.
8. WHEN the Demo_Page finishes loading, THE Demo_Page SHALL present both Service_Buttons enabled,
   the Request_Field holding no text, the Status_Field holding no text, and the Body_Field
   holding no text.
9. WHEN the `Microservice 2` Service_Button is activated while both Service_Buttons are enabled,
   THE Demo_Page SHALL send exactly one GET request to the path `/microservice2/config` on the
   Demo_Page's own origin.
10. WHEN the `Microservice 3` Service_Button is activated while both Service_Buttons are enabled,
    THE Demo_Page SHALL send exactly one GET request to the path `/microservice3/config` on the
    Demo_Page's own origin.
11. THE Demo_Page SHALL issue every microservice request as a same-origin request whose path is
    one of `/microservice2/config` and `/microservice3/config`, naming no other origin and
    reading no host from configuration, so that every call passes through the Overseer.
12. WHEN a Service_Button is activated while both Service_Buttons are enabled, THE Demo_Page
    SHALL replace the Request_Field text, before the request it sends settles, with the text
    Requirement 10 criteria 2 and 4 state for that request, replace the Status_Field text with a
    non-empty pending indication, and leave the Body_Field holding no text, restating no rule of
    its own for computing the Request_Field text.
13. WHILE a request is in flight, THE Demo_Page SHALL keep both Service_Buttons in the disabled
    state, so that at most one request is in flight at any time.
14. WHEN a request settles — by completing with a status, by failing at transport, or by
    reaching the 10-second request limit of criterion 16 — THE Demo_Page SHALL re-enable both
    Service_Buttons within 1 second of that settlement.
15. IF either Service_Button is activated while a request is in flight, THEN THE Demo_Page SHALL
    send no additional request and SHALL leave the Request_Field text, the Status_Field text,
    and the Body_Field text each unchanged.
16. IF a request has not completed within 10 seconds of being sent, THEN THE Demo_Page SHALL
    abandon that request, treat it as settled, display in the Status_Field the text Requirement 10
    criterion 8 states for an abandonment at that 10-second limit, and leave the Request_Field
    holding the Request_Line of the abandoned request.
17. WHEN a request completes with a status code, THE Demo_Page SHALL replace the whole Body_Field
    text with the text the Result_Formatter's body function returns for the response body received,
    as Requirement 10 criterion 9 states, and SHALL apply no formatting rule of its own,
    Requirement 10 criteria 11 through 14 being the sole statement of how that text is computed
    and of the status codes it applies to.
18. THE Demo_Spa SHALL declare, as its `@microservices`-scoped dependencies, only
    Framework_Singletons and Common_Packages.

### Requirement 10: Demo_Page field reporting and the Result_Formatter's three functions

**User Story:** As a user of the template, I want each of the three fields to explain failures
as well as successes, so that a Specific_Container that omits a microservice teaches me
something instead of appearing broken.

#### Acceptance Criteria

1. THE Result_Formatter SHALL be a single module of the Demo_Spa exporting exactly three
   functions, one per display field — a Request_Line function, a status function, and a body
   function — each returning a single string, so that each field's rule is stated and satisfied
   independently of the other two and no two rules compete for one string.
2. WHEN the Demo_Page sends a request, THE Demo_Page SHALL compose the Request_Line from the
   HTTP method of that request, a single space, and the absolute URL requested — scheme, host,
   and path — carrying no HTTP protocol version, and SHALL supply that Request_Line to the
   Result_Formatter's Request_Line function as a string, so that the function stays deterministic
   while the dependence on the browser environment sits in the Demo_Page's DOM wiring.
3. WHEN the Result_Formatter's Request_Line function is called with a Request_Line of 0 to 2,048
   characters, THE Result_Formatter SHALL return that Request_Line character for character,
   applying no branch, no truncation, no normalisation, and no substitution.
4. WHEN the Demo_Page sends a request, THE Demo_Page SHALL display in the Request_Field the text
   the Result_Formatter's Request_Line function returns for the Request_Line of criterion 2.
5. WHEN the Result_Formatter's status function is called with a status code present as an integer
   from 100 to 599 inclusive, THE Result_Formatter SHALL return text containing that status code
   in decimal, for every status code in that range including every status code from 200 to 299
   inclusive.
6. IF the Result_Formatter's status function is called with no status code and with a reported
   reason text of 1 to 2,048 characters, THEN THE Result_Formatter SHALL return text indicating
   that the request settled without a status code together with that reason text character for
   character.
7. IF the Result_Formatter's status function is called with no status code and with no reported
   reason text, THEN THE Result_Formatter SHALL return text indicating that the request settled
   without a status code and indicating a transport failure.
8. WHEN the Demo_Page abandons a request at the 10-second limit of Requirement 9 criterion 16,
   THE Demo_Page SHALL call the Result_Formatter's status function with no status code and with a
   reason text naming that 10-second limit, so that the abandonment is one instance of the
   settled-without-a-status-code case of criterion 6.
9. WHEN a request completes with a status code, THE Demo_Page SHALL replace the Status_Field text
   with the text the Result_Formatter's status function returns for that status code and replace
   the Body_Field text with the text the Result_Formatter's body function returns for that
   response body.
10. IF a request settles without a status code, THEN THE Demo_Page SHALL replace the Status_Field
    text with the text the Result_Formatter's status function returns for an absent status code
    and the reported reason text, and SHALL leave the Body_Field holding no text, no response
    body having arrived.
11. IF the Result_Formatter's body function is called with an absent response body, or with a
    response body that is a string of 0 characters, THEN THE Result_Formatter SHALL return text
    indicating that the response carried no body.
12. WHEN the Result_Formatter's body function is called with a response body that is parseable
    as JSON, THE Result_Formatter SHALL return that body serialised as JSON indented with two
    spaces.
13. WHEN the Result_Formatter's body function is called with a response body that is a string of
    1 or more characters that is not parseable as JSON, THE Result_Formatter SHALL return that
    response body character for character, with no truncation for a response body of up to
    1,048,576 characters.
14. THE Result_Formatter's body function SHALL take the response body as its sole input and
    SHALL receive no status code, so that its three branches — criteria 11, 12, and 13 — consult
    no status code, and so that a microservice returning a JSON error body with a status code
    outside 200 to 299 has that body formatted as JSON rather than returned as unparsed text.
15. THE Result_Formatter SHALL accept, as the whole input domain of its three functions, a
    Request_Line that is a string of 0 to 2,048 characters, a status code that is either absent
    or an integer from 100 to 599 inclusive together with a reason text that is either absent or
    a string of 0 to 2,048 characters, and a response body that is either absent or a string of
    0 to 1,048,576 characters.
16. WHEN any one of the Result_Formatter's three functions is called twice with input equal
    across the two calls — the same Request_Line, or the same status code and reason text, each
    present with the same value or absent in both calls, or the same response body — THE
    Result_Formatter SHALL return character-identical text from both calls (determinism
    property).
17. THE Result_Formatter SHALL return a string, and SHALL raise no error, from each of its three
    functions for every input in the domain criterion 15 states (totality property).
18. THE Result_Formatter SHALL read and write no document, issue no request, and use no
    browser-provided global in any of its three functions, so that all three are callable in a
    test environment that provides neither a DOM nor a browser global (purity property).
19. THE Request_Field SHALL hold the requested path character for character for every request
    the Demo_Page sends, unconditionally — with no exception for a response body parseable as
    JSON and no exception beyond the trivial one of a Request_Line of 0 characters, which the
    Demo_Page composes for no request (metamorphic property).
20. THE Status_Field SHALL hold the received status code in decimal for every status code from
    100 to 599 inclusive, unconditionally and no longer restricted to a status code outside the
    range 200 to 299 inclusive (metamorphic property).
21. WHEN the Result_Formatter's body function is called with the JSON serialisation of any JSON
    value as its response body, THE Result_Formatter SHALL return that same value serialised as
    JSON indented with two spaces (round-trip property).
22. WHERE a called microservice is excluded from the Container's Selector, WHEN its
    Service_Button is activated, THE Demo_Page SHALL display the status code 404 in decimal in
    the Status_Field and the requested path character for character in the Request_Field, that
    404 being the one Microservice1 returns under Requirement 7 criterion 14 because it owns that
    path in a Container that contains no such microservice.
23. WHERE a called microservice is disabled by its runtime toggle, WHEN its Service_Button is
    activated, THE Demo_Page SHALL display the status code 404 in decimal in the Status_Field and
    the requested path character for character in the Request_Field, that 404 being the one
    Microservice1 returns under Requirement 7 criterion 14.

### Requirement 11: The Quality_Gate and the local commands

**User Story:** As a maintainer, I want both samples to pass the existing gate and the existing
local commands unchanged, so that adding them costs no tooling debt.

#### Acceptance Criteria

1. WHEN `npm run ci` runs after `npm ci` on a clean clone — one with no installed dependencies,
   no build output, and no incremental build state present — THE Quality_Gate SHALL execute all
   of its steps in their declared order, skipping none, and SHALL exit with status 0.
2. THE lint configuration SHALL declare browser globals for the Demo_Spa's source files only, so
   that the lint step reports zero errors and zero warnings for the Demo_Page's use of
   `document`, `window`, and `fetch`, while every package outside the Demo_Spa keeps the global
   set declared for it today.
3. WHEN the Demo_Spa's `test` script runs, THE Demo_Spa's test suite SHALL execute under the
   repository's Vitest configuration in its default Node environment, SHALL reference no
   `document` or `window` global, and SHALL exit with status 0.
4. WHEN `npm test` runs from the repository root, THE Build_System SHALL invoke the Demo_Spa's
   own `build` script and observe it exit with status 0 before the first test executes.
5. WHEN `npm start` runs, THE Build_System SHALL invoke the Demo_Spa's own `build` script and
   observe it exit with status 0 before the Overseer process is started, so that the Demo_Page is
   served on the first request, the `index.html` document that build leaves in the Spa_Root being
   the outcome Requirement 6 criterion 6 places on the Demo_Spa's own bundler configuration rather
   than a filename the Build_System inspects.
6. WHEN `npm run dev` runs and a source file of a Tsc_Project changes, THE Dev_Supervisor SHALL
   recompile the Tsc_Projects only, SHALL invoke no `build` script of the Demo_Spa, and SHALL
   leave the Spa_Root's file set and each file's contents exactly as the developer's own
   `npm run build` last produced them.
7. THE Extended_Config_Package SHALL own a test suite holding at least one automated test per
   acceptance criterion of Requirement 2, with the metamorphic property of Requirement 2
   criterion 6 and the key-set property of Requirement 2 criterion 7 expressed as fast-check
   property-based tests over the supplied microservice name and Microservice_Path.
8. THE Demo_Spa SHALL own a test suite that covers every acceptance criterion of Requirement 10
   through one of exactly two treatments, selected by what that criterion constrains, and that
   references neither `document` nor `window`, so that the Node environment of criterion 3 of this
   requirement holds for every test of the Demo_Spa. A criterion of Requirement 10 that constrains
   the value one of the Result_Formatter's three functions returns for a given input — an input
   domain, a branch outcome, or the determinism, totality, purity, metamorphic, or round-trip
   properties — SHALL be covered by at least one automated test that calls that function directly,
   with the determinism, totality, purity, metamorphic, and round-trip properties expressed as
   fast-check property-based tests over Request_Line, status code and reason text, and response
   body; and where such a criterion states its constraint as a property of the content of a display
   field, THE Demo_Spa's test suite SHALL express that property over the return value of the
   formatter function that computes that field's text. A criterion of Requirement 10 that
   constrains a mutation of the Demo_Page's document — that the Demo_Page displays a formatter
   function's return value in a named field, that it sets or clears a named field's text, or that a
   named field holds a stated text for a Selector-excluded or toggle-disabled microservice — SHALL
   be covered instead by at least one automated assertion over the Demo_Spa's committed
   `index.html` document and over the Demo_Spa's own sources, the treatment Requirement 9's markup
   and in-flight criteria receive, so that no test of the Demo_Spa requires a DOM.
9. THE Integration_Suite SHALL hold at least one automated test per staging outcome stated in
   Requirement 5 criteria 1 through 6 and Requirement 6 criteria 11 through 13, each asserting
   the staged package set for the Selector that criterion names.
10. THE Microservice1 SHALL own a test suite holding at least one automated test per response
    stated in Requirement 7 criteria 5 through 12 and criterion 14, and per response stated in
    Requirement 8 criteria 1, 2, 3, 5, and 6, each asserting the status, the headers, and the body
    that criterion states — and for the ownership obligation of Requirement 7 criterion 12, that
    each probed request in Microservice1's Owned_Subtree receives a response from Microservice1's
    own router — with every one of those assertions made against Microservice1's exported router
    alone and no Overseer composed, so that no Sample_Scope_Test for Microservice1 sits in the
    Integration_Suite.
11. THE Integration_Suite SHALL hold at least one automated test per mount-ordering outcome stated
    in Requirement 7 criterion 13 and per Overseer-startup outcome stated in Requirement 8
    criterion 4, each asserting only which mounted router answered and the status that response
    carried, while the ownership outcome of Requirement 7 criterion 14 is asserted in
    Microservice1's own test suite under criterion 10.
12. THE release workflow SHALL publish exactly two Container configurations — the Generic
    Container for the Selector `*` and the Specific Container for the Selector
    `microservice1,microservice2` — with both selector values and the workflow's trigger set
    unchanged from what they are today.
13. IF any Quality_Gate step exits with a non-zero status, THEN THE Quality_Gate SHALL execute no
    later step and SHALL exit with a non-zero status and output identifying the step that
    failed.
14. IF the Demo_Spa's `build` script exits with a non-zero status during `npm test` or
    `npm start`, THEN THE Build_System SHALL execute no test and start no Overseer process, and
    SHALL exit with a non-zero status and a message naming the Demo_Spa's package directory.
15. THE Extended_Config_Package SHALL own type-level assertions for the type extension stated in
    Requirement 2 criterion 4, executed by the Quality_Gate's type-level assertion step.
16. THE root `package.json` SHALL declare an `engines.node` floor that every Node version the
    range admits satisfies the `engines.node` range the Demo_Spa's pinned bundler declares —
    concretely `">=22.12.0"` — so that `npm ci` on a clean clone reports no engine mismatch for
    any Node version the repository declares support for, and so that the declared floor and the
    bundler's own requirement agree rather than the developer having to reconcile them. CI and
    the Container image both resolve to the latest 22.x and therefore already satisfy the
    bundler, so this criterion removes an unexplained warning rather than fixing a failure.

### Requirement 12: Documentation

**User Story:** As a user of the template, I want the two samples documented where I will look
for them, so that I can find the demo page and understand which package each microservice
consumes.

#### Acceptance Criteria

1. THE README — the repository's root `README.md` — SHALL state that the Demo_Page is served by
   Microservice1 at the Overseer's base URL itself, that is at Microservice1's Mount_Root `/`,
   and that it is reachable only while Microservice1 is among the Selected_Microservices and its
   runtime toggle is enabled.
2. THE README SHALL state, each by its package name, that Microservice2 consumes
   `@microservices/config`, that Microservice3 consumes `@microservices/extended-config`, and
   that `@microservices/extended-config` consumes `@microservices/config`.
3. THE README SHALL state the command `npm run build --workspace @microservices/demo` as the
   command a developer runs from the repository root to produce the Spa_Root for local
   development, SHALL state that `npm run dev` neither produces nor refreshes the Spa_Root, and
   SHALL state that the Overseer's base URL answers with status 503 and the message of
   Requirement 8 criterion 1 while the Spa_Root is absent.
4. THE README SHALL state, for the Generic Container configuration (Selector `*`), that it
   stages the Common_Packages `config` and `extended-config` and the Spa_Package `demo`, and for
   the Specific Container configuration (Selector `microservice1,microservice2`), that it stages
   the Common_Package `config` and the Spa_Package `demo` and does not stage `extended-config`.
5. WHERE this feature makes a statement in `.kiro/steering/product.md`, `.kiro/steering/tech.md`,
   or `.kiro/steering/structure.md` untrue, or introduces a convention a user of the template
   needs in order to add a package of the same kind, THE affected steering document SHALL be
   updated in the same change, so that after the change no steering document states that
   `packages/spa/` ships empty or that the Config_Package is the repository's only
   Common_Package, and so that the convention criterion 10 names is recorded there.
6. WHEN each command the README quotes for the two samples is run from the repository root on a
   clean clone after `npm ci`, THE command SHALL exit with status 0.
7. THE README SHALL state that, under the Specific Container configuration, activating the
   `Microservice 3` Service_Button shows the not-found outcome stated in Requirement 10
   criterion 22 — the status code 404 in the Status_Field alongside the requested path in the
   Request_Field — because Microservice3 is not among that configuration's
   Selected_Microservices.
8. THE README SHALL state that a microservice's framework contract is its exported
   Microservice_Path plus its exported Express router, and that what a microservice serves at
   that path — its response bodies, its content types, and its per-method handling, naming the
   status code and the `Allow` header a microservice returns for a method it does not serve — is
   that microservice's own choice rather than a framework rule, so that a user of the template
   reads neither Microservice2's identifier response body nor its `405 Allow: GET` response to a
   non-GET request as a requirement on a microservice they add, and reads Microservice1's
   `405 Allow: GET, HEAD` response to such a request as an equally valid choice.
9. THE README SHALL state both Spa_Resolution_Pairs, that the manifest half and the resolution
   half of a pair must match and cannot be mixed, that the choice of pair belongs to the
   microservice and Spa_Package that form it rather than to the framework, and which pair this
   sample uses together with the reason — consistency with the repository's convention of
   importing a package by its bare `@microservices/<name>` name in shipped code.
10. THE `.kiro/steering/structure.md` document SHALL state that a microservice serving a
    Spa_Package locates the Spa_Root through a run-time module-resolution call, that either
    Spa_Resolution_Pair is permitted, that the manifest half and the resolution half of the
    chosen pair must match, and that the Build_System constrains neither half, so that a user of
    the template adding a second Spa_Package finds the convention in steering rather than by
    reading this sample's source.
11. THE `.kiro/steering/tech.md` document SHALL state the order of the two build phases as the
    `package-categories` spec and the Build_System implementation have it — the single
    `tsc --build` pass over the ordered Tsc_Project roots being the first phase, and the required
    Spa_Package bundler builds being the second, entered only after that pass exits with status 0
    — and SHALL state that order in place of any statement that the Spa builds run first, so that
    a user of the template adding a Spa_Package reads the order the Build_System implements,
    rather than inheriting the same inverted claim that produced a defective criterion in this
    document.
12. THE README SHALL state, where it explains adding a microservice, that a microservice owns the
    subtree rooted at its exported Microservice_Path and answers every request in that subtree
    itself — including the status it chooses for a path it does not serve and for a method it does
    not serve — and leaves no request in that subtree unhandled for the Overseer to answer, and
    SHALL state alongside the statement criterion 8 requires that this obligation fixes only
    whether the microservice answers while what it answers stays that microservice's own choice, so
    that a user of the template reads the two statements as one obligation and its complement
    rather than as a contradiction.
13. THE `.kiro/steering/structure.md` document SHALL record, in its Microservice package
    conventions section, that a microservice owns the subtree rooted at its exported
    Microservice_Path and answers every request in that subtree from its own router — including
    the status it chooses for a path it does not serve and for a method it does not serve — and
    leaves no such request unhandled for the Overseer to answer, SHALL state that the Overseer's
    responsibilities are to mount the enabled Selected_Microservices and to respond 404 where no
    mounted microservice matches the path, SHALL state that the obligation fixes whether a
    microservice answers while the status, the headers, and the body it answers with stay that
    microservice's own choice, and SHALL note as a consequence that a microservice mounted at `/`
    owns the whole origin, so that the Overseer's catch-all is unreachable in a Container
    containing one.

### Requirement 13: Framework-scope and sample-scope test boundary

**User Story:** As a maintainer, I want the shared integration suite to assert only what the
framework declares, so that one sample's response body and one sample's method policy stop acting
as framework-wide law and Microservice1 is free to serve the Demo_Page at its Mount_Root.

#### Acceptance Criteria

1. THE Integration_Suite SHALL assert, for each microservice among the Selected_Microservices
   with its runtime toggle enabled, that a request at that microservice's Mount_Root — its
   exported Microservice_Path itself, and no path under it — is dispatched to that microservice's
   exported router, evidenced by a response status other than 404, the Mount_Root being the probe
   point precisely because a path under it is answered by the owning microservice under
   Subtree_Ownership and may carry status 404 legitimately.
2. WHERE the Selected_Microservices with their runtime toggles enabled include no microservice
   whose Microservice_Path is `/`, THE Integration_Suite SHALL assert, for each microservice
   absent from the Selected_Microservices or having its runtime toggle disabled, that a request at
   that microservice's Microservice_Path and a request under it each receive status 404 from the
   Overseer's catch-all.
3. WHERE a microservice whose Microservice_Path is `/` is among the Selected_Microservices with
   its runtime toggle enabled, THE Integration_Suite SHALL assert that no request receives the
   Overseer's catch-all 404 — that microservice owning the whole origin and answering every
   request in it under Subtree_Ownership — and SHALL state in that assertion's description that
   the unreachability of the catch-all is the intended consequence of Subtree_Ownership rather
   than a defect.
4. THE Integration_Suite SHALL confine its per-microservice assertions to the Mount_Root at which
   a router is mounted and to the status at that Mount_Root that distinguishes a dispatched
   request from the Overseer's catch-all 404, so that every assertion in the Integration_Suite is
   a Framework_Scope_Test.
5. THE Integration_Suite SHALL assert no response body, no content type, no per-method status
   code, and no `Allow` header, each of those being determined by an individual
   Microservice_Package rather than by the framework, whether one Microservice_Package or several
   produce the same one.
6. THE Integration_Suite SHALL hold no assertion of a `405` status code and no assertion of an
   `Allow` header for any Microservice_Package, so that the `405 Allow: GET` assertion that
   `endpoint-contract.test.ts` presently applies to all three reference microservices — a
   Sample_Scope_Test, since nothing in this document or in the steering documents requires that
   method policy of a microservice — is reduced to the microservices that implement it,
   Microservice2 and Microservice3, is asserted in each of those microservices' own test suites,
   is asserted for Microservice1 only in Microservice1's own test suite and there as the different
   policy `405 Allow: GET, HEAD` that Requirement 7 criterion 11 states, and is presented as no
   rule that a newly added Microservice_Package satisfies.
7. WHERE a shared parameterised test — whether it sits in one microservice's own test suite or in
   a helper two microservices' suites share — asserts a per-method status code or an `Allow`
   header for more than one Microservice_Package, THE shared parameterised test SHALL take the
   Microservice_Packages it covers as an explicit enumeration naming each one, and SHALL derive
   that enumeration from neither filesystem discovery nor the generated Microservice_Registry.
8. THE Integration_Suite SHALL assert a per-method status code or a response header for no
   Microservice_Package it does not name explicitly — criterion 6 being the stricter rule that
   admits no `405` status assertion and no `Allow` header assertion in the Integration_Suite at
   all — and SHALL quantify no assertion of a response body, a content type, a status code other
   than the Mount_Root dispatched-versus-catch-all-404 distinction of criteria 1 through 3, or a
   response header over every discovered Microservice_Package, over every registered
   Microservice_Package, or over the generated Microservice_Registry as a whole.
9. THE Microservice2 SHALL own a test suite asserting its Mount_Root identifier response of
   Requirement 3 criterion 6 as applied to Microservice2, its `/config` Config_Payload response
   of Requirement 3 criterion 4, its non-GET 405 responses of Requirement 3 criterion 9, and its
   own 404 response at a path in its Owned_Subtree that it does not serve, of Requirement 3
   criterion 11.
10. THE Microservice3 SHALL own a test suite asserting its Mount_Root identifier response of
    Requirement 3 criterion 6, its `/config` Extended_Config_Payload response of Requirement 3
    criterion 3, its non-GET 405 responses of Requirement 3 criteria 7 and 8, and its own 404
    response at a path in its Owned_Subtree that it does not serve, of Requirement 3 criterion 10.
11. THE Microservice1 SHALL own a test suite asserting the Demo_Page responses of Requirement 7
    and the absent-Spa_Root responses of Requirement 8, as enumerated by Requirement 11
    criterion 10, including the `405 Allow: GET, HEAD` method policy of Requirement 7 criterion 11
    and the ownership obligation of Requirement 7 criterion 12, every one of those assertions being
    made against Microservice1's exported router with no Overseer composed.
12. WHEN a Liveness_Probe_Test issues an HTTP request to confirm that a running Overseer is
    serving, THE Liveness_Probe_Test SHALL derive that confirmation from the response status
    alone, at the Mount_Root of a microservice the test names explicitly, and SHALL depend on no
    response body, no content type, and no per-method status of Microservice1.
13. THE Integration_Suite SHALL keep every Liveness_Probe_Test in `start-parity.test.ts`,
    `specific-container-404.test.ts`, `dev-environment-passthrough.test.ts`,
    `dev-cold-start.test.ts`, `dev-start-parity.test.ts`, and `dev-warm-tree.test.ts` asserting
    the same process-level or build-level subject it asserts today, with each such test passing
    after Microservice1's Mount_Root response changes to the Demo_Page, and SHALL record in
    `specific-container-404.test.ts` that the 404 it observes for an unselected microservice's path
    is the one Microservice1 returns under Requirement 7 criterion 14, the observed status being
    unchanged while its source is the owning microservice rather than the Overseer's catch-all.
14. WHEN an Integration_Suite test forces a recompile or introduces a deliberate error by
    string-replacing a Mutation_Anchor in a tracked microservice source file, THE test SHALL
    target a Mutation_Anchor in a microservice whose source retains a single, stable expression
    to replace, and SHALL name that microservice's source path in the assertion that checks the
    reported diagnostic path.
15. THE Integration_Suite SHALL retarget the Mutation_Anchor used by `dev-session-scope.test.ts`
    and by `dev-error-recovery.test.ts` away from Microservice1's identifier response literal,
    so that each of those suites compiles and passes against Microservice1's Demo_Page source.
16. IF a Mutation_Anchor is not found in the source file a test reads, THEN THE test SHALL raise
    an error naming the source file and the Mutation_Anchor and SHALL fail, so that the suite
    reports the stale anchor rather than proceeding with an unmodified file.
17. THE Integration_Suite SHALL exercise the Overseer through the real reference microservice
    modules and the in-process `buildApp` composition it uses today, with no change to the
    Overseer package and no change to `packages/overseer/tests/router.property.test.ts`, which
    builds its own synthetic stub microservice modules and is unaffected.
18. WHEN `npm run ci` runs after the test boundary correction, THE Quality_Gate SHALL exit with
    status 0, so that the correction leaves no test asserting a behaviour Microservice1 no longer
    has.

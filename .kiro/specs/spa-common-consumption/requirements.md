# Requirements Document

## Introduction

This feature proves that a Spa_Package can consume a Common_Package by package name, the
same way a Microservice_Package already does, and that the Build_System sequences and packages
that dependency edge correctly.

Three changes carry the proof:

1. **The Demo_Spa consumes `@microservices/extended-config`.** The Demo_Spa declares the
   Extended_Config_Package in its own `dependencies` and imports it by package name only. It
   stops being the "true sink" its manifest comment currently describes, and becomes the first
   Spa_Package with an `@microservices`-scoped dependency of its own. The edge is a real one:
   the Extended_Config_Package itself depends on the Config_Package, so the Demo_Spa reaches a
   two-link Common_Package chain transitively.

2. **The Demo_Page gains an Expected_Payload_Field.** One additional read-only field below all
   existing ones, under the heading `microservice 3 should yield:`, holding the payload
   Microservice3 returns from a GET at `/microservice3/config`. Its text is computed at bundle
   time from the values the Extended_Config_Package exports, never restated as a literal, and it
   is rendered unconditionally — no toggle, no request, no branch. A reader can press the
   existing **Microservice 3** button and compare the Body_Field with the Expected_Payload_Field
   character for character.

3. **A third shipped Container configuration, Selector `microservice1`.** The Release_Pipeline
   publishes two configurations today (Generic, Selector `*`; Specific, Selector
   `microservice1,microservice2`). A third — the Spa_Only_Container, Selector `microservice1` —
   is the configuration in which the Demo_Spa's Common_Package dependencies are reachable
   *only* through the Demo_Spa. That is what makes it the interesting packaging case: no
   Selected_Microservice imports the Config_Package or the Extended_Config_Package directly, so
   the build has to reach them through a Bundler_Project or fail.

No framework capability is added. Every mechanism this feature exercises already exists; what
does not exist yet is a worked example of it.

### Recorded decision — the SPA's Common_Packages are compiled, bundled, and deliberately NOT staged

The originating request expected the Spa_Only_Container to *stage* the Demo_Spa "and, through
it, `@microservices/extended-config` and its own dependency `@microservices/config`". It will
not, and that is correct rather than a defect. The distinction the Build_System already draws
is worth stating plainly, because this feature is the first case in which it becomes visible:

- **Required_Dependencies (the BUILD set)** — everything that must compile. Resolution walks
  `@microservices`-scoped specifiers through *every* category, a Spa_Package included, so the
  Extended_Config_Package and the Config_Package land in the BUILD set for the Selector
  `microservice1` and become roots of the Tsc_Build_Pass. Their compiled `dist/` is exactly
  what the Demo_Spa's bundler reads.
- **Staged_Dependencies (the STAGE set)** — the narrower list that ships inside an image.
  Resolution arrives at a Spa_Package and includes it, but does not expand it, so a package
  reachable *only* by way of a Spa_Package is left out. Its code has been inlined into a
  self-contained bundle; no runtime process in the image can reach its `dist/`, so staging it
  would ship dead bytes and break minimality-by-construction.

The proof this feature delivers is therefore stronger than the one requested: the Spa_Only_Container
demonstrates that a Spa_Package's Common_Package dependencies are **discovered, ordered, compiled,
and inlined**, and that the Image_Tree stays minimal afterwards. Requirement 5 states both halves,
and criterion 5.6 pins the observable that makes the inlining checkable without a runtime.
Criterion 5.11 pins the second such observable — that the built bundle carries no residual
`@microservices` import specifier needing resolution at run time — so the inlining is confirmed
from both directions, the presence of the inlined value and the absence of the unresolved
reference, still with no runtime started.

### Recorded decision — the heading is the field's label

The Expected_Payload_Heading is a `label` element carrying a `for` attribute, not an `h2`. One
element then serves both purposes the request implies: it is the small visible heading above the
field, and it is the field's programmatically associated accessible name. This mirrors the
Demo_Page's existing `<p><label for="body">Response body</label></p>` treatment of the
Body_Field, so the new field is indistinguishable in structure from the ones it sits below.

### Recorded decision — no `aria-live` on the Expected_Payload_Field

The field's content never changes after load, so there is nothing to announce. The Demo_Page
declares no `aria-live` attribute anywhere today, and this feature adds none.

## Glossary

- **Build_System**: the collection of ordering, resolution, and assembly logic in
  `packages/build-tools/`, reached through its bins and the repository's build scripts.
- **Build_Sequence**: the single ordering primitive (`buildSequence` in
  `packages/build-tools/src/build-sequence.ts`) whose seven statements every build path derives
  its order from. Statement 3 holds the Common_Packages; statement 7 holds the Spa_Packages.
- **Body_Field**: the existing read-only `textarea` of the Demo_Page holding a received response
  body, whose text the Result_Formatter's `formatBody` computes.
- **Bundler_Build_Phase**: the trailing build phase in which each required Spa_Package is built
  by invoking its own `npm run build` in its own directory.
- **Bundler_Project**: the Build_Kind of a Spa_Package — built by its own bundler, never a root
  of a Tsc_Build_Pass.
- **Common_Package**: a consumer-written leaf library at `packages/common/<name>/`, imported by
  the package name `@microservices/<name>`.
- **Config_Package**: the Common_Package `@microservices/config` at `packages/common/config/`.
- **Container**: a built container image produced from the generated `Dockerfile` for one
  Selector, running the Overseer with its Selected_Microservices mounted.
- **Demo_Page**: the committed `packages/spa/demo/index.html` document plus the Demo_Spa modules
  it loads.
- **Demo_Spa**: the Spa_Package `@microservices/demo` at `packages/spa/demo/`.
- **Dependency_Resolver**: `packages/build-tools/src/required-dependencies.ts`, which produces
  the Required_Dependencies and the Staged_Dependencies.
- **Exclusion_List**: the `EXCLUDE_TOPLEVEL` set in `scripts/emit-effective-dockerfile.sh` that
  drops named top-level `packages/<name>` entries from the emitted manifest `COPY` lines.
- **Expected_Payload_Field**: the one read-only `textarea` this feature adds to the Demo_Page,
  holding the Expected_Payload_Text.
- **Expected_Payload_Heading**: the visibly rendered `label` element above the
  Expected_Payload_Field, associated with it through `for`/`id`.
- **Expected_Payload_Text**: the Extended_Config_Payload for the name `microservice3` and the
  path `/microservice3`, serialised as JSON indented with two spaces.
- **Extended_Config_Package**: the Common_Package `@microservices/extended-config` at
  `packages/common/extended-config/`, which depends on the Config_Package.
- **Extended_Config_Payload**: the value `buildExtendedConfigPayload(name, path)` returns.
- **Framework_Singleton**: one of the four scaffold packages the Build_System knows by name —
  `packages/contracts/`, `packages/overseer/`, `packages/build-tools/`, and
  `packages/integration-tests/`.
- **Generic_Container**: the shipped Container configuration whose Selector is `*`.
- **Image_Tree**: the single staged tree the image build assembles and the runtime stage copies.
- **Image_Tree_Assembler**: `packages/build-tools/src/image-tree.ts`.
- **Integrity_Assertion**: `assertImageTreeIntegrity`, which checks the assembled Image_Tree
  holds exactly the packages the plan justified.
- **Microservice1**: the Microservice_Package at `packages/microservices/microservice1/`, mounted
  at `/`, which serves the Demo_Spa's built `dist/`.
- **Microservice3**: the Microservice_Package at `packages/microservices/microservice3/`, which
  serves the Extended_Config_Payload from a GET at `/microservice3/config`.
- **Microservice_Package**: a consumer-written microservice at
  `packages/microservices/<identifier>/`, whose directory name is its identifier.
- **Overseer**: the Framework_Singleton routing frontend at `packages/overseer/`, which mounts
  each enabled Selected_Microservice's router at that microservice's declared path.
- **Payload_Preview**: the pure Demo_Spa module that computes the Expected_Payload_Text.
- **Release_Pipeline**: the `release` GitHub Actions workflow at `.github/workflows/release.yml`.
- **Repo_Invariant_Checker**: the compiled `check-repo-invariants` bin the root
  `check:invariants` script runs.
- **Request_Field**: the existing read-only field of the Demo_Page holding the issued request
  line, whose text the Result_Formatter's `formatRequestLine` computes.
- **Required_Dependencies**: the BUILD set — every discovered Consumer_Package a build must
  compile, in the lexicographically-least topological order.
- **Result_Formatter**: the existing pure Demo_Spa module exporting `formatRequestLine`,
  `formatStatus`, and `formatBody`.
- **Root_Manifest**: the repository root `package.json`.
- **Selected_Microservices**: the microservice identifiers the Selector resolved to.
- **Selector**: the `MICROSERVICES` value — `*` for every discovered microservice, or a
  comma-separated list of identifiers.
- **Service_Button**: one of the two existing Demo_Page buttons that call a microservice through
  the Overseer.
- **Spa_Only_Container**: the shipped Container configuration this feature adds, whose Selector
  is `microservice1`.
- **Spa_Package**: a consumer-written bundler-built frontend at `packages/spa/<name>/`.
- **Specific_Container**: the shipped Container configuration whose Selector is
  `microservice1,microservice2`.
- **Staged_Dependencies**: the STAGE set — the subsequence of the Required_Dependencies that
  ships inside an image.
- **Status_Field**: the existing read-only field of the Demo_Page holding the received response
  status, whose text the Result_Formatter's `formatStatus` computes.
- **Tsc_Build_Pass**: the single `tsc --build` invocation over the ordered Tsc_Project roots.
- **Tsc_Project**: the Build_Kind of every Framework_Singleton, Microservice_Package, and
  Common_Package — built through `tsc`.
- **Verification_Pass**: the check in `build-sequence.ts` that rejects a produced order placing
  a package ahead of one of its own compile-time prerequisites.
- **Workspace_Coverage**: the Repo_Invariant_Checker's invariant that every workspace package is
  matched by exactly one entry of the Root_Manifest's `workspaces` array.

## Requirements

### Requirement 1: The Demo_Spa consumes the Extended_Config_Package by package name

**User Story:** As a user of the template, I want the Demo_Spa to consume a Common_Package, so
that I can see that a bundler-built frontend reuses shared code the same way a microservice
does.

#### Acceptance Criteria

1. THE Demo_Spa SHALL declare `@microservices/extended-config` as a key of the `dependencies`
   object of `packages/spa/demo/package.json`, with the value `*`, and SHALL declare it in no
   other dependency object of that manifest.
2. THE Demo_Spa SHALL name `@microservices/extended-config` as the only `@microservices`-scoped
   key of every dependency object of `packages/spa/demo/package.json`, reaching the
   Config_Package only transitively through the Extended_Config_Package.
3. THE Demo_Spa SHALL reference the Extended_Config_Package through the static import specifier
   `@microservices/extended-config` and through no other specifier: no relative specifier that
   leaves `packages/spa/demo/`, no specifier holding a path segment below
   `@microservices/extended-config`, and no dynamic `import()` of it.
4. THE Demo_Spa SHALL declare a `scripts.build` value holding 1 or more non-whitespace
   characters.
5. THE Demo_Spa SHALL declare an `exports` map whose `"."` entry is the string
   `./dist/index.html`.
6. THE Demo_Spa SHALL omit both the `main` field and the `types` field from its `package.json`.
7. THE explanatory comment in `packages/spa/demo/package.json` SHALL state that the Demo_Spa
   declares an `@microservices`-scoped dependency, and SHALL make no statement that the Demo_Spa
   declares none or that it is a dependency sink.
8. WHEN the Demo_Spa's `typecheck` script runs after the Extended_Config_Package's `dist/` holds
   its compiled declaration output, THE Demo_Spa SHALL exit with status 0.
9. WHEN the Demo_Spa's `lint` script runs, THE Demo_Spa SHALL exit with status 0.
10. WHEN the Demo_Spa's `build` script runs after the Extended_Config_Package's `dist/` holds its
    compiled output, THE Demo_Spa SHALL exit with status 0 and write `dist/index.html`.
11. IF the Demo_Spa's `typecheck` script runs while the Extended_Config_Package's `dist/` holds no
    compiled output, THEN THE Demo_Spa SHALL exit with a status other than 0, SHALL report an error
    indicating that `@microservices/extended-config` could not be resolved, and SHALL leave the
    Demo_Spa's existing `dist/index.html`, if any, unmodified.
12. IF the Demo_Spa's `build` script runs while the Extended_Config_Package's `dist/` holds no
    compiled output, THEN THE Demo_Spa SHALL exit with a status other than 0 and SHALL report an
    error indicating that `@microservices/extended-config` could not be resolved.

### Requirement 2: The Expected_Payload_Field on the Demo_Page

**User Story:** As a reader of the Demo_Page, I want to see the payload Microservice3 is
expected to return, so that I can compare it with the response the page actually receives.

#### Acceptance Criteria

1. THE Demo_Page SHALL render exactly 1 Expected_Payload_Field.
2. THE Demo_Page SHALL render the Expected_Payload_Field as a `textarea` element carrying the
   `readonly` attribute, so the field stays focusable, keyboard reachable, scrollable, and
   selectable.
3. THE Demo_Page SHALL omit the `disabled` attribute from the Expected_Payload_Field.
4. THE Demo_Page SHALL place the Expected_Payload_Field after both Service_Buttons, the
   Request_Field, the Status_Field, and the Body_Field in document order, and SHALL place no
   Service_Button, Request_Field, Status_Field, or Body_Field after it.
5. THE Demo_Page SHALL render the Expected_Payload_Heading as a `label` element whose `for`
   attribute equals the Expected_Payload_Field's `id` attribute, and that `id` SHALL hold 1 or
   more non-whitespace characters and SHALL be carried by no other element of the Demo_Page.
6. THE Expected_Payload_Heading SHALL hold the text content `microservice 3 should yield:` and no
   further text content.
7. THE Demo_Page SHALL place the Expected_Payload_Heading before the Expected_Payload_Field in
   document order.
8. WHEN the Demo_Page finishes loading, THE Demo_Spa SHALL set the Expected_Payload_Field's
   value, within 1 second of that load and before any Service_Button activation, to the
   Expected_Payload_Text character for character, preserving its line breaks and its two-space
   indentation.
9. THE Demo_Spa SHALL derive the Expected_Payload_Field's value from the values the
   Extended_Config_Package exports, reached through the import specifier
   `@microservices/extended-config`, restating none of those values as a literal in the
   Demo_Spa's own sources and issuing no network request to obtain them, so that the value is
   fixed when the Demo_Spa is bundled.
10. WHILE a request initiated by a Service_Button is in flight, THE Demo_Spa SHALL leave the
    Expected_Payload_Field's value equal to the Expected_Payload_Text.
11. WHEN a request initiated by a Service_Button settles with any status code, with a transport
    failure, or at the 10-second request limit, THE Demo_Spa SHALL leave the
    Expected_Payload_Field's value equal to the Expected_Payload_Text, and SHALL do so after
    each of 1 to 20 successive Service_Button activations in one page lifetime.
12. THE Demo_Page SHALL retain the two Service_Buttons, the Request_Field, the Status_Field, and
    the Body_Field at their existing document positions with their existing `id` attributes.
13. THE Demo_Page SHALL declare no `aria-live` attribute on the Expected_Payload_Field.
14. IF the loaded document holds no `textarea` element carrying the Expected_Payload_Field's
    `id`, THEN THE Demo_Spa SHALL leave both Service_Buttons issuing their requests and writing
    the Request_Field, the Status_Field, and the Body_Field exactly as they do when the field is
    present, and SHALL surface no uncaught error.
15. WHEN a keystroke or a paste is directed at the focused Expected_Payload_Field, THE Demo_Spa
    SHALL leave the field's value equal to the Expected_Payload_Text.

### Requirement 3: The Payload_Preview computes the Expected_Payload_Text

**User Story:** As a maintainer, I want the expected-payload text computed by one pure module,
so that its content is asserted by calling a function rather than by driving a browser.

#### Acceptance Criteria

1. THE Payload_Preview SHALL export exactly 1 function and no other binding, that function SHALL
   accept exactly 2 string arguments — a name and a path — and SHALL return a string holding 1 or
   more characters.
2. THE Payload_Preview SHALL compute the Expected_Payload_Text as the Extended_Config_Payload
   for the name `microservice3` and the path `/microservice3`, serialised as JSON indented with
   2 spaces, holding no leading whitespace, no trailing whitespace, and no trailing newline.
3. THE Payload_Preview SHALL compute its result from its 2 arguments and from the values the
   Extended_Config_Package exports, reading no `document`, `window`, `fetch`,
   `AbortController`, `setTimeout`, clock, or random source, and performing no network,
   filesystem, or console access either when the module is evaluated or when its function is
   called.
4. WHEN the Payload_Preview's function is called 2 to 1,000 times with equal arguments, in one
   process or in 2 separate processes, THE Payload_Preview SHALL return character-identical
   strings.
5. FOR the Expected_Payload_Text, parsing it as JSON SHALL produce a value equal to the
   Extended_Config_Payload the Extended_Config_Package builds for the name `microservice3` and
   the path `/microservice3` (round-trip property).
6. THE Expected_Payload_Text SHALL equal, character for character, the string the
   Result_Formatter's body function returns when it is given the JSON text of the response body
   Microservice3 serves from a GET at `/microservice3/config` — that is, the JSON text of the
   Extended_Config_Payload for the name `microservice3` and the path `/microservice3` — with no
   HTTP request issued and no Microservice3 process started (metamorphic property).
7. WHEN the Payload_Preview's test suite runs non-watch in the Vitest default `node` environment,
   with no DOM implementation present and no network access, THE test suite SHALL exit with
   status 0.
8. FOR ALL name strings of 0 to 2,048 characters and ALL path strings of 0 to 2,048 characters,
   drawn from the full Unicode range and including the quotation mark, the backslash, control
   characters, and characters outside the Basic Multilingual Plane, THE Payload_Preview SHALL
   return a string and throw no error, and parsing that string as JSON SHALL produce a value
   equal to that Extended_Config_Payload, over 100 or more generated examples (round-trip
   property).
9. THE Expected_Payload_Text SHALL contain, as a substring, the string value the
   Extended_Config_Package exports as `extendedSetting`.
10. FOR ALL name strings of 0 to 2,048 characters and ALL path strings of 0 to 2,048 characters,
    the string the Payload_Preview returns for that name and path SHALL equal, character for
    character, the string the Result_Formatter's body function returns when it is given the JSON
    text of the Extended_Config_Payload for that same name and path, over 100 or more generated
    examples (metamorphic property).

### Requirement 4: The Common_Packages compile before the Bundler_Build_Phase

**User Story:** As a maintainer, I want the Demo_Spa's Common_Packages built before its bundler
runs, so that the bundler finds compiled output to inline rather than failing to resolve it.

#### Acceptance Criteria

1. WHERE the Demo_Spa is a member of the Required_Dependencies, THE Dependency_Resolver SHALL
   include in the Required_Dependencies the Extended_Config_Package, reached through the
   Demo_Spa's own `dependencies`, and the Config_Package, reached transitively through the
   Extended_Config_Package's `dependencies`.
2. THE Dependency_Resolver SHALL place the Config_Package ahead of the Extended_Config_Package
   in the Required_Dependencies, and the Extended_Config_Package ahead of the Demo_Spa.
3. WHERE the Extended_Config_Package and the Config_Package are members of the
   Required_Dependencies, THE Build_System SHALL include both among the roots of the
   Tsc_Build_Pass.
4. THE Build_System SHALL include the Demo_Spa among the roots of no Tsc_Build_Pass for any
   Selector.
5. WHERE the Demo_Spa is a member of the Required_Dependencies, THE Build_System SHALL include
   the Demo_Spa in the Bundler_Build_Phase.
6. THE Build_Sequence SHALL place every statement-3 member ahead of every statement-7 member in
   every produced order.
7. WHEN the Tsc_Build_Pass exits with status 0, THE Build_System SHALL enter the
   Bundler_Build_Phase.
8. IF the Tsc_Build_Pass exits with a status other than 0, THEN THE Build_System SHALL enter no
   Bundler_Build_Phase, SHALL copy no package into the Image_Tree, and SHALL exit with a status
   other than 0.
9. WHEN the repository-wide ordered build runs with the Demo_Spa in the Required_Dependencies,
   THE Build_System SHALL invoke the Demo_Spa's own `npm run build` in the Demo_Spa's own
   directory after every Tsc_Project root's `build` script has exited with status 0 and after
   the Config_Package's `dist/` and the Extended_Config_Package's `dist/` each hold their
   compiled output.
10. WHEN the Verification_Pass runs over an order containing the Demo_Spa and the
    Extended_Config_Package, THE Verification_Pass SHALL report no `[build-order:prerequisite]`
    finding and no `[build-order:divergence]` finding.
11. IF the Demo_Spa declares a dependency specifier that resolves to no discovered package and
    to no Framework_Singleton, THEN THE Dependency_Resolver SHALL report a `[shared:unresolved]`
    finding naming `packages/spa/demo` and the unresolved specifier, and THE Build_System SHALL
    enter no Tsc_Build_Pass, enter no Bundler_Build_Phase, copy no package into the Image_Tree,
    and exit with a status other than 0.
12. IF the Demo_Spa is no member of the Required_Dependencies, THEN THE Build_System SHALL
    include the Demo_Spa in no Bundler_Build_Phase and SHALL invoke no `npm run build` in the
    Demo_Spa's directory.
13. IF the Demo_Spa's `npm run build` exits with a status other than 0 during the
    Bundler_Build_Phase, THEN THE Build_System SHALL copy no package into the Image_Tree, SHALL
    report an error identifying the Demo_Spa as the failing package, and SHALL exit with a
    status other than 0.

### Requirement 5: The Spa_Only_Container compiles, inlines, and stays minimal

**User Story:** As an operator, I want a Container that ships Microservice1 alone to carry the
Demo_Spa's code with nothing spare, so that a SPA's shared dependencies cost the image nothing
at runtime.

#### Acceptance Criteria

1. WHERE the Selector resolves to `microservice1` alone, THE Build_System SHALL include the
   Config_Package, the Extended_Config_Package, Microservice1, the Overseer, and `contracts`
   among the roots of the Tsc_Build_Pass, SHALL include no Microservice_Package other than
   Microservice1 among those roots, and SHALL leave each of those 5 packages' `dist/` holding its
   compiled output once that pass has exited with status 0.
2. WHERE the Selector resolves to `microservice1` alone, WHEN the Tsc_Build_Pass has exited with
   status 0, THE Build_System SHALL invoke the Demo_Spa's own `npm run build` in the Demo_Spa's
   own directory exactly 1 time, and SHALL do so before copying any package into the Image_Tree.
3. WHERE the Selector resolves to `microservice1` alone, THE Staged_Dependencies SHALL hold the
   Demo_Spa as their only member, holding neither the Config_Package nor the
   Extended_Config_Package, while the Required_Dependencies hold all 3 of them.
4. WHERE the Selector resolves to `microservice1` alone, THE Image_Tree SHALL contain
   `node_modules/@microservices/contracts`, `node_modules/@microservices/demo`, and
   `node_modules/@microservices/microservice1` as real directories and `packages/overseer` as a
   real directory, SHALL contain no further entry and no symbolic link under
   `node_modules/@microservices/`, and SHALL contain no `packages/microservices/` entry.
5. WHEN the Image_Tree for the Selector `microservice1` is assembled, THE Integrity_Assertion
   SHALL report no unjustified entry and no missing entry, and the image build SHALL exit with
   status 0.
6. WHEN the Demo_Spa's `build` script has exited with status 0, THE Demo_Spa's `dist/` SHALL hold
   in at least 1 file, as a substring of that file's contents, the exact string value the
   Extended_Config_Package exports as `extendedSetting`.
7. WHERE the Selector resolves to `microservice1` alone, WHEN a GET arrives at `/`, THE
   Container SHALL respond with status 200 and with a body byte-identical to the `dist/index.html`
   the Demo_Spa's `build` script wrote.
8. WHERE the Selector resolves to `microservice2` alone, THE Staged_Dependencies SHALL hold the
   Config_Package as their only member.
9. WHERE the Selector resolves to `*`, THE Staged_Dependencies SHALL hold exactly the
   Config_Package, the Extended_Config_Package, and the Demo_Spa.
10. IF the Demo_Spa's `npm run build` exits with a status other than 0, THEN THE Build_System
    SHALL fail the image build with a non-zero status, SHALL copy no package into the Image_Tree,
    and SHALL report an error naming the Demo_Spa as the failing package.
11. WHEN the Demo_Spa's `build` script has exited with status 0, THE files the Demo_Spa's `dist/`
    holds SHALL carry no import specifier requiring `@microservices/extended-config` or
    `@microservices/config` to be resolvable at run time.
12. IF the assembled Image_Tree for the Selector `microservice1` holds 1 or more entries the
    Staged_Dependencies did not justify, or omits 1 or more entries they did justify, THEN THE
    Integrity_Assertion SHALL fail the image build with a non-zero status and SHALL report each
    such entry by name.

### Requirement 6: The Release_Pipeline ships three Container configurations

**User Story:** As a maintainer, I want a third published Container configuration holding
Microservice1 alone, so that every merge proves a SPA's dependency packaging end to end.

#### Acceptance Criteria

1. THE Release_Pipeline SHALL define exactly 3 build legs, 1 per shipped Container
   configuration: the Generic_Container with Selector `*`, the Specific_Container with Selector
   `microservice1,microservice2`, and the Spa_Only_Container with Selector `microservice1`.
2. THE Release_Pipeline SHALL assign the 3 configurations 3 pairwise-distinct image-name
   suffixes.
3. THE Release_Pipeline SHALL assign the Spa_Only_Container the image-name suffix
   `microservice1`.
4. WHEN the triggering event is any event other than a pull request — a push to `main`, a push of
   a tag matching `v*.*.*`, or a manual dispatch — THE Release_Pipeline SHALL publish the
   Spa_Only_Container image to GHCR.
5. WHEN the triggering event is a pull request targeting `main`, THE Release_Pipeline SHALL build
   the Spa_Only_Container image and publish no image.
6. WHEN all 3 build legs have completed and each exited with status 0, THE Release_Pipeline SHALL
   prune the untagged GHCR versions of the image whose name carries the Spa_Only_Container's
   image-name suffix, retaining the 10 most recent untagged versions and deleting every older
   untagged version.
7. IF 1 or 2 of the 3 legs exit with a status other than 0, THEN THE Release_Pipeline SHALL
   cancel no remaining leg, SHALL run each remaining leg to completion, and SHALL report the
   workflow run as failed.
8. THE Release_Pipeline SHALL request exactly the permissions `contents: read`,
   `packages: write`, and `id-token: write`.
9. THE Root_Manifest SHALL declare a `docker:build:microservice1` script that runs
   `scripts/emit-effective-dockerfile.sh` with `MICROSERVICES=microservice1`, then — only when
   that emit step exits with status 0 — builds the image with `microservice1` passed as the
   `MICROSERVICES` build argument and tags it with the Spa_Only_Container's image-name suffix.
10. THE Root_Manifest's `docker:build` script SHALL invoke all 3 per-configuration
    `docker:build:*` scripts one after another, and SHALL stop at the first invoked script that
    exits with a status other than 0 and exit with a status other than 0 itself.
11. WHEN `scripts/emit-effective-dockerfile.sh` runs with `MICROSERVICES=microservice1`, THE
    emit script SHALL write a generated `Dockerfile` containing exactly 1
    `ENV MICROSERVICE_<IDENTIFIER>_ENABLED=enabled` line, and that line SHALL name
    `MICROSERVICE_MICROSERVICE1_ENABLED`.
12. THE `Dockerfile.template` SHALL be byte-identical to its committed content before this
    feature, with 0 lines added, removed, or modified.
13. WHEN the Release_Pipeline runs the Spa_Only_Container leg, THE Release_Pipeline SHALL set
    `MICROSERVICES` to `microservice1` for that leg's emit step and SHALL pass `microservice1` as
    the `MICROSERVICES` build argument of that leg's image build.
14. IF the Spa_Only_Container leg's emit step or image build exits with a status other than 0,
    THEN THE Release_Pipeline SHALL publish no Spa_Only_Container image, SHALL prune no GHCR
    version, and SHALL surface the failing step's status in the workflow run's result.
15. THE Release_Pipeline SHALL build the Spa_Only_Container image for the same platform set and
    publish it under the same tag set it applies to the Generic_Container and the
    Specific_Container.

### Requirement 7: The repository invariants and the quality gate stay green

**User Story:** As a maintainer, I want the new dependency edge to satisfy every existing
invariant, so that adding a Common_Package dependency to a SPA needs no rule change.

#### Acceptance Criteria

1. WHEN `check:invariants` runs over a checkout containing the Demo_Spa's dependency on the
   Extended_Config_Package, after the ordered build has written the Repo_Invariant_Checker's
   compiled output, THE Repo_Invariant_Checker SHALL report 0 findings for all 4 invariants it
   enforces — Workspace_Coverage, import discipline, Common_Package dependency direction, and
   build-order source — and SHALL exit with status 0.
2. THE Repo_Invariant_Checker SHALL report no finding naming `packages/spa/demo` for the
   Demo_Spa's declaration of `@microservices/extended-config` or for its import of that package
   name — in particular no `[deps:direction]` finding, no `[imports:peer]` finding, and no
   `[imports:spa]` finding.
3. IF a Tsc_Project names the Demo_Spa in an `import … from` specifier, a side-effect `import`
   specifier, or a dynamic `import()` specifier, THEN THE Repo_Invariant_Checker SHALL report an
   `[imports:spa]` finding naming the importing file and SHALL exit with status 1.
4. IF a Common_Package declares a dependency specifier resolving to a Spa_Package, THEN THE
   Dependency_Resolver SHALL report `[deps:common-to-spa]` naming the declaring Common_Package
   and the resolved Spa_Package, and THE Build_System SHALL exit with a status other than 0
   before invoking any package's `build` script.
5. THE Root_Manifest's `workspaces` array SHALL match the Demo_Spa, the Config_Package, and the
   Extended_Config_Package by exactly 1 entry each, at their existing patterns, with no entry
   added, removed, or reordered by this feature.
6. WHEN `npm run ci` runs on a checkout holding no `dist/` directory and no `*.tsbuildinfo` file
   for any package, THE quality gate SHALL run the ordered build, `check:invariants`, the
   per-package typecheck, the per-package lint, the test suite, and the type-level assertions,
   each exiting with status 0, and SHALL exit with status 0.
7. WHEN the Demo_Spa's `test` script runs in the Vitest default `node` environment on a checkout
   where no DOM implementation is installed, THE Demo_Spa SHALL exit with status 0.
8. IF 1 or more of the 4 invariants reports a finding, THEN THE Repo_Invariant_Checker SHALL
   report every finding from all 4 invariants in the same run and SHALL exit with status 1.
9. THE Repo_Invariant_Checker SHALL report no `[workspaces:order-source]` finding for any
   Root_Manifest script or repository script this feature adds or changes.
10. THE rule set of the Repo_Invariant_Checker and the rule set of the Dependency_Resolver SHALL
    remain unchanged by this feature.

### Requirement 8: The documentation records the new consumption pattern

**User Story:** As a user of the template, I want the SPA-consumes-Common pattern and the third
Container configuration documented, so that I can repeat both without reading the Build_System's
source.

#### Acceptance Criteria

1. THE `README.md` SHALL state all 3 of: that a Spa_Package declares a Common_Package as a key
   of the `dependencies` object of its own `package.json`, that it imports that Common_Package
   through the specifier `@microservices/<name>` and through no relative path into that
   Common_Package's `src/` or `dist/`, and that the Demo_Spa's dependency on the
   Extended_Config_Package is the worked example.
2. THE `README.md` SHALL list exactly 3 shipped Container configurations — the Generic_Container
   with Selector `*`, the Specific_Container with Selector `microservice1,microservice2`, and the
   Spa_Only_Container with Selector `microservice1` — SHALL give each one its published
   image-name suffix, and SHALL give the Spa_Only_Container the suffix `microservice1`.
3. THE `README.md` SHALL state both halves of the BUILD/STAGE distinction for a Common_Package
   reachable only through a Spa_Package: that it is a member of the Required_Dependencies,
   compiled before the Bundler_Build_Phase begins, and inlined into that Spa_Package's bundle;
   and that it is not a member of the Staged_Dependencies and is therefore absent from the
   Image_Tree.
4. THE `.kiro/steering/structure.md` SHALL state that a Spa_Package may declare a dependency on a
   Common_Package by the package name `@microservices/<name>` while keeping the leaf discipline
   already required of it (no dependency on a Microservice_Package and none on the Overseer), and
   SHALL name the Demo_Spa's dependency on the Extended_Config_Package as the worked example.
5. THE `README.md` and THE `.kiro/steering/structure.md` SHALL each contain no statement that a
   Spa_Package declares no `@microservices`-scoped dependency, no statement that the Demo_Spa is
   a dependency sink, and no statement that the shipped Container configurations number other
   than 3.
6. THE `README.md` SHALL state that adding a Common_Package dependency to a Spa_Package requires
   no change to `Dockerfile.template`, no change to the Exclusion_List, and no change to the
   Build_System.

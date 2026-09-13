# Bugfix Requirements Document

## Introduction

The repository has no single authority on build order. Three distinct order-producing mechanisms are spread across four entry points a developer can invoke, and only one of the three is correct by construction. The repository-wide ordered build — the path `npm run build`, the root `pretest`, `npm test`, and `npm run ci` all take — was correct at an earlier commit only by an alphabetical coincidence, and is no longer correct on the committed tree (see the measurement below). `npm start` is correct only because a human keeps the Root_Manifest's `workspaces` array in topological sequence, an obligation no check enforces.

The decisive missing relation is the Overseer's compile-time dependency on the Selected_Microservices: the generated Microservice_Registry statically imports each of them by package name, so the Overseer cannot compile before them. That edge is structurally undeclarable — the Dependency_Resolver rejects any manifest naming a Microservice_Package with `[deps:peer]`, and which microservices exist is Selector-dependent, so no correct static declaration exists. `workspaceBuildOrder()` is therefore not a sorting bug: it computes the lexicographically least topological order over its input faithfully, and its input is necessarily incomplete. What has been covering the gap is the code-point tiebreak on package directory, under which `packages/microservices/…` precedes `packages/overseer` because `m` < `o`.

**The shape of the fix.** The knowledge the derivation lacks is not missing from the repository. The Build_System already knows its four Framework_Singletons by name, and the image path already composes its roots positionally rather than by sorting a graph: `tscRootsOf` emits `contracts`, then the Required_Dependencies, then the Selected_Microservices, then the Overseer. The fix generalizes that composition into a single **Build_Sequence** — a fixed, hardcoded sequence of ordered statements, each naming a framework member by name or looping over one discovered category — and makes every Order_Producing_Path reach its order through it. No per-package position metadata is consulted to produce the sequence.

The sequence is expressed as ordered statements over groups rather than as per-package positions because a per-package reading does not work. Read absolutely, "the Overseer builds after every other workspace package" contradicts a real declared edge: `packages/integration-tests` declares `@microservices/overseer`, so it must follow the Overseer, and no order can satisfy both. That unsatisfiability is the reason for the group formulation, not a problem the fix must separately solve — under ordered statements `integration-tests` simply occupies a later statement than the Overseer, and nothing needs reconciling.

**Why the Build_Sequence is sound.** No dependency edge points from a later statement of the sequence to an earlier one, and that is a consequence of dependency-direction rules the scaffold already enforces rather than a property of this sample: a Common_Package and a Spa_Package are leaves that may never name a Microservice_Package or the Overseer (`[deps:peer]`, `[deps:common-to-spa]`, `[deps:spa-to-spa]`); a Microservice_Package may never name a peer or the Overseer; the Overseer's Microservice_Registry imports the Selected_Microservices; and `integration-tests` depends on nearly everything. Verified over the committed tree by reading every workspace manifest's `@microservices`-scoped dependencies: zero backward-pointing Compile_Time_Prerequisite edges across the statements.

**Spa_Packages build last.** The trailing bundler phase is licensed by an enforced invariant, not by this sample's good behaviour: **no Tsc_Project can ever compile against a Spa_Package.** Only a Microservice_Package or the Overseer may declare a dependency on a Spa_Package at all — the Dependency_Resolver rejects `common → spa` with `[deps:common-to-spa]` and `spa → spa` with `[deps:spa-to-spa]` — and the Repo_Invariant_Checker rejects a Tsc_Project statically or dynamically importing a Spa_Package with `[imports:spa]`. A consumer can therefore reach a Spa_Package only through a run-time module-resolution call. Measured confirmation: with `packages/spa/demo/dist` moved aside and `packages/microservices/microservice1/dist` plus its `tsconfig.tsbuildinfo` deleted, `npm run build --workspace @microservices/microservice1` exits 0; Microservice1's only references to `@microservices/demo` are the `import.meta.resolve` / `createRequire(...).resolve(...)` calls in `src/spa-root.ts` and a package name inside an error message string.

This document reuses the completed root-cause evaluation recorded as deviation **D11** in `.kiro/specs/scaffold-demo-samples/design.md` and does not re-derive it. Every measured fact below — the TS2307 failure, the declared dependency edges, the absence of a project-reference graph, the four-entry-point mechanism table — comes from that evaluation.

**Impact.** The defect is latent, not an immediate failure: it bites only where a real Microservice_Registry meets a missing Microservice_Package `dist/`. A fresh clone compiles against the empty registry template that the root `prepare` script installs on every `npm ci`, so CI is unaffected today. What is reachable is a hand-made state — a real registry left by an earlier `npm start` plus deleted `dist/` trees — in which the ordered build fails at the Overseer and the obvious recovery does not work, because the ordered build stops at the first failure and a re-run fails identically.

**Relationship to the `scaffold-demo-samples` feature, and the current measurement.** That feature introduces no defect and fixes none; by having `microservice1` declare `@microservices/demo` (at `packages/spa/demo`, which sorts after `packages/overseer`) it removes the alphabetical coincidence D11 identified. It is implemented and committed in the repository, at `35156ce` ("add a common-package dependency and an SPA"), so the derived Workspace_Build_Order over the committed tree is now:

```
1 packages/contracts                  6 packages/microservices/microservice3
2 packages/build-tools                 7 packages/overseer
3 packages/common/config               8 packages/spa/demo
4 packages/common/extended-config      9 packages/microservices/microservice1
5 packages/microservices/microservice2  10 packages/integration-tests
```

`packages/overseer` at 7, `packages/spa/demo` at 8, and `packages/microservices/microservice1` at 9 — exactly the order D11 predicted. The Ordering_Violation is therefore live rather than prospective, and only the empty Microservice_Registry template keeps it from failing a build. This bugfix nevertheless remains independent of that feature: it must not be specified, designed, or implemented as depending on that feature's implementation, and it must be correct whether that feature's changes are present or absent.

### Glossary

- **Build_System**: The tooling that discovers packages, generates the Microservice_Registry, derives the Workspace_Build_Order and the Project_List, and assembles the container Image_Tree. Concretely `packages/build-tools/` plus the repo-level scripts under `scripts/`.
- **Framework_Singleton**: A workspace package that is part of the scaffold itself and is known to the Build_System **by name**, never discovered. Exactly four: `packages/contracts/`, `packages/overseer/`, `packages/build-tools/`, `packages/integration-tests/`.
- **Framework_Constants_Module**: `packages/build-tools/src/framework.ts`, the single module declaring every Framework_Singleton's name, directory, and staging.
- **Overseer**: The Framework_Singleton at `packages/overseer/`: the routing frontend that mounts each enabled Microservice_Package's router at its declared Microservice_Path.
- **Microservice_Package**: A Consumer_Package at `packages/microservices/<identifier>/`, whose directory name is its Microservice_Identifier.
- **Common_Package**: A Consumer_Package at `packages/common/<name>/`: a consumer-written leaf library imported by package name.
- **Spa_Package**: A Consumer_Package at `packages/spa/<name>/`, built through its own `npm run build` and never a root of `tsc --build`.
- **Consumer_Package**: Any package discovered by location under one of the three Namespace_Containers `packages/microservices/`, `packages/common/`, `packages/spa/`.
- **Namespace_Container**: One of those three directories. Not itself a package and declaring no `package.json`; its direct subdirectories are its category's members.
- **Microservice_Identifier**: The directory name of a Microservice_Package under `packages/microservices/`, which is the sole declaration of the identifier.
- **Microservice_Path**: The HTTP path a Microservice_Package exports and the Overseer mounts its router at.
- **Tsc_Project**: A package built through `tsc` — every Framework_Singleton, every Microservice_Package, every Common_Package.
- **Bundler_Project**: A package built through its own `npm run build` bundler invocation. Every Spa_Package, and nothing else.
- **Spa_Root**: The built `dist/` directory of a Spa_Package, which a serving Microservice_Package locates through a run-time module-resolution call.
- **Mount_Root**: The Microservice_Path a Microservice_Package's router is mounted at by the Overseer.
- **Dependency_Specifier**: An `@microservices`-scoped key of a package's `dependencies`, e.g. `@microservices/config`.
- **Dependency_Resolver**: The Build_System component in `packages/build-tools/src/required-dependencies.ts` that resolves Dependency_Specifiers and computes the build and stage sets.
- **Required_Dependencies**: The set of Consumer_Packages the Dependency_Resolver reaches from the Selected_Microservices and the Overseer by following Dependency_Specifiers. What a Selector justifies compiling and staging.
- **Build_Sequence**: The fix's single ordering authority: a fixed, hardcoded sequence of ordered statements, each of which either builds one named framework member or loops over the members of one discovered category. The statement order is hardcoded because the Build_System knows its framework members by name; the order **within** a statement is either calculated or unconstrained, as that statement says. Requirement 2.1 states it in full.
- **Verification_Pass**: The check the fix runs after a Build_Sequence order is produced, asserting that no package appears at an earlier position than one of its own Compile_Time_Prerequisites, and failing with a diagnostic naming the offending packages. Requirement 2.13 states it in full.
- **Compile_Time_Prerequisite**: A package whose compiled output another package's compilation reads. It is every package a declared Dependency_Specifier resolves to **except a Spa_Package**, plus — for the Overseer — each Selected_Microservice its Microservice_Registry statically imports. A Spa_Package is excluded because no Tsc_Project can compile against one (see 2.6).
- **Ordering_Violation**: A produced order in which some package appears at an earlier position than one of its own Compile_Time_Prerequisites.
- **Workspace_Build_Order**: The order the Build_System produces over every workspace package — the four Framework_Singletons and every discovered Consumer_Package — in which every package precedes each package for which it is a Compile_Time_Prerequisite. It is the order in which the repository-wide build invokes each package's own `build` script. After this fix it is the Build_Sequence applied to every workspace package. Distinct from the entry order of the Root_Manifest's `workspaces` array.
- **Build_Position**: The `FrameworkSingleton.buildPosition` value — `"first"`, `"last"`, `"excluded"` — declared per Framework_Singleton in the Framework_Constants_Module. Before the fix, `tscRootsOf` reads it to compose the Tsc_Root_Order and the repository-wide derivation reads it not at all. After the fix, **no derivation reads it as an ordering input**: the Build_Sequence names its framework members by name and the two positional roles collapse into statements 1 and 5. Whether the field remains declared, and whether `tscRootsOf` keeps consulting it to decide which roots to emit for a Selector, is a design decision this document leaves open.
- **Declared_Array_Sequence**: The entry order of the Root_Manifest's `workspaces` array, which is what `npm run <script> --workspaces` traverses. The mechanism this bugfix deletes as a build-order source.
- **Workspace_Coverage**: The Root_Manifest obligation that exactly one `workspaces` entry matches each workspace package directory, which is all npm needs to discover the workspaces. An obligation over the *set* of entries; it constrains their order in no way.
- **Root_Manifest**: The repository root `package.json`.
- **Ordered_Build**: The repository-wide build: `scripts/build.js` bootstraps `contracts` and `build-tools`, then spawns `packages/build-tools/dist/bin/build-workspaces.js`, which produces the Workspace_Build_Order and runs each package's own `build` script in it.
- **Bootstrap_Build**: The compilation of exactly `packages/contracts` and `packages/build-tools`, performed by `scripts/common-startup.js` before any Build_System step that is itself compiled output can run.
- **Selector**: The `MICROSERVICES` value: `*` or blank for every discovered Microservice_Package, or a comma-separated list of Microservice_Identifiers.
- **Selected_Microservices**: The Microservice_Packages the Selector resolves to.
- **Microservice_Registry**: The generated TypeScript manifest at `packages/overseer/src/generated/microservice-registry.ts` that statically imports the Selected_Microservices.
- **Image_Assembler**: `buildImageTree` in `packages/build-tools/src/image-tree.ts`.
- **Image_Tree**: The single staged tree the Image_Assembler produces, which the Dockerfile's runtime stage copies once.
- **Integrity_Assertion**: The Image_Assembler's post-staging check that the staged tree holds exactly the entries the Selector justifies, under `node_modules/@microservices/` and at the Overseer's package directory.
- **Tsc_Root_Order**: The ordered `tscRoots` sequence `buildPlanFrom` returns: the Tsc_Projects a Selector justifies, in the order the single `tsc --build` invocation receives them.
- **Project_List**: The ordered root list the Dev_Server hands to the solution builder, returned by `projectListFrom` / `devProjectList` as `buildPlanFrom(...).tscRoots`.
- **Dev_Server**: The `npm run dev` supervisor in `packages/build-tools/src/dev-supervisor.ts`.
- **Build_Watcher**: The solution builder running in watch mode inside the Dev_Server.
- **Order_Producing_Path**: Any repository entry point that produces a build order. Exactly four: the Ordered_Build path (`npm run build`, root `pretest`, `npm test`, `npm run ci`), the `npm start` path (`scripts/start.js`), the image build path (Image_Assembler), and the `npm run dev` path (Dev_Server).
- **Ordering_Mechanism**: The means by which an Order_Producing_Path decides its order. Three exist before the fix: the derivation over declared Dependency_Specifiers, the Declared_Array_Sequence, and `tscRootsOf`'s positional composition.
- **Repo_Invariant_Checker**: `packages/build-tools/src/repo-invariants.ts`, run as `npm run check:invariants`, which enforces Workspace_Coverage, import discipline, and Common_Package dependency direction.
- **Steering_Documents**: `.kiro/steering/tech.md` and `.kiro/steering/structure.md`.
- **Pre_Fix_Baseline**: The repository state at the commit immediately preceding this bugfix, the reference for every unchanged-behavior comparison.
- **Bug_Condition**: The predicate identifying the inputs that trigger this defect, formalized below.

## Bug Analysis

### Bug Condition

The input is a pair of a repository state and an Order_Producing_Path, and the observable output is the order that path produces.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type (RepositoryState, Order_Producing_Path)
  OUTPUT: boolean

  order ← orderProducedBy(X.path, X.state)

  // An Ordering_Violation: some package precedes none of its prerequisites.
  RETURN EXISTS a, b IN order WHERE
      isCompileTimePrerequisite(b, a)
      AND positionOf(a, order) < positionOf(b, order)
END FUNCTION
```

`isCompileTimePrerequisite(b, a)` holds when `a` declares a Dependency_Specifier resolving to `b` **and `b` is not a Spa_Package**, and additionally when `a` is the Overseer and `b` is one of the Selected_Microservices its Microservice_Registry imports — the relation no manifest may declare. The Spa_Package exclusion is not a convenience: a declared dependency on a Spa_Package is a staging and resolution declaration and imposes no compile-time ordering constraint, because no Tsc_Project can compile against a Spa_Package (2.6). Without the exclusion, `microservice1` building before `@microservices/demo` would be reported as an Ordering_Violation when it is not one.

A secondary condition covers the divergence between paths, which is what let the defect exist unnoticed:

```pascal
FUNCTION isDivergenceBugCondition(Y)
  INPUT: Y of type (RepositoryState, Order_Producing_Path, Order_Producing_Path)
  OUTPUT: boolean

  left  ← orderProducedBy(Y.pathA, Y.state)
  right ← orderProducedBy(Y.pathB, Y.state)

  // Two paths over one unchanged state disagree about a pair both of them contain.
  RETURN EXISTS a, b IN (left ∩ right) WHERE
      (positionOf(a, left)  < positionOf(b, left))
      ≠ (positionOf(a, right) < positionOf(b, right))
END FUNCTION
```

```pascal
// Property: Fix Checking — no order-producing path emits an Ordering_Violation
FOR ALL X WHERE isBugCondition(X) DO
  order ← orderProducedBy'(X.path, X.state)
  ASSERT NOT hasOrderingViolation(order)
    AND compileOf(order) succeeds for every package in order
END FOR
```

```pascal
// Property: Fix Checking — one mechanism, no divergence
FOR ALL Y WHERE isDivergenceBugCondition(Y) DO
  ASSERT agreeOnRelativeOrder(
    orderProducedBy'(Y.pathA, Y.state),
    orderProducedBy'(Y.pathB, Y.state))
END FOR
```

```pascal
// Property: Preservation Checking — every prerequisite-forced pair keeps its order
FOR ALL X WHERE NOT isBugCondition(X) DO
  FOR ALL a, b IN orderProducedBy(X.path, X.state) WHERE isCompileTimePrerequisite(b, a) DO
    ASSERT positionOf(b, orderProducedBy'(X.path, X.state))
         < positionOf(a, orderProducedBy'(X.path, X.state))
  END FOR
END FOR
```

`F` is the Build_System before the fix and `F'` the Build_System after it. Preservation is stated over the **prerequisite-forced pairs** of the produced order rather than over the produced order as a whole: wherever the Compile_Time_Prerequisite relation forces one package ahead of another, `F'` keeps that pair in the same relative order as `F`. A pair the relation leaves unconstrained is **not** claimed to be preserved.

Four concrete preservation obligations carry the rest of the weight, and each is already stated as an Unchanged Behavior criterion below rather than restated here:

- the Tsc_Root_Order for the Selector `*` and the Selector `microservice1,microservice2`, element for element against the Pre_Fix_Baseline (3.4);
- Selector order wherever it is observable — `plan.selected`, the `selected-microservice` staging entries, and the Microservice_Registry's import order (3.5, 3.13, 3.17);
- the two pinned real-tree orders: the post-fix order over the committed tree (2.21) and the pre-feature order over the state preceding `scaffold-demo-samples` (3.18).

**What is given up, and why it costs nothing stated.** The narrowed property abandons the guarantee that an order already free of Ordering_Violations comes out byte-identical, including every pair the ordering rules leave unconstrained. That general form was written before the fix model was chosen, and the design falsified it: the pre-fix order is the lexicographically least topological order over declared dependencies, while the post-fix order is the Build_Sequence. Both break unconstrained ties deterministically and they break them **differently**, so any layout containing an unconstrained pair the two rank oppositely is a counterexample — and such a layout need carry no Ordering_Violation at all, which puts it outside the Bug_Condition. Two, read off the two mechanisms:

- The Overseer declaring `@microservices/demo` is a legal `overseer → spa` edge. Pre-fix the order is `packages/spa/demo` then `packages/overseer`; post-fix the Overseer is statement 5 and the Spa_Package statement 7. Neither order is an Ordering_Violation, because a Spa_Package is not a Compile_Time_Prerequisite (2.6) — so the input lies outside the Bug_Condition and the two orders differ.
- A Common_Package declaring no scoped specifier at all. Pre-fix it is ready from the first step and `packages/common/…` sorts before `packages/contracts` (`com` < `con`), so it is emitted **first**. Post-fix `contracts` is statement 1. Again no violation, again a difference.

Both differences are the fix working exactly as specified: 2.4 requires the Spa_Package to move, and 2.1's statement 1 requires `contracts` to lead. No Unchanged Behavior criterion from 3.1 through 3.18 names the abandoned guarantee, so narrowing the property costs no stated obligation. The narrowing is a correction of an unsatisfiable formalization, not a weakening of intent.

### Current Behavior (Defect)

**User Story:** As a scaffold maintainer, I want to know exactly how the current build order goes wrong, so that the fix addresses the incomplete input rather than the sorting code that faithfully consumes it.

1.1 WHEN the Ordered_Build derives the Workspace_Build_Order THEN the Build_System decides the Overseer's position relative to every Microservice_Package solely by the code-point tiebreak on `packageDir`, because the Overseer's only declared Dependency_Specifier is `@microservices/contracts`, so the currently correct order holds by the coincidence that `m` < `o` and not by any modelled edge.

1.2 WHEN a Microservice_Package declares a Dependency_Specifier resolving to a package whose directory sorts after `packages/overseer` — as `@microservices/demo` at `packages/spa/demo` does, since `s` > `o` — THEN the Build_System orders that Microservice_Package after the Overseer, producing an Ordering_Violation against the Overseer's registry imports. Measured over the committed tree at `35156ce`: `packages/overseer` at position 7, `packages/spa/demo` at 8, and `packages/microservices/microservice1` at 9.

1.3 WHEN the Overseer is compiled while its Microservice_Registry names a Microservice_Package whose `dist/` is absent THEN `tsc` in `packages/overseer` fails with `src/generated/microservice-registry.ts(3,21): error TS2307: Cannot find module '@microservices/microservice1' or its corresponding type declarations.`

1.4 WHEN the Ordered_Build fails at the Overseer for the reason in 1.3 THEN the Build_System stops at that first failure without reaching the unbuilt Microservice_Package, so re-running the same command fails identically and recovery requires either `npm ci` or building that Microservice_Package directly.

1.5 WHEN `npm start` builds THEN `scripts/start.js` runs `npm run build --workspaces`, whose order is npm's traversal of the Declared_Array_Sequence and consults no declared dependency at all, so that path's correctness rests on a hand-maintained array sequence.

1.6 WHERE the Declared_Array_Sequence is the order source for `npm start` THEN no Build_System check constrains it, because `checkWorkspaceCoverage()` deliberately ignores entry order, its own comment reading "entry order, which carries no meaning".

1.7 WHEN the same repository state is built through the four Order_Producing_Paths THEN the Build_System produces orders from three distinct Ordering_Mechanisms, of which only `tscRootsOf`'s positional composition — shared by the image build and `npm run dev` — is correct by construction.

1.8 WHERE the Overseer's compile-time dependency on the Selected_Microservices is the decisive edge THEN no manifest edit can supply it, for two independent reasons: the Dependency_Resolver's `peerDependencyError` rejects any declarer naming a Microservice_Package with `[deps:peer] "<dir>" depends on Microservice_Package "<specifier>"; a Microservice_Package is never a dependency target`, and the set of microservices is Selector-dependent, so no static declaration is correct for every build.

1.9 WHERE the Selected_Microservices and the Overseer are treated as sibling roots by `rootDirectories()` in `required-dependencies.ts` THEN the overseer-to-microservice relation appears in no dependency graph the Build_System builds, on the image path either.

1.10 WHEN `tsc --build` receives a root order containing an Ordering_Violation THEN the solution builder does not repair it, because only `packages/overseer/tsconfig.json` declares `references` and only `[{"path": "../contracts"}]`, so no project-reference graph exists and roots are built in command-line order.

1.11 WHERE the Framework_Constants_Module already declares the Overseer's Build_Position as `"last"` and `contracts`' as `"first"` THEN `workspaceBuildOrder()` reads neither, so the position knowledge that makes one Ordering_Mechanism correct is absent from another.

1.12 WHERE `.kiro/steering/tech.md` asserts that "the `workspaces` array order IS the build order and must stay topological" and that `check:invariants` "enforces (1) the Workspace_Build_Order" THEN both claims are false, and the document tells a reader to maintain a sequence that three of the four Order_Producing_Paths do not read.

1.13 WHERE `.kiro/specs/shared-packages/requirements.md` defines Workspace_Build_Order as "The order of the `workspaces` array in the root `package.json`" while `.kiro/specs/package-categories/requirements.md` defines it as the order the Build_System derives from declared dependencies THEN two live specs define one term two incompatible ways, with the superseded definition never retracted.

1.14 WHERE no check asserts that the Order_Producing_Paths agree, nor that a produced order is free of Ordering_Violations THEN the Build_System permits this defect to return silently after it is fixed.

### Expected Behavior (Correct)

**User Story:** As a scaffold user, I want every entry point to build in one hardcoded sequence that already knows the Overseer follows the microservices and the bundlers run last, so that no build depends on the alphabet or on a hand-maintained array.

2.1 WHEN any Order_Producing_Path produces a build order THE Build_System SHALL produce it from the Build_Sequence, the following fixed sequence of ordered statements:

1. build `packages/contracts`;
2. build `packages/build-tools`;
3. loop over the Common_Packages **in calculated order** — a topological sort over their declared `@microservices`-scoped dependencies, which places `config` before `extended-config`;
4. loop over the Microservice_Packages **in any order**, no ordering edge existing among them because a peer dependency is forbidden and enforced;
5. build `packages/overseer`;
6. loop over the test-only Framework_Singletons (`packages/integration-tests`) **in any order**;
7. finally, loop over the Spa_Packages **in any order**, a trailing phase after every statement above.

(Corresponds to 1.1, 1.2, 1.7, 1.11.)

2.2 THE Build_System SHALL consult no per-package build-order position metadata to produce the Build_Sequence: the statement order of 2.1 is hardcoded, its framework members named by name, and no ordering input is read from a package's manifest or from a declared Build_Position. (Corresponds to 1.11.)

2.3 WHERE a statement of 2.1 loops **in any order** THE Build_System SHALL nonetheless iterate deterministically, by ascending code-point comparison of package directory, so that two runs over an unchanged repository produce identical orders and a pinned expected-order oracle can name a single list. Correctness does not depend on the within-statement order of statements 4, 6, and 7; reproducibility does. (Corresponds to 1.14.)

2.4 THE Build_Sequence SHALL place every Spa_Package after every Tsc_Project, and no Tsc_Project SHALL be built after a Spa_Package on any Order_Producing_Path. (Corresponds to 1.2.)

2.5 WHERE the Build_Sequence orders the repository-wide path and the image build path alike THE two paths' phase structure SHALL match — every Tsc_Project first, every Bundler_Project second — so that they differ only in the **membership** of a statement and never in statement order. The image path scopes statement 3 to the Common_Packages in the Required_Dependencies and statement 4 to the Selected_Microservices, and omits `packages/build-tools` and `packages/integration-tests` entirely; that scoping is the whole of the difference. (Corresponds to 1.7.)

2.6 THE Build_System SHALL treat a declared Dependency_Specifier resolving to a Spa_Package as a staging and resolution declaration rather than an ordering edge: it places that Spa_Package in the Required_Dependencies, and therefore in the stage set and the bundler build set, while imposing no build-order constraint on the declarer. Accordingly a Spa_Package SHALL NOT be a Compile_Time_Prerequisite of any package, and a Tsc_Project building before a Spa_Package it declares a dependency on SHALL NOT be reported as an Ordering_Violation. (Corresponds to 1.2.)

2.7 THE Build_System SHALL produce the Workspace_Build_Order and the Tsc_Root_Order through one shared ordering primitive that implements the Build_Sequence, so that neither ordering can be corrected without the other and no second copy of the statement order exists. This is a requirement on the design, not on any particular function signature. (Corresponds to 1.7, 1.11.)

2.8 WHEN any Order_Producing_Path produces an order containing both the Overseer and a Microservice_Package its Microservice_Registry names THE Build_System SHALL place that Microservice_Package at an earlier position than the Overseer, so the compilation in 1.3 finds the module and no TS2307 occurs. (Corresponds to 1.3.)

2.9 WHEN `npm start` builds THE start path SHALL obtain its order from the same Build_Sequence implementation the Ordered_Build uses, by invoking the same compiled `build-workspaces` entry point that `scripts/build.js` invokes, and SHALL NOT invoke `npm run build --workspaces`. (Corresponds to 1.5, 1.6.)

2.10 THE Build_System SHALL retain exactly one Ordering_Mechanism after this fix, and every one of the four Order_Producing_Paths SHALL reach its order through it, so that the Declared_Array_Sequence is an order source for no path and no repository script derives a build order from it. (Corresponds to 1.7.)

2.11 WHERE the Dev_Server produces a Selector-scoped Project_List THE Build_System SHALL make that Project_List agree with the Workspace_Build_Order on the relative order of every pair of packages both contain, both coming from the primitive of 2.7. Agreement is on relative order only: the Project_List legitimately omits `packages/build-tools`, `packages/integration-tests`, and every unselected Microservice_Package. (Corresponds to 1.7.)

2.12 WHERE the change of 2.9 removes the Declared_Array_Sequence as the `npm start` order source THE implementation SHALL NOT land that change before the Build_Sequence of 2.1 is in place, because `npm start` is today saved only by the hand-topological array; a change set that removes the array mechanism while the order still comes from the incomplete derivation leaves every fresh clone running `npm start` on the TS2307 of 1.3. The two changes are ordered, not independent, and a task sequence placing 2.9 first is invalid.

2.13 WHEN the Build_Sequence has produced an order THE Build_System SHALL run one Verification_Pass over it that fails when any package appears at an earlier position than one of its own Compile_Time_Prerequisites, with a diagnostic naming the offending packages. That single pass SHALL BE the automated enforcement check for this defect — no second or third mechanism is specified for the same claim — and it SHALL cover the cases the ordered statements cannot detect on their own, including a Microservice_Package declaring a peer, which the statement order would otherwise ignore silently. It SHALL be exercised over generated repository layouts and not over the committed tree alone, so that an alphabetical coincidence cannot re-hide the defect. (Corresponds to 1.7, 1.14.)

2.14 THE Verification_Pass SHALL also fail when the Workspace_Build_Order and the Tsc_Root_Order disagree on the relative order of a pair of packages both contain, for the same repository state and Selector. (Corresponds to 1.7, 1.14.)

2.15 THE Repo_Invariant_Checker SHALL fail when a repository script or npm script derives a build order from the Declared_Array_Sequence, so that the deleted mechanism cannot return unnoticed. Whether this is expressed as an invariant of the checker or as a correctness property of the build-tools suite is a design decision; that it exists is a requirement. (Corresponds to 1.5, 1.6.)

2.16 WHEN `.kiro/steering/tech.md` is corrected THE document SHALL state that build order comes from the Build_Sequence, SHALL NOT assert that the `workspaces` array order is the build order, and SHALL NOT attribute build-order enforcement to `check:invariants`. (Corresponds to 1.12.)

2.17 WHERE `.kiro/steering/tech.md` describes the `workspaces` array THE document SHALL state that the field remains declared and remains expressed as globs, because npm reads it statically to discover the workspaces and create the `node_modules/@microservices/*` symlinks before any repository code runs; it therefore declares **membership**, not a package list and not an order, and only its **sequence** stops being load-bearing. (Corresponds to 1.12.)

2.18 WHEN `.kiro/steering/tech.md` describes `check:invariants` THE document SHALL name its three actual enforcement areas — Workspace_Coverage, import discipline, and Common_Package dependency direction — and SHALL describe the `build`, `pretest`, and `ci` commands as the scripts they actually invoke, so that no command listing implies a `--workspaces` traversal decides build order. (Corresponds to 1.12.)

2.19 WHEN the superseded definition in `.kiro/specs/shared-packages/requirements.md` is addressed THE document SHALL be marked as superseded on that term, pointing at the current definition, so that one term no longer carries two incompatible definitions across live specs. (Corresponds to 1.13.)

2.20 WHEN the documentation is updated THE `README.md` and the `spa` category section of `.kiro/steering/structure.md` SHALL record that a Microservice_Package serving a Spa_Package must **compile and start** without that Spa_Package's bundle being present: the compile half is what licenses the trailing bundler phase of statement 7, and the runtime half is already specified by the `scaffold-demo-samples` feature — a `503` at the Mount_Root while the Spa_Root is absent, recovering on the next request with no restart. (Corresponds to 1.2.)

2.21 WHEN the Build_Sequence is applied to the committed tree at `35156ce` THE Build_System SHALL produce exactly this order:

```
1   packages/contracts
2   packages/build-tools
3   packages/common/config
4   packages/common/extended-config
5   packages/microservices/microservice1
6   packages/microservices/microservice2
7   packages/microservices/microservice3
8   packages/overseer
9   packages/integration-tests
10  packages/spa/demo
```

Ten entries in total: the three Microservice_Packages occupy positions 5, 6, and 7 in the deterministic directory order of 2.3, followed by `packages/overseer` at 8, `packages/integration-tests` at 9, and `packages/spa/demo` last at 10. THE committed expected-order oracle at `packages/build-tools/tests/workspace-build-order-real-tree.test.ts` currently encodes the buggy order of 1.2 and SHALL be updated to this order by the fix. (Corresponds to 1.2.)

2.22 THE fix SHALL be implementable against the repository state that precedes the `scaffold-demo-samples` feature and against the state that follows it, requiring no part of that feature's implementation, and SHALL satisfy 2.1 through 2.21 in both states.

### Unchanged Behavior (Regression Prevention)

**User Story:** As a scaffold maintainer, I want the fix confined to how order is produced and which path produces it, so that nothing about what gets built, staged, served, or reported changes.

3.1 WHEN the Build_System produces the Workspace_Build_Order over the committed tree THE Build_System SHALL CONTINUE TO place `packages/contracts` first and to place `packages/integration-tests` after every other Tsc_Project, `packages/spa/demo` being the sole entry that follows it because a Spa_Package builds in the trailing phase of statement 7.

3.2 WHERE `packages/integration-tests` declares `@microservices/overseer` THE Build_System SHALL CONTINUE TO order `packages/integration-tests` after `packages/overseer`, that declared edge being honoured by the statement order of 2.1 and confirmed by the Verification_Pass.

3.3 WHERE two packages fall in the **same** statement of the Build_Sequence and no calculated order constrains them THE Build_System SHALL CONTINUE TO order that pair by ascending code-point comparison of `packageDir`, so that two runs over an unchanged repository produce identical orders. The tiebreak governs pairs within one statement only: for a pair drawn from two different statements the statement order of 2.1 decides, and the tiebreak is not consulted — so a Common_Package with no Dependency_Specifier no longer leads the order ahead of `packages/contracts`. The criterion preserves determinism, which is its intent, not a code-point ranking over arbitrary pairs of the produced order.

3.4 FOR the Selector `*` and the Selector `microservice1,microservice2` THE Image_Assembler SHALL CONTINUE TO produce the Tsc_Root_Order it produces at the Pre_Fix_Baseline, entry for entry in the same sequence, with no root added, removed, or moved.

3.5 FOR the Selector `*` and the Selector `microservice1,microservice2` THE Image_Assembler SHALL CONTINUE TO stage the set of tree-relative paths it stages at the Pre_Fix_Baseline, with no file added and none omitted, and SHALL CONTINUE TO apply its Integrity_Assertion unchanged.

3.6 WHEN a source file changes under `npm run dev` THE Dev_Server SHALL CONTINUE TO recompile incrementally through the Build_Watcher and restart the Overseer against the recompiled output, with its existing restart decisions, diagnostics framing, and failure messages unchanged.

3.7 WHEN `npm start` runs THE start path SHALL CONTINUE TO perform the Bootstrap_Build and regenerate the real Microservice_Registry for its Selector through `scripts/common-startup.js`, abort before starting the Overseer on a selector error or a failed build, run the Overseer once from `packages/overseer/dist/index.js`, and exit with the Overseer process's status.

3.8 WHEN `npm start` builds THE start path SHALL CONTINUE TO build every workspace package rather than a Selector-scoped subset, so that Selector parsing stays in one place and no second copy of it appears under `scripts/`.

3.9 WHERE `npm start` and `npm run dev` are wrapped with `dotenvx run --` THE repository SHALL CONTINUE TO inject the `MICROSERVICE_<IDENTIFIER>_ENABLED` variables from `.env` and SHALL CONTINUE TO honour an inline `MICROSERVICES` override on either command.

3.10 THE Repo_Invariant_Checker SHALL CONTINUE TO enforce Workspace_Coverage, import discipline, and Common_Package dependency direction, with its existing message shapes and its existing indifference to `workspaces` entry order.

3.11 THE Root_Manifest SHALL CONTINUE TO declare the `workspaces` array as globs matching every workspace package, so that npm discovers the workspaces and creates the `node_modules/@microservices/*` symlinks exactly as before.

3.12 THE Dependency_Resolver SHALL CONTINUE TO reject a Dependency_Specifier naming a Microservice_Package with `[deps:peer]`, granting the Overseer no exemption, and no manifest in the repository SHALL declare such a dependency as part of this fix.

3.13 THE Build_System SHALL CONTINUE TO resolve the Selector as it does at the Pre_Fix_Baseline — `*` or blank for every discovered Microservice_Package, otherwise the listed identifiers — and SHALL CONTINUE TO fail with the existing `[selector:empty]` and `[selector:unmatched]` messages.

3.14 THE Ordered_Build SHALL CONTINUE TO invoke each workspace package's own `build` script exactly once, to stop at the first non-zero exit without building any later package, and to report `[shared:unresolved]`, `[build-order:cycle]`, and `[build-order:failed]` with their existing wording. The cycle case is now raised by the calculated Common_Package sort of statement 3 where the cycle lies among Common_Packages, and by the Verification_Pass of 2.13 where no valid order exists for any other reason; which component reports a given input is a design decision, that the wording is unchanged is a requirement.

3.15 THE Build_System SHALL CONTINUE TO exclude `packages/build-tools` and `packages/integration-tests` from the Selector-scoped roots, to build every Spa_Package through its own `npm run build` and never as a `tsc --build` root, and to enter the bundler builds only after the `tsc --build` pass exits zero.

3.16 WHEN `npm ci` is followed by `npm run ci` on a clean clone THE repository SHALL CONTINUE TO exit zero, with the root `prepare` script still installing the empty Microservice_Registry template so the Overseer compiles against a registry importing no microservice.

3.17 WHEN a container built from either shipped configuration serves traffic THE Overseer SHALL CONTINUE TO mount the same microservices at the same Microservice_Paths with the same toggle variables, this fix changing no runtime behavior.

3.18 WHEN the Build_Sequence is applied to the repository state preceding the `scaffold-demo-samples` feature THE Build_System SHALL CONTINUE TO produce that state's then-committed expected order exactly — `packages/contracts`, `packages/build-tools`, `packages/common/config`, the three Microservice_Packages in directory order, `packages/overseer`, `packages/integration-tests` — so that preservation holds with no special case in the fix.

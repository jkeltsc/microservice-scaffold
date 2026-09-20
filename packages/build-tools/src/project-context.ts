// This module derives, from the one Effective_Config a run operates on, the
// small set of scope-dependent strings every Build_System component actually
// wants: the scoped-name composer, the Dependency_Specifier prefix, the scoped
// `node_modules` directory, the per-category Discovery_Root, and the four
// Framework_Singleton records with their names composed under the run's scope
// (R1.9, R3.6, R3.7). It is also the one place the Entry_Root and the
// Entry_Point_Path are derived (registry-inversion R1.3, R7.1).
//
// `projectContext(config)` is pure and total over any EffectiveConfig: it reads
// no filesystem, so a property test can build a context from a generated config
// with no tree at all (R14.5-R14.7). It is the single value threaded through
// discovery, the Repo_Invariant_Checker, the Registry_Generator, the build-order
// derivation, the Project_List derivation, and the Image_Assembler, so no two
// components of one run disagree about scope or roots.
//
// Framework records split by what varies: framework.ts owns each singleton's
// scope-free facts (directory name, package directory, staging) as
// FRAMEWORK_DIRECTORIES; this module composes the per-run `name` =
// `${config.scope}/${dirName}` on top of them (R3.7).

import {
  FRAMEWORK_DIRECTORIES,
  type ConsumerCategory,
  type FrameworkStaging,
} from "./framework.js";
import { type EffectiveConfig } from "./project-config.js";

/**
 * A Framework_Singleton with its name composed under the run's Configured_Scope.
 *
 * The scope-free facts — `dirName`, `packageDir`, `staging` — come straight from
 * framework.ts; only `name` is per run, being the Configured_Scope followed by
 * `/` and the unchanged directory name (R3.7).
 */
export interface FrameworkSingleton {
  /** `${config.scope}/${dirName}`, composed for this run (R3.7). */
  readonly name: string;
  /** Directory name under `packages/`, e.g. "contracts". */
  readonly dirName: string;
  /** Repo-relative package directory, e.g. "packages/contracts". */
  readonly packageDir: string;
  readonly staging: FrameworkStaging;
}

/** The threaded per-run derivation of one Effective_Config (R1.9). */
export interface ProjectContext {
  /** The one Effective_Config of this run (R1.9). */
  readonly config: EffectiveConfig;
  /** `${scope}/${name}` — every scoped name the run composes (R3.6, R3.7). */
  scopedName(name: string): string;
  /** `${scope}/` — the Dependency_Specifier prefix to match (R3.6). */
  readonly specifierPrefix: string;
  /** `node_modules/${scope}` — where scoped packages are staged. */
  readonly scopeDir: string;
  /** The configured Discovery_Root of each Consumer_Category (R6.1). */
  readonly roots: Readonly<Record<ConsumerCategory, string>>;
  /** The Entry_Root: the Entry_Package's directory, Project_Directory-relative
   *  POSIX, `config.entry` verbatim (registry-inversion R1.1, R1.3).
   *
   *  A sibling of `roots` rather than a member of it: the Entry_Package belongs
   *  to no Consumer_Category and is discovered by nothing. */
  readonly entryRoot: string;
  /** The Entry_Point_Path: `${entryRoot}/dist/index.js` — the Entry_Root joined
   *  to `dist/index.js` by a single `/`, `/` its only separator, with no
   *  normalisation of either part (registry-inversion R7.1).
   *
   *  Derived in this one module and supplied to every consumer through the
   *  context, which is what makes "exactly one module derives it" checkable. */
  readonly entryPointPath: string;
  /** The four Framework_Singletons with names composed under this scope (R3.7). */
  readonly framework: {
    readonly contracts: FrameworkSingleton;
    readonly overseer: FrameworkSingleton;
    readonly buildTools: FrameworkSingleton;
    readonly integrationTests: FrameworkSingleton;
    readonly all: readonly FrameworkSingleton[];
  };
  /** Exact, case-sensitive lookup by declared name (R3.8). */
  frameworkByName(name: string): FrameworkSingleton | undefined;
}

/**
 * Derives the per-run context from one Effective_Config. Pure and total over any
 * EffectiveConfig: it touches no filesystem, composes every scoped string from
 * `config.scope`, and reads each root straight out of `config.roots`.
 *
 * @param config the one validated configuration this run operates on.
 */
export function projectContext(config: EffectiveConfig): ProjectContext {
  const scopedName = (name: string): string => `${config.scope}/${name}`;

  // The four singletons, each the scope-free FrameworkDirectory (dirName,
  // packageDir, staging) with its `name` composed under this run's scope (R3.7).
  // Iterating FRAMEWORK_DIRECTORIES keeps the fixed order.
  const [contracts, overseer, buildTools, integrationTests] =
    FRAMEWORK_DIRECTORIES.map(
      (entry): FrameworkSingleton => ({
        name: scopedName(entry.dirName),
        dirName: entry.dirName,
        packageDir: entry.packageDir,
        staging: entry.staging,
      }),
    );

  // FRAMEWORK_DIRECTORIES has exactly four entries, in contracts, overseer,
  // build-tools, integration-tests order; assert the destructuring for the type.
  if (
    contracts === undefined ||
    overseer === undefined ||
    buildTools === undefined ||
    integrationTests === undefined
  ) {
    throw new Error(
      "internal error: FRAMEWORK_SINGLETONS must declare all four framework packages",
    );
  }

  const all: readonly FrameworkSingleton[] = [
    contracts,
    overseer,
    buildTools,
    integrationTests,
  ];

  // Resolution index for frameworkByName: exact and case-sensitive because Map
  // keys compare by value with no normalisation (R3.8).
  const byName = new Map<string, FrameworkSingleton>(
    all.map((entry) => [entry.name, entry]),
  );

  // The Entry_Root is `config.entry` verbatim, and the Entry_Point_Path is it
  // joined to `dist/index.js` by a single `/` — derived once, here, so every
  // consumer reads the same string instead of composing its own (R1.3, R7.1).
  const entryRoot = config.entry;
  const entryPointPath = `${entryRoot}/dist/index.js`;

  return {
    config,
    scopedName,
    specifierPrefix: `${config.scope}/`,
    scopeDir: `node_modules/${config.scope}`,
    roots: {
      microservice: config.roots.microservice,
      common: config.roots.common,
      spa: config.roots.spa,
    },
    entryRoot,
    entryPointPath,
    framework: { contracts, overseer, buildTools, integrationTests, all },
    frameworkByName: (name: string): FrameworkSingleton | undefined =>
      byName.get(name),
  };
}

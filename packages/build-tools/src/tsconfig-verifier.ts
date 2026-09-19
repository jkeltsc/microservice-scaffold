// The Tsconfig_Verifier: it verifies that every Tsc_Project of a run declares —
// after every `extends` chain is applied — the four Load_Bearing_Settings the
// Build_System depends on (R9.1):
//
//   composite   === true    the build is a single `tsc --build` over refs
//   declaration === true    packages are consumed across boundaries by name
//   outDir      -> dist/     the Image_Assembler stages each package's dist
//   rootDir     -> src/      pins the output layout the Assembler + Overseer need
//
// `composite` and `declaration` are judged for EVERY verified package, because
// every one is a root of the single `tsc --build`. `outDir` and `rootDir` are
// judged for every verified package EXCEPT a Non_Shipping_Singleton — a
// Framework_Singleton whose `staging === "none"` (`build-tools` and
// `integration-tests`), whose `dist` no image stages and which no package
// imports by name, so no output layout depends on where it emits (R9.1, R9.8,
// R9.13). The verifier carries this as a per-package `verifyLayout` boolean:
// `false` exactly for such a singleton, `true` for every other package
// (discovered microservices and common packages carry no `staging` field, so
// they are always `true`).
//
// It reads a package's *resolved* configuration — never its raw JSON text (R9.2,
// R9.3) — so a value inherited from `tsconfig.base.json` counts as satisfaction.
// The resolution mechanism is injected (`ResolveTsconfig`): a property test hands
// resolved values directly (R14.8), while the real implementation
// (`resolveTsconfigWithCompiler`) reads a real `extends` chain through the
// TypeScript compiler API (R14.13).
//
// `verifyTsconfigs` returns violations rather than throwing (R9.5, R9.11): the
// Repo_Invariant_Checker runs its other checks whether or not this one found
// anything, and this one continues past the first offending package.
//
// The verified set is `context.framework.all` plus the discovered
// Microservice_Packages plus the discovered Common_Packages, and no Spa_Package
// (R9.8, R9.9). No Selector appears in the signature, which is how "for every
// Selector value and independently of any Selector" is discharged.

import { resolve, sep } from "node:path";

import ts from "typescript";

import { type Discovery } from "./discovery.js";
import { type FrameworkStaging } from "./framework.js";
import { type ProjectContext } from "./project-context.js";

/** The four Load_Bearing_Settings, in the order R9.10's comparator produces. */
export type LoadBearingSetting =
  | "composite"
  | "declaration"
  | "outDir"
  | "rootDir";

/** One package's resolved TypeScript configuration, reduced to what R9.1 judges.
 *  `undefined` means the setting is unset in the RESOLVED view — after every
 *  `extends` has been applied, which is what makes inheritance count as
 *  satisfaction (R9.3). `outDir`/`rootDir` are absolute, compiler-resolved
 *  paths, never declared text (R9.4). */
export interface ResolvedTsconfig {
  readonly composite: boolean | undefined;
  readonly declaration: boolean | undefined;
  readonly outDir: string | undefined;
  readonly rootDir: string | undefined;
}

/** What resolving one package's configuration yielded. The three shapes are the
 *  three outcomes R9.1, R9.7 and R9.15 distinguish. */
export type TsconfigResolution =
  | { readonly kind: "resolved"; readonly resolved: ResolvedTsconfig }
  | { readonly kind: "absent"; readonly configPath: string }
  | {
      readonly kind: "failed";
      readonly configPath: string;
      readonly reason: string;
    };

/** The injected resolution mechanism. Its only parameter is a package
 *  directory, so a property test supplies resolved values directly (R14.8) while
 *  the real implementation reads a real `extends` chain (R14.13). */
export type ResolveTsconfig = (packageDir: string) => TsconfigResolution;

/** One reported violation. `setting` is absent for the whole-package shapes. */
export interface TsconfigViolation {
  readonly tag: "tsconfig:setting" | "tsconfig:absent" | "tsconfig:unresolvable";
  /** Project_Directory-relative POSIX path (R1.11). */
  readonly packageDir: string;
  readonly setting?: LoadBearingSetting;
  /** The resolved value found, or that the setting is unset (R9.5). */
  readonly found: string;
  /** The value required (R9.5). */
  readonly required: string;
  /** Why the Build_System requires it — the four texts R9.6 fixes. */
  readonly reason: string;
}

// --- The four fixed reason texts (R9.6). One per setting, stated as constants. ---

const REASON_COMPOSITE =
  "the build is a single `tsc --build` over project references";
const REASON_DECLARATION =
  "packages are consumed across package boundaries by package name";
const REASON_OUTDIR = "the Image_Assembler stages each package's `dist` directory";
const REASON_ROOTDIR =
  "it pins the output layout the Image_Assembler and the Overseer entrypoint depend on";

/** The empty sort key gives the whole-package shapes (absent, unresolvable) a
 *  slot ahead of any setting name (R9.10). */
const WHOLE_PACKAGE_SORT_KEY = "";

/** The order R9.10 fixes for the setting names: their natural code-point order. */
const SETTING_SORT_KEY: Readonly<Record<LoadBearingSetting, string>> = {
  composite: "composite",
  declaration: "declaration",
  outDir: "outDir",
  rootDir: "rootDir",
};

/** Ascending code-point comparison of raw strings, never `localeCompare`. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalises away a trailing path separator so `dist` and `dist/` compare equal
 *  (R9.4). The comparison itself is code-point exact on the normalised absolute
 *  paths, so a differently-cased spelling is a violation even on a
 *  case-insensitive filesystem. */
function normalizeAbsolutePath(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** A Non_Shipping_Singleton is a Framework_Singleton whose `staging === "none"`
 *  (`build-tools`, `integration-tests`). Any package lacking a `staging` field —
 *  a discovered Microservice_Package or Common_Package — is not one, so its
 *  layout settings are always verified (R9.8, R9.13). */
function isNonShippingSingleton(pkg: {
  readonly staging?: FrameworkStaging;
}): boolean {
  return pkg.staging === "none";
}

/**
 * Judges one package's resolved configuration against the Load_Bearing_Settings,
 * appending one violation per unsatisfied setting (R9.5).
 *
 * `composite` and `declaration` are judged unconditionally, because every
 * verified package is a root of the single `tsc --build`. `outDir` and `rootDir`
 * are judged only when `verifyLayout` is `true` — every shipping package, never
 * a Non_Shipping_Singleton (R9.1, R9.8, R9.13).
 *
 * `projectDirectory` and `packageDir` fix the two directories the resolved
 * `outDir`/`rootDir` are compared against by location (R9.4).
 */
function verifyResolved(
  projectDirectory: string,
  packageDir: string,
  resolved: ResolvedTsconfig,
  verifyLayout: boolean,
  into: TsconfigViolation[],
): void {
  if (resolved.composite !== true) {
    into.push({
      tag: "tsconfig:setting",
      packageDir,
      setting: "composite",
      found: resolved.composite === undefined ? "unset" : String(resolved.composite),
      required: "true",
      reason: REASON_COMPOSITE,
    });
  }

  if (resolved.declaration !== true) {
    into.push({
      tag: "tsconfig:setting",
      packageDir,
      setting: "declaration",
      found:
        resolved.declaration === undefined
          ? "unset"
          : String(resolved.declaration),
      required: "true",
      reason: REASON_DECLARATION,
    });
  }

  // outDir and rootDir pin the shipping output layout the Image_Assembler and
  // the Overseer entrypoint depend on, which a Non_Shipping_Singleton never
  // reaches, so they are judged only for a package that ships (R9.8, R9.13).
  if (!verifyLayout) {
    return;
  }

  const expectedOutDir = normalizeAbsolutePath(
    resolve(projectDirectory, packageDir, "dist"),
  );
  const actualOutDir =
    resolved.outDir === undefined
      ? undefined
      : normalizeAbsolutePath(resolved.outDir);
  if (actualOutDir !== expectedOutDir) {
    into.push({
      tag: "tsconfig:setting",
      packageDir,
      setting: "outDir",
      found: resolved.outDir === undefined ? "unset" : resolved.outDir,
      required: expectedOutDir,
      reason: REASON_OUTDIR,
    });
  }

  const expectedRootDir = normalizeAbsolutePath(
    resolve(projectDirectory, packageDir, "src"),
  );
  const actualRootDir =
    resolved.rootDir === undefined
      ? undefined
      : normalizeAbsolutePath(resolved.rootDir);
  if (actualRootDir !== expectedRootDir) {
    into.push({
      tag: "tsconfig:setting",
      packageDir,
      setting: "rootDir",
      found: resolved.rootDir === undefined ? "unset" : resolved.rootDir,
      required: expectedRootDir,
      reason: REASON_ROOTDIR,
    });
  }
}

/**
 * Verifies every Tsc_Project of one run: the four Framework_Singletons, the
 * discovered Microservice_Packages and the discovered Common_Packages, and no
 * Spa_Package (R9.8, R9.9). Selector-independent by construction — it takes no
 * Selector.
 *
 * Returns violations rather than throwing, ordered by ascending code-point
 * comparison of `packageDir` then setting name, with the whole-package shapes
 * sorting first via the empty sort key (R9.10). Never throws.
 */
export function verifyTsconfigs(
  context: ProjectContext,
  discovery: Discovery,
  resolveTsconfig: ResolveTsconfig,
): readonly TsconfigViolation[] {
  const projectDirectory = process.cwd();

  // The verified set (R9.8): the four Framework_Singletons plus the discovered
  // microservices plus the discovered common packages. No Spa_Package appears,
  // so a Spa_Package's tsconfig is never even read (R9.9). Each target carries a
  // `staging` field only when it is a Framework_Singleton, which is what decides
  // its `verifyLayout` below.
  const targets: readonly { readonly staging?: FrameworkStaging; readonly packageDir: string }[] =
    [
      ...context.framework.all,
      ...discovery.byCategory.microservice,
      ...discovery.byCategory.common,
    ];

  const violations: TsconfigViolation[] = [];

  for (const target of targets) {
    const { packageDir } = target;
    // false exactly for a Framework_Singleton that never ships (staging "none":
    // build-tools, integration-tests); true for every shipping package and for
    // every discovered microservice/common package (R9.8, R9.13).
    const verifyLayout = !isNonShippingSingleton(target);

    const resolution = resolveTsconfig(packageDir);

    // The suppression is structural: the per-setting loop lives inside the
    // `resolved` branch of this single switch, so the absent and failed shapes
    // cannot reach it (R9.7, R9.15).
    switch (resolution.kind) {
      case "resolved":
        verifyResolved(
          projectDirectory,
          packageDir,
          resolution.resolved,
          verifyLayout,
          violations,
        );
        break;
      case "absent":
        violations.push({
          tag: "tsconfig:absent",
          packageDir,
          found: `no tsconfig.json in ${packageDir}`,
          required: `a tsconfig.json at ${resolution.configPath}`,
          reason:
            "every Tsc_Project must declare its own tsconfig.json to be a root of `tsc --build`",
        });
        break;
      case "failed":
        violations.push({
          tag: "tsconfig:unresolvable",
          packageDir,
          found: resolution.reason,
          required: `a resolvable tsconfig.json at ${resolution.configPath}`,
          reason:
            "the Load_Bearing_Settings cannot be judged unless the configuration resolves",
        });
        break;
    }
  }

  return [...violations].sort((a, b) => {
    const byPackage = compareStrings(a.packageDir, b.packageDir);
    if (byPackage !== 0) {
      return byPackage;
    }
    const keyA = a.setting ? SETTING_SORT_KEY[a.setting] : WHOLE_PACKAGE_SORT_KEY;
    const keyB = b.setting ? SETTING_SORT_KEY[b.setting] : WHOLE_PACKAGE_SORT_KEY;
    return compareStrings(keyA, keyB);
  });
}

/** `[<tag>] <packageDir>[ <setting>] — found <found>; required <required>; <reason>` */
export function renderTsconfigViolation(violation: TsconfigViolation): string {
  const subject = violation.setting
    ? `${violation.packageDir} ${violation.setting}`
    : violation.packageDir;
  return `[${violation.tag}] ${subject} — found ${violation.found}; required ${violation.required}; ${violation.reason}`;
}

/**
 * The real mechanism: `ts.getParsedCommandLineOfConfigFile` over `ts.sys` — the
 * entry point `tsc` itself uses to turn a config path into `CompilerOptions`,
 * applying the whole `extends` chain and returning `outDir`/`rootDir` already
 * resolved to absolute paths (R9.4).
 *
 * It reports resolution failures as `Diagnostic` values, which is what lets the
 * `failed` shape name a reason (R9.15).
 */
export const resolveTsconfigWithCompiler: ResolveTsconfig = (packageDir) => {
  const configPath = resolve(process.cwd(), packageDir, "tsconfig.json");

  if (!ts.sys.fileExists(configPath)) {
    return { kind: "absent", configPath: `${packageDir}/tsconfig.json` };
  }

  const diagnostics: ts.Diagnostic[] = [];
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  };

  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    /* optionsToExtend */ undefined,
    host,
  );

  const failureText = collectFailure(diagnostics, parsed);
  if (parsed === undefined || failureText !== undefined) {
    return {
      kind: "failed",
      configPath: `${packageDir}/tsconfig.json`,
      reason: failureText ?? "the configuration file could not be parsed",
    };
  }

  const options = parsed.options;
  return {
    kind: "resolved",
    resolved: {
      composite: options.composite,
      declaration: options.declaration,
      outDir: options.outDir,
      rootDir: options.rootDir,
    },
  };
};

/** Renders the first error-level diagnostic as a single-line reason, or
 *  `undefined` when resolution reported no error. */
function collectFailure(
  hostDiagnostics: readonly ts.Diagnostic[],
  parsed: ts.ParsedCommandLine | undefined,
): string | undefined {
  const errors = [
    ...hostDiagnostics,
    ...(parsed?.errors ?? []),
  ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

  if (errors.length === 0) {
    return undefined;
  }

  return ts.flattenDiagnosticMessageText(errors[0]!.messageText, " ");
}

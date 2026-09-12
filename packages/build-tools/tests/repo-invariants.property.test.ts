// The import-discipline and dependency-direction invariants of
// `repo-invariants.ts` (Properties 25 and 26).
//
// Both checks under test are pure and RETURN message lists rather than throwing,
// so each property is a straight comparison of the returned list against an
// oracle written from the acceptance criteria rather than from the module.
//
// Two shared conventions across this file:
//
//   * The oracles never call anything from `repo-invariants.ts`. Requirement
//     14.4's "relative path that leaves the importing package's own directory"
//     is re-derived with `node:path/posix` arithmetic, and Requirement 8.9's
//     upward set is re-derived from the declared names in the generated layout.
//     The framework names Requirements 8.9 and 14.5 mention are restated as
//     literals below for the same reason: the requirement names them, so the
//     oracle should too, instead of inheriting them from the code it judges.
//
//   * Message content is asserted structurally — the right `[imports:escape]`,
//     `[imports:peer]`, or `[deps:direction]` prefix plus the quoted names the
//     requirement says the message must carry. Quoting both ends of a fragment is
//     what keeps a message about `"./a.js"` from being claimed by a violation
//     about `"../a.js"`. The concrete cases at the end of each section pin the
//     full message shapes.
//
// Validates: Requirements 8.9, 14.4, 14.5, 14.10

import { posix } from "node:path";

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  checkDependencyDirection,
  checkImportDiscipline,
} from "../src/repo-invariants.js";
import {
  buildKindOf,
  type ConsumerPackage,
  type Discovery,
} from "../src/discovery.js";
import { type ConsumerCategory } from "../src/framework.js";

// ---------------------------------------------------------------------------
// The literals the requirements name
// ---------------------------------------------------------------------------

const SCOPE = "@microservices";
const OVERSEER_NAME = `${SCOPE}/overseer`;
const CONTRACTS_NAME = `${SCOPE}/contracts`;
const BUILD_TOOLS_NAME = `${SCOPE}/build-tools`;
const INTEGRATION_TESTS_NAME = `${SCOPE}/integration-tests`;

/** The Namespace_Container of each Consumer_Category, restated for the oracle. */
const CONTAINER: Readonly<Record<ConsumerCategory, string>> = {
  microservice: "packages/microservices",
  common: "packages/common",
  spa: "packages/spa",
};

const ESCAPE_PREFIX = "[imports:escape]";
const PEER_PREFIX = "[imports:peer]";
const DIRECTION_PREFIX = "[deps:direction]";

// ---------------------------------------------------------------------------
// The in-memory layout model, shared by both properties
// ---------------------------------------------------------------------------

/**
 * A discovered Consumer_Package placed in its category's Namespace_Container.
 *
 * The specifiers are deduplicated and sorted the way discovery records them:
 * they are the `@microservices`-scoped keys of a `dependencies` object, so a
 * repeated specifier is not a possible input and a generator that draws the same
 * name twice must not manufacture one.
 */
function consumer(
  category: ConsumerCategory,
  dirName: string,
  name: string,
  dependencySpecifiers: readonly string[] = [],
): ConsumerPackage {
  return {
    category,
    dirName,
    packageDir: `${CONTAINER[category]}/${dirName}`,
    name,
    dependencySpecifiers: [...new Set(dependencySpecifiers)].sort(),
    buildKind: buildKindOf(category),
  };
}

/** The `Discovery` a set of Consumer_Packages presents to the checks. */
function discoveryOf(packages: readonly ConsumerPackage[]): Discovery {
  return {
    byCategory: {
      microservice: packages.filter((pkg) => pkg.category === "microservice"),
      common: packages.filter((pkg) => pkg.category === "common"),
      spa: packages.filter((pkg) => pkg.category === "spa"),
    },
    nameByDir: new Map(packages.map((pkg) => [pkg.packageDir, pkg.name])),
    byName: new Map(packages.map((pkg) => [pkg.name, pkg])),
  };
}

/** How many packages of each category a generated layout holds. */
interface Layout {
  readonly microservices: number;
  readonly commons: number;
  readonly spas: number;
  /**
   * Whether the first Microservice_Package declares a name that does NOT mirror
   * its directory. Nothing requires a Microservice_Package to mirror (R3.6
   * covers Common and Spa only), and both checks resolve a specifier through the
   * declared name, so a non-mirroring microservice supplies two useful inputs at
   * once: its declared name resolves and its directory-derived name does not.
   */
  readonly nonMirroringMicroservice: boolean;
}

function packagesOf(layout: Layout): ConsumerPackage[] {
  const packages: ConsumerPackage[] = [];

  for (let i = 0; i < layout.microservices; i += 1) {
    const dirName = `microservice${String(i)}`;
    const name =
      layout.nonMirroringMicroservice && i === 0
        ? `${SCOPE}/svc-zero`
        : `${SCOPE}/${dirName}`;
    packages.push(consumer("microservice", dirName, name));
  }
  for (let i = 0; i < layout.commons; i += 1) {
    const dirName = `common${String(i)}`;
    packages.push(consumer("common", dirName, `${SCOPE}/${dirName}`));
  }
  for (let i = 0; i < layout.spas; i += 1) {
    const dirName = `spa${String(i)}`;
    packages.push(consumer("spa", dirName, `${SCOPE}/${dirName}`));
  }

  return packages;
}

const arbLayout: fc.Arbitrary<Layout> = fc.record({
  microservices: fc.integer({ min: 0, max: 3 }),
  commons: fc.integer({ min: 0, max: 2 }),
  spas: fc.integer({ min: 0, max: 2 }),
  nonMirroringMicroservice: fc.boolean(),
});

// ===========================================================================
// Feature: package-categories, Property 25: Import discipline is enforced over every Consumer_Package source
//
// For any set of Consumer_Package source files and import specifiers, the check
// reports exactly those specifiers that are relative paths escaping the
// importing package's own directory, plus those declared by a
// Microservice_Package that name a peer Microservice_Package or the Overseer —
// naming the importing file and the offending specifier for each — and reports
// nothing for a specifier that names another workspace package by its declared
// name from a package permitted to depend on it.
//
// Validates: Requirements 14.4, 14.5, 14.10
// ===========================================================================

// ---------------------------------------------------------------------------
// Specifier pools
// ---------------------------------------------------------------------------

/**
 * Relative specifiers, mixed on purpose: some stay inside the importing
 * package at every file depth, some leave it at every depth, and some depend on
 * the depth of the importing file. The oracle decides which is which, so the
 * generator never has to know — that is the whole point of pooling them.
 */
const RELATIVE_POOL: readonly string[] = [
  "./sibling.js",
  "./deep/util.js",
  "../index.js",
  "../../src/index.js",
  "../../../contracts/src/index.js",
  "../../peer/src/router.js",
  "../../../../../../../beyond.js",
  ".",
  "..",
];

/** Relative specifiers that stay inside the package from any file within it. */
const LEGAL_RELATIVE_POOL: readonly string[] = [
  "./sibling.js",
  "./deep/util.js",
];

/**
 * By-name specifiers: every declared name in the layout, the directory-derived
 * specifier of each Microservice_Package (which resolves only when that
 * microservice mirrors its directory), one subpath import of a microservice and
 * one of the Overseer — R14.5 forbids the peer "by package name or by any other
 * specifier", so a subpath must be caught too — the Framework_Singletons a
 * package may legally name, third-party names, and a scoped name that resolves
 * to nothing.
 */
function byNamePool(packages: readonly ConsumerPackage[]): string[] {
  const microservices = packages.filter(
    (pkg) => pkg.category === "microservice",
  );
  return [
    ...packages.map((pkg) => pkg.name),
    ...microservices.map((pkg) => `${SCOPE}/${pkg.dirName}`),
    ...(microservices.length > 0
      ? [`${microservices[0].name}/dist/router.js`]
      : []),
    OVERSEER_NAME,
    `${OVERSEER_NAME}/dist/index.js`,
    CONTRACTS_NAME,
    BUILD_TOOLS_NAME,
    "express",
    "node:path",
    `${SCOPE}/absent-package`,
  ];
}

/**
 * The by-name specifiers no owner category can be faulted for: the importer's
 * own name, the Common and Spa packages, the Framework_Singletons other than the
 * Overseer, third-party names, and an unresolvable scoped name. Used by the
 * "legal" generation mode, which exists so a healthy share of runs exercises the
 * empty-message verdict rather than only the violating one.
 */
function legalByNamePool(
  packages: readonly ConsumerPackage[],
  owner: ConsumerPackage,
): string[] {
  return [
    owner.name,
    ...packages
      .filter((pkg) => pkg.category !== "microservice")
      .map((pkg) => pkg.name),
    CONTRACTS_NAME,
    BUILD_TOOLS_NAME,
    "express",
    "node:path",
    `${SCOPE}/absent-package`,
  ];
}

// ---------------------------------------------------------------------------
// The generated import model
// ---------------------------------------------------------------------------

interface SourceFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** The specifiers this file imports, deduplicated, in order of appearance. */
  readonly specifiers: readonly string[];
}

interface ImportModel {
  readonly packages: readonly ConsumerPackage[];
  readonly files: readonly SourceFile[];
}

/** The source files each Consumer_Package owns: `src/`, nested `src/`, and tests. */
const OWNED_FILE_SUFFIXES: readonly string[] = [
  "src/index.ts",
  "src/deep/nested.ts",
  "tests/thing.test.ts",
];

/**
 * Files outside every package the check attributes an import to — neither a
 * discovered Consumer_Package nor a Framework_Singleton — each importing
 * something that would be a violation from inside one. The check attributes a
 * file only when it lies under a known package directory, so every one of these
 * must be reported as nothing at all.
 *
 * A Framework_Singleton's own `src/` is deliberately NOT used here: since rule 4
 * ({@link SPA} in the module) a Framework_Singleton IS an owner — a Tsc_Project —
 * so a file under `packages/overseer/` or `packages/contracts/` is attributed to
 * that singleton and an escaping relative import from it is a real
 * `[imports:escape]`. The genuinely unowned locations are a repo-root file, a
 * file directly under `packages/` (which is neither a package nor a container),
 * and a file directly inside a Namespace_Container (which is not a package).
 */
const UNOWNED_FILES: readonly SourceFile[] = [
  {
    // At the repository root, below no package directory at all.
    path: "root-note.ts",
    specifiers: ["./scripts/thing.js", OVERSEER_NAME],
  },
  {
    // Directly under `packages/`, which is neither a package nor a container.
    path: "packages/loose-note.ts",
    specifiers: ["../beyond.js", OVERSEER_NAME],
  },
  {
    // Directly inside a Namespace_Container, which is not a package.
    path: "packages/microservices/loose-note.ts",
    specifiers: ["../../../beyond.js", OVERSEER_NAME],
  },
];

/** Deduplicate while preserving first-appearance order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * A layout, a file set, and each file's import specifiers. `legal` mode draws
 * only from pools no rule can fault, so it produces zero-violation models;
 * `free` mode draws from everything, supplying escapes, peer imports, Overseer
 * imports, and subpath variants of both.
 */
const arbImportModel: fc.Arbitrary<ImportModel> = fc
  .tuple(arbLayout, fc.constantFrom<"legal" | "free">("legal", "free"))
  .chain(([layout, mode]) => {
    const packages = packagesOf(layout);
    const pool = byNamePool(packages);

    const owned = packages.flatMap((pkg) =>
      OWNED_FILE_SUFFIXES.map((suffix) => ({
        owner: pkg,
        path: `${pkg.packageDir}/${suffix}`,
      })),
    );

    const specifiersFor = (owner: ConsumerPackage): fc.Arbitrary<string[]> =>
      fc
        .tuple(
          fc.subarray(mode === "legal" ? LEGAL_RELATIVE_POOL : RELATIVE_POOL),
          fc.subarray(
            mode === "legal" ? legalByNamePool(packages, owner) : pool,
          ),
        )
        .map(([relative, byName]) => unique([...relative, ...byName]));

    return fc
      .tuple(...owned.map((entry) => specifiersFor(entry.owner)))
      .map((specifierLists) => ({
        packages,
        files: [
          ...owned.map((entry, i) => ({
            path: entry.path,
            specifiers: specifierLists[i],
          })),
          ...UNOWNED_FILES,
        ],
      }));
  });

// ---------------------------------------------------------------------------
// Source synthesis
// ---------------------------------------------------------------------------

/**
 * A specifier that escapes any package directory from any file depth, used only
 * as decoy content. It never appears as a real import, so if the scanner ever
 * picked a specifier out of a comment or out of a CommonJS `require`, the extra
 * `[imports:escape]` message would break the count assertion.
 */
const DECOY = "../../../../../../../../decoy-never-imported.js";

/**
 * A source file declaring exactly `specifiers`, spread across the four import
 * forms the module documents scanning for — an `import ... from` clause, a
 * side-effect `import`, a re-export, and a dynamic `import()` — followed by the
 * three forms it documents NOT reporting: a line comment, a block comment, and a
 * CommonJS `require` (ES modules only, so there is no second form to scan).
 */
function renderSource(specifiers: readonly string[]): string {
  const lines = specifiers.map((specifier, i) => {
    switch (i % 4) {
      case 0:
        return `import binding${String(i)} from "${specifier}";`;
      case 1:
        return `import "${specifier}";`;
      case 2:
        return `export * from "${specifier}";`;
      default:
        return `const dynamic${String(i)} = await import("${specifier}");`;
    }
  });

  return [
    "// synthesized source",
    ...lines,
    `// import decoyLine from "${DECOY}";`,
    `/* import "${DECOY}"; */`,
    `/* export * from "${DECOY}"; */`,
    `const decoyRequire = require("${DECOY}");`,
    "export const value = 1;",
    "",
  ].join("\n");
}

/** A `readSource` over a model, recording which files it was asked for. */
function readerFor(
  model: ImportModel,
  asked: string[] = [],
): (file: string) => string {
  const sources = new Map(
    model.files.map((file) => [file.path, renderSource(file.specifiers)]),
  );
  return (file) => {
    asked.push(file);
    return sources.get(file) ?? "";
  };
}

// ---------------------------------------------------------------------------
// The rule oracle for Requirements 14.4 and 14.5
// ---------------------------------------------------------------------------

interface ImportViolation {
  readonly kind: "escape" | "peer" | "spa";
  readonly file: string;
  readonly specifier: string;
}

/** R14.4's "relative path": the only specifier forms that denote a path. */
function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

/**
 * The directory a relative specifier lands in, by plain POSIX path arithmetic
 * against the importing file's directory. A specifier walking above the
 * repository root normalizes to a `../`-prefixed path, which is outside every
 * package directory and therefore an escape.
 */
function landsIn(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

/** Whether `path` is `packageDir` itself or something beneath it. */
function isInside(packageDir: string, path: string): boolean {
  return path === packageDir || path.startsWith(`${packageDir}/`);
}

/** The package-name part of a by-name specifier: `@scope/name`, or `name`. */
function declaredNameIn(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") && segments.length > 1
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

/**
 * The innermost Consumer_Package strictly containing `file`, or `undefined` when
 * the file lies outside every one of them.
 */
function ownerOf(
  packages: readonly ConsumerPackage[],
  file: string,
): ConsumerPackage | undefined {
  return packages
    .filter((pkg) => file.startsWith(`${pkg.packageDir}/`))
    .sort((a, b) => b.packageDir.length - a.packageDir.length)[0];
}

/**
 * Every import-discipline violation a model commits, derived from the criteria:
 *
 *  - a relative specifier is an escape (R14.4) exactly when it leaves the
 *    importing package's own directory;
 *  - a by-name specifier declared by a Microservice_Package is a peer violation
 *    (R14.5) exactly when it names a peer Microservice_Package (through the name
 *    that peer declares, by any specifier that resolves to it) or the Overseer;
 *  - a by-name specifier declared by ANY Tsc_Project — every Microservice_Package
 *    and every Common_Package here, since both are `tsc-project`, and Spa
 *    importers are `bundler-project` and so excluded — that names a discovered
 *    Spa_Package is a spa violation (R14.13, R14.14).
 *
 * The peer/Overseer test runs ahead of the spa test for a Microservice_Package,
 * mirroring the module's first-match-wins order, so a single specifier yields at
 * most one violation. A Common_Package naming a Microservice_Package is not one
 * of these — that is Requirement 8.9's business, and Property 26's.
 */
function importOracle(model: ImportModel): ImportViolation[] {
  const byDeclaredName = new Map(model.packages.map((pkg) => [pkg.name, pkg]));
  const violations: ImportViolation[] = [];

  for (const file of model.files) {
    const owner = ownerOf(model.packages, file.path);
    if (owner === undefined) {
      continue;
    }

    for (const specifier of unique(file.specifiers)) {
      if (isRelativeSpecifier(specifier)) {
        if (!isInside(owner.packageDir, landsIn(file.path, specifier))) {
          violations.push({ kind: "escape", file: file.path, specifier });
        }
        continue;
      }

      const target = declaredNameIn(specifier);
      const resolved = byDeclaredName.get(target);

      if (owner.category === "microservice") {
        const isPeer =
          resolved !== undefined &&
          resolved.category === "microservice" &&
          resolved.packageDir !== owner.packageDir;
        if (target === OVERSEER_NAME || isPeer) {
          violations.push({ kind: "peer", file: file.path, specifier });
          continue;
        }
      }

      if (owner.buildKind === "tsc-project" && resolved?.category === "spa") {
        violations.push({ kind: "spa", file: file.path, specifier });
      }
    }
  }

  return violations;
}

/** The prefix Requirement 14.10's error must carry for each violation kind. */
function prefixOf(violation: ImportViolation): string {
  switch (violation.kind) {
    case "escape":
      return ESCAPE_PREFIX;
    case "peer":
      return PEER_PREFIX;
    default:
      return SPA_PREFIX;
  }
}

/** The messages that name what the requirement says this violation must name. */
function matching(
  messages: readonly string[],
  violation: ImportViolation,
): string[] {
  return messages.filter(
    (message) =>
      message.startsWith(`${prefixOf(violation)} `) &&
      message.includes(`"${violation.file}"`) &&
      message.includes(`"${violation.specifier}"`),
  );
}

// ---------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------

describe("Property 25: import discipline is enforced over every Consumer_Package source", () => {
  it("reports no message exactly when every import is legal", () => {
    fc.assert(
      fc.property(arbImportModel, (model) => {
        const messages = checkImportDiscipline(
          discoveryOf(model.packages),
          model.files.map((file) => file.path),
          readerFor(model),
        );

        expect(messages.length === 0).toBe(importOracle(model).length === 0);
      }),
      { numRuns: 200 },
    );
  });

  it("reports one message per offending specifier, naming the file and the specifier", () => {
    fc.assert(
      fc.property(arbImportModel, (model) => {
        const messages = checkImportDiscipline(
          discoveryOf(model.packages),
          model.files.map((file) => file.path),
          readerFor(model),
        );
        const violations = importOracle(model);

        expect(messages.length).toBe(violations.length);
        for (const violation of violations) {
          expect(matching(messages, violation)).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("reports nothing about a file outside every Consumer_Package", () => {
    fc.assert(
      fc.property(arbImportModel, (model) => {
        const asked: string[] = [];
        const paths = model.files.map((file) => file.path);
        const messages = checkImportDiscipline(
          discoveryOf(model.packages),
          paths,
          readerFor(model, asked),
        );

        for (const unowned of UNOWNED_FILES) {
          for (const message of messages) {
            expect(message).not.toContain(`"${unowned.path}"`);
          }
        }
        // No path other than the ones supplied is ever read.
        for (const file of asked) {
          expect(paths).toContain(file);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("returns the same messages however the caller ordered the files", () => {
    fc.assert(
      fc.property(
        arbImportModel,
        fc.integer({ min: 0, max: 1000 }),
        (model, seed) => {
          const paths = model.files.map((file) => file.path);
          // A deterministic rotation, which is enough to make the caller's
          // enumeration order differ from the sorted order.
          const rotated = [
            ...paths.slice(seed % Math.max(paths.length, 1)),
            ...paths.slice(0, seed % Math.max(paths.length, 1)),
          ];
          const discovery = discoveryOf(model.packages);

          expect(
            checkImportDiscipline(discovery, rotated, readerFor(model)),
          ).toEqual(checkImportDiscipline(discovery, paths, readerFor(model)));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25 (concrete): the message shapes and the scanner's documented edges
// ---------------------------------------------------------------------------

describe("Property 25 (concrete): message shapes and scanner edges", () => {
  const microservice1 = consumer(
    "microservice",
    "microservice1",
    `${SCOPE}/microservice1`,
  );
  const microservice2 = consumer(
    "microservice",
    "microservice2",
    `${SCOPE}/microservice2`,
  );
  const config = consumer("common", "config", `${SCOPE}/config`);
  const packages = [microservice1, microservice2, config];
  const discovery = discoveryOf(packages);

  /** Run the check over a single synthesized file. */
  function check(
    file: string,
    specifiers: readonly string[],
  ): readonly string[] {
    return checkImportDiscipline(discovery, [file], () =>
      renderSource(specifiers),
    );
  }

  const ms1File = `${microservice1.packageDir}/src/index.ts`;

  it("names the file and the specifier for a relative path that escapes (R14.4)", () => {
    expect(check(ms1File, ["../../microservice2/src/router.js"])).toEqual([
      `${ESCAPE_PREFIX} "${ms1File}" imports "../../microservice2/src/router.js", a relative path that escapes the package directory`,
    ]);
  });

  it("accepts relative paths that stay inside the package, from src/ and tests/", () => {
    expect(check(ms1File, ["./router.js", "../package.json", "."])).toEqual([]);
    expect(
      check(`${microservice1.packageDir}/tests/router.test.ts`, [
        "../src/index.js",
        "./helpers.js",
      ]),
    ).toEqual([]);
  });

  it("names a peer Microservice_Package imported by name or by subpath (R14.5)", () => {
    expect(check(ms1File, [microservice2.name])).toEqual([
      `${PEER_PREFIX} "${ms1File}" imports "${microservice2.name}", a peer Microservice_Package`,
    ]);
    expect(check(ms1File, [`${microservice2.name}/dist/router.js`])).toEqual([
      `${PEER_PREFIX} "${ms1File}" imports "${microservice2.name}/dist/router.js", a peer Microservice_Package`,
    ]);
  });

  it("names the Overseer imported by name or by subpath (R14.5)", () => {
    expect(check(ms1File, [OVERSEER_NAME])).toEqual([
      `${PEER_PREFIX} "${ms1File}" imports "${OVERSEER_NAME}", the Overseer`,
    ]);
    expect(check(ms1File, [`${OVERSEER_NAME}/dist/index.js`])).toEqual([
      `${PEER_PREFIX} "${ms1File}" imports "${OVERSEER_NAME}/dist/index.js", the Overseer`,
    ]);
  });

  it("accepts a legal by-name import from a package permitted to depend on it", () => {
    // A microservice naming a Common_Package, a Framework_Singleton, a
    // third-party package, and itself.
    expect(
      check(ms1File, [
        config.name,
        CONTRACTS_NAME,
        "express",
        microservice1.name,
      ]),
    ).toEqual([]);
    // A Common_Package's by-name imports are outside R14.5 entirely; an upward
    // one is Requirement 8.9's business and Property 26's.
    expect(
      check(`${config.packageDir}/src/index.ts`, [
        microservice2.name,
        OVERSEER_NAME,
        CONTRACTS_NAME,
      ]),
    ).toEqual([]);
  });

  it("reports one message for a specifier imported twice in one file", () => {
    const source = [
      `import router from "${microservice2.name}";`,
      `export * from "${microservice2.name}";`,
      "",
    ].join("\n");

    expect(
      checkImportDiscipline(discovery, [ms1File], () => source),
    ).toHaveLength(1);
  });

  it("ignores a commented-out import and a CommonJS require", () => {
    const source = [
      `// import peer from "${microservice2.name}";`,
      `/* import "${OVERSEER_NAME}"; */`,
      "/*",
      ` * import legacy from "../../microservice2/src/router.js";`,
      " */",
      `const legacy = require("${microservice2.name}");`,
      `import { thing } from "./thing.js";`,
      "",
    ].join("\n");

    expect(checkImportDiscipline(discovery, [ms1File], () => source)).toEqual(
      [],
    );
  });
});

// ===========================================================================
// Feature: package-categories, Property 26: A Common_Package's declared dependencies point downward only
//
// For any discovered layout, the dependency-direction check reports exactly
// those Common_Packages declaring a Dependency_Specifier that resolves to a
// Microservice_Package or to the Overseer, and reports nothing for a
// Common_Package whose specifiers name only third-party packages, other
// Common_Packages, and Framework_Singletons.
//
// Validates: Requirements 8.9, 14.10
// ===========================================================================

/**
 * The specifiers a generated package may declare: every declared name in the
 * layout, the directory-derived specifier of each Microservice_Package (which
 * resolves only for a microservice that mirrors its directory), every
 * Framework_Singleton name, a scoped name that resolves to nothing, and a
 * third-party name. Discovery records only `@microservices`-scoped keys, so
 * `express` here is belt and braces: it pins that an unscoped specifier is never
 * reported even if one reaches the check.
 */
function dependencyPool(packages: readonly ConsumerPackage[]): string[] {
  return [
    ...packages.map((pkg) => pkg.name),
    ...packages
      .filter((pkg) => pkg.category === "microservice")
      .map((pkg) => `${SCOPE}/${pkg.dirName}`),
    OVERSEER_NAME,
    CONTRACTS_NAME,
    BUILD_TOOLS_NAME,
    INTEGRATION_TESTS_NAME,
    `${SCOPE}/absent-package`,
    "express",
  ];
}

/**
 * A layout in which every package — Common, Spa, and Microservice alike —
 * declares an arbitrary subset of the pool. Non-Common packages are given
 * upward specifiers too, because R8.9 constrains Common_Packages only: an
 * upward specifier declared by a microservice or a Spa_Package must be reported
 * as nothing.
 */
const arbDependencyModel: fc.Arbitrary<readonly ConsumerPackage[]> =
  arbLayout.chain((layout) => {
    const bare = packagesOf(layout);
    const pool = dependencyPool(bare);
    return fc
      .tuple(...bare.map(() => fc.subarray(pool)))
      .map((specifierLists) =>
        bare.map((pkg, i) =>
          consumer(pkg.category, pkg.dirName, pkg.name, specifierLists[i]),
        ),
      );
  });

/** One offending `(Common_Package, specifier)` pair. */
interface DirectionViolation {
  readonly packageDir: string;
  readonly specifier: string;
}

/**
 * Every Requirement 8.9 violation a layout commits: a Common_Package's
 * Dependency_Specifier that resolves, through the declared names, to a
 * Microservice_Package or to the Overseer. A specifier resolving to a Spa
 * package is deliberately not a violation — R8.9's prohibition names
 * Microservice_Packages and the Overseer, and Property 26 pins the check to
 * exactly that pair.
 */
function directionOracle(
  packages: readonly ConsumerPackage[],
): DirectionViolation[] {
  const byDeclaredName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const violations: DirectionViolation[] = [];

  for (const pkg of packages) {
    if (pkg.category !== "common") {
      continue;
    }
    for (const specifier of pkg.dependencySpecifiers) {
      const upward =
        specifier === OVERSEER_NAME ||
        byDeclaredName.get(specifier)?.category === "microservice";
      if (upward) {
        violations.push({ packageDir: pkg.packageDir, specifier });
      }
    }
  }

  return violations;
}

describe("Property 26: a Common_Package's declared dependencies point downward only", () => {
  it("reports no message exactly when every Common_Package is a leaf library", () => {
    fc.assert(
      fc.property(arbDependencyModel, (packages) => {
        const messages = checkDependencyDirection(discoveryOf(packages));

        expect(messages.length === 0).toBe(
          directionOracle(packages).length === 0,
        );
      }),
      { numRuns: 200 },
    );
  });

  it("reports one message per offending specifier, naming the package and the specifier", () => {
    fc.assert(
      fc.property(arbDependencyModel, (packages) => {
        const messages = checkDependencyDirection(discoveryOf(packages));
        const violations = directionOracle(packages);

        expect(messages.length).toBe(violations.length);
        for (const violation of violations) {
          const claimed = messages.filter(
            (message) =>
              message.startsWith(`${DIRECTION_PREFIX} `) &&
              message.includes(`"${violation.packageDir}"`) &&
              message.includes(`"${violation.specifier}"`),
          );
          expect(claimed).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("leaves the discovered layout unmodified", () => {
    fc.assert(
      fc.property(arbDependencyModel, (packages) => {
        const before = JSON.stringify(packages);
        checkDependencyDirection(discoveryOf(packages));
        expect(JSON.stringify(packages)).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26 (concrete): the message shape and the permitted set
// ---------------------------------------------------------------------------

describe("Property 26 (concrete): message shape and the permitted set", () => {
  const microservice1 = consumer(
    "microservice",
    "microservice1",
    `${SCOPE}/microservice1`,
  );
  const spa1 = consumer("spa", "dashboard", `${SCOPE}/dashboard`);
  const helpers = consumer("common", "helpers", `${SCOPE}/helpers`);

  function withConfigDeps(
    specifiers: readonly string[],
  ): readonly ConsumerPackage[] {
    return [
      microservice1,
      spa1,
      helpers,
      consumer("common", "config", `${SCOPE}/config`, specifiers),
    ];
  }

  it("accepts third-party packages, other Common_Packages, and Framework_Singletons (R8.9)", () => {
    expect(
      checkDependencyDirection(
        discoveryOf(
          withConfigDeps([
            CONTRACTS_NAME,
            BUILD_TOOLS_NAME,
            helpers.name,
            "express",
            `${SCOPE}/absent-package`,
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("names the Common_Package and the specifier for a Microservice_Package dependency", () => {
    expect(
      checkDependencyDirection(
        discoveryOf(withConfigDeps([microservice1.name])),
      ),
    ).toEqual([
      `${DIRECTION_PREFIX} Common_Package "packages/common/config" depends on "${microservice1.name}"; a Common_Package must point downward only`,
    ]);
  });

  it("names the Common_Package and the specifier for an Overseer dependency", () => {
    expect(
      checkDependencyDirection(discoveryOf(withConfigDeps([OVERSEER_NAME]))),
    ).toEqual([
      `${DIRECTION_PREFIX} Common_Package "packages/common/config" depends on "${OVERSEER_NAME}"; a Common_Package must point downward only`,
    ]);
  });

  it("does not report a Spa_Package dependency, which the check deliberately omits", () => {
    expect(
      checkDependencyDirection(discoveryOf(withConfigDeps([spa1.name]))),
    ).toEqual([]);
  });

  it("does not report an upward dependency declared by a non-Common package", () => {
    const packages = [
      consumer("microservice", "microservice1", `${SCOPE}/microservice1`, [
        OVERSEER_NAME,
      ]),
      consumer("spa", "dashboard", `${SCOPE}/dashboard`, [
        OVERSEER_NAME,
        `${SCOPE}/microservice1`,
      ]),
    ];

    expect(checkDependencyDirection(discoveryOf(packages))).toEqual([]);
  });
});

// ===========================================================================
// Feature: package-categories, Property 30: No Tsc_Project source imports a Spa_Package
//
// For any set of source files belonging to Tsc_Projects of every kind —
// Framework_Singleton, Microservice_Package, and Common_Package — and any set of
// `import` specifiers over Spa_Package names, Common_Package names,
// Framework_Singleton names, third-party names, and near-misses of each, the
// import-discipline check reports exactly those specifiers that name a
// discovered Spa_Package, naming the importing file and the offending specifier,
// and reports nothing for any other specifier — including a Spa_Package name that
// appears only as a substring of another specifier and a Spa_Package name passed
// to `import.meta.resolve`, which is not an `import` specifier.
//
// Validates: Requirements 14.13, 14.14
// ===========================================================================

const SPA_PREFIX = "[imports:spa]";

/**
 * The Framework_Singletons, restated as literals the way the header of this file
 * restates every framework name the requirements mention. Every Framework
 * _Singleton is a Tsc_Project, so rule 4 (`[imports:spa]`) applies to its
 * sources; the Overseer is omitted so a Microservice_Package importer can never
 * incidentally trip `[imports:peer]` and pollute the spa-only message list.
 */
const TSC_FRAMEWORK_DIRS: readonly string[] = [
  "packages/contracts",
  "packages/build-tools",
  "packages/integration-tests",
];

/** The framework names that are always a legal by-name import here (never a peer/Overseer). */
const LEGAL_FRAMEWORK_NAMES: readonly string[] = [
  CONTRACTS_NAME,
  BUILD_TOOLS_NAME,
  INTEGRATION_TESTS_NAME,
];

/**
 * An importer of a given Tsc_Project kind, and the repo-relative source files it
 * owns. A Framework_Singleton importer is attributed by its package directory
 * exactly as a discovered Consumer_Package is; discovery does not list it, but
 * the check folds every Framework_Singleton into its owner table on Build_Kind
 * grounds, so a file under `packages/contracts/src/` resolves to that singleton.
 */
interface Importer {
  readonly packageDir: string;
}

/**
 * Every importing source file across all three Tsc_Project kinds: one `src/` and
 * one `tests/` file per discovered Microservice_Package and Common_Package, plus
 * one `src/` file per Framework_Singleton directory. Spa_Packages are NOT
 * importers — a Spa_Package is a Bundler_Project, so rule 4 does not range over
 * its sources — but they must be present in the layout to have a name to import.
 */
function tscImporters(packages: readonly ConsumerPackage[]): Importer[] {
  const consumers = packages
    .filter((pkg) => pkg.category !== "spa")
    .flatMap((pkg) => [
      { packageDir: pkg.packageDir },
    ]);
  const frameworks = TSC_FRAMEWORK_DIRS.map((packageDir) => ({ packageDir }));
  return [...consumers, ...frameworks];
}

/** The two source files a Tsc_Project importer owns for this property. */
const IMPORTER_FILE_SUFFIXES: readonly string[] = [
  "src/index.ts",
  "tests/thing.test.ts",
];

/**
 * The by-name specifiers Property 30 draws from: every discovered Spa_Package
 * name (each of which MUST be reported), a subpath import of the first
 * Spa_Package (its package-name part still resolves to the Spa_Package, so it too
 * is reported), every Common_Package name, the legal Framework_Singleton names,
 * two third-party names, and — the two documented near-misses that must be
 * reported as nothing — a longer specifier that merely CONTAINS a Spa_Package
 * name as a substring, and a Spa_Package name suffixed so it resolves to no
 * package. None of these draws in a peer or the Overseer, so the only rule that
 * can fire over this pool is rule 4.
 */
function spaByNamePool(packages: readonly ConsumerPackage[]): string[] {
  const spas = packages.filter((pkg) => pkg.category === "spa");
  const commons = packages.filter((pkg) => pkg.category === "common");
  return [
    ...spas.map((pkg) => pkg.name),
    ...(spas.length > 0 ? [`${spas[0].name}/dist/widget.js`] : []),
    ...commons.map((pkg) => pkg.name),
    ...LEGAL_FRAMEWORK_NAMES,
    "express",
    "node:path",
    // Substring near-miss: `@microservices/spa0-extra` contains `@microservices/spa0`
    // only as a leading substring, but its package-name part is a different name,
    // so it resolves to no Spa_Package and must NOT be reported.
    ...(spas.length > 0 ? [`${spas[0].name}-extra`] : []),
  ];
}

interface Property30Model {
  readonly packages: readonly ConsumerPackage[];
  readonly files: readonly SourceFile[];
  /** The Spa_Package names, for the `import.meta.resolve` decoy and the oracle. */
  readonly spaNames: readonly string[];
}

/**
 * A layout that always holds at least one Spa_Package (so there is a name to
 * import), a file set spanning every Tsc_Project importer, and each file's
 * import specifiers drawn from {@link spaByNamePool}.
 */
const arbProperty30Model: fc.Arbitrary<Property30Model> = arbLayout
  .map((layout) => ({ ...layout, spas: Math.max(layout.spas, 1) }))
  .chain((layout) => {
    const packages = packagesOf(layout);
    const pool = spaByNamePool(packages);
    const importers = tscImporters(packages);

    const owned = importers.flatMap((importer) =>
      IMPORTER_FILE_SUFFIXES.map((suffix) => ({
        path: `${importer.packageDir}/${suffix}`,
      })),
    );

    return fc
      .tuple(...owned.map(() => fc.subarray(pool)))
      .map((specifierLists) => ({
        packages,
        spaNames: packages
          .filter((pkg) => pkg.category === "spa")
          .map((pkg) => pkg.name),
        files: owned.map((entry, i) => ({
          path: entry.path,
          specifiers: unique(specifierLists[i]),
        })),
      }));
  });

/**
 * A source declaring exactly `specifiers` through the four scanned import forms,
 * plus two forms that must be reported as nothing: an `import.meta.resolve` call
 * naming a Spa_Package (not an `import` specifier), and a commented-out import of
 * a Spa_Package. If either leaked into the report, the count assertion breaks.
 */
function renderProperty30Source(
  specifiers: readonly string[],
  spaName: string | undefined,
): string {
  const resolveDecoy =
    spaName === undefined
      ? []
      : [
          `const url = import.meta.resolve("${spaName}");`,
          `// import widget from "${spaName}";`,
        ];
  return [renderSource(specifiers), ...resolveDecoy, ""].join("\n");
}

/** One `(file, specifier)` pair the check must report as `[imports:spa]`. */
interface SpaViolation {
  readonly file: string;
  readonly specifier: string;
}

/**
 * Every Requirement 14.13 / 14.14 violation a model commits: a specifier
 * declared by a Tsc_Project source whose package-name part equals a discovered
 * Spa_Package's declared name. Resolution is on the package-name part alone, so a
 * substring near-miss and a suffixed near-miss both resolve to nothing and are
 * not violations, and `import.meta.resolve` — never rendered as an `import`
 * specifier — never reaches this oracle.
 */
function spaImportOracle(model: Property30Model): SpaViolation[] {
  const spaNames = new Set(model.spaNames);
  const violations: SpaViolation[] = [];

  for (const file of model.files) {
    for (const specifier of unique(file.specifiers)) {
      if (spaNames.has(declaredNameIn(specifier))) {
        violations.push({ file: file.path, specifier });
      }
    }
  }

  return violations;
}

/** A `readSource` that renders each file, injecting the decoys tied to a Spa_Package name. */
function property30Reader(
  model: Property30Model,
): (file: string) => string {
  const spaName = model.spaNames[0];
  const sources = new Map(
    model.files.map((file) => [
      file.path,
      renderProperty30Source(file.specifiers, spaName),
    ]),
  );
  return (file) => sources.get(file) ?? "";
}

describe("Property 30: no Tsc_Project source imports a Spa_Package", () => {
  it("reports no message exactly when no source names a Spa_Package", () => {
    fc.assert(
      fc.property(arbProperty30Model, (model) => {
        const messages = checkImportDiscipline(
          discoveryOf(model.packages),
          model.files.map((file) => file.path),
          property30Reader(model),
        );

        expect(messages.length === 0).toBe(spaImportOracle(model).length === 0);
      }),
      { numRuns: 200 },
    );
  });

  it("reports one [imports:spa] message per offending specifier, naming the file and the specifier", () => {
    fc.assert(
      fc.property(arbProperty30Model, (model) => {
        const messages = checkImportDiscipline(
          discoveryOf(model.packages),
          model.files.map((file) => file.path),
          property30Reader(model),
        );
        const violations = spaImportOracle(model);

        expect(messages.length).toBe(violations.length);
        for (const violation of violations) {
          const claimed = messages.filter(
            (message) =>
              message.startsWith(`${SPA_PREFIX} `) &&
              message.includes(`"${violation.file}"`) &&
              message.includes(`"${violation.specifier}"`),
          );
          expect(claimed).toHaveLength(1);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 30 (concrete): the message shape, the three Tsc_Project kinds, and
// the two documented near-misses
// ---------------------------------------------------------------------------

describe("Property 30 (concrete): message shape and the documented non-reports", () => {
  const microservice1 = consumer(
    "microservice",
    "microservice1",
    `${SCOPE}/microservice1`,
  );
  const config = consumer("common", "config", `${SCOPE}/config`);
  const dashboard = consumer("spa", "dashboard", `${SCOPE}/dashboard`);
  const packages = [microservice1, config, dashboard];
  const discovery = discoveryOf(packages);

  /** Run the check over a single synthesized file, with no decoy resolve/comment lines. */
  function check(file: string, specifiers: readonly string[]): readonly string[] {
    return checkImportDiscipline(discovery, [file], () =>
      renderSource(specifiers),
    );
  }

  it("names a Spa_Package imported by a Microservice_Package (R14.13, R14.14)", () => {
    const file = `${microservice1.packageDir}/src/index.ts`;
    expect(check(file, [dashboard.name])).toEqual([
      `${SPA_PREFIX} "${file}" imports "${dashboard.name}", a Spa_Package; a Spa_Package exposes no importable API`,
    ]);
  });

  it("names a Spa_Package imported by a Common_Package (R14.13)", () => {
    const file = `${config.packageDir}/src/index.ts`;
    expect(check(file, [dashboard.name])).toEqual([
      `${SPA_PREFIX} "${file}" imports "${dashboard.name}", a Spa_Package; a Spa_Package exposes no importable API`,
    ]);
  });

  it("names a Spa_Package imported by a Framework_Singleton (R14.13)", () => {
    const file = "packages/contracts/src/index.ts";
    expect(check(file, [`${dashboard.name}/dist/widget.js`])).toEqual([
      `${SPA_PREFIX} "${file}" imports "${dashboard.name}/dist/widget.js", a Spa_Package; a Spa_Package exposes no importable API`,
    ]);
  });

  it("does not report a Spa_Package name that is only a substring of a longer specifier", () => {
    const file = `${microservice1.packageDir}/src/index.ts`;
    expect(check(file, [`${dashboard.name}-extra`])).toEqual([]);
  });

  it("does not report a Spa_Package name passed to import.meta.resolve", () => {
    const file = `${microservice1.packageDir}/src/index.ts`;
    const source = [
      `const url = import.meta.resolve("${dashboard.name}");`,
      `import { thing } from "./thing.js";`,
      "",
    ].join("\n");
    expect(checkImportDiscipline(discovery, [file], () => source)).toEqual([]);
  });

  it("accepts legal by-name imports (Common_Package, Framework_Singleton, third-party)", () => {
    const file = `${microservice1.packageDir}/src/index.ts`;
    expect(
      check(file, [config.name, CONTRACTS_NAME, BUILD_TOOLS_NAME, "express"]),
    ).toEqual([]);
  });
});

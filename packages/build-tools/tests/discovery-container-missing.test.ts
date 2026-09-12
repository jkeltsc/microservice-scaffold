// Feature: package-categories — the absent-microservices-container case (design
// "Example and unit tests": «Absent microservices container — one case asserting
// `[discovery:container-missing]`»).
//
// R2.7 is a single, sharp statement: when `packages/microservices/` is absent
// from the filesystem, discovery fails with an error naming that directory and
// returns no discovery result for any Consumer_Category — "preserving the
// current handling rather than yielding an empty set". There is no input space
// worth quantifying over here, so this is an example test; the quantified
// version of the surrounding behaviour (each container independently absent,
// empty, or populated) is Property 4 in `discovery.containers.property.test.ts`,
// which pins the failure *prefix* and the directory it mentions.
//
// What this file adds on top of that property:
//
//   1. The message is pinned **verbatim**, as a hand-written literal, so a
//      reworded failure is caught rather than silently accepted by a
//      `startsWith` check. The literal is separately tied back to
//      `NAMESPACE_CONTAINER` so the two cannot drift apart unnoticed.
//   2. "No discovery result for any category" is asserted as *nothing came
//      back and nothing was half-built*: the call site's binding is never
//      assigned, and not one discovered package's manifest was read — even
//      though the `common` and `spa` containers of this layout are populated
//      and readable. Discovery does not partially classify the categories whose
//      containers do exist.
//   3. The contrast R2.7 turns on is stated in one place: the *same* layout with
//      `packages/microservices/` present but holding zero qualifying entries
//      succeeds and yields the empty set. Absent and empty are different
//      outcomes, which is the whole point of exempting this one container from
//      the tolerance `common` and `spa` enjoy.
//
// Method: the layout is fixed and in-memory, injected through the two readers
// `discoverPackagesFrom` takes. An absent container is exactly what the lister
// reporting `undefined` means, so no filesystem is involved and the case is not
// approximated.
//
// Validates: Requirements 2.7

import { describe, expect, it } from "vitest";

import {
  discoverPackagesFrom,
  type ContainerEntry,
  type ListContainer,
  type PackageManifest,
  type ReadManifest,
} from "../src/discovery.js";
import { CONSUMER_CATEGORIES, NAMESPACE_CONTAINER } from "../src/framework.js";

/**
 * The failure R2.7 requires, spelled out as a literal rather than composed from
 * the module under test: the message is the contract, and composing it here
 * would let a reworded message pass by rewording the expectation with it.
 */
const EXPECTED_MESSAGE =
  '[discovery:container-missing] no such Microservice_Namespace: "packages/microservices"';

/** A Common_Package manifest that satisfies its category's contract (R4.1). */
const COMMON_MANIFEST: PackageManifest = {
  name: "@microservices/config",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
};

/** A Spa_Package manifest that satisfies its category's contract (R4.3). */
const SPA_MANIFEST: PackageManifest = {
  name: "@microservices/dashboard",
  scripts: { build: "vite build" },
};

/**
 * The manifests of the layout below, keyed by repo-relative package directory.
 * Both are valid, so the only thing that can fail a run over this layout is the
 * missing container itself.
 */
const MANIFESTS: ReadonlyMap<string, PackageManifest> = new Map([
  [`${NAMESPACE_CONTAINER.common}/config`, COMMON_MANIFEST],
  [`${NAMESPACE_CONTAINER.spa}/dashboard`, SPA_MANIFEST],
]);

/**
 * Readers over one fixed layout: `common` and `spa` populated and readable,
 * `packages/microservices/` in the state the `microservices` parameter names.
 * `undefined` from the lister is what "the container directory is absent" means;
 * an empty entry list is "present and holds zero qualifying entries".
 *
 * Every manifest the reader is asked for is recorded, so a test can assert that
 * a failed run read none of them.
 */
function readersFor(microservices: "absent" | "present-empty"): {
  readonly listContainer: ListContainer;
  readonly readManifest: ReadManifest;
  readonly manifestsRead: string[];
} {
  const entriesByDir = new Map<string, readonly ContainerEntry[] | undefined>([
    [
      NAMESPACE_CONTAINER.microservice,
      microservices === "absent" ? undefined : [],
    ],
    [NAMESPACE_CONTAINER.common, [{ name: "config", isDirectory: true }]],
    [NAMESPACE_CONTAINER.spa, [{ name: "dashboard", isDirectory: true }]],
  ]);

  const manifestsRead: string[] = [];
  return {
    listContainer: (containerDir) => entriesByDir.get(containerDir),
    readManifest: (packageDir) => {
      manifestsRead.push(packageDir);
      const manifest = MANIFESTS.get(packageDir);
      return manifest === undefined
        ? { kind: "absent" }
        : { kind: "ok", manifest };
    },
    manifestsRead,
  };
}

describe("discovery with packages/microservices absent (R2.7)", () => {
  it("fails with the [discovery:container-missing] message naming that directory", () => {
    const { listContainer, readManifest } = readersFor("absent");

    expect(() => discoverPackagesFrom(listContainer, readManifest)).toThrow(
      new Error(EXPECTED_MESSAGE),
    );
  });

  it("names the Namespace_Container the framework constants declare, and no other container", () => {
    const { listContainer, readManifest } = readersFor("absent");

    let message = "";
    try {
      discoverPackagesFrom(listContainer, readManifest);
    } catch (caught) {
      message = (caught as Error).message;
    }

    // Ties the hand-written literal above to the single declaration site, so a
    // renamed container directory cannot leave this file quietly asserting the
    // old path.
    expect(message).toContain(`"${NAMESPACE_CONTAINER.microservice}"`);
    // A message naming a tolerated container would send a reader after a
    // directory that is allowed to be absent.
    expect(message).not.toContain(NAMESPACE_CONTAINER.common);
    expect(message).not.toContain(NAMESPACE_CONTAINER.spa);
  });

  it("returns no discovery result for any category and reads no discovered manifest", () => {
    const { listContainer, readManifest, manifestsRead } = readersFor("absent");

    let discovery: unknown = undefined;
    let thrown: unknown = undefined;
    try {
      discovery = discoverPackagesFrom(listContainer, readManifest);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Nothing came back: no `byCategory`, so no category — not even the two
    // whose containers are present and populated — has a discovered set.
    expect(discovery).toBeUndefined();
    // And nothing was half-built on the way out: the populated `common` and
    // `spa` members were never even read.
    expect(manifestsRead).toEqual([]);
  });
});

describe("discovery with packages/microservices present but empty (R2.7 contrast)", () => {
  it("succeeds and yields the empty set, which absence does not", () => {
    const { listContainer, readManifest } = readersFor("present-empty");

    const discovery = discoverPackagesFrom(listContainer, readManifest);

    // Present-and-empty is the tolerated state: every category has an entry,
    // `microservice`'s being empty. Absence, asserted above, is not tolerated —
    // that difference is what R2.7 preserves.
    expect(Object.keys(discovery.byCategory).sort()).toEqual(
      [...CONSUMER_CATEGORIES].sort(),
    );
    expect(discovery.byCategory.microservice).toEqual([]);
    expect(discovery.byCategory.common.map((pkg) => pkg.packageDir)).toEqual([
      `${NAMESPACE_CONTAINER.common}/config`,
    ]);
    expect(discovery.byCategory.spa.map((pkg) => pkg.packageDir)).toEqual([
      `${NAMESPACE_CONTAINER.spa}/dashboard`,
    ]);
  });
});

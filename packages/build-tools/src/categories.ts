// Leaf module: the primitives shared by framework.ts and project-config.ts,
// declared where neither can import the other's initialised values.
//
// framework.ts and project-config.ts each need three things the other used to
// own: the Consumer_Category type, the fixed list of categories, and the four
// Framework_Singleton directory names. Left in framework.ts, they forced
// project-config.ts to import framework.ts; but framework.ts's transitional
// shims (WORKSPACE_SCOPE, NAMESPACE_CONTAINER, and the four `singleton()` calls)
// read project-config.ts's SCOPE_DEFAULT and ROOT_DEFAULTS at their own top
// level. That is a value dependency at module-initialisation time in the
// framework.ts -> project-config.ts direction, so whenever project-config.ts (or
// a test importing it) is entered first, framework.ts's top-level shims observed
// ROOT_DEFAULTS/SCOPE_DEFAULT in their temporal dead zone and read `undefined`.
//
// This module carries no dependency on either of them, so nothing here can
// participate in that cycle. framework.ts and project-config.ts both import it;
// project-config.ts no longer imports framework.ts at all, so the only remaining
// edge, framework.ts -> project-config.ts, is one-directional and safe.
//
// The framework directory *records* (FrameworkDirectory / FrameworkSingleton and
// their staging classification) stay in framework.ts; only the bare directory
// names live here, because both modules need those names without needing the
// records.

/** The kind of package a user of the template writes. */
export type ConsumerCategory = "microservice" | "common" | "spa";

/** Every Consumer_Category, in a fixed order, for exhaustive iteration. */
export const CONSUMER_CATEGORIES: readonly ConsumerCategory[] = [
  "microservice",
  "common",
  "spa",
];

/** The directory every workspace package lives under, repo-relative. */
export const PACKAGES_DIR = "packages";

/** The four Framework_Singleton directory names under `packages/`, in fixed
 *  order. framework.ts builds its scope-free FrameworkDirectory records from
 *  these; project-config.ts derives the `[config:root-framework]` comparison
 *  directories from them. The single source of the four directory names. */
export const FRAMEWORK_DIR_NAMES: readonly string[] = [
  "contracts",
  "overseer",
  "build-tools",
  "integration-tests",
];

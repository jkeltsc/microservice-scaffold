import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Spa_Root: the `dist/` directory of the resolved `@microservices/demo`
 * package.
 *
 * Obtained through a run-time module-resolution call whose sole argument is the
 * bare package name `@microservices/demo` (R7.4). There is no static import, no
 * dynamic import, and no relative path leaving this package — which is also what
 * keeps `check:invariants` silent: its import-discipline scanner matches
 * `from "…"`, `import "…"`, and `import("…")`, and neither `import.meta.resolve("…")`
 * nor `require.resolve("…")` is any of those, so the call is deliberately not
 * reported. Its "a Tsc_Project must not name a Spa_Package" rule would otherwise
 * reject a static or dynamic import of `@microservices/demo`, because
 * Microservice1 is a Tsc_Project and `@microservices/demo` is a Spa_Package.
 *
 * This is the CONSUMER half of pair A of the two Spa_Resolution_Pairs (R7.15);
 * the demo package declares the matching MANIFEST half,
 * `"exports": { ".": "./dist/index.html" }`. Resolution does not stat an
 * `exports` target, so it succeeds and points at `<demo>/dist/index.html`
 * whether or not the bundle has been built; `dirname` of that path is
 * `<demo>/dist`, the Spa_Root. The other pair — resolving
 * `@microservices/demo/package.json` against a manifest declaring no `exports` —
 * is equally permitted by the framework, but the two halves cannot be mixed.
 *
 * WHY TWO RESOLUTION MECHANISMS. The native ESM form `import.meta.resolve`
 * (Node 22+, synchronous, returns a `file://` URL) is what production, `npm
 * start`, and the dev server run under. But a test runner that transforms this
 * module into its own SSR module system (Vitest) does not provide
 * `import.meta.resolve` — there it is `undefined` — so calling it would throw at
 * module init and take down every integration suite that composes the real
 * Microservice1 router. `createRequire(import.meta.url).resolve(...)` is the
 * equivalent resolution under CommonJS-style resolution: it honours the same
 * `exports` map, does not stat the target, and returns the identical
 * `<demo>/dist/index.html` path. Both are resolution-only (they return a path
 * and import nothing), so both keep the no-import discipline intact; we prefer
 * the native form and fall back to `createRequire` only when the runtime does
 * not expose it.
 *
 * The same resolution works in both deployment layouts:
 * - In the workspace the resolved string may be the realpath (when `dist/`
 *   exists) or the symlinked path (when it does not), and both read the same
 *   files because the intervening `node_modules/@microservices/demo` link is a
 *   DIRECTORY link — a read through it reaches `packages/spa/demo/…` unchanged.
 * - In an image the walk lands on the real staged directory at
 *   `node_modules/@microservices/demo/dist`.
 */
export function resolveSpaRoot(): string {
  // `import.meta.resolve` is the native ESM resolver (Node 22+). A test runner
  // that rewrites this module into its own module system may not expose it, in
  // which case it is `undefined`; fall back to `createRequire(...).resolve`,
  // which resolves the same `exports` target to the same path. Neither form
  // imports the package — both only resolve its specifier to a path.
  const metaResolve = (
    import.meta as ImportMeta & {
      resolve?: (specifier: string) => string;
    }
  ).resolve;

  const resolved =
    typeof metaResolve === "function"
      ? fileURLToPath(metaResolve("@microservices/demo"))
      : createRequire(import.meta.url).resolve("@microservices/demo");

  return dirname(resolved);
}

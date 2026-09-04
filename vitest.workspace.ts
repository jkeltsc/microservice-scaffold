import { defineWorkspace } from 'vitest/config';
import { sharedTest } from './vitest.shared.js';

// Root Vitest workspace configuration.
//
// Each glob below is a standalone npm workspace that owns its own test suite
// (per the repository structure conventions). Listing them as inline project
// configs lets us apply the shared `test` options -- most importantly the
// `fast-check` setup file that pins `numRuns: 100` -- to every project without
// duplicating a config file in each package.
//
// CI and the `test` npm scripts invoke Vitest in non-watch mode with
// `vitest --run`, which this workspace layout supports directly.
export default defineWorkspace([
  {
    test: {
      ...sharedTest,
      name: 'contracts',
      root: './packages/contracts',
    },
  },
  {
    test: {
      ...sharedTest,
      name: 'build-tools',
      root: './packages/build-tools',
    },
  },
  {
    test: {
      ...sharedTest,
      name: 'overseer',
      root: './packages/overseer',
    },
  },
  {
    test: {
      ...sharedTest,
      name: 'integration-tests',
      root: './packages/integration-tests',
      // Some integration suites (tasks 12.5, 12.6) spawn the Overseer as a
      // child process, bind a real TCP port, and regenerate the shared
      // generated registry + rebuild via tsc. Running the integration test
      // files sequentially in a single worker avoids port conflicts and races
      // over the shared `packages/overseer/src/generated/microservice-registry.ts` file.
      //
      // `fileParallelism` is a ROOT-only option: Vitest reads it from the root
      // config, so setting it here was silently ignored and these files still
      // ran concurrently (observed: start-parity's microservice1 registry being
      // overwritten with "*" by toggle-abort's beforeAll mid-build). The
      // per-project options Vitest does honor are
      // `poolOptions.forks.singleFork` / `poolOptions.threads.singleThread`,
      // which run this project's files one at a time in a single worker. Both
      // pools are covered so the guarantee survives a change of `pool`.
      poolOptions: {
        forks: { singleFork: true },
        threads: { singleThread: true },
      },
    },
  },
  {
    test: {
      ...sharedTest,
      name: 'microservices',
      root: './packages/microservices',
      // Every microservice subdirectory owns its own tests.
      include: [
        '*/tests/**/*.{test,property.test}.ts',
        '*/src/**/*.{test,property.test}.ts',
      ],
    },
  },
]);

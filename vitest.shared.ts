import { fileURLToPath } from 'node:url';
import type { UserWorkspaceConfig } from 'vitest/config';

// Absolute path to the shared setup file so every workspace project resolves it
// the same way regardless of that project's own directory.
const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url));

/**
 * Test options shared by every package in the monorepo. Spread this into each
 * workspace project's `test` block so `fast-check`'s global `numRuns: 100`
 * default (configured in `vitest.setup.ts`) is applied consistently everywhere.
 */
export const sharedTest: UserWorkspaceConfig['test'] = {
  environment: 'node',
  globals: true,
  setupFiles: [setupFile],
  include: ['tests/**/*.{test,property.test}.ts', 'src/**/*.{test,property.test}.ts'],
};

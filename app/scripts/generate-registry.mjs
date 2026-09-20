// The Registry_Generation_Step of this package's own `build` and `typecheck`
// scripts (R5.4): generate the Generated_Registry, then let the `&&` chain reach
// the compiler.
//
// Consumer-owned committed source, like the Entry_Module itself, and deliberately
// dependency-free: it imports nothing beyond `node:fs` and `node:child_process`,
// so it runs on a clone where nothing has been installed and nothing has been
// compiled. That is the point. The Build_System's own registry-presence guard
// cannot report the condition this shim reports, because that guard IS
// Build_System compiled output — if `packages/build-tools/dist/` is absent, the
// guard's bin cannot run and npm reports its own ENOENT instead of naming the
// command that fixes it.
//
// So, in order: verify the Build_System's compiled entry point exists and, when
// it does not, write exactly one diagnostic naming that absent path and the
// repository-root command that produces it, invoke no compiler, write no
// registry, and exit non-zero (R5.9); otherwise spawn the generator and exit on
// its status, so a failed generation stops the chain ahead of the compiler.
//
// Paths are derived from this file's own location rather than from the working
// directory, and the generator is spawned with the Project_Directory as its cwd,
// because the generator resolves the Project_Config_File and every path it
// reports against its cwd.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const projectDirectory = `${import.meta.dirname}/../..`;
const generatorRelativePath =
  "packages/build-tools/dist/bin/generate-registry.js";
const generatorPath = `${projectDirectory}/${generatorRelativePath}`;

if (!existsSync(generatorPath)) {
  process.stderr.write(
    `[entry] cannot generate the microservice registry: the build tools are not compiled — ${generatorRelativePath} is absent. Run \`npm run build\` in the repository root first.\n`,
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [generatorPath], {
  cwd: projectDirectory,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(
    `[entry] failed to run the registry generator: ${result.error.message}\n`,
  );
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);

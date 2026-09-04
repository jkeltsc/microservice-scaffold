// ESLint 9 flat configuration for the Microservice Scaffold monorepo.
//
// Format choice: this repo pins ESLint 9 (see root package.json). ESLint 9
// uses the "flat config" format (eslint.config.js) as its default and
// idiomatic form; the legacy `.eslintrc.*` format is deprecated. Because the
// tech steering mandates ES modules only (no CommonJS) and the root package is
// `"type": "module"`, this file is an ES module rather than a `.cjs` file.
//
// Prettier owns formatting; ESLint owns correctness. `eslint-config-prettier`
// is placed last so it disables any stylistic rules that would conflict with
// Prettier.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // Ignore build output, dependencies, and generated code.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/overseer/src/generated/**",
    ],
  },

  // Base recommended rules for all JS/TS files.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide correctness rules.
  {
    rules: {
      // Forbid CommonJS in source: ES modules only per tech steering.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='require']",
          message: "CommonJS require() is forbidden; use ES module imports.",
        },
        {
          selector:
            "MemberExpression[object.name='module'][property.name='exports']",
          message:
            "CommonJS module.exports is forbidden; use ES module exports.",
        },
        {
          selector: "MemberExpression[object.name='exports']",
          message: "CommonJS exports.* is forbidden; use ES module exports.",
        },
      ],
      "@typescript-eslint/no-require-imports": "error",
    },
  },

  // Node runtime scripts (plain JS at the repo root, e.g. scripts/start.js)
  // execute directly under Node and use Node globals such as `process`. Declare
  // the Node globals so `no-undef` recognizes them.
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Disable stylistic rules that conflict with Prettier. Must come last.
  prettier,
);

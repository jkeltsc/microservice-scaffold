import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset references: no leading "/" and no scheme, so the Demo_Page
  // keeps working if Microservice1 is later mounted somewhere other than "/"
  // (R6.7).
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  // No `test` block on purpose: Vitest's default `node` environment stays in
  // force for this package's suite (R11.3).
});

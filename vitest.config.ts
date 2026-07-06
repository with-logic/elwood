/**
 * Vitest configuration for npm-based unit and conformance tests.
 * Implements PRD §12 default coverage requirements.
 */

import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: Vitest config files use default exports.
export default defineConfig({
  test: {
    coverage: {
      all: false,
      exclude: ["tests/**"],
      provider: "istanbul",
      reporter: ["text", "lcov"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
    exclude: ["tests/e2e/**", "node_modules/**"],
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/helpers/preload.ts"],
  },
});

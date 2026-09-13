/**
 * Vitest configuration for npm-based unit and conformance tests.
 * Implements PRD §12 default coverage requirements.
 */

import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: Vitest config files use default exports.
export default defineConfig({
  test: {
    coverage: {
      all: true,
      // Only shipped code is gated. The developer apps under dev/ still have
      // tests and those tests still run, but they do not count toward the
      // 100% thresholds: the coverage number should describe what consumers
      // install, and dev/ is excluded from the published build.
      include: ["src/**/*.ts"],
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
    // Real-timer, PTY-driven conformance tests (e.g. the Codex model-picker flows)
    // poll for fake-PTY output; under heavy parallel-suite CPU contention the default
    // 5s ceiling can be hit before the poll settles. 15s gives headroom without
    // masking a genuine hang, which still fails fast relative to the suite runtime.
    testTimeout: 15_000,
  },
});

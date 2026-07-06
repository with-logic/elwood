/**
 * Unit tests for CJS-bundler-safe require construction.
 * Covers the consumer-reported bundler compatibility contract.
 */

import { describe, expect, test } from "vitest";
import { moduleRequire } from "../../src/core/module-require.ts";

describe("moduleRequire", () => {
  test("uses import.meta.url when the module system provides it", () => {
    const nodeRequire = moduleRequire(import.meta.url);
    expect(typeof nodeRequire.resolve("vitest")).toBe("string");
  });

  test("falls back to the CJS filename when a bundler lowered import.meta.url", () => {
    // Under vite-node, __filename exists exactly as it does in a CJS bundle.
    const nodeRequire = moduleRequire(undefined);
    expect(typeof nodeRequire.resolve("vitest")).toBe("string");
  });
});

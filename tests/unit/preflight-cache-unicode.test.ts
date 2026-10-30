/** Version-cache stream limits count UTF-16 units, not characters (PRD §9.2, C-PERF-02). */
import { beforeEach, expect, test } from "vitest";
import { cachedVersionRead, resetPreflightCacheForTests } from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(resetPreflightCacheForTests);

test.each([
  ["stdout", 32_768, 1],
  ["stdout", 32_769, 2],
  ["stderr", 32_768, 1],
  ["stderr", 32_769, 2],
] as const)("C-PERF-02 %s with %s surrogate pairs is cached only within 65,536 code units", async (stream, pairs, expectedReads) => {
  const cwd = tempDir("elwood-unicode-cache-");
  const output = "😀".repeat(pairs);
  let reads = 0;
  const read = () => {
    reads += 1;
    return Promise.resolve({ status: 0, stdout: "", stderr: "", [stream]: output });
  };
  const results = [
    await cachedVersionRead("claude", cwd, read),
    await cachedVersionRead("claude", cwd, read),
  ];
  expect(output.length).toBe(pairs * 2);
  for (const result of results) expect(result[stream]).toBe(output);
  expect(reads).toBe(expectedReads);
});

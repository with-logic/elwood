/** Read Codex resume locators only from bounded, private, validated state (C-STATE-15). */
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadCodexRolloutLocator } from "../../src/codex/session/rollout-locator.ts";
import { tempDirForUnit } from "./helpers.ts";

const nativeSessionId = "native-session";
const path = "/native/rollout.jsonl";
const locatorFile = "codex-rollout.json";
const valid = JSON.stringify({ path, nativeSessionId });

test("C-STATE-15 loads only a matching owner-only locator", () => {
  const sessionDir = tempDirForUnit();
  const locator = join(sessionDir, locatorFile);
  expect(loadCodexRolloutLocator(sessionDir, nativeSessionId)).toBeUndefined();
  writeFileSync(locator, valid, { mode: 0o600 });
  expect(loadCodexRolloutLocator(sessionDir, nativeSessionId)).toBe(path);
  expect(loadCodexRolloutLocator(sessionDir, "another-conversation")).toBeUndefined();
  chmodSync(locator, 0o644);
  expect(loadCodexRolloutLocator(sessionDir, nativeSessionId)).toBeUndefined();
});

test("C-STATE-15 ignores a symbolic link to an owner-only locator", () => {
  const sessionDir = tempDirForUnit();
  const source = join(sessionDir, "private.json");
  const locator = join(sessionDir, locatorFile);
  writeFileSync(source, valid, { mode: 0o600 });
  symlinkSync(source, locator);
  expect(loadCodexRolloutLocator(sessionDir, nativeSessionId)).toBeUndefined();
});

test.each([
  ["malformed", "{"],
  ["non-object", "null"],
  ["missing path", JSON.stringify({ nativeSessionId })],
  ["relative path", JSON.stringify({ path: "relative", nativeSessionId })],
  ["NUL in path", JSON.stringify({ path: "/native/rollout\0", nativeSessionId })],
  ["oversized path", JSON.stringify({ path: `/${"é".repeat(2048)}`, nativeSessionId })],
  ["oversized locator", valid.padEnd(32 * 1024 + 1)],
  ["oversized locator beyond the read window", valid.padEnd(32 * 1024 + 2)],
])("C-STATE-15 ignores a %s", (_case, value) => {
  const sessionDir = tempDirForUnit();
  writeFileSync(join(sessionDir, locatorFile), value, { mode: 0o600 });
  expect(loadCodexRolloutLocator(sessionDir, nativeSessionId)).toBeUndefined();
});

test("C-STATE-15 accepts a locator at the file size limit", () => {
  const sessionDir = tempDirForUnit();
  writeFileSync(join(sessionDir, locatorFile), valid.padEnd(32 * 1024), { mode: 0o600 });
  expect(loadCodexRolloutLocator(sessionDir, nativeSessionId)).toBe(path);
});

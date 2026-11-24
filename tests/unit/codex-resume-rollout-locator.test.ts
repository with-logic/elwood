/** Read Codex resume locators only from bounded, private, validated state (C-STATE-15). */
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { loadCodexRolloutPath } from "../../src/state/codex-rollout.ts";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { tempDirForUnit } from "./helpers.ts";

const nativeSessionId = "native-session";
const path = "/native/rollout.jsonl";
const locatorFile = "codex-rollout.json";
const valid = JSON.stringify({ path, nativeSessionId });

function readForLaunch(sessionDir: string) {
  const ownership = reserveLaunchOwnership(sessionDir);
  onTestFinished(() => ownership.release());
  return (id = nativeSessionId) => loadCodexRolloutPath(sessionDir, id, ownership.readFile);
}

const unusable = expect.objectContaining({
  code: "state_corrupt",
  message: "Invalid private Codex rollout locator.",
});

test("C-STATE-15 loads only a matching owner-only locator", () => {
  const sessionDir = tempDirForUnit();
  const locator = join(sessionDir, locatorFile);
  const read = readForLaunch(sessionDir);
  expect(read()).toBeUndefined();
  writeFileSync(locator, valid, { mode: 0o600 });
  expect(read()).toBe(path);
  expect(() => read("another-conversation")).toThrowError(unusable);
  chmodSync(locator, 0o644);
  expect(read).toThrowError(unusable);
});

test("C-STATE-15 rejects a symbolic link to an owner-only locator", () => {
  const sessionDir = tempDirForUnit();
  const source = join(sessionDir, "private.json");
  const locator = join(sessionDir, locatorFile);
  writeFileSync(source, valid, { mode: 0o600 });
  symlinkSync(source, locator);
  expect(readForLaunch(sessionDir)).toThrowError(unusable);
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
])("C-STATE-15 rejects a %s", (_case, value) => {
  const sessionDir = tempDirForUnit();
  writeFileSync(join(sessionDir, locatorFile), value, { mode: 0o600 });
  expect(readForLaunch(sessionDir)).toThrowError(unusable);
});

test("C-STATE-15 accepts a locator at the file size limit", () => {
  const sessionDir = tempDirForUnit();
  writeFileSync(join(sessionDir, locatorFile), valid.padEnd(32 * 1024), { mode: 0o600 });
  expect(readForLaunch(sessionDir)()).toBe(path);
});

test("C-STATE-15 never reads a same-ID locator from a replacement launch directory", () => {
  const root = tempDirForUnit();
  const sessionDir = join(root, "session");
  const moved = join(root, "moved");
  mkdirSync(sessionDir, { mode: 0o700 });
  writeFileSync(join(sessionDir, locatorFile), valid, { mode: 0o600 });
  const ownership = reserveLaunchOwnership(sessionDir);
  ownership.publishFile(join(sessionDir, "session.json"), "published");
  try {
    renameSync(sessionDir, moved);
    mkdirSync(sessionDir, { mode: 0o700 });
    writeFileSync(
      join(sessionDir, locatorFile),
      JSON.stringify({ nativeSessionId, path: "/replacement/rollout.jsonl" }),
      { mode: 0o600 },
    );
    const read = () => loadCodexRolloutPath(sessionDir, nativeSessionId, ownership.readFile);
    if (process.platform === "darwin") expect(read()).toBe(path);
    else expect(read).toThrowError(unusable);
  } finally {
    ownership.release();
  }
});

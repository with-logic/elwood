/** Validate and defer authenticated Codex rollout locator writes (C-STATE-15). */
import { expect, test, vi } from "vitest";
import { bindCodexRolloutLocator } from "../../src/codex/session/rollout-locator.ts";
import type { StateFileWriter } from "../../src/state/launch-ownership.ts";

const sessionDir = "/session";
const elwoodSessionId = "elwood-session";
const nativeSessionId = "conversation";

test.each([
  ["missing", undefined],
  ["wrong type", 123],
  ["relative", "relative"],
  ["NUL", "/native/rollout\0.jsonl"],
  ["over the UTF-8 byte limit", `/${"é".repeat(2048)}`],
])("C-STATE-15 ignores a %s reported locator path", (_case, path) => {
  const persistFile = vi.fn<StateFileWriter>();
  const locator = bindCodexRolloutLocator(
    { sessionDir, elwoodSessionId },
    {
      canPersist: () => true,
      persistFile,
    },
  );
  expect(locator.onLaunchCommitted()).toEqual([]);
  expect(locator.observe(nativeSessionId, path)).toEqual([]);
  expect(persistFile).not.toHaveBeenCalled();
});

test("C-STATE-15 defers only the latest valid report to commit", () => {
  const persistFile = vi.fn<StateFileWriter>();
  const locator = bindCodexRolloutLocator(
    { sessionDir, elwoodSessionId },
    {
      canPersist: () => true,
      persistFile,
    },
  );
  const path = `/${"x".repeat(4095)}`;
  expect(locator.observe(nativeSessionId, "/older")).toEqual([]);
  expect(locator.observe(nativeSessionId, path)).toEqual([]);
  expect(locator.observe(nativeSessionId, null)).toEqual([]);
  expect(locator.observe("", "/native/ignored")).toEqual([]);
  expect(persistFile).not.toHaveBeenCalled();
  expect(locator.onLaunchCommitted()).toEqual([]);
  expect(persistFile).toHaveBeenCalledExactlyOnceWith(
    "/session/codex-rollout.json",
    `${JSON.stringify({ nativeSessionId, path })}\n`,
  );
});

test("C-STATE-15 writes only locators within the UTF-8 read limit", () => {
  const persistFile = vi.fn<StateFileWriter>();
  const locator = bindCodexRolloutLocator(
    { sessionDir, elwoodSessionId },
    { canPersist: () => true, persistFile },
  );
  const path = "/native/rollout.jsonl";
  const fixedBytes = Buffer.byteLength(`${JSON.stringify({ nativeSessionId: "", path })}\n`);
  const exactId = `${"x".repeat(32 * 1024 - fixedBytes - 2)}é`;
  locator.onLaunchCommitted();
  expect(locator.observe(exactId, path)).toEqual([]);
  expect(locator.observe(`${exactId}é`, path)).toMatchObject([
    { code: "codex_rollout_locator_write_failed", elwoodSessionId },
  ]);
  expect(persistFile).toHaveBeenCalledExactlyOnceWith(
    "/session/codex-rollout.json",
    `${JSON.stringify({ nativeSessionId: exactId, path })}\n`,
  );
});

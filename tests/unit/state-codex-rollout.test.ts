/** Validate and defer authenticated Codex rollout locator writes (C-STATE-15). */
import { expect, test, vi } from "vitest";
import { bindCodexRolloutLocator } from "../../src/codex/session/rollout-locator.ts";

const sessionDir = "/session";
const elwoodSessionId = "elwood-session";
const nativeId = "conversation";

test.each([
  ["missing", undefined],
  ["wrong type", 123],
  ["relative", "relative"],
  ["NUL", "/native/rollout\0.jsonl"],
  ["over the UTF-8 byte limit", `/${"é".repeat(2048)}`],
])("C-STATE-15 ignores a %s reported locator path", (_case, path) => {
  const persistFile = vi.fn();
  const locator = bindCodexRolloutLocator(
    { sessionDir, elwoodSessionId },
    {
      canPersist: () => true,
      persistFile,
    },
  );
  expect(locator.onLaunchCommitted()).toEqual([]);
  expect(locator.observe(nativeId, path)).toEqual([]);
  expect(persistFile).not.toHaveBeenCalled();
});

test("C-STATE-15 defers only the latest valid report to commit", () => {
  const persistFile = vi.fn();
  const locator = bindCodexRolloutLocator(
    { sessionDir, elwoodSessionId },
    {
      canPersist: () => true,
      persistFile,
    },
  );
  const path = `/${"x".repeat(4095)}`;
  expect(locator.observe(nativeId, "/older")).toEqual([]);
  expect(locator.observe(nativeId, path)).toEqual([]);
  expect(locator.observe(nativeId, null)).toEqual([]);
  expect(locator.observe("", "/native/ignored")).toEqual([]);
  expect(persistFile).not.toHaveBeenCalled();
  expect(locator.onLaunchCommitted()).toEqual([]);
  expect(persistFile).toHaveBeenCalledExactlyOnceWith(
    "/session/codex-rollout.json",
    `${JSON.stringify({ nativeSessionId: nativeId, path })}\n`,
  );
});

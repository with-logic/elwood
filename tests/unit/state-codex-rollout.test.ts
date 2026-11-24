/** Scope optional Codex rollout locators to one native ID (C-STATE-15). */
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { bindCodexRolloutWriter, loadCodexRollout } from "../../src/state/codex-rollout.ts";

const directory = "/session";
const path = "/native/rollout.jsonl";
const id = "conversation";

test("C-STATE-15 reject recovered paths without exact native identity or valid shape", () => {
  for (const text of [
    undefined,
    "{",
    "[]",
    JSON.stringify({ nativeSessionId: "other", path }),
    JSON.stringify({ nativeSessionId: id, path: "relative" }),
    JSON.stringify({ nativeSessionId: id, path: `${path}\0` }),
    JSON.stringify({ nativeSessionId: id, path: `/${"x".repeat(4096)}` }),
  ]) {
    expect(loadCodexRollout(directory, id, () => text)).toBeUndefined();
  }
});

test("C-STATE-15 invalid paths and repeat observations do not rewrite the locator", () => {
  const persistFile = vi.fn();
  const readFile = vi.fn(() => JSON.stringify({ nativeSessionId: id, path }));
  const remember = bindCodexRolloutWriter(directory, { readFile, persistFile });
  remember(id, null);
  remember(id, path);
  expect(readFile).toHaveBeenCalledExactlyOnceWith(join(directory, "codex-rollout.json"));
  expect(persistFile).not.toHaveBeenCalled();
  remember(id, "/native/replacement.jsonl");
  expect(persistFile).toHaveBeenCalledOnce();
});

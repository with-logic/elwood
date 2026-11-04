/** No-attempt outcomes remain retryable and preserve unaffected caches (C-LIFE-09/11, C-PERF-02). */
import { beforeEach, expect, test, vi } from "vitest";
import { preflightClaude } from "../../src/claude/preflight.ts";
import {
  detectCodexCliCapabilities,
  preflightCodex,
  resetCodexPreflightCacheForTests,
} from "../../src/codex/preflight.ts";
import { elwoodError } from "../../src/core/errors.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  cachedAutoupdate,
  cachedVersionRead,
  resetAutoupdateForTests,
  resetPreflightCacheForTests,
  setUpdateCoordinatorForTests,
} from "../../src/runtime/update/once.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => {
  setPlatformForTests("darwin");
  resetAutoupdateForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
});

test.each([
  "verification",
  "coordinator",
])("C-PERF-02 %s NoAttempt preserves version and capability caches", async (kind) => {
  const directory = { cwd: tempDir("elwood-noattempt-cache-") };
  const version = vi.fn(async () => ({ status: 0, stdout: "codex-cli 0.150.0", stderr: "" }));
  const help = vi.fn(() => ({ status: 0, stdout: "--dangerously-bypass-hook-trust", stderr: "" }));
  setCommandRunnerForTests(help);
  await cachedVersionRead("codex", version, directory);
  await detectCodexCliCapabilities(directory);
  let coordinated = 0;
  setUpdateCoordinatorForTests((_adapter, update) => {
    if (++coordinated === 1 && kind === "coordinator") return Promise.resolve({ started: false });
    return update();
  });
  const invalidated = vi.fn(() => resetCodexPreflightCacheForTests());
  const update = vi.fn(async () => {});
  const verify = vi.fn(() => Promise.reject(undefined));
  expect(await cachedAutoupdate("codex", { verify, update }, invalidated)).toEqual({
    ok: false,
    error: undefined,
    notStarted: true,
  });
  expect(update).not.toHaveBeenCalled();
  expect(invalidated).not.toHaveBeenCalled();
  await cachedVersionRead("codex", version, directory);
  await detectCodexCliCapabilities(directory);
  expect(version).toHaveBeenCalledTimes(1);
  expect(help).toHaveBeenCalledTimes(1);
  expect(
    await cachedAutoupdate("codex", { verify: async () => false, update }, invalidated),
  ).toEqual({ ok: true });
  expect(update).toHaveBeenCalledTimes(1);
  expect(invalidated).toHaveBeenCalledTimes(1);
  await cachedVersionRead("codex", version, directory);
  await detectCodexCliCapabilities(directory);
  expect(version).toHaveBeenCalledTimes(2);
  expect(help).toHaveBeenCalledTimes(2);
});

test.each([
  "active_owner",
  "cleanup_pending",
])("C-LIFE-09 %s before callback is retryable after recovery", async (updateReason) => {
  const error = elwoodError("codex_update_failed", "update skipped", { updateReason });
  let coordinated = 0;
  setUpdateCoordinatorForTests((_adapter, update) =>
    ++coordinated === 1 ? Promise.reject(error) : update(),
  );
  const verify = vi.fn(async () => true);
  const update = vi.fn(async () => {});
  const invalidate = vi.fn();
  expect(await cachedAutoupdate("codex", { verify, update }, invalidate)).toEqual({
    ok: false,
    error,
    notStarted: true,
  });
  expect(verify).not.toHaveBeenCalled();
  // An observed peer may have changed the shared binary despite no local invocation.
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(await cachedAutoupdate("codex", { verify, update }, invalidate)).toEqual({ ok: true });
  expect(await cachedAutoupdate("codex", { verify, update }, invalidate)).toEqual({ ok: true });
  expect(coordinated).toBe(2);
  expect(update).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledTimes(2);
});

test("C-LIFE-09 unknown coordination rejection stays conservative while confirmed peer completion is reusable", async () => {
  const failure = new Error("attempt unknown");
  const coordinate = vi.fn(() => Promise.reject(failure));
  setUpdateCoordinatorForTests(coordinate);
  const steps = { verify: async () => true, update: async () => {} };
  expect(await cachedAutoupdate("codex", steps)).toEqual({ ok: false, error: failure });
  expect(await cachedAutoupdate("codex", steps)).toEqual({ ok: false, error: failure });
  expect(coordinate).toHaveBeenCalledTimes(1);
  resetAutoupdateForTests();
  const peer = vi.fn(async () => {});
  setUpdateCoordinatorForTests(peer);
  expect(await cachedAutoupdate("codex", steps)).toEqual({ ok: true });
  expect(await cachedAutoupdate("codex", steps)).toEqual({ ok: true });
  expect(peer).toHaveBeenCalledTimes(1);
});

for (const [agent, version, preflight] of [
  ["claude", "2.1.144", preflightClaude],
  ["codex", "codex-cli 0.150.0", preflightCodex],
] as const) {
  test(`C-LIFE-11 ${agent} an updater rejecting undefined still warns and is shared`, async () => {
    setUpdateCoordinatorForTests((_adapter, update) => update());
    let updates = 0;
    setCommandRunnerForTests((_shell, args) => {
      if (args.join(" ").includes(`${agent} update`)) {
        updates++;
        return Promise.reject(undefined);
      }
      return { status: 0, stdout: version, stderr: "" };
    });
    expect(await preflight(false, true)).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_failed",
    });
    expect(await preflight(false, true)).toMatchObject({
      code: "agent_update_failed",
      errorCode: "update_failed",
    });
    expect(updates).toBe(1);
  });
}

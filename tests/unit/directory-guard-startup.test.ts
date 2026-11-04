/** Directory refusal evidence is bounded and independent of terminal rendering (C-API-61). */
import { afterEach, expect, test, vi } from "vitest";
import { directoryGuardStopMarker } from "../../src/core/directory-guard.ts";
import type { CheckedLaunchDirectory } from "../../src/runtime/session/launch-directory.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../src/runtime/startup/buffer.ts";
import {
  resetStartupWaitMsForTests,
  setStartupWaitMsForTests,
} from "../../src/runtime/startup/index.ts";

const directory: CheckedLaunchDirectory = {
  agent: "claude",
  cwd: "/checked",
  identity: { dev: 1n, ino: 2n },
};
afterEach(() => {
  vi.useRealTimers();
  resetStartupWaitMsForTests();
});
function check(exitCode = 96) {
  vi.useFakeTimers();
  setStartupWaitMsForTests(0);
  const buffer = createStartupBuffer({ directory, capBytes: 8, watchStopMarker: false });
  const result = assertStartupThenRelease("claude", buffer, () => ({ exitCode })).catch(
    (error: unknown) => error,
  );
  return { buffer, result };
}
const refusal = {
  code: "claude_start_failed",
  message:
    "claude did not start: the launch directory failed verification. Keep the workspace available and unchanged, then retry.",
  details: { cwd: "/checked", exitCode: 96 },
};
test("C-API-61 a split marker past the output cap identifies the refusal and is released", async () => {
  const { buffer, result } = check();
  const observation = buffer.directoryGuard;
  buffer.push("profile output past cap");
  buffer.push(directoryGuardStopMarker.slice(0, 17));
  expect(observation?.sawMarker()).toBe(false);
  buffer.push(directoryGuardStopMarker.slice(17));
  expect(observation?.sawMarker()).toBe(true);
  expect(buffer.read()).toBe("profile ");
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject(refusal);
  expect(observation?.sawMarker()).toBe(false);
  buffer.push(directoryGuardStopMarker);
  expect(observation?.sawMarker()).toBe(false);
});
test("C-API-61 a marker arriving after exit within the existing grace identifies the refusal", async () => {
  const { buffer, result } = check();
  setTimeout(() => buffer.push(directoryGuardStopMarker), 990);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toMatchObject(refusal);
});
test("C-API-61 status96 without its private marker remains an ordinary agent exit", async () => {
  const { buffer, result } = check();
  buffer.push("elwood-directory-guard-wrong-token");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await result).toMatchObject({
    message: "claude exited during startup.",
    details: { exitCode: 96 },
  });
  expect(await result).not.toHaveProperty("details.cwd");
});
test("C-API-61 a marker arriving beyond the existing grace remains an ordinary exit", async () => {
  const { buffer, result } = check();
  setTimeout(() => buffer.push(directoryGuardStopMarker), 1_010);
  await vi.advanceTimersByTimeAsync(1_020);
  expect(await result).toMatchObject({ message: "claude exited during startup." });
});
test("C-API-61 a matching marker with another exit status remains an ordinary exit", async () => {
  const { buffer, result } = check(1);
  buffer.push(directoryGuardStopMarker);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({
    message: "claude exited during startup.",
    details: { exitCode: 1 },
  });
});
test("C-API-61 an unchecked directory allocates no directory-marker watcher", () => {
  const buffer = createStartupBuffer({ directory: { ...directory, identity: undefined } });
  expect(buffer.directoryGuard).toBeUndefined();
  buffer.release();
});

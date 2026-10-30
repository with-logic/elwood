/** Graceful termination cannot discard an observed exit or failed survivor cleanup (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { terminatePty } from "../../src/runtime/shutdown/terminate.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

const pty = (kill: (signal?: string) => void) => ({
  pid: LEADER,
  onData: () => () => {},
  onExit: () => () => {},
  write: () => {},
  resize: () => "resized" as const,
  kill,
});
afterEach(() => vi.useRealTimers());

test("C-LIFE-10 a first read without the leader sends no PTY signal before its exit callback", async () => {
  const { ops } = scripted([[]]);
  const signal = vi.fn();
  await expect(
    terminatePty(pty(signal), "SIGTERM", new SessionReaper(LEADER, ops), {
      gracefulMs: 0,
      forceMs: 0,
    }),
  ).resolves.toBeUndefined();
  expect(signal).not.toHaveBeenCalled();
});

test("C-LIFE-10 throwing SIGTERM keeps a recorded detached child's failure sticky", async () => {
  vi.useFakeTimers();
  const tree = [leaderRow, hook(5002)];
  const fake = scripted([tree], {
    stopGroup: () => {
      throw errno("EPERM");
    },
  });
  const reaper = new SessionReaper(LEADER, fake.ops);
  const signal = () => {
    throw new Error("TERM failed");
  };
  await expect(terminatePty(pty(signal), "SIGTERM", reaper)).rejects.toMatchObject({
    code: "termination_failed",
    details: {
      cause: "TERM failed",
      sweepError: expect.stringContaining("leader's exit was not confirmed"),
    },
  });
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow(
    "leader's exit was not confirmed",
  );
});

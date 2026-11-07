/** Retained confirmation never renews numeric leader signaling (C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  hook,
  LEADER,
  leaderNeverExits,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([
  "expired confirmation",
  "completed background recovery",
] as const)("C-LIFE-14 %s cannot reap a replacement leader group after the original KILL failed", async (phase) => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([]);
  const background = Promise.withResolvers<readonly ProcessEntry[]>();
  const confirmation = Promise.withResolvers<readonly ProcessEntry[]>();
  let confirming = false;
  let confirmationReads = 0;
  let replacementAlive = false;
  let replacementSignals = 0;
  const rootFailure = errno("EIO");
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () => {
      if (confirming) {
        confirmationReads += 1;
        return confirmation.promise;
      }
      return Promise.resolve(fake.asRead([leaderRow, hook(5002)]));
    },
    listProcessesUnreferenced: () => background.promise,
    killGroup: (group) => {
      if (group === LEADER && replacementAlive) {
        replacementSignals += 1;
        return;
      }
      throw group === LEADER ? rootFailure : errno("EIO");
    },
  });
  await expect(reaper.sweepDetached(leaderNeverExits)).rejects.toThrow("could not kill");
  expect(() => reaper.reap()).toThrow("raw EIO detail");
  if (phase === "expired confirmation") {
    clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
    confirming = true;
    const pending = Promise.resolve().then(() => reaper.reapAndThrowOnDetachedSweepFailure());
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    background.resolve([hook(5002, { ppid: 1 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(confirmationReads).toBe(1);
    replacementAlive = true;
    confirmation.resolve([{ ...leaderRow, startedAt: "Sun Oct 25 22:01:00 2026" }]);
    await expect(settled).resolves.toBe(rootFailure);
  } else {
    background.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    replacementAlive = true;
    await expect(
      Promise.resolve().then(() => reaper.reapAndThrowOnDetachedSweepFailure()),
    ).rejects.toBe(rootFailure);
    expect(confirmationReads).toBe(0);
  }
  expect(replacementSignals).toBe(0);
  expect(() => reaper.reap()).toThrow(rootFailure);
  expect(replacementSignals).toBe(0);
});

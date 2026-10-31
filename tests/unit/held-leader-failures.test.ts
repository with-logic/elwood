/** Unknown identity/state, deadlines, and restore failures never authorize SIGTERM (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { heldLeaderHarness as harness } from "../helpers/held-leader.ts";
import { errno } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.restoreAllMocks());

test.each([
  { firstReadError: errno("EIO") },
  { stopError: errno("EPERM") },
  { postStopError: errno("EIO") },
  { notStopped: true },
  { differentGroup: true },
  { elapsedBeforeStop: 10_001 },
  { elapsedAfterRead: 10_001 },
])("C-LIFE-10 an uncertain held leader %j receives no TERM", async (options) => {
  const run = harness(options);
  await expect(run.stop()).rejects.toMatchObject({ code: "termination_failed" });
  expect(run.signals).toEqual([]);
  expect(() => run.reaper.reapAndThrowOnDetachedSweepFailure()).toThrow();
});

test("C-LIFE-10 verification spends the first read's remaining deadline", async () => {
  const run = harness({ elapsedBeforeStop: 4_000 });
  await run.stop();
  expect(run.timeouts).toEqual([10_000, 6_000]);
});

test.each([
  { exitOnStop: true },
  { exitAfterRead: true },
  { zombieOnStop: true },
  { stopError: errno("ESRCH") },
])("C-LIFE-10 an exit during leader verification %j cancels TERM", async (options) => {
  const run = harness(options);
  await run.stop();
  expect(run.signals).toEqual([]);
});

test("C-LIFE-10 a failed leader resume is reported after a verified TERM", async () => {
  const run = harness({ resumeError: errno("EPERM") });
  await expect(run.stop()).rejects.toMatchObject({
    code: "termination_failed",
    details: { errno: "EPERM" },
  });
  expect(run.signals).toEqual([{ generation: "original", held: true }]);
});

test("C-LIFE-10 a leader group already gone at resume needs nothing", async () => {
  await expect(harness({ resumeError: errno("ESRCH") }).stop()).resolves.toBeUndefined();
});

test.each([
  new Error("TERM failed"),
  errno("EIO"),
])("C-LIFE-10 a signal failure and failed resume retain both causes (%s)", async (termError) => {
  const run = harness({ termError, resumeError: errno("EPERM") });
  await expect(run.stop()).rejects.toMatchObject({
    code: "termination_failed",
    details: { cause: `${termError.message}; raw EPERM detail` },
  });
});

test("C-LIFE-10 a failed resume without a post-stop read retains uncertainty", async () => {
  const run = harness({ postStopError: errno("EIO"), resumeError: errno("EPERM") });
  await expect(run.stop()).rejects.toMatchObject({
    code: "termination_failed",
    details: { errno: "EIO" },
  });
  expect(run.signals).toEqual([]);
  expect(() => run.reaper.reapAndThrowOnDetachedSweepFailure()).toThrow();
});

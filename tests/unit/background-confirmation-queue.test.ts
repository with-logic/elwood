/** Queued confirmations retain a bounded foreground lifetime (C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_WINDOW_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { serializedReapQueue } from "../helpers/reap-queue.ts";
import { recordedDescendants } from "../helpers/recorded-descendants.ts";
import { LEADER, leaderRow, scripted, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const expiry = () => {
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
};

test("C-LIFE-10 confirmation expiry while queued starts no late process read", async () => {
  const queue = serializedReapQueue();
  const gate = Promise.withResolvers<void>();
  const held = queue(() => gate.promise);
  const fake = scripted([[]]);
  const recovery = reapInBackground(recordedDescendants(), fake.ops, queue);
  expiry();
  const confirmation = recovery.confirm();
  clock += 10_000;
  await vi.advanceTimersByTimeAsync(10_000);
  await confirmation;
  gate.resolve();
  await held;
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 queue time reduces the confirmation budget and tardy results cannot resolve it", async () => {
  const queue = serializedReapQueue();
  const gate = Promise.withResolvers<void>();
  const held = queue(() => gate.promise);
  const table = Promise.withResolvers<readonly (typeof leaderRow)[]>();
  const fake = scripted([[]]);
  const read = vi.fn((_ms: number) => table.promise);
  const record = recordedDescendants();
  const stopped = { ...leaderRow, stopped: true };
  record.resumes.remember([stopped], LEADER);
  const restore = vi.fn();
  const recovery = reapInBackground(record, fake.ops, queue, {
    ...fake.ops,
    listProcesses: read,
    continueGroup: restore,
  });
  expiry();
  const confirmation = recovery.confirm();
  clock += 1_000;
  gate.resolve();
  await held;
  await vi.advanceTimersByTimeAsync(0);
  expect(read.mock.calls).toEqual([[9_000, expect.anything()]]);
  clock += 9_000;
  await vi.advanceTimersByTimeAsync(10_000);
  await confirmation;
  table.resolve([stopped]);
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(false);
  expect(restore).not.toHaveBeenCalled();
  await recovery.confirm();
  expect(recovery.resolved()).toBe(true);
  expect(restore).toHaveBeenCalledExactlyOnceWith(LEADER);
});

test("C-LIFE-10 expired three-argument confirmation uses its original reader", async () => {
  const queue = serializedReapQueue();
  const gate = Promise.withResolvers<void>();
  const held = queue(() => gate.promise);
  const fake = scripted([[]]);
  const recovery = reapInBackground(recordedDescendants(), fake.ops, queue);
  expiry();
  const checking = recovery.confirm();
  gate.resolve();
  await held;
  await checking;
  expect(fake.calls).toEqual(["list"]);
  expect(recovery.resolved()).toBe(true);
});

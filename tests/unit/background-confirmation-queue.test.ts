/** Queued confirmations retain a bounded foreground lifetime (C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_WINDOW_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { SerialDetachedSweepQueue } from "../../src/runtime/shutdown/reap-queue.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

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
function recorded() {
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(5002)], LEADER, true);
  return record;
}
const expiry = () => {
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
};

test("C-LIFE-10 confirmation expiry while queued starts no late process read", async () => {
  const queue = new SerialDetachedSweepQueue();
  const gate = Promise.withResolvers<void>();
  const held = queue.run(() => gate.promise);
  const fake = scripted([[]]);
  const recovery = reapInBackground(recorded(), fake.ops, (attempt) => queue.run(attempt));
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
  const queue = new SerialDetachedSweepQueue();
  const gate = Promise.withResolvers<void>();
  const held = queue.run(() => gate.promise);
  const table = Promise.withResolvers<readonly (typeof leaderRow)[]>();
  const fake = scripted([[]]);
  const read = vi.fn((_ms: number) => table.promise);
  const record = recorded();
  const stopped = { ...leaderRow, stopped: true };
  record.resumes.remember([stopped], LEADER);
  const restore = vi.fn();
  const recovery = reapInBackground(record, fake.ops, (attempt) => queue.run(attempt), {
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

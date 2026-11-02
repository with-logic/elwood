/** Newly discovered descendants and ambiguous foreground identities stay unresolved (C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import { reapInBackground } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import { errno, hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.useRealTimers());

test("C-LIFE-14 a failed observed child reap remains pending after its recorded parent exits", async () => {
  vi.useFakeTimers();
  const parent = hook(5002, { ppid: 1 });
  const child = hook(5003, { ppid: 5002 });
  const record = new DescendantRecord();
  record.observe([leaderRow, hook(5002)], LEADER);
  let rows = [parent, child, hook(5004, { zombie: true })];
  const fake = scripted([], {
    killGroup: () => {
      throw errno("EPERM");
    },
  });
  const ops = { ...fake.ops, listProcesses: () => Promise.resolve(fake.asRead(rows)) };
  expect(await reapRecordedSurvivors(record, ops)).toBeDefined();
  rows = [{ ...child, ppid: 1 }];
  const recovery = reapInBackground(record, ops);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(recovery.resolved()).toBe(false);
  expect(record.pids).toContain(child.pid);
  expect(record.pids).not.toContain(5004);
  await vi.advanceTimersByTimeAsync(58_000);
  await recovery.confirm();
  expect(recovery.resolved()).toBe(false);
  rows = [];
  await recovery.confirm();
  expect(recovery.resolved()).toBe(true);
});

test.each([
  false,
  true,
])("C-LIFE-10 ambiguity veto applies to survivor reaping (background=%s)", async (background) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T22:00:00.500Z"));
  const record = new DescendantRecord();
  const ambiguous = hook(5002);
  const safe = hook(5003, { startedAt: "Sun Oct 25 21:59:00 2026" });
  record.observe([leaderRow, ambiguous, safe], LEADER);
  const fake = scripted([[ambiguous, safe]]);
  if (background) {
    const recovery = reapInBackground(record, fake.ops);
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.resolved()).toBe(false);
  } else expect(await reapRecordedSurvivors(record, fake.ops)).toBeDefined();
  expect(fake.calls).not.toContain("stop 5002");
  expect(fake.calls).not.toContain("kill 5002");
  expect(fake.calls).toContain("kill 5003");
});

/** Each fresh recovery read rechecks the group's ambiguity veto (C-LIFE-14). */
import { expect, test, vi } from "vitest";
import { reapInBackground } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { hook, LEADER, leaderRow, scripted } from "../helpers/scripted-process-tree.ts";

test("C-LIFE-14 a stopped group gaining an ambiguous member is restored instead of killed", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-25T22:00:00.500Z"));
    const ambiguous = hook(5002);
    const safe = hook(5003, { startedAt: "Sun Oct 25 21:59:00 2026" });
    const record = new DescendantRecord();
    record.observe([leaderRow, ambiguous, safe], LEADER);
    const fake = scripted([]);
    let joined = false;
    const recovery = reapInBackground(record, {
      ...fake.ops,
      listProcesses: () =>
        Promise.resolve(fake.asRead([safe, { ...ambiguous, pgid: joined ? 5003 : 5002 }])),
      stopGroup: (group) => {
        fake.ops.stopGroup(group);
        if (group === 5003) joined = true;
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.calls).toContain("stop 5003");
    expect(fake.calls).toContain("cont 5003");
    expect(fake.calls).not.toContain("kill 5003");
    expect(recovery.resolved()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

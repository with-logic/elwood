/** Combined survivor roots bound work on the real reap path (PRD §5.3, C-LIFE-10). */
import { expect, test } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();

// Includes verification and kill-pass scans; per-member traversal exceeds 40,000 for 500 rows.
const MAX_REAP_PID_INSPECTIONS_PER_ROW = 80;

test("C-LIFE-10 a survivor group is traversed once rather than once per member", async () => {
  let inspected = 0;
  const rows = Array.from({ length: 500 }, (_, index) => {
    const pid = 6000 + index;
    const row = hook(pid, { pgid: 6000 });
    Object.defineProperty(row, "pid", {
      get: () => {
        inspected += 1;
        return pid;
      },
    });
    return row;
  });
  const record = new DescendantRecord();
  record.observeFirst([leaderRow, ...rows], LEADER, Date.now());
  record.observe([leaderRow, ...rows], LEADER, Date.now());
  const fake = scripted([rows]);
  inspected = 0;
  expect(await reapRecordedSurvivors(record, fake.ops)).toBeUndefined();
  expect(fake.calls).toContain("kill 6000");
  expect(inspected).toBeLessThanOrEqual(rows.length * MAX_REAP_PID_INSPECTIONS_PER_ROW);
});

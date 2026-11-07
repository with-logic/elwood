/** Retained-debt work stays bounded at each foreground deadline boundary (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { ResumeDebt } from "../../src/runtime/shutdown/detached-sweep/resume-debt.ts";
import { hook } from "../helpers/scripted-process-tree.ts";

afterEach(() => vi.restoreAllMocks());

test("C-LIFE-10 a finite deadline with spare budget restores known debt", () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const row = hook(5002, { stopped: true });
  const debt = new ResumeDebt();
  debt.remember([row], row.pgid);
  const continueGroup = vi.fn<(group: number) => void>();
  expect(debt.retry([row], { continueGroup }, 1000)).toBe(true);
  expect(continueGroup).toHaveBeenCalledTimes(1);
  expect(continueGroup).toHaveBeenCalledWith(row.pgid);
  expect(debt.pids).toEqual([]);
});

test.each(
  Array.from({ length: 21 }, (_, deadline) => deadline),
)("C-LIFE-10 a confirmation budget of %i clock ticks never resumes late or clears unsent debt", (deadline) => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock++);
  const rows = [hook(5002, { stopped: true }), hook(5003, { stopped: true })];
  const debt = new ResumeDebt();
  for (const row of rows) debt.remember([row], row.pgid);
  const restored: number[] = [];
  debt.retry(
    rows,
    {
      continueGroup: (group) => {
        expect(clock - 1).toBeLessThan(deadline);
        restored.push(group);
      },
    },
    deadline,
  );
  for (const row of rows) {
    if (!restored.includes(row.pgid)) expect(debt.pids).toContain(row.pid);
  }
});

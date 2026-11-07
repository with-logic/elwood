/** A failed shared-daemon resume retains identity-bound debt (PRD §5.3, C-LIFE-10). */
import { expect, test, vi } from "vitest";
import { ResumeDebt } from "../../src/runtime/shutdown/detached-sweep/resume-debt.ts";
import { errno, hook } from "../helpers/scripted-process-tree.ts";

const held = hook(5002, { stopped: true, shared: true });

test("C-LIFE-10 only live rows of the failed group are remembered", () => {
  const debt = new ResumeDebt();
  const member = hook(5005, { pgid: 5002, stopped: true });
  const table = [held, member];
  debt.remember([...table, hook(5003), hook(5004, { zombie: true, pgid: 5002 })], 5002);
  expect(debt.pids).toEqual([5002, 5005]);
  const continueGroup = vi.fn();
  expect(debt.retry(table, { continueGroup })).toBe(true);
  expect(continueGroup.mock.calls).toEqual([[5002]]);
  expect(debt.retry(table, { continueGroup })).toBe(true);
  expect(continueGroup).toHaveBeenCalledOnce();
  expect(debt.pids).toEqual([]);
});

test.each(
  [
    [],
    [{ ...held, zombie: true }],
    [{ ...held, stopped: false }],
    [{ ...held, pgid: 5003 }],
    [{ ...held, startedAt: "another process" }],
  ].map((table) => ({ table })),
)("C-LIFE-10 a gone, resumed or replacement row needs no SIGCONT (%#)", ({ table }) => {
  const debt = new ResumeDebt();
  debt.remember([held], 5002);
  const continueGroup = vi.fn();
  expect(debt.retry(table, { continueGroup })).toBe(true);
  expect(continueGroup).not.toHaveBeenCalled();
  expect(debt.pids).toEqual([]);
  expect(debt.retry([held], { continueGroup })).toBe(true);
  expect(continueGroup).not.toHaveBeenCalled();
});

test("C-LIFE-10 a failed resume remains pending while another group's resume succeeds", () => {
  const other = hook(5003, { stopped: true, shared: true });
  const debt = new ResumeDebt();
  debt.remember([held, other], 5002);
  debt.remember([held, other], 5003);
  const continueGroup = vi.fn((group: number) => {
    if (group === 5002) throw errno("EPERM");
  });
  expect(debt.retry([held, other], { continueGroup })).toBe(false);
  expect(continueGroup.mock.calls).toEqual([[5002], [5003]]);
  expect(debt.pids).toEqual([5002]);
  expect(debt.retry([held, other], { continueGroup })).toBe(false);
  expect(continueGroup.mock.calls).toEqual([[5002], [5003], [5002]]);
  expect(debt.retry([], { continueGroup })).toBe(true);
});

test("C-LIFE-10 an already-gone group's ESRCH resolves the resume debt", () => {
  const debt = new ResumeDebt();
  debt.remember([held], 5002);
  expect(
    debt.retry([held], {
      continueGroup: () => {
        throw errno("ESRCH");
      },
    }),
  ).toBe(true);
  expect(debt.pids).toEqual([]);
});

test("C-LIFE-10 one read's identity index is shared across retained resume records", () => {
  let inspected = 0;
  const table = Array.from({ length: 2000 }, (_, index) => {
    const row = hook(6000 + index, { stopped: true });
    Object.defineProperty(row, "startedAt", {
      get: () => {
        inspected += 1;
        return held.startedAt;
      },
    });
    return row;
  });
  const first = new ResumeDebt();
  const second = new ResumeDebt();
  for (const row of table.slice(-100)) {
    first.remember([row], row.pgid);
    second.remember([row], row.pgid);
  }
  inspected = 0;
  const continueGroup = vi.fn();
  expect(first.retry(table, { continueGroup })).toBe(true);
  expect(second.retry(table, { continueGroup })).toBe(true);
  expect(inspected).toBeLessThanOrEqual(table.length);
  expect(continueGroup).toHaveBeenCalledTimes(200);
});

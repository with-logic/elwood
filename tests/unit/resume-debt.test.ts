/** A failed shared-daemon resume retains identity-bound debt (PRD §5.3, C-LIFE-14). */
import { expect, test, vi } from "vitest";
import { ResumeDebt } from "../../src/runtime/shutdown/detached-sweep/resume-debt.ts";
import { errno, hook } from "../helpers/scripted-process-tree.ts";

const held = hook(5002, { stopped: true, shared: true });

test("C-LIFE-14 only live rows of the failed group are remembered", () => {
  const debt = new ResumeDebt();
  debt.remember([held, hook(5003), hook(5004, { zombie: true, pgid: 5002 })], 5002);
  const continueGroup = vi.fn();
  expect(debt.retry([held], { continueGroup })).toBe(true);
  expect(continueGroup.mock.calls).toEqual([[5002]]);
  expect(debt.retry([held], { continueGroup })).toBe(true);
  expect(continueGroup).toHaveBeenCalledOnce();
});

test.each(
  [
    [],
    [{ ...held, zombie: true }],
    [{ ...held, stopped: false }],
    [{ ...held, pgid: 5003 }],
    [{ ...held, startedAt: "another process" }],
  ].map((table) => ({ table })),
)("C-LIFE-14 a gone, resumed or replacement row needs no SIGCONT (%#)", ({ table }) => {
  const debt = new ResumeDebt();
  debt.remember([held], 5002);
  const continueGroup = vi.fn();
  expect(debt.retry(table, { continueGroup })).toBe(true);
  expect(continueGroup).not.toHaveBeenCalled();
});

test("C-LIFE-14 a failed resume remains pending while another group's resume succeeds", () => {
  const other = hook(5003, { stopped: true, shared: true });
  const debt = new ResumeDebt();
  debt.remember([held, other], 5002);
  debt.remember([held, other], 5003);
  const continueGroup = vi.fn((group: number) => {
    if (group === 5002) throw errno("EPERM");
  });
  expect(debt.retry([held, other], { continueGroup })).toBe(false);
  expect(continueGroup.mock.calls).toEqual([[5002], [5003]]);
  expect(debt.retry([held, other], { continueGroup })).toBe(false);
  expect(continueGroup.mock.calls).toEqual([[5002], [5003], [5002]]);
  expect(debt.retry([], { continueGroup })).toBe(true);
});

test("C-LIFE-14 an already-gone group's ESRCH resolves the resume debt", () => {
  const debt = new ResumeDebt();
  debt.remember([held], 5002);
  expect(
    debt.retry([held], {
      continueGroup: () => {
        throw errno("ESRCH");
      },
    }),
  ).toBe(true);
});

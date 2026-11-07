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

test.each([
  [0, false, [], [5002, 5003]],
  [1, false, [], [5002, 5003]],
  [2, false, [], [5002, 5003]],
  [3, false, [], [5002, 5003]],
  [4, false, [], [5002, 5003]],
  [5, false, [], [5002, 5003]],
  [6, false, [], [5002, 5003]],
  [7, false, [], [5002, 5003]],
  [8, false, [], [5002, 5003]],
  [9, false, [], [5002, 5003]],
  [10, false, [], [5002, 5003]],
  [11, false, [5002], [5002, 5003]],
  [12, false, [5002], [5003]],
  [13, false, [5002, 5003], [5003]],
  [14, false, [5002, 5003], []],
  [15, true, [5002, 5003], []],
  [16, true, [5002, 5003], []],
  [17, true, [5002, 5003], []],
  [18, true, [5002, 5003], []],
  [19, true, [5002, 5003], []],
  [20, true, [5002, 5003], []],
] as const)("C-LIFE-10 a budget of %i ticks has fixed restoration results", (deadline, expectedResolved, expectedGroups, expectedPids) => {
  let clock = 0;
  let observedTime = 0;
  vi.spyOn(performance, "now").mockImplementation(() => {
    observedTime = clock++;
    return observedTime;
  });
  const rows = [hook(5002, { stopped: true }), hook(5003, { stopped: true })];
  const debt = new ResumeDebt();
  for (const row of rows) debt.remember([row], row.pgid);
  const attempts: { readonly group: number; readonly at: number }[] = [];
  const resolved = debt.retry(
    rows,
    {
      continueGroup: (group) => {
        attempts.push({ group, at: observedTime });
      },
    },
    deadline,
  );
  expect(resolved).toBe(expectedResolved);
  expect(attempts.map(({ group }) => group)).toEqual(expectedGroups);
  expect(debt.pids).toEqual(expectedPids);
  for (const attempt of attempts) expect(attempt.at).toBeLessThan(deadline);
});

test("C-LIFE-10 equality with the deadline preserves debt without dispatching CONT", () => {
  vi.spyOn(performance, "now").mockReturnValue(10);
  const row = hook(5002, { stopped: true });
  const debt = new ResumeDebt();
  debt.remember([row], row.pgid);
  const continueGroup = vi.fn<(group: number) => void>();
  expect(debt.retry([row], { continueGroup }, 10)).toBe(false);
  expect(continueGroup).not.toHaveBeenCalled();
  expect(debt.pids).toEqual([row.pid]);
});

test.each([
  "identity indexing",
  "debt traversal",
] as const)("C-LIFE-10 expiry during %s stops before the next row", (phase) => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const rows = [hook(5002, { stopped: true }), hook(5003, { stopped: true })];
  const debt = new ResumeDebt();
  for (const row of rows) debt.remember([row], row.pgid);
  let firstReads = 0;
  let secondReads = 0;
  const field = phase === "identity indexing" ? "startedAt" : "stopped";
  const value = phase === "identity indexing" ? rows[0]!.startedAt : false;
  Object.defineProperty(rows[0], field, {
    get: () => {
      firstReads += 1;
      clock = 10;
      return value;
    },
  });
  Object.defineProperty(rows[1], field, {
    get: () => {
      secondReads += 1;
      return value;
    },
  });
  const continueGroup = vi.fn<(group: number) => void>();
  expect(debt.retry(rows, { continueGroup }, 10)).toBe(false);
  expect(continueGroup).not.toHaveBeenCalled();
  expect(debt.pids).toEqual([5002, 5003]);
  expect(firstReads).toBe(1);
  expect(secondReads).toBe(0);
});

test("C-LIFE-10 expiry inside CONT retains debt and prevents the next group", () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const rows = [hook(5002, { stopped: true }), hook(5003, { stopped: true })];
  const debt = new ResumeDebt();
  for (const row of rows) debt.remember([row], row.pgid);
  const groups: number[] = [];
  expect(
    debt.retry(
      rows,
      {
        continueGroup: (group) => {
          groups.push(group);
          clock = 10;
        },
      },
      10,
    ),
  ).toBe(false);
  expect(groups).toEqual([5002]);
  expect(debt.pids).toEqual([5002, 5003]);
});

/** Graceful leader-group recording retains only the frozen original identity (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import {
  RECORD_INTERVAL_MS,
  watchDescendants,
} from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => vi.useRealTimers());

test.each([
  { name: "missing", rows: [] },
  { name: "zombie", rows: [{ ...leaderRow, zombie: true }] },
  { name: "wrong group", rows: [{ ...leaderRow, pgid: 5004 }] },
  { name: "replacement", rows: [{ ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" }] },
])("C-LIFE-10 a $name original leader cannot add group members", ({ rows }) => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observeLeaderGroup([...rows, hook(5001, { pgid: LEADER })], LEADER, Date.now());
  expect(record.pids).toEqual([]);
});

test("C-LIFE-10 recording a leader group cannot establish a missing or refused baseline", () => {
  const record = new DescendantRecord();
  record.observeLeaderGroup([leaderRow], LEADER, Date.now());
  expect(record.pids).toEqual([]);
  record.refuseFirstObservation(new Error("failed initial read"));
  record.observeLeaderGroup([leaderRow], LEADER, Date.now());
  expect(record.pids).toEqual([]);
});

test("C-LIFE-10 a positively matched leader group establishes recorded ownership", () => {
  const record = new DescendantRecord();
  const rows = [leaderRow, hook(5001, { pgid: LEADER })];
  record.observeFirst(rows, LEADER, Date.now());
  record.observeLeaderGroup(rows, LEADER, Date.now());
  expect(record.known).toBe(true);
  expect(record.pids).toEqual([LEADER, 5001]);
});

test("C-LIFE-10 initial and later observations retain original leader-group helpers", async () => {
  vi.useFakeTimers();
  const firstChild = hook(5001, { pgid: LEADER });
  const laterChild = hook(5002, { pgid: LEADER });
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  const unowned = hook(5003, { pgid: LEADER });
  const fake = scripted([
    [leaderRow, firstChild],
    [leaderRow, firstChild, laterChild],
    [replacement, unowned],
  ]);
  const watch = watchDescendants(LEADER, fake.ops, () => false);
  await watch.firstRead;
  expect(watch.record.pids).toEqual([LEADER, firstChild.pid]);
  await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 2);
  const record = await watch.finish();
  expect(record.pids).toEqual([LEADER, firstChild.pid, laterChild.pid]);
  expect(record.survivors([replacement, unowned])).toEqual([]);
});

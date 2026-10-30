/** Concurrent descendant watches retain the shared production table-read pattern (C-LIFE-10). */
import { expect, test } from "vitest";
import { coalesceUnstarted } from "../../src/runtime/shutdown/coalesce.ts";
import { watchDescendants } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { leaderRow } from "../helpers/scripted-process-tree.ts";

test("C-LIFE-10 concurrent survivor watches share a fresh table listing", async () => {
  const leaders = [10_000_001, 10_000_002];
  const table = leaders.map((pid) => ({ ...leaderRow, pid, pgid: pid }));
  let reads = 0;
  const listProcesses = coalesceUnstarted(() => {
    reads += 1;
    return Promise.resolve(table);
  });
  const watches = leaders.map((pid) => watchDescendants(pid, { listProcesses }, () => false));
  await Promise.all(watches.map((watch) => watch.firstRead));
  expect(reads).toBe(1);
  const records = await Promise.all(watches.map((watch) => watch.finish()));
  expect(records.every((record) => record.known)).toBe(true);
  expect(reads).toBe(1);
});

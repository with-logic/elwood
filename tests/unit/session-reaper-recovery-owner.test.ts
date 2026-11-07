/** Retained recovery preserves the cached graceful owner's signal authority (C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { LEADER, leaderRow, scripted, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("C-LIFE-14 early failed finish cannot recover original-group KILL authority after veto", async () => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([]);
  let reads = 0;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () => first.promise,
    listProcessesUnreferenced: () => {
      reads += 1;
      return Promise.resolve(fake.asRead(fake.calls.includes(`kill ${LEADER}`) ? [] : [leaderRow]));
    },
  });
  const watch = reaper.watchSurvivors(() => false);
  expect(() => reaper.reap()).toThrow("before signal ownership was verified");
  first.resolve([leaderRow]);
  await watch.firstRead;
  await expect(watch.finish(true)).rejects.toThrow("exit was not confirmed");
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBeGreaterThan(0);
  expect(fake.calls).toEqual([]);
  expect(reaper.watchSurvivors(() => true)).toBe(watch);
  expect(() => reaper.reap()).toThrow("before signal ownership was verified");
});

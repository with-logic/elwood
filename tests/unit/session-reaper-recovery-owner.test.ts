/** Retained recovery preserves the cached graceful owner's signal authority (C-LIFE-14). */
import { afterEach, expect, test, vi } from "vitest";
import type { SurvivorWatch } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import { LEADER, leaderRow, scripted, useScriptedHost } from "../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([
  {
    phase: "finish",
    act: (watch: SurvivorWatch) => watch.finish(true),
    error: "exit was not confirmed",
  },
  { phase: "reap", act: (watch: SurvivorWatch) => watch.reap(), error: "ambiguous identity" },
])("C-LIFE-14 early $phase cannot recover original-group KILL authority after veto", async ({
  act,
  error,
}) => {
  vi.useFakeTimers();
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([]);
  let reads = 0;
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: async () => fake.asRead(await first.promise),
    listProcessesUnreferenced: () => {
      reads += 1;
      return Promise.resolve(fake.asRead(fake.calls.includes(`kill ${LEADER}`) ? [] : [leaderRow]));
    },
  });
  const watch = reaper.watchSurvivors(() => false);
  expect(() => reaper.reap()).toThrow("before signal ownership was verified");
  first.resolve([leaderRow]);
  await watch.firstRead;
  await expect(act(watch)).rejects.toThrow(error);
  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBeGreaterThan(0);
  expect(fake.calls).toEqual([]);
  expect(reaper.watchSurvivors(() => true)).toBe(watch);
  expect(() => reaper.reap()).toThrow("before signal ownership was verified");
});

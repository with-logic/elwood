/** Fifty staggered recovery owners share queued scans without starving a later read (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { coalesceBeforeNativeAdmission } from "../../../src/runtime/shutdown/coalesce-before-native-admission.ts";
import { reapInBackground } from "../../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../../src/runtime/shutdown/detached-sweep/record.ts";
import { listProcessTable, type PsRunner } from "../../../src/runtime/shutdown/process-table.ts";
import { SerialDetachedSweepQueue } from "../../../src/runtime/shutdown/reap-queue.ts";
import {
  daemonScope,
  listProcessTableMarkingDaemon,
} from "../../../src/runtime/shutdown/shared-daemon.ts";
import { createUnreferencedProcessTableReader } from "../../../src/runtime/shutdown/unreferenced-read.ts";
import { errno, hook, leaderRow, useScriptedHost } from "../../helpers/scripted-process-tree.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test.each([
  500, 750,
])("C-LIFE-10 fifty owners preserve foreground budget with %s ms native scans", async (scanMs) => {
  vi.useFakeTimers();
  const epoch = Date.now();
  const now = () => Date.now() - epoch;
  vi.spyOn(performance, "now").mockImplementation(now);
  let active = 0;
  let maximum = 0;
  let nativeCalls = 0;
  let owners = 0;
  const stdout = Array.from({ length: 50 }, (_, i) => {
    const pid = 10_002_000 + i;
    return `${pid} 1 ${pid} S Sun Oct 25 22:00:00 2026 sh ${pid}\n`;
  }).join("");
  const native: PsRunner = (_file, _args, options) => {
    nativeCalls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    return new Promise((resolve, reject) =>
      setTimeout(
        () => {
          active -= 1;
          if (options.timeout < scanMs) reject(errno("ETIMEDOUT"));
          else resolve({ stdout });
        },
        Math.min(scanMs, options.timeout),
      ),
    );
  };
  const background = createUnreferencedProcessTableReader(native);
  const foreground = coalesceBeforeNativeAdmission((ms) => listProcessTable(ms, native));
  for (let i = 0; i < 50; i++)
    setTimeout(() => {
      const leader = 10_001_000 + i;
      const entry = { ...leaderRow, pid: leader, pgid: leader };
      const table = [entry, hook(10_002_000 + i, { ppid: leader })];
      const record = new DescendantRecord();
      const queue = new SerialDetachedSweepQueue();
      record.observeFirst(table, leader, Date.now());
      record.observe(table, leader, Date.now());
      owners += 1;
      reapInBackground(
        record,
        {
          listProcesses: (ms, scope) => listProcessTableMarkingDaemon(ms, scope, background),
          stopGroup: () => {
            throw errno("EIO");
          },
          killGroup: () => {
            throw new Error("Unexpected KILL");
          },
          continueGroup: () => {
            throw new Error("Unexpected CONT");
          },
        },
        (pass) => queue.run(pass),
      );
    }, i * 20);
  let outcome = "pending";
  let finished = -1;
  setTimeout(() => {
    void listProcessTableMarkingDaemon(10_000, daemonScope(new Set()), foreground)
      .then(
        () => {
          outcome = "ok";
        },
        () => {
          outcome = "error";
        },
      )
      .finally(() => {
        finished = now();
      });
  }, 5_000);
  await vi.advanceTimersByTimeAsync(80_000);
  expect(owners).toBe(50);
  expect(outcome).toBe("ok");
  expect(finished - 5_000).toBeLessThan(10_000);
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(nativeCalls).toBeLessThan(300);
});

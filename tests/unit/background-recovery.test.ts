/** Retained evidence recovers without retracing a dead leader (PRD §9.4, C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_WINDOW_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { SerialDetachedSweepQueue } from "../../src/runtime/shutdown/reap-queue.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function recorded() {
  const record = new DescendantRecord();
  record.observeFirst(
    [{ ...leaderRow, startedAt: "Sun Oct 25 21:59:00 2026" }, hook(5002)],
    LEADER,
    Date.now(),
  );
  record.observe(
    [{ ...leaderRow, startedAt: "Sun Oct 25 21:59:00 2026" }, hook(5002)],
    LEADER,
    Date.now(),
  );
  return record;
}
function queue() {
  const serialized = new SerialDetachedSweepQueue();
  return <T>(attempt: () => Promise<T>) => serialized.run(attempt);
}

test("C-LIFE-10 reads fresh evidence and safely reaps only recorded survivors", async () => {
  const record = recorded();
  const { ops, calls, asRead } = scripted([]);
  const reaping = reapInBackground(
    record,
    {
      ...ops,
      listProcesses: () =>
        Promise.resolve(asRead(calls.includes("kill 5002") ? [] : [hook(5002, { ppid: 1 })])),
    },
    queue(),
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(reaping.resolved()).toBe(true);
  expect(calls.filter((call) => call !== "list")).toEqual(["stop 5002", "kill 5002"]);
});

test("C-LIFE-10 transient failed reads retry with the full fresh read budget", async () => {
  const record = recorded();
  let reads = 0;
  const fake = scripted([]);
  const budgets: number[] = [];
  const read = vi.fn((ms: number) => {
    budgets.push(ms);
    reads += 1;
    return reads === 1 ? Promise.reject(errno("EIO")) : Promise.resolve([]);
  });
  const recovery = reapInBackground(record, { ...fake.ops, listProcesses: read }, queue());
  await vi.advanceTimersByTimeAsync(2000);
  expect(recovery.resolved()).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(budgets).toEqual([10000, 10000]);
});

test("C-LIFE-10 replacement PIDs are not signaled and no retained process starts no reads", async () => {
  const fake = scripted([[hook(5002, { startedAt: "another process" })]]);
  const recovery = reapInBackground(recorded(), fake.ops, queue());
  const empty = reapInBackground(new DescendantRecord(), fake.ops, queue());
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(true);
  expect(empty.resolved()).toBe(false);
  expect(fake.calls).toEqual(["list"]);
});

test.each([
  true,
  false,
])("C-LIFE-10 resume-only recovery requires a known tree (%s)", async (known) => {
  const record = new DescendantRecord();
  if (known) {
    record.observeFirst([leaderRow], LEADER, Date.now());
    record.observe([leaderRow], LEADER, Date.now());
  }
  record.resumes.remember([{ ...leaderRow, stopped: true }], LEADER);
  const fake = scripted([[{ ...leaderRow, stopped: true }]]);
  const recovery = reapInBackground(record, fake.ops, queue());
  await vi.advanceTimersByTimeAsync(3000);
  expect(fake.calls).toEqual(["list", `cont ${LEADER}`]);
  expect(recovery.resolved()).toBe(known);
});

test("C-LIFE-10 unknown restoration alone stops automatic scans and remains unresolved", async () => {
  const record = recorded();
  record.markUnknownResume();
  const fake = scripted([[]]);
  const recovery = reapInBackground(record, fake.ops, queue());
  await vi.advanceTimersByTimeAsync(5000);
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls).toEqual(["list"]);
});

test("C-LIFE-10 live ambiguous survivors remain un-signaled and expire within one retry window", async () => {
  vi.setSystemTime(new Date("2026-10-25T22:00:00.500Z"));
  const fake = scripted([[hook(5002)]]);
  const recovery = reapInBackground(recorded(), fake.ops, queue());
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_WINDOW_MS + 3000);
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls.every((call) => call === "list")).toBe(true);
  expect(fake.calls.length).toBeLessThanOrEqual(60);
});

test("C-LIFE-10 every attempt retains confirmed daemon paths", async () => {
  const record = recorded();
  const fake = scripted([], {
    stopGroup: () => {
      throw errno("EPERM");
    },
  });
  const caches: Set<string>[] = [];
  reapInBackground(
    record,
    {
      ...fake.ops,
      listProcesses: (_ms, scope) => {
        if (scope) {
          caches.push(scope.known);
          scope.known.add("confirmed path");
        }
        return Promise.resolve([hook(5002, { ppid: 1 })]);
      },
    },
    queue(),
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(caches.length).toBeGreaterThan(2);
  for (const cache of caches) {
    expect(cache).toBe(caches[0]);
    expect(cache.has("confirmed path")).toBe(true);
  }
});

test("C-LIFE-10 failed restoration stays pending until a matching stopped group resumes", async () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow], LEADER, Date.now());
  record.resumes.remember([{ ...leaderRow, stopped: true }], LEADER);
  let attempts = 0;
  const fake = scripted([], {
    continueGroup: () => {
      attempts += 1;
      if (attempts === 1) throw errno("EPERM");
    },
  });
  const recovery = reapInBackground(
    record,
    {
      ...fake.ops,
      listProcesses: () => Promise.resolve([{ ...leaderRow, stopped: true }]),
    },
    queue(),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(recovery.resolved()).toBe(true);
  expect(attempts).toBe(2);
});

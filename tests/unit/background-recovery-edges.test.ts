/** Recovery stops inactive work and respects its automatic cutoff (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function serialized() {
  const queue = new SerialDetachedSweepQueue();
  return <T>(attempt: () => Promise<T>) => queue.run(attempt);
}

test.each([
  false,
  true,
])("C-LIFE-10 an unknown tree stops work once its restoration debt clears (%s)", async (pending) => {
  vi.useFakeTimers();
  const record = new DescendantRecord();
  const row = hook(5002, { stopped: true });
  record.observeGroups([row], new Map([[5002, new Set()]]), Date.now());
  if (pending) record.resumes.remember([row], 5002);
  let resumes = 0;
  const fake = scripted([], {
    continueGroup: () => {
      resumes += 1;
      if (resumes === 1) throw errno("EPERM");
    },
  });
  const list = vi.fn(() => Promise.resolve([row]));
  const recovery = reapInBackground(record, { ...fake.ops, listProcesses: list }, serialized());
  await vi.advanceTimersByTimeAsync(3000);
  expect(list).toHaveBeenCalledTimes(pending ? 2 : 1);
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls.some((call) => call.startsWith("stop") || call.startsWith("kill"))).toBe(false);
});

test("C-LIFE-10 a read ending beyond the retry window cannot start a survivor reap", async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const record = new DescendantRecord();
  record.observeFirst([leaderRow, hook(5002)], LEADER, Date.now());
  record.observe([leaderRow, hook(5002)], LEADER, Date.now());
  const fake = scripted([]);
  const recovery = reapInBackground(
    record,
    {
      ...fake.ops,
      listProcesses: () => {
        now = BACKGROUND_REAP_RETRY_WINDOW_MS;
        return Promise.resolve(fake.asRead([hook(5002, { ppid: 1 })]));
      },
    },
    serialized(),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 queued admission past expiry starts no automatic scan", async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const queue = new SerialDetachedSweepQueue();
  const gate = Promise.withResolvers<void>();
  const held = queue.run(() => gate.promise);
  const record = new DescendantRecord();
  record.observeFirst([leaderRow, hook(5002)], LEADER, Date.now());
  record.observe([leaderRow, hook(5002)], LEADER, Date.now());
  const fake = scripted([[]]);
  const recovery = reapInBackground(record, fake.ops, (attempt) => queue.run(attempt));
  now = BACKGROUND_REAP_RETRY_WINDOW_MS;
  gate.resolve();
  await held;
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 a newly recorded child's root remains in later automatic reads", async () => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const record = new DescendantRecord();
  record.observeFirst([leaderRow, hook(5002)], LEADER, Date.now());
  record.observe([leaderRow, hook(5002)], LEADER, Date.now());
  const parent = hook(5002, { ppid: 1 });
  const child = hook(5003, { ppid: 5002 });
  const tables = [[parent], [parent, child], [{ ...child, ppid: 1 }], []];
  const scopes: number[][] = [];
  let reads = 0;
  const fake = scripted([]);
  const recovery = reapInBackground(
    record,
    {
      ...fake.ops,
      listProcesses: (_ms, scope) => {
        scopes.push([...(scope?.roots ?? [])]);
        // Leave budget for the mandatory post-stop identity read.
        clock += 1000;
        return Promise.resolve(fake.asRead(tables[reads++] ?? []));
      },
    },
    serialized(),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(record.pids).toContain(5003);
  expect(scopes.at(-1)).toContain(5003);
  expect(recovery.resolved()).toBe(true);
});

test("C-LIFE-10 empty recovery reads cannot retire an unreadable observation gap", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const record = new DescendantRecord();
  const tree = [leaderRow, hook(5002)];
  record.observeFirst(tree, LEADER, Date.now());
  record.observe(tree, LEADER, Date.now());
  record.noteReadFailure(errno("EIO"));
  const fake = scripted([[]]);
  const first = reapInBackground(record, fake.ops, serialized());
  await vi.advanceTimersByTimeAsync(0);
  expect(first.resolved()).toBe(false);
  const second = reapInBackground(record, fake.ops, serialized());
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_WINDOW_MS + 1);
  expect(first.resolved()).toBe(false);
  expect(second.resolved()).toBe(false);
  expect(fake.calls).toEqual(["list", "list"]);
});

test("C-LIFE-10 empty recovery reads cannot clear unknown original-group ownership", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const record = new DescendantRecord();
  const tree = [leaderRow, hook(5002, { pgid: LEADER })];
  record.observeFirst(tree, LEADER, Date.now());
  record.observeLeaderGroup(tree, LEADER, Date.now());
  expect(record.unsafeSurvivorGroups([hook(5003, { pgid: LEADER })])).toEqual(new Set([LEADER]));
  const fake = scripted([[]]);
  const first = reapInBackground(record, fake.ops, serialized());
  await vi.advanceTimersByTimeAsync(0);
  expect(first.resolved()).toBe(false);
  const second = reapInBackground(record, fake.ops, serialized());
  await vi.advanceTimersByTimeAsync(BACKGROUND_REAP_RETRY_WINDOW_MS + 1);
  expect(first.resolved()).toBe(false);
  expect(second.resolved()).toBe(false);
  expect(fake.calls).toEqual(["list", "list"]);
});

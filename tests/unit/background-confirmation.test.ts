/** Explicit retries confirm retained evidence with a bounded referenced read (C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  BACKGROUND_REAP_RETRY_WINDOW_MS,
  reapInBackground,
} from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import type { SweepOps } from "../../src/runtime/shutdown/detached-sweep/rounds.ts";
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
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function recorded() {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow, hook(5002)], LEADER);
  return record;
}
const serialize = () => {
  const queue = new SerialDetachedSweepQueue();
  return <T>(attempt: () => Promise<T>) => queue.run(attempt);
};
const expiry = () => {
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
};

test("C-LIFE-10 confirmation starts only after expiry, and never for empty or resolved records", async () => {
  const fake = scripted([[]]);
  const empty = reapInBackground(new DescendantRecord(), fake.ops, serialize());
  const resolved = reapInBackground(recorded(), fake.ops, serialize());
  expect(resolved.confirm()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved.resolved()).toBe(true);
  expiry();
  expect(resolved.confirm()).toBeUndefined();
  expect(empty.confirm()).toBeUndefined();
  expect(empty.resolved()).toBe(false);
});

test("C-LIFE-10 fresh live or unreadable confirmation stays unresolved until matching identities disappear", async () => {
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  let rows = [hook(5002)];
  let unreadable = false;
  const read = vi.fn(() => (unreadable ? Promise.reject(errno("EIO")) : Promise.resolve(rows)));
  const recovery = reapInBackground(recorded(), fake.ops, serialize(), {
    ...fake.ops,
    listProcesses: read,
  });
  await vi.advanceTimersByTimeAsync(0);
  expiry();
  await recovery.confirm();
  expect(recovery.resolved()).toBe(false);
  unreadable = true;
  await recovery.confirm();
  expect(recovery.resolved()).toBe(false);
  unreadable = false;
  rows = [{ ...hook(5002), startedAt: "Mon Jan 1 00:00:00 2001" }];
  await recovery.confirm();
  expect(recovery.resolved()).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
  expect(fake.calls).toEqual([]);
});

test.each([
  false,
  true,
])("C-LIFE-10 unknown ownership or restoration cannot be confirmed (%s)", async (unknownResume) => {
  const record = recorded();
  if (unknownResume) record.markUnknownResume();
  else record.known = false;
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  const recovery = reapInBackground(record, fake.ops, serialize(), {
    ...fake.ops,
    listProcesses: () => Promise.resolve([]),
  });
  await vi.advanceTimersByTimeAsync(0);
  expiry();
  await recovery.confirm();
  expect(recovery.resolved()).toBe(false);
});

test("C-LIFE-10 concurrent confirmations reuse conclusive evidence and retain new roots and daemon paths", async () => {
  const record = recorded();
  const fake = scripted([], {
    listProcesses: (_ms, scope) => {
      scope?.known.add("confirmed daemon path");
      return Promise.reject(errno("EIO"));
    },
  });
  const read = vi.fn<SweepOps["listProcesses"]>((_ms, scope) => {
    expect(scope?.roots).toEqual(new Set([5002, 5003]));
    expect(scope?.known.has("confirmed daemon path")).toBe(true);
    return Promise.resolve([]);
  });
  const recovery = reapInBackground(record, fake.ops, serialize(), {
    ...fake.ops,
    listProcesses: read,
  });
  await vi.advanceTimersByTimeAsync(0);
  record.observeGroups([hook(5003)], new Map([[5003, new Set()]]), Date.now());
  expiry();
  await Promise.all([recovery.confirm(), recovery.confirm(), recovery.confirm()]);
  expect(recovery.resolved()).toBe(true);
  expect(read).toHaveBeenCalledOnce();
});

test("C-LIFE-10 expired confirmation retries matching stopped restoration without restarting kills", async () => {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow], LEADER);
  const held = { ...leaderRow, stopped: true };
  record.resumes.remember([held], LEADER);
  const fake = scripted([[held]], {
    continueGroup: () => {
      throw errno("EPERM");
    },
  });
  const restored: number[] = [];
  const recovery = reapInBackground(record, fake.ops, serialize(), {
    ...fake.ops,
    continueGroup: (group) => {
      restored.push(group);
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expiry();
  await recovery.confirm();
  expect(recovery.resolved()).toBe(true);
  expect(restored).toEqual([LEADER]);
  expect(fake.calls).toEqual(["list", "list"]);
});

test("C-LIFE-10 an ambiguous recorded survivor stays unresolved until it disappears", async () => {
  const record = recorded();
  const ambiguous = hook(5003);
  record.observeGroups(
    [ambiguous],
    new Map([[5003, new Set()]]),
    Date.parse(`${ambiguous.startedAt} UTC`),
  );
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  let rows = [ambiguous];
  const recovery = reapInBackground(record, fake.ops, serialize(), {
    ...fake.ops,
    listProcesses: () => Promise.resolve(rows),
  });
  await vi.advanceTimersByTimeAsync(0);
  expiry();
  await recovery.confirm();
  expect(recovery.resolved()).toBe(false);
  expect(fake.calls).toEqual([]);
  rows = [];
  await recovery.confirm();
  expect(recovery.resolved()).toBe(true);
});

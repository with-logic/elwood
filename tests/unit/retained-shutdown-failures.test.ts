/** Retained failures clear only after every owned record is confirmed resolved (C-LIFE-10). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { RetainedShutdownFailures } from "../../src/runtime/shutdown/detached-sweep/retained-failures.ts";
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
function recorded(pid = 5002) {
  const record = new DescendantRecord();
  record.observeFirst([leaderRow], LEADER, Date.now());
  record.observe([leaderRow, hook(pid)], LEADER);
  return record;
}
function manager(ops: ConstructorParameters<typeof RetainedShutdownFailures>[0]) {
  const queue = new SerialDetachedSweepQueue();
  return new RetainedShutdownFailures(ops, (attempt) => queue.run(attempt));
}
const failure = Object.assign(new Error("original cleanup failed"), { processGroupIds: [5002] });

test("C-LIFE-10 the original attempt rejects even when automatic recovery resolves immediately", async () => {
  const fake = scripted([[]]);
  const failures = manager(fake.ops);
  failures.keep(undefined, recorded());
  expect(failures.confirm()).toBeUndefined();
  expect(() => failures.throwIfUnresolved()).not.toThrow();
  expect(() => failures.keep(failure, recorded())).toThrow(failure);
  expect(() => failures.throwIfUnresolved()).toThrow(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(() => failures.throwIfUnresolved()).not.toThrow();
  expect(failures.confirm()).toBeUndefined();
});

test("C-LIFE-10 separate background and referenced readers confirm all retained records", async () => {
  const background = vi.fn(() => Promise.reject(errno("EIO")));
  let live = [hook(5003)];
  const foreground = vi.fn(() => Promise.resolve(live));
  const failures = manager({
    ...scripted([]).ops,
    listProcesses: foreground,
    listProcessesUnreferenced: background,
  });
  expect(() => failures.keep(failure, recorded())).toThrow(failure);
  const second = Object.assign(new Error("second failed"), { processGroupIds: [5003] });
  expect(() => failures.keep(second, recorded(5003))).toThrow(second);
  await vi.advanceTimersByTimeAsync(0);
  expect(foreground).not.toHaveBeenCalled();
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  await failures.confirm();
  expect(() => failures.throwIfUnresolved()).toThrow(failure);
  live = [];
  await failures.confirm();
  expect(() => failures.throwIfUnresolved()).not.toThrow();
  expect(background).toHaveBeenCalledTimes(2);
  expect(foreground).toHaveBeenCalledTimes(3);
});

test("C-LIFE-10 an unknown older record keeps the original failure after newer records resolve", async () => {
  const failures = manager(scripted([[]]).ops);
  expect(() => failures.keep(failure, new DescendantRecord())).toThrow(failure);
  expect(() =>
    failures.keep(Object.assign(new Error("later"), { processGroupIds: [] }), recorded()),
  ).toThrow("later");
  await vi.advanceTimersByTimeAsync(0);
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  await failures.confirm();
  expect(() => failures.throwIfUnresolved()).toThrow(failure);
});

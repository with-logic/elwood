/** A graceful owner reaps original groups through one verified cleanup (C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_REAP_RETRY_WINDOW_MS } from "../../src/runtime/shutdown/detached-sweep/background.ts";
import { RetainedShutdownFailures } from "../../src/runtime/shutdown/detached-sweep/retained-failures.ts";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import {
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";
import { survivorGuard } from "../helpers/survivor-guard.ts";

useScriptedHost();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("C-LIFE-10 explicit reaping verifies a live original leader and same-group helper", async () => {
  const fake = scripted([[leaderRow, hook(5001, { pgid: LEADER }), hook(5002)]]);
  const keep = vi.fn();
  const watch = watchSurvivors(LEADER, fake.ops, () => false, keep, survivorGuard());
  await watch.firstRead;
  await watch.reap();
  expect(fake.calls).toContain(`stop ${LEADER}`);
  expect(fake.calls).toContain(`kill ${LEADER}`);
  expect(fake.calls).toContain("kill 5002");
  expect(keep).toHaveBeenCalledExactlyOnceWith(undefined, expect.anything());
});

test("C-LIFE-10 replacement leader-group owners are spared while detached originals are reaped", async () => {
  const child = hook(5002);
  const originalHelper = hook(5001, { pgid: LEADER });
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  const fake = scripted([
    [leaderRow, originalHelper, child],
    [replacement, { ...child, ppid: 1 }],
  ]);
  const keep = vi.fn();
  const watch = watchSurvivors(LEADER, fake.ops, () => true, keep, survivorGuard());
  await watch.finish();
  expect(keep).toHaveBeenCalledWith(
    expect.objectContaining({ processGroupIds: [LEADER] }),
    expect.anything(),
  );
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain(`stop ${LEADER}`);
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
});

test("C-LIFE-10 finish and explicit reap share one queued cleanup and retained outcome", async () => {
  const fake = scripted([[leaderRow, hook(5001, { pgid: LEADER })]]);
  const keep = vi.fn();
  const guard = survivorGuard();
  const watch = watchSurvivors(LEADER, fake.ops, () => true, keep, guard);
  await watch.firstRead;
  const gate = Promise.withResolvers<void>();
  const held = guard.serialize(() => gate.promise);
  const finishing = watch.finish();
  const reaping = watch.reap();
  expect(watch.reap()).toBe(reaping);
  await Promise.resolve();
  expect(fake.calls).toEqual(["list"]);
  gate.resolve();
  await held;
  await Promise.all([finishing, reaping]);
  const completed = [...fake.calls];
  await watch.reap();
  await watch.finish();
  expect(fake.calls).toEqual(completed);
  expect(fake.calls.filter((call) => call === `kill ${LEADER}`)).toHaveLength(1);
  expect(keep).toHaveBeenCalledExactlyOnceWith(undefined, expect.anything());
});

test("C-LIFE-10 missing targets refuse explicit reaping without signals", async () => {
  const fake = scripted([]);
  const keep = vi.fn();
  const watch = watchSurvivors(undefined, fake.ops, () => false, keep, survivorGuard());
  await expect(watch.reap()).rejects.toThrow("No safe leader signal target.");
  await watch.finish(true);
  expect(keep).toHaveBeenCalledOnce();
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 a rejected retained cleanup is not repeated by finish", async () => {
  const failure = new Error("retained failure");
  const fake = scripted([[leaderRow]]);
  const keep = vi.fn(() => {
    throw failure;
  });
  const watch = watchSurvivors(LEADER, fake.ops, () => false, keep, survivorGuard());
  await watch.firstRead;
  await expect(watch.reap()).rejects.toBe(failure);
  const completed = [...fake.calls];
  await expect(watch.finish(true)).rejects.toBe(failure);
  expect(keep).toHaveBeenCalledOnce();
  expect(fake.calls).toEqual(completed);
});

test("C-LIFE-10 failed graceful finish retains unmatched original-group ownership", async () => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([]);
  let recording = true;
  let later = [hook(5003, { pgid: LEADER, ppid: 1 })];
  const ops = {
    ...fake.ops,
    listProcesses: () => Promise.resolve(recording ? fake.asRead([leaderRow]) : later),
    listProcessesUnreferenced: () => Promise.resolve(later),
  };
  const guard = survivorGuard();
  const failures = new RetainedShutdownFailures(ops, guard.serialize);
  const watch = watchSurvivors(
    LEADER,
    ops,
    () => false,
    (failure, record) => failures.keep(failure, record),
    guard,
  );
  await watch.firstRead;
  await expect(
    watch.sendSignal(() => {
      throw new Error("PTY send failed");
    }),
  ).rejects.toThrow("PTY send failed");
  const originalSignals = [...fake.calls];
  recording = false;
  const original = await watch.finish(true).catch((error: unknown) => error);
  expect(original).toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(0);
  await expect(Promise.resolve().then(() => failures.throwIfUnresolved())).rejects.toBe(original);
  later = [];
  clock = BACKGROUND_REAP_RETRY_WINDOW_MS;
  await failures.confirm();
  await expect(Promise.resolve().then(() => failures.throwIfUnresolved())).rejects.toBe(original);
  expect(originalSignals).toEqual([`stop ${LEADER}`, `cont ${LEADER}`]);
  expect(fake.calls).toEqual(originalSignals);
});

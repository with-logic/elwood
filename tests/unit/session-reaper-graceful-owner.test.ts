/** Graceful ownership survives exit, replacement and later force paths (C-LIFE-10). */
import { expect, test, vi } from "vitest";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { SessionReaper } from "../../src/runtime/shutdown/reap-tree.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";

useScriptedHost();

test("C-LIFE-10 the cached graceful owner spares replacements through exit and final reaps", async () => {
  const child = hook(5002);
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  let exited = false;
  const fake = scripted([]);
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () =>
      Promise.resolve(
        fake.asRead(exited ? [replacement, { ...child, ppid: 1 }] : [leaderRow, child]),
      ),
  });
  const watch = reaper.watchSurvivors(() => exited);
  expect(reaper.watchSurvivors(() => true)).toBe(watch);
  await watch.sendSignal(() => {
    exited = true;
    reaper.reap();
  });
  expect(() => reaper.signalLeaderPty(() => fake.calls.push("unsafe PTY signal"))).toThrow(
    "verified leader-group cleanup",
  );
  const afterTerm = fake.calls.length;
  await expect(reaper.sweepDetached(() => false)).rejects.toMatchObject({
    processGroupIds: [LEADER],
  });
  await expect(watch.finish()).rejects.toMatchObject({ processGroupIds: [LEADER] });
  expect(fake.calls.slice(afterTerm)).not.toContain(`stop ${LEADER}`);
  const completed = [...fake.calls];
  reaper.reap();
  await expect(reaper.sweepDetached(() => false)).rejects.toMatchObject({
    processGroupIds: [LEADER],
  });
  expect(reaper.watchSurvivors(() => false)).toBe(watch);
  await expect(watch.sendSignal(() => fake.calls.push("late TERM"))).rejects.toMatchObject({
    processGroupIds: [LEADER],
  });
  expect(fake.calls).toEqual(completed);
  expect(fake.calls).toContain("kill 5002");
  expect(fake.calls).not.toContain(`kill ${LEADER}`);
});

test("C-LIFE-10 native exit during the first read permanently vetoes later numeric reaps", async () => {
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([], { listProcesses: () => first.promise });
  const reaper = new SessionReaper(LEADER, fake.ops);
  const watch = reaper.watchSurvivors(() => true);
  expect(() => reaper.reap()).toThrow("before signal ownership was verified");
  first.resolve([]);
  await watch.firstRead;
  await expect(watch.finish()).rejects.toThrow("before signal ownership was verified");
  expect(() => reaper.reap()).toThrow("before signal ownership was verified");
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 failed first ownership remains refused for cached retries and force cleanup", async () => {
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  const reaper = new SessionReaper(LEADER, fake.ops);
  const watch = reaper.watchSurvivors(() => false);
  expect(await watch.firstObservation).toMatchObject({ kind: "refused" });
  await expect(watch.sendSignal(() => fake.calls.push("unsafe TERM"))).rejects.toMatchObject({
    code: "EIO",
  });
  await expect(watch.finish(true)).rejects.toMatchObject({ processGroupIds: [] });
  expect(reaper.watchSurvivors(() => true)).toBe(watch);
  await expect(reaper.sweepDetached(() => false)).rejects.toMatchObject({ processGroupIds: [] });
  expect(() => reaper.reapAndThrowOnDetachedSweepFailure()).toThrow(
    "First leader process-table read failed",
  );
  expect(fake.calls).toEqual([]);
});

test("C-LIFE-10 an earlier forced-sweep failure survives verified graceful cleanup", async () => {
  let readable = false;
  const fake = scripted([]);
  const reaper = new SessionReaper(LEADER, {
    ...fake.ops,
    listProcesses: () =>
      readable ? Promise.resolve(fake.asRead([leaderRow])) : Promise.reject(errno("EIO")),
  });
  await expect(reaper.sweepDetached(() => false)).rejects.toMatchObject({ code: "EIO" });
  readable = true;
  const watch = reaper.watchSurvivors(() => false);
  await watch.firstRead;
  const before = [...fake.calls];
  await expect(watch.sendSignal(() => fake.calls.push("unsafe TERM"))).rejects.toMatchObject({
    code: "EIO",
  });
  expect(fake.calls).toEqual(before);
  await expect(watch.reap()).rejects.toMatchObject({ code: "EIO" });
  const completed = [...fake.calls];
  await expect(reaper.sweepDetached(() => false)).rejects.toMatchObject({ code: "EIO" });
  expect(fake.calls).toEqual(completed);
});

async function completedWatchOutcome(reaper: SessionReaper, fake: ReturnType<typeof scripted>) {
  const send = vi.fn();
  reaper.signalLeaderPty(send);
  await reaper.sweepDetached(() => false);
  const completed = fake.calls.length;
  const watch = reaper.watchSurvivors(() => false);
  await watch.firstRead;
  const signal = await watch.sendSignal(() => fake.calls.push("unsafe TERM"));
  await watch.reap();
  await watch.finish();
  return {
    groupSignals: send.mock.calls,
    signal,
    observation: (await watch.firstObservation).kind,
    extra: fake.calls.slice(completed),
  };
}

test("C-LIFE-10 a successfully reaped group exposes an inert completed watch", async () => {
  const fake = scripted([]);
  const reaper = new SessionReaper(LEADER, fake.ops);
  reaper.reap();
  expect(await completedWatchOutcome(reaper, fake)).toEqual({
    groupSignals: [],
    signal: "leader-group-gone",
    observation: "gone",
    extra: [],
  });
});

test("C-LIFE-10 a confirmed-gone group exposes an inert completed watch", async () => {
  const fake = scripted([], {
    stopGroup: () => {
      throw errno("ESRCH");
    },
  });
  const reaper = new SessionReaper(LEADER, fake.ops);
  await reaper.sweepDetached(() => false);
  expect(await completedWatchOutcome(reaper, fake)).toEqual({
    groupSignals: [],
    signal: "leader-group-gone",
    observation: "gone",
    extra: [],
  });
});

test("C-LIFE-10 graceful ESRCH keeps its original observation and an inert cleanup", async () => {
  const fake = scripted([[leaderRow], []], {
    stopGroup: () => {
      throw errno("ESRCH");
    },
  });
  const reaper = new SessionReaper(LEADER, fake.ops);
  await reaper.watchSurvivors(() => false).sendSignal(() => fake.calls.push("unsafe TERM"));
  expect(await completedWatchOutcome(reaper, fake)).toEqual({
    groupSignals: [],
    signal: "leader-group-gone",
    observation: "observed",
    extra: [],
  });
});

test("C-LIFE-10 a completed watch still reports earlier unresolved sweep errors", async () => {
  const fake = scripted([], { listProcesses: () => Promise.reject(errno("EIO")) });
  const reaper = new SessionReaper(LEADER, fake.ops);
  await expect(reaper.sweepDetached(() => false)).rejects.toMatchObject({ code: "EIO" });
  reaper.reap();
  const watch = reaper.watchSurvivors(() => false);
  await expect(watch.finish()).rejects.toMatchObject({ code: "EIO" });
  await expect(watch.reap()).rejects.toMatchObject({ code: "EIO" });
});

test.each([
  0, 1,
])("C-LIFE-10 unsafe leader %s cannot create graceful signal authority", async (pid) => {
  const fake = scripted([[leaderRow]]);
  const watch = new SessionReaper(pid, fake.ops).watchSurvivors(() => false);
  expect(await watch.firstObservation).toMatchObject({ kind: "refused" });
  await expect(watch.reap()).rejects.toThrow("No safe leader signal target");
  await watch.finish();
  expect(fake.calls).toEqual([]);
});

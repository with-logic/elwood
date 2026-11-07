/** The private watch keeps original signal authority and its deadline (PRD §5.3, C-LIFE-10). */
import { afterEach, expect, test, vi } from "vitest";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import { RECORD_READ_MS } from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import {
  errno,
  hook,
  LEADER,
  leaderRow,
  scripted,
  useScriptedHost,
} from "../helpers/scripted-process-tree.ts";
import { survivorGuard } from "../helpers/survivor-guard.ts";

useScriptedHost();

afterEach(() => vi.restoreAllMocks());

test.each([
  "refused",
  "gone",
])("C-LIFE-10 initial %s authority forbids later leader signals", async (kind) => {
  const failure = errno("EIO");
  const fake = scripted(
    [],
    kind === "refused" ? { listProcesses: () => Promise.reject(failure) } : {},
  );
  const guard = survivorGuard();
  const forbidden = vi.spyOn(guard, "forbid");
  const watch = watchSurvivors(
    LEADER,
    fake.ops,
    () => false,
    () => undefined,
    guard,
  );
  expect(await watch.firstObservation).toMatchObject({ kind });
  expect(forbidden).toHaveBeenCalledOnce();
  const delivered = vi.fn();
  await expect(watch.sendSignal(delivered)).rejects.toBeInstanceOf(Error);
  await watch.finish();
  expect(delivered).not.toHaveBeenCalled();
  expect(fake.calls).not.toContain(`stop ${LEADER}`);
});

test("C-LIFE-10 a replacement identity after the first read receives neither TERM nor CONT", async () => {
  const replacement = { ...leaderRow, startedAt: "Sun Oct 25 22:00:09 2026" };
  const fake = scripted([[leaderRow], [replacement]]);
  const delivered = vi.fn();
  const watch = watchSurvivors(
    LEADER,
    fake.ops,
    () => false,
    () => undefined,
    survivorGuard(),
  );
  await watch.firstRead;
  await expect(watch.sendSignal(delivered)).rejects.toThrow("not confirmed held");
  await watch.finish();
  expect(delivered).not.toHaveBeenCalled();
  expect(fake.calls).not.toContain(`cont ${LEADER}`);
});

test("C-LIFE-10 queued signal admission spends the watch's original deadline", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const fake = scripted([[leaderRow]]);
  const guard = survivorGuard();
  const gate = Promise.withResolvers<void>();
  const held = guard.serialize(() => gate.promise);
  const watch = watchSurvivors(
    LEADER,
    fake.ops,
    () => false,
    () => undefined,
    guard,
  );
  await watch.firstRead;
  const delivered = vi.fn();
  const pending = expect(watch.sendSignal(delivered)).rejects.toMatchObject({ code: "ETIMEDOUT" });
  clock = RECORD_READ_MS + 1;
  gate.resolve();
  await held;
  await pending;
  await watch.finish();
  expect(delivered).not.toHaveBeenCalled();
  expect(fake.calls).not.toContain(`stop ${LEADER}`);
});

test("C-LIFE-10 held signaling and survivor reaping share the session queue and retained record", async () => {
  const tree = [leaderRow, hook(5002)];
  const fake = scripted([tree, tree, [hook(5002, { ppid: 1 })]]);
  const guard = survivorGuard();
  const gate = Promise.withResolvers<void>();
  const held = guard.serialize(() => gate.promise);
  let exited = false;
  let delivered = 0;
  const keep = vi.fn();
  const watch = watchSurvivors(LEADER, fake.ops, () => exited, keep, guard);
  await watch.firstRead;
  const signaling = watch.sendSignal(() => {
    delivered += 1;
    exited = true;
  });
  await Promise.resolve();
  expect(delivered).toBe(0);
  expect(fake.calls).not.toContain(`stop ${LEADER}`);
  gate.resolve();
  await held;
  expect(await signaling).toBe("signal-sent");
  await watch.finish();
  expect(delivered).toBe(1);
  expect(keep).toHaveBeenCalledExactlyOnceWith(undefined, expect.objectContaining({ known: true }));
  expect(keep.mock.calls[0]?.[1].pids).toEqual([5002]);
  expect(fake.calls).toContain("kill 5002");
});

test("C-LIFE-10 whole-group disappearance reaps recorded survivors without a leader exit event", async () => {
  const fake = scripted([[leaderRow, hook(5002)], []]);
  const keep = vi.fn();
  const delivered = vi.fn();
  const watch = watchSurvivors(LEADER, fake.ops, () => false, keep, survivorGuard());
  await watch.firstRead;
  expect(await watch.sendSignal(delivered)).toBe("leader-group-gone");
  await watch.finish();
  expect(delivered).not.toHaveBeenCalled();
  expect(keep).toHaveBeenCalledOnce();
});

test("C-LIFE-10 pending first observation keeps signal admission ahead of later passes", async () => {
  const first = Promise.withResolvers<readonly ProcessEntry[]>();
  const fake = scripted([[leaderRow]]);
  const list = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(fake.ops.listProcesses);
  const guard = survivorGuard();
  const events: string[] = [];
  const watch = watchSurvivors(
    LEADER,
    { ...fake.ops, listProcesses: list },
    () => false,
    () => undefined,
    guard,
  );
  expect(list).toHaveBeenCalledTimes(1);
  const signaling = watch.sendSignal(() => {
    events.push("TERM");
  });
  const later = guard.serialize(() => {
    events.push("later");
    return Promise.resolve();
  });
  await Promise.resolve();
  expect(events).toEqual([]);
  first.resolve([leaderRow]);
  await signaling;
  await later;
  await watch.finish();
  expect(events).toEqual(["TERM", "later"]);
});

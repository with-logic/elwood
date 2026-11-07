/** Bound graceful observation work and retain unreadable gaps (C-LIFE-10). */
import { ok as assert } from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";
import type { DescendantRecord } from "../../src/runtime/shutdown/detached-sweep/record.ts";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
import { reapRecordedSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivors.ts";
import {
  RECORD_INTERVAL_MS,
  watchDescendants,
} from "../../src/runtime/shutdown/detached-sweep/watch-descendants.ts";
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
afterEach(() => vi.useRealTimers());

test("C-LIFE-10 later observations wait a full interval and finish cancels the timer", async () => {
  vi.useFakeTimers();
  const fake = scripted([[leaderRow]]);
  const watch = watchDescendants(LEADER, fake.ops, () => false);
  await watch.firstRead;
  expect(fake.calls).toEqual(["list"]);
  await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS - 1);
  expect(fake.calls).toEqual(["list"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.calls).toEqual(["list", "list"]);
  await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 3);
  expect(fake.calls).toHaveLength(5);
  await watch.finish();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 10);
  expect(fake.calls).toHaveLength(5);
});

test("C-LIFE-10 unreadable observation gaps remain failures after known survivors are reaped", async () => {
  vi.useFakeTimers();
  const child = hook(5002);
  const tree = [leaderRow, child];
  const fake = scripted([tree, tree, [{ ...child, ppid: 1 }]]);
  let reads = 0;
  let exited = false;
  let retained: DescendantRecord | undefined;
  const keep = vi.fn((_: unknown, record: DescendantRecord) => {
    retained = record;
  });
  const watch = watchSurvivors(
    LEADER,
    {
      ...fake.ops,
      listProcesses: (...args) =>
        ++reads === 2 ? Promise.reject(errno("EIO")) : fake.ops.listProcesses(...args),
    },
    () => exited,
    keep,
    survivorGuard(),
  );
  await watch.firstRead;
  await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 2);
  exited = true;
  await watch.finish();
  expect(fake.calls).toContain("kill 5002");
  expect(keep).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: "Could not reap detached descendants: process table unreadable (EIO)",
      code: "EIO",
      processGroupIds: [],
    }),
    expect.anything(),
  );
  assert(retained !== undefined);
  const later = await reapRecordedSurvivors(retained, scripted([]).ops);
  expect(later).toMatchObject({ code: "EIO", processGroupIds: [] });
  expect(later?.message).not.toContain("raw");
});

test.each([
  false,
  true,
])("C-LIFE-10 a watch ending before exit retains sanitized observation failures (failed=%s)", async (failed) => {
  vi.useFakeTimers();
  const listProcesses = vi
    .fn()
    .mockResolvedValueOnce([leaderRow])
    .mockRejectedValueOnce(errno("EIO"))
    .mockRejectedValueOnce(new Error("secret process output"));
  const keep = vi.fn();
  const watch = watchSurvivors(
    LEADER,
    { ...scripted([]).ops, listProcesses },
    () => false,
    keep,
    survivorGuard(),
  );
  await watch.firstRead;
  await vi.advanceTimersByTimeAsync(RECORD_INTERVAL_MS * 2);
  await watch.finish(failed);
  expect(keep).toHaveBeenCalledOnce();
  expect(keep.mock.calls[0]?.[0]).toMatchObject({ code: "EIO", processGroupIds: [] });
  const message = keep.mock.calls[0]?.[0].message;
  expect(message).toContain("process table unreadable (EIO)");
  expect(message).not.toContain("secret");
  expect(message.includes("exit was not confirmed")).toBe(failed);
});

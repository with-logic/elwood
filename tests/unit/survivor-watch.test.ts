/**
 * A graceful stop's watch for the detached descendants its leader leaves (PRD §5.3 and
 * §9.4, C-LIFE-10): it records from the read before the SIGTERM until it is finished, then
 * reaps what it recorded only if `leaderExited` reports the exit, and hands the outcome,
 * a failure included, to `keep` once. Injected process operations only.
 */

import { ok as assert } from "node:assert/strict";
import { setImmediate as yieldTask } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { watchSurvivors } from "../../src/runtime/shutdown/detached-sweep/survivor-watch.ts";
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

/** The leader's tree as the read before the SIGTERM shows it, then as its exit leaves it. */
const tree = [leaderRow, hook(5002), hook(5003, { ppid: 5002, pgid: 5002 })];
const orphaned: readonly ProcessEntry[] = [
  hook(5002, { ppid: 1 }),
  hook(5003, { ppid: 5002, pgid: 5002 }),
];

describe("C-LIFE-10 a graceful stop's survivor watch", () => {
  test("a missing leader PID is refused and failed termination retains unknown ownership", async () => {
    const { ops, calls } = scripted([orphaned]);
    const keep = vi.fn();
    const guard = survivorGuard();
    const gone = vi.spyOn(guard, "gone");
    const watch = watchSurvivors(undefined, ops, () => true, keep, guard);
    await watch.firstRead;
    const observation = await watch.firstObservation;
    expect(observation).toMatchObject({
      kind: "refused",
      error: { message: "No safe leader signal target." },
    });
    const delivered = vi.fn();
    assert(observation.kind === "refused");
    await expect(watch.sendSignal(delivered)).rejects.toBe(observation.error);
    await watch.finish();
    expect(keep).not.toHaveBeenCalled();
    await watch.finish(true);
    expect(keep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("no read showed the leader's tree"),
      }),
      expect.objectContaining({ known: false, pids: [] }),
    );
    expect(calls).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  test("a leader not seen to exit is not reaped after", async () => {
    const { ops, calls } = scripted([tree]);
    const keep = vi.fn();
    const watch = watchSurvivors(LEADER, ops, () => false, keep, survivorGuard());
    await watch.firstRead;
    await watch.finish();
    expect(new Set(calls)).toEqual(new Set(["list"]));
    expect(keep).not.toHaveBeenCalled();
  });

  test("once the leader is gone, the recorded survivors are reaped and the outcome kept", async () => {
    const { ops, calls } = scripted([tree, orphaned]);
    const keep = vi.fn();
    const watch = watchSurvivors(LEADER, ops, () => true, keep, survivorGuard());
    await watch.firstRead;
    await watch.finish();
    expect(calls.join(", ")).toBe("list, list, stop 5002, list, list, kill 5002");
    expect(keep).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ known: true }),
    );
    expect(keep.mock.calls[0]?.[1].pids).toEqual([5002, 5003, LEADER]);
  });

  test("a reap that fails hands its failure to keep, once", async () => {
    const refusingStop = () => {
      throw errno("EPERM");
    };
    const { ops } = scripted([tree, orphaned], { stopGroup: refusingStop });
    const keep = vi.fn();
    const watch = watchSurvivors(LEADER, ops, () => true, keep, survivorGuard());
    await watch.firstRead;
    await watch.finish();
    expect(keep).toHaveBeenCalledOnce();
    expect(keep.mock.calls[0]?.[0]).toMatchObject({
      message:
        "Could not reap detached descendants: could not stop a live descendant group (EPERM)",
      processGroupIds: [5002],
    });
  });

  test("a failed termination retains its record even before leader exit is confirmed", async () => {
    const { ops } = scripted([tree]);
    const keep = vi.fn();
    const watch = watchSurvivors(LEADER, ops, () => false, keep, survivorGuard());
    await watch.firstRead;
    await watch.finish(true);
    expect(keep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("leader's exit was not confirmed"),
      }),
      expect.objectContaining({ known: true }),
    );
    expect(keep.mock.calls[0]?.[1].pids).toEqual([5002, 5003, LEADER]);
  });
  test("whole-group disappearance queues reaping of a live recorded child", async () => {
    const child = hook(5002);
    const fake = scripted([[leaderRow, child], [], [{ ...child, ppid: 1 }]]);
    const guard = survivorGuard();
    const keep = vi.fn();
    const delivered = vi.fn();
    const watch = watchSurvivors(LEADER, fake.ops, () => false, keep, guard);
    await watch.firstRead;
    expect(await watch.sendSignal(delivered)).toBe("leader-group-gone");
    const gate = Promise.withResolvers<void>();
    const held = guard.serialize(() => gate.promise);
    const beforeReap = [...fake.calls];
    const finishing = watch.finish();
    try {
      await yieldTask();
      expect(fake.calls).toEqual(beforeReap);
      expect(keep).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await held;
      await finishing;
    }
    expect(fake.calls.slice(beforeReap.length)).toEqual([
      "list",
      "stop 5002",
      "list",
      "list",
      "kill 5002",
    ]);
    expect(delivered).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ known: true, pids: [5002, LEADER] }),
    );
  });
});

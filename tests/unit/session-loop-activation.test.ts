/** Pending loops stay inactive and transfer readiness atomically at commit (C-LOOP-17). */
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { SessionLoops } from "../../src/runtime/session/loops.ts";
import { reserveLaunchOwnership } from "../../src/state/launch-ownership.ts";
import { readLoopDefinitions } from "../../src/state/loop-store.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => vi.useRealTimers());

test("C-LOOP-17 readiness before commit schedules only the activated successor", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const stateDir = tempDir();
  const id = "loop-activation";
  const priorOwner = reserveLaunchOwnership(join(stateDir, "sessions", id));
  const priorWrites: string[] = [];
  const successorWrites: string[] = [];
  const build = (ownership: typeof priorOwner, writes: string[]) => {
    const queue = new ControlQueue(
      (input) => {
        writes.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    queue.markReady();
    return new SessionLoops({
      stateDir,
      elwoodSessionId: id,
      ownership,
      queue,
      definitions: readLoopDefinitions(stateDir, id),
      emitter: { emit: () => undefined },
    });
  };
  const prior = build(priorOwner, priorWrites);
  priorOwner.commit();
  prior.ready();
  prior.create({ mode: "idle", message: "one owner" });
  const pendingOwner = reserveLaunchOwnership(join(stateDir, "sessions", id));
  const successor = build(pendingOwner, successorWrites);
  try {
    const priorTimerCount = vi.getTimerCount();
    successor.start();
    successor.ready();
    expect(vi.getTimerCount()).toBe(priorTimerCount);
    await vi.advanceTimersByTimeAsync(30_000);
    prior.callerActivity();
    expect(priorWrites).toEqual([]);
    expect(successorWrites).toEqual([]);
    pendingOwner.commit();
    expect(vi.getTimerCount()).toBe(priorTimerCount);
    await vi.advanceTimersByTimeAsync(successor.list()[0]!.nextDueAt! - Date.now());
    expect(priorWrites).toEqual([]);
    expect(successorWrites).toEqual(["one owner"]);
  } finally {
    prior.pause();
    successor.pause();
    pendingOwner.release();
  }
});

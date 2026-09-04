/** Shared runtime loop-controller delivery tests (PRD §5.9, C-LOOP-05/17). */

import { afterEach, describe, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue.ts";
import type { ElwoodLoopEvent } from "../../src/core/loops/types.ts";
import { SessionLoops } from "../../src/runtime/session-loops.ts";
import { tempDir } from "../claude/helpers.ts";

afterEach(() => vi.useRealTimers());

describe("SessionLoops", () => {
  test("scheduled delivery enters the attributed control queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const submitted: string[] = [];
    const queue = new ControlQueue(
      (input) => {
        submitted.push(input);
        return Promise.resolve();
      },
      () => new Error("closed"),
      () => undefined,
    );
    const loops = createLoops(queue);
    loops.turnStarted({ kind: "loop", loopId: "external" });
    loops.ready();
    queue.markReady();
    const loop = loops.create({ mode: "fixed", intervalMs: 60_000, message: "scheduled" });
    await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now());
    expect(submitted).toEqual(["scheduled"]);
  });

  test("cancelling an in-flight delivery exercises its queue abort boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const queue = new ControlQueue(
      (_input, _mode, signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
      () => new Error("closed"),
      () => undefined,
    );
    const loops = createLoops(queue);
    loops.ready();
    queue.markReady();
    const loop = loops.create({ mode: "fixed", intervalMs: 60_000, message: "scheduled" });
    await vi.advanceTimersByTimeAsync(loop.nextDueAt! - Date.now());
    loops.cancel(loop.id);
    await vi.runAllTimersAsync();
    expect(loops.list()).toEqual([]);
  });
});

function createLoops(queue: ControlQueue): SessionLoops {
  const stateDir = tempDir();
  return new SessionLoops({
    stateDir,
    elwoodSessionId: "session-loops",
    definitions: [],
    queue,
    emitter: { emit: (_event: "loop", _payload: ElwoodLoopEvent) => undefined },
  });
}

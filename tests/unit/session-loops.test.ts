/** Shared runtime loop-controller delivery tests (PRD §5.9, C-LOOP-05/17). */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { ElwoodLoopEvent } from "../../src/core/loops/types.ts";
import { SessionLoops } from "../../src/runtime/session/loops.ts";
import { type PersistedLoopDefinition, readLoopDefinitions } from "../../src/state/loop-store.ts";
import { tempDir } from "../helpers/tmp.ts";

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

  test("C-LOOP-17 cancelling an in-flight delivery aborts its queued write with a typed error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const aborts: unknown[] = [];
    const queue = new ControlQueue(
      (_input, _mode, signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborts.push(signal.reason);
              reject(signal.reason);
            },
            { once: true },
          ),
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
    // The queued write is aborted with the typed §10 error naming only the loop id.
    expect(aborts).toEqual([
      expect.objectContaining({ code: "loop_submission_failed", details: { loopId: loop.id } }),
    ]);
    expect(loops.list()).toEqual([]);
  });

  test("C-API-20 stale expiry pruning cannot overwrite a successor's loop sidecar", () => {
    vi.useFakeTimers();
    const start = 1_800_000_000_000;
    vi.setSystemTime(start);
    const queue = new ControlQueue(
      () => Promise.resolve(),
      () => new Error("closed"),
      () => undefined,
    );
    const stateDir = tempDir();
    let mayPersistLoops = true;
    const old = createLoops(queue, [], stateDir, () => mayPersistLoops);
    old.ready();
    const oldLoop = old.create({ mode: "fixed", intervalMs: 60_000, message: "old" });
    old.pause();
    mayPersistLoops = false;
    vi.setSystemTime(start + 86_400_000);
    const successor = createLoops(queue, [], stateDir);
    successor.ready();
    successor.cancel(oldLoop.id);
    const fresh = successor.create({ mode: "fixed", intervalMs: 60_000, message: "new" });
    successor.pause();
    vi.setSystemTime(start + 604_800_001);
    expect(old.list()).toEqual([]);
    expect(readLoopDefinitions(stateDir, "session-loops")).toEqual([
      expect.objectContaining({ id: fresh.id }),
    ]);
  });

  test("rejects unreadable durable loop state during activation", () => {
    const queue = new ControlQueue(
      () => Promise.resolve(),
      () => new Error("closed"),
      () => undefined,
    );
    const stateDir = join(tempDir(), "not-a-directory");
    writeFileSync(stateDir, "block persistence");
    expect(() => createLoops(queue, [], stateDir)).toThrowError(
      expect.objectContaining({ code: "state_corrupt" }),
    );
  });
});

function createLoops(
  queue: ControlQueue,
  definitions: readonly PersistedLoopDefinition[] = [],
  stateDir = tempDir(),
  mayPersistLoops = () => true,
): SessionLoops {
  return new SessionLoops({
    ownership: {
      canPersist: mayPersistLoops,
      onCommit: (activate) => activate(),
      onRevoked: () => undefined,
    },
    stateDir,
    elwoodSessionId: "session-loops",
    definitions,
    queue,
    emitter: { emit: (_event: "loop", _payload: ElwoodLoopEvent) => undefined },
  });
}

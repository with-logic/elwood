/**
 * Acceptance recovery must never outlive its turn (PRD §5.3/§5.8, C-API-58): once the
 * turn settles no further replay may fire, and the serializer slot is not released while
 * a replay WRITE is still outstanding. Driven through the real `runTurn` against a
 * scriptable `TurnSession`, because the bug lives in how the runner wires the two.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { collect, deferred, FakeTurnSession, runTurnFake } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());

/**
 * A session whose first submission reaches `running`/`ready` WITHOUT acceptance — the
 * ordering that arms the replay watchdog while the turn is still live. `order` records
 * every submission so a post-settle replay is visible, not merely counted.
 */
function armedSession(order: string[]): FakeTurnSession {
  const s = new FakeTurnSession();
  s.script = () => {
    order.push(`send#${s.submissions}`);
    if (s.submissions !== 1) return;
    s.emit("status", { status: "running" });
    s.emit("status", { status: "ready" });
  };
  return s;
}

describe("C-API-58 acceptance recovery is bounded by its turn", () => {
  test("a submission that rejects after readiness never replays the failed prompt", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const s = armedSession(order);
    const submission = deferred();
    s.sendResult = submission.promise;
    const events = collect(runTurnFake(s, { fallbackQuietMs: 10, drainMs: 1 }).events);
    const rejected = expect(events).rejects.toThrow("submission rejected");
    submission.reject(new Error("submission rejected"));
    await rejected;
    // Past two full quiet windows: a surviving watchdog would have replayed by now, putting
    // the failed prompt onto a session whose slot the serializer has already released.
    await vi.advanceTimersByTimeAsync(40);
    expect(order).toEqual(["send#1"]);
  });

  test("a terminal status disarms replay, so no later quiet window re-submits", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const s = armedSession(order);
    const events = collect(runTurnFake(s, { fallbackQuietMs: 10, drainMs: 1 }).events);
    events.catch(() => undefined);
    s.emit("status", { status: "stopped" }); // the agent is gone mid-quiet-window
    await vi.advanceTimersByTimeAsync(60);
    expect(order).toEqual(["send#1"]);
  });

  test("a consumer failure after ready disarms replay for every later quiet window", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const s = armedSession(order);
    // A whole-turn ceiling shorter than the quiet window fails the CONSUMER while the
    // watchdog is armed — the settle path that does not go through a terminal status.
    const events = collect(
      runTurnFake(s, { fallbackQuietMs: 50, drainMs: 1, timeoutMs: 5 }).events,
    );
    const rejected = expect(events).rejects.toMatchObject({ code: "wait_timeout" });
    await vi.advanceTimersByTimeAsync(6); // the ceiling fires, failing the consumer
    await rejected;
    await vi.advanceTimersByTimeAsync(300); // several quiet windows
    expect(order).toEqual(["send#1"]);
  });

  test("the slot is not released while a replay WRITE is still in flight", async () => {
    // A cancelled write can still be finishing asynchronous cleanup. Releasing the
    // boundary before its promise settles would free the captured images and let
    // the next turn start while that cleanup is outstanding.
    vi.useFakeTimers();
    const order: string[] = [];
    const s = armedSession(order);
    const replayWrite = deferred();
    const script = s.script;
    s.script = () => {
      script();
      if (s.submissions === 2) s.sendResult = replayWrite.promise; // the write hangs in the queue
    };
    const run = runTurnFake(s, { fallbackQuietMs: 10, drainMs: 1 });
    const events = collect(run.events);
    events.catch(() => undefined);
    void run.boundary.then(() => order.push("BOUNDARY"));
    await vi.advanceTimersByTimeAsync(11); // the quiet window fires replay #2; its write hangs
    s.emit("status", { status: "stopped" }); // the turn settles UNDER the pending write
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["send#1", "send#2"]); // the slot is still held
    replayWrite.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["send#1", "send#2", "BOUNDARY"]); // released only once quiesced
  });

  test("a replay write that REJECTS still releases the slot", async () => {
    // A failed write is settled: nothing is outstanding, so quiescing must not hang the
    // serializer forever on it.
    vi.useFakeTimers();
    const order: string[] = [];
    const s = armedSession(order);
    const replayWrite = deferred();
    const script = s.script;
    s.script = () => {
      script();
      if (s.submissions === 2) s.sendResult = replayWrite.promise;
    };
    const run = runTurnFake(s, { fallbackQuietMs: 10, drainMs: 1 });
    const events = collect(run.events);
    events.catch(() => undefined);
    void run.boundary.then(() => order.push("BOUNDARY"));
    await vi.advanceTimersByTimeAsync(11); // replay #2 fires; its write hangs
    s.emit("status", { status: "stopped" }); // the turn settles under the pending write
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["send#1", "send#2"]); // still held by the outstanding write
    replayWrite.reject(new Error("write failed"));
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["send#1", "send#2", "BOUNDARY"]); // a rejected write is settled too
  });
});

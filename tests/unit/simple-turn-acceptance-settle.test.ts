/**
 * Acceptance recovery must never outlive its turn (PRD §5.3/§5.8, C-API-48): once the
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

describe("C-API-48 acceptance recovery is bounded by its turn", () => {
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
      runTurnFake(s, { fallbackQuietMs: 50, drainMs: 100, timeoutMs: 5 }).events,
    );
    const rejected = expect(events).rejects.toMatchObject({ code: "wait_timeout" });
    await vi.advanceTimersByTimeAsync(6); // the ceiling fires, failing the consumer
    await rejected;
    await vi.advanceTimersByTimeAsync(300); // several quiet windows
    expect(order).toEqual(["send#1"]);
  });

  test.each([
    ["the slot is not released while a replay WRITE is still in flight", "resolve"],
    ["a replay write that REJECTS still releases the slot", "reject"],
  ] as const)("%s", async (_title, outcome) => {
    // A pending replay owns the slot until physical cleanup settles, even after
    // the turn stops. Both resolved and rejected writers release that ownership.
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
    await vi.advanceTimersByTimeAsync(11);
    s.emit("status", { status: "stopped" });
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["send#1", "send#2"]);
    if (outcome === "resolve") replayWrite.resolve();
    else replayWrite.reject(new Error("write failed"));
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(["send#1", "send#2", "BOUNDARY"]);
  });
});

test("C-API-48 an outstanding initial writer owns recovery until its physical settlement", async () => {
  vi.useFakeTimers();
  const s = new FakeTurnSession();
  const initial = deferred();
  s.sendResult = initial.promise;
  const turn = runTurnFake(s, { fallbackQuietMs: 10 });
  const events = collect(turn.events);
  s.emit("status", { status: "running" });
  s.emit("status", { status: "ready" });
  await vi.advanceTimersByTimeAsync(100);
  expect(s.submissions).toBe(1);
  s.emit("status", { status: "stopped" });
  initial.resolve();
  await events;
  await turn.boundary;
});

/**
 * Unit coverage for one ergonomic turn's LIFECYCLE races (PRD §5.8, C-API-48/51): a terminal
 * status arriving WHILE a submission is still pending ends the iterator cleanly and preserves
 * buffered content, and a late whole-turn timer cannot overwrite an already-succeeded turn.
 * These exercise the timing windows the deterministic completion path must survive, under
 * fake timers so each window is advanced explicitly rather than raced against the wall clock.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  activity,
  collect,
  deferred,
  drive,
  FakeTurnSession,
  runTurn,
} from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Resolves with the collected events once every pending fake timer has run. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  pending.catch(() => undefined); // a failing turn rejects before the caller awaits — not unhandled
  await vi.runAllTimersAsync();
  return pending;
}

describe("streamTurn lifecycle races (C-API-48/51)", () => {
  test("a terminal status DURING a pending submission ends cleanly and KEEPS buffered content", async () => {
    // The gate ends on a terminal status while `sendMessage` is still awaiting. When the send
    // then rejects `session_not_running`, the turn must NOT throw and must still yield the
    // content buffered before the terminal status — the completion is routed through the gate.
    const s = new FakeTurnSession();
    const send = deferred();
    s.sendResult = send.promise;
    s.script = () => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "buffered", turnId: "t1" })); // arrives before terminal
      s.emit("status", { status: "exited" }); // terminal ends the gate while send still pending
      // The pending submission now fails because the session is gone.
      send.reject(Object.assign(new Error("session not running"), { code: "session_not_running" }));
    };
    const events = runTurn(s, "go", { fallbackQuietMs: 20, catchUpMs: 5_000 }).events;
    expect(await settle(collect(events))).toEqual([{ type: "text", text: "buffered" }]); // no throw
  });

  test("a late whole-turn timer cannot overwrite an already-succeeded turn as a timeout", async () => {
    // The turn completes via the oracle, but a slow consumer drains the buffered events only
    // after `timeoutMs` would have elapsed. The success must stand — the late timer is a no-op
    // because end() already committed (first-completion-wins) and cleanup cancels the timer.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "ok" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "ok", turnId: "t1" })); // matches oracle → ends now
    });
    const turn = runTurn(s, "go", { timeoutMs: 10, catchUpMs: 5_000, fallbackQuietMs: 20 });
    // Wait past timeoutMs BEFORE draining — if the timer could overwrite success, it would fire.
    await vi.advanceTimersByTimeAsync(30);
    expect(await collect(turn.events)).toEqual([{ type: "text", text: "ok" }]); // success stands
    await expect(turn.completion).resolves.toBeUndefined();
  });

  test("the runner removes ALL its listeners once the turn settles (success)", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "ok" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "ok", turnId: "t1" }));
    });
    const turn = runTurn(s, "go", { catchUpMs: 5_000, fallbackQuietMs: 20 });
    await settle(collect(turn.events));
    await turn.boundary;
    expect(s.listenerCount()).toBe(0); // activity + hook + status listeners all detached
  });

  test("the runner removes ALL its listeners once the turn settles (failure)", async () => {
    const s = new FakeTurnSession();
    s.sendResult = Promise.reject(new Error("pty write failed"));
    const turn = runTurn(s, "go", { catchUpMs: 5_000, fallbackQuietMs: 20 });
    await expect(settle(collect(turn.events))).rejects.toThrow(/pty write failed/);
    await turn.boundary;
    expect(s.listenerCount()).toBe(0); // no leak even on the failure path
  });

  test("after a consumer TIMEOUT, boundary holds while the agent is `running` (a silent tool is NOT done)", async () => {
    // The consumer times out but the agent is still `running` (a long-running silent tool). The
    // serializer boundary must NOT resolve on mere quiet — quiet ≠ done — only on a real `ready`
    // or terminal. Here `ready` never comes, so the slot stays held (honest backpressure).
    const s = new FakeTurnSession();
    let emit!: (text: string) => void;
    s.script = () => {
      s.emit("status", { status: "running" });
      emit = (text: string) => s.emit("activity", activity({ text })); // untagged (Claude-like)
    };
    const turn = runTurn(s, "go", { timeoutMs: 10, catchUpMs: 40, fallbackQuietMs: 5_000 });
    await expect(settle(collect(turn.events))).rejects.toMatchObject({ code: "wait_timeout" });
    let resolved = false;
    void turn.boundary.then(() => {
      resolved = true;
    });
    // Long quiet stretch with the agent still `running` (no `ready`): the boundary must NOT resolve.
    emit("still-working");
    await vi.advanceTimersByTimeAsync(120); // >> catchUpMs/DRAIN — proves quiet alone won't release
    expect(resolved).toBe(false); // held — a silent running agent is not done
  });

  test("after a consumer TIMEOUT, a real `ready` (then a drain settle) resolves the boundary", async () => {
    // The failed turn's agent eventually reaches `ready` — the reliable "turn done" signal. Only
    // then (after a short transcript-drain settle) does the boundary resolve.
    const s = new FakeTurnSession();
    let ready!: () => void;
    s.script = () => {
      s.emit("status", { status: "running" });
      ready = () => s.emit("status", { status: "ready" });
    };
    const turn = runTurn(s, "go", {
      timeoutMs: 10,
      catchUpMs: 5_000,
      fallbackQuietMs: 5_000,
      drainMs: 40,
    });
    await expect(settle(collect(turn.events))).rejects.toMatchObject({ code: "wait_timeout" });
    let resolved = false;
    void turn.boundary.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(resolved).toBe(false); // no `ready` yet → still held
    ready(); // the agent finishes its turn
    await vi.advanceTimersByTimeAsync(40); // the drain settle elapses
    await turn.boundary;
    expect(resolved).toBe(true);
  });

  test("post-failure: trailing transcript activity after `ready` RE-ARMS the drain before release", async () => {
    // After the timeout, `ready` arms the drain (drainMs=50); a trailing event emitted just before
    // that deadline must RE-ARM it, so the boundary is still UNRESOLVED past the original deadline
    // and only lands after a fresh drain window with no further activity.
    const s = new FakeTurnSession();
    let ready!: () => void;
    let emit!: (t: string) => void;
    s.script = () => {
      s.emit("status", { status: "running" });
      ready = () => s.emit("status", { status: "ready" });
      emit = (t: string) => s.emit("activity", activity({ text: t }));
    };
    const turn = runTurn(s, "go", {
      timeoutMs: 10,
      catchUpMs: 5_000,
      fallbackQuietMs: 5_000,
      drainMs: 50,
    });
    await expect(settle(collect(turn.events))).rejects.toMatchObject({ code: "wait_timeout" });
    let resolved = false;
    void turn.boundary.then(() => {
      resolved = true;
    });
    ready(); // arms a 50ms drain
    await vi.advanceTimersByTimeAsync(40); // just BEFORE the original 50ms deadline
    emit("trailing"); // RE-ARMS → a fresh 50ms window starts now
    await vi.advanceTimersByTimeAsync(30); // now PAST the original deadline (40+30=70 > 50)
    expect(resolved).toBe(false); // WITHOUT re-arm this would already be resolved → proves re-arm
    await vi.advanceTimersByTimeAsync(20); // the fresh window elapses with no more activity
    await turn.boundary;
    expect(resolved).toBe(true);
  });

  test("after a consumer TIMEOUT, a terminal status resolves the boundary immediately", async () => {
    const s = new FakeTurnSession();
    let die!: () => void;
    s.script = () => {
      s.emit("status", { status: "running" });
      die = () => s.emit("status", { status: "exited" });
    };
    const turn = runTurn(s, "go", { timeoutMs: 10, catchUpMs: 5_000 });
    await expect(settle(collect(turn.events))).rejects.toMatchObject({ code: "wait_timeout" });
    die(); // the agent process is gone — the real boundary, no drain needed
    await turn.boundary; // resolves (would hang if terminal did not release)
    expect(s.listenerCount()).toBe(0);
  });
});

/**
 * Unit coverage for one ergonomic turn's LIFECYCLE races (PRD §5.8, C-API-48/51): a terminal
 * status arriving WHILE a submission is still pending ends the iterator cleanly and preserves
 * buffered content, and a late whole-turn timer cannot overwrite an already-succeeded turn.
 * These exercise the timing windows the deterministic completion path must survive.
 */

import { describe, expect, test } from "vitest";
import {
  activity,
  collect,
  deferred,
  drive,
  FakeTurnSession,
  runTurn,
  type TurnSession,
} from "./simple-turn-fakes.ts";

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
    const events = runTurn(s as unknown as TurnSession, "go", {
      fallbackQuietMs: 20,
      catchUpMs: 5_000,
    }).events;
    expect(await collect(events)).toEqual([{ type: "text", text: "buffered" }]); // kept, no throw
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
    const turn = runTurn(s as unknown as TurnSession, "go", {
      timeoutMs: 10,
      catchUpMs: 5_000,
      fallbackQuietMs: 20,
    });
    // Wait past timeoutMs BEFORE draining — if the timer could overwrite success, it would fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(await collect(turn.events)).toEqual([{ type: "text", text: "ok" }]); // success stands
    await expect(turn.completion).resolves.toBeUndefined();
  });

  test("the runner removes ALL its listeners once the turn settles (success)", async () => {
    const s = new FakeTurnSession();
    s.script = () => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "ok" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "ok", turnId: "t1" }));
    };
    const turn = runTurn(s as unknown as TurnSession, "go", {
      catchUpMs: 5_000,
      fallbackQuietMs: 20,
    });
    await collect(turn.events);
    await turn.boundary;
    expect(s.listenerCount()).toBe(0); // activity + hook + status listeners all detached
  });

  test("the runner removes ALL its listeners once the turn settles (failure)", async () => {
    const s = new FakeTurnSession();
    s.sendResult = Promise.reject(new Error("pty write failed"));
    const turn = runTurn(s as unknown as TurnSession, "go", {
      catchUpMs: 5_000,
      fallbackQuietMs: 20,
    });
    await expect(collect(turn.events)).rejects.toThrow(/pty write failed/);
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
    const turn = runTurn(s as unknown as TurnSession, "go", {
      timeoutMs: 10,
      catchUpMs: 40,
      fallbackQuietMs: 5_000,
    });
    await expect(collect(turn.events)).rejects.toMatchObject({ code: "wait_timeout" }); // consumer failed
    let resolved = false;
    void turn.boundary.then(() => {
      resolved = true;
    });
    // Long quiet stretch with the agent still `running` (no `ready`): the boundary must NOT resolve.
    emit("still-working");
    await new Promise((r) => setTimeout(r, 120)); // >> catchUpMs/DRAIN — proves quiet alone won't release
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
    const turn = runTurn(s as unknown as TurnSession, "go", {
      timeoutMs: 10,
      catchUpMs: 5_000,
      fallbackQuietMs: 5_000,
    });
    await expect(collect(turn.events)).rejects.toMatchObject({ code: "wait_timeout" });
    let resolved = false;
    void turn.boundary.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false); // no `ready` yet → still held
    ready(); // the agent finishes its turn
    await turn.boundary; // resolves after the short drain settle
    expect(resolved).toBe(true);
  });

  test("post-failure: trailing transcript activity after `ready` RE-ARMS the drain before release", async () => {
    // After the timeout, `ready` arms the drain; a further trailing (untagged) transcript event
    // must RE-ARM it (a bursty flush), so the boundary lands only once the flush truly stops.
    const s = new FakeTurnSession();
    let ready!: () => void;
    let emit!: (t: string) => void;
    s.script = () => {
      s.emit("status", { status: "running" });
      ready = () => s.emit("status", { status: "ready" });
      emit = (t: string) => s.emit("activity", activity({ text: t }));
    };
    const turn = runTurn(s as unknown as TurnSession, "go", {
      timeoutMs: 10,
      catchUpMs: 60, // drain window
      fallbackQuietMs: 5_000,
    });
    await expect(collect(turn.events)).rejects.toMatchObject({ code: "wait_timeout" });
    let resolved = false;
    void turn.boundary.then(() => {
      resolved = true;
    });
    ready(); // arms the drain
    await new Promise((r) => setTimeout(r, 40)); // partway through the drain window
    emit("trailing"); // RE-ARMS the drain (this exercises the re-arm + draining branches)
    await new Promise((r) => setTimeout(r, 40)); // still within a fresh drain window
    expect(resolved).toBe(false); // the re-arm deferred release past the original window
    await turn.boundary; // now quiet → resolves
    expect(resolved).toBe(true);
  });

  test("after a consumer TIMEOUT, a terminal status resolves the boundary immediately", async () => {
    const s = new FakeTurnSession();
    let die!: () => void;
    s.script = () => {
      s.emit("status", { status: "running" });
      die = () => s.emit("status", { status: "exited" });
    };
    const turn = runTurn(s as unknown as TurnSession, "go", { timeoutMs: 10, catchUpMs: 5_000 });
    await expect(collect(turn.events)).rejects.toMatchObject({ code: "wait_timeout" });
    die(); // the agent process is gone — the real boundary, no drain needed
    await turn.boundary; // resolves (would hang if terminal did not release)
    expect(s.listenerCount()).toBe(0);
  });
});

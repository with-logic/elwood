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
});

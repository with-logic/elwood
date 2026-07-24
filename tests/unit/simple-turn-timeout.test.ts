/**
 * Unit coverage for the ergonomic turn's timeout + bounding model (PRD §5.8, C-API-48): NO
 * default whole-turn timeout (a live turn may run for hours); an opt-in `timeoutMs` ceiling;
 * a tight post-`ready` `catchUpMs` cap; and the memory bounds (pending-event cap, rolling
 * oracle window, queue head compaction) that keep a verbose/hours-long turn from growing
 * without limit.
 */

import { describe, expect, test } from "vitest";
import {
  activity,
  collect,
  drive,
  run,
  runTurn,
  runTurnFake,
  type TurnSession,
} from "./simple-turn-fakes.ts";

describe("streamTurn timeouts (C-API-48)", () => {
  test("default options (no args): oracle path still ends deterministically", async () => {
    // Exercises the `options = {}` default and the default catch-up/quiet constants.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "ok" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "ok", turnId: "t1" })); // matches the oracle → ends
    });
    // Call runTurn with NO options object → exercises the `options = {}` default + defaults.
    expect(await collect(runTurn(s as unknown as TurnSession, "go").events)).toEqual([
      { type: "text", text: "ok" },
    ]);
  });

  test("a content event after ready with the oracle pending does NOT arm the quiet timer", async () => {
    // With an oracle set, a post-ready content push must NOT start the quiet-window fallback
    // (armQuiet returns early when expected is set) — the oracle governs completion.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "FINAL" });
      s.emit("status", { status: "ready" }); // oracle pending
      s.emit("activity", activity({ text: "partial ", turnId: "t1" })); // push after ready, oracle set
      s.emit("activity", activity({ text: "FINAL", turnId: "t1" })); // completes the oracle
    });
    expect(await run(s)).toEqual([
      { type: "text", text: "partial " },
      { type: "text", text: "FINAL" },
    ]);
  });

  test("an OPT-IN timeoutMs caps a still-running turn (no default whole-turn timeout)", async () => {
    // A turn that never reaches `ready` runs forever by default (a live turn is valid); a
    // caller-supplied timeoutMs is the opt-in whole-turn ceiling.
    const s = drive((s) => {
      s.emit("status", { status: "running" }); // never settles
    });
    await expect(collect(runTurnFake(s, { timeoutMs: 10 }).events)).rejects.toMatchObject({
      code: "wait_timeout",
    });
  });

  test("SAFETY NET: oracle set but the transcript NEVER catches up → catchUpMs fires after ready", async () => {
    // The Stop hook promises "NEVER ARRIVES" but the transcript delivers something else. The
    // oracle waits, so the post-`ready` catch-up cap must terminate the turn rather than hang.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "NEVER ARRIVES" });
      s.emit("status", { status: "ready" }); // settled — the catch-up cap starts ticking here
      s.emit("activity", activity({ text: "something else", turnId: "t1" })); // never matches
    });
    await expect(
      collect(runTurnFake(s, { catchUpMs: 20, fallbackQuietMs: 5_000 }).events),
    ).rejects.toMatchObject({ code: "wait_timeout" });
  });

  test("a stalled consumer past the pending-event cap fails with wait_timeout", async () => {
    // With a tiny cap, a turn that buffers more events than the cap (consumer not draining)
    // must fail rather than grow the buffer without bound.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      for (let i = 0; i < 10; i += 1) s.emit("activity", activity({ text: `x${i}`, turnId: "t1" }));
    });
    await expect(collect(runTurnFake(s, { maxPendingEvents: 3 }).events)).rejects.toMatchObject({
      code: "wait_timeout",
    });
  });

  test("the oracle still matches after the collected text is truncated to its rolling window", async () => {
    // A very long turn: `collected` is a bounded rolling window, but the expected text (which
    // arrives last) is still found because the window retains the recent tail.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "THE END" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "x".repeat(20000), turnId: "t1" })); // huge fragment
      s.emit("activity", activity({ text: "THE END", turnId: "t1" })); // the expected tail
    });
    const out = (await run(s)) as { type: string; text: string }[];
    expect(out.at(-1)).toEqual({ type: "text", text: "THE END" }); // matched → turn ended
  });

  test("a large content burst is drained fully (queue head compaction, no O(n^2))", async () => {
    // Emit more than the gate's head-compaction threshold (1024) so the consumed-prefix
    // splice path runs; every event must still be yielded, in order.
    const N = 1100;
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      for (let i = 0; i < N; i += 1) s.emit("activity", activity({ text: `x${i}`, turnId: "t1" }));
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: `x${N - 1}` });
      s.emit("status", { status: "ready" });
    });
    const out = (await run(s)) as { type: string; text: string }[];
    expect(out).toHaveLength(N);
    expect(out[0]).toEqual({ type: "text", text: "x0" });
    expect(out[N - 1]).toEqual({ type: "text", text: `x${N - 1}` });
  });
});

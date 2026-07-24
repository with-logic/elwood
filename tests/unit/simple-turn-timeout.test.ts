/**
 * Unit coverage for the ergonomic turn's timeout model (PRD §5.8, C-API-48): NO default
 * whole-turn timeout (a live turn may run for hours); an opt-in `timeoutMs` ceiling; and a
 * tight post-`ready` `catchUpMs` cap that fires if the transcript never catches up.
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
});

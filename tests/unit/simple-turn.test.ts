/**
 * Unit coverage for one ergonomic turn (PRD §5.8, C-API-48/49): the turn ends
 * DETERMINISTICALLY when the transcript catches up to the Stop hook's expected text (the
 * completeness oracle) and falls back to a bounded quiet window when there is no oracle. Turn
 * binding/termination lives in `simple-turn-binding.test.ts`, timeouts in
 * `simple-turn-timeout.test.ts`. Runs under fake timers so the quiet window is explicit.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { elwoodError } from "../../src/core/errors.ts";
import { activity, drive, runFakeTimed } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("streamTurn completeness oracle (C-API-48)", () => {
  test("ends when the transcript catches up to the Stop hook's expected text", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "HELLO" }); // oracle set
      s.emit("status", { status: "ready" }); // settles, but text not yet arrived
      // The transcript lags: the assistant text arrives AFTER ready — the turn waits for it.
      queueMicrotask(() => s.emit("activity", activity({ text: "HELLO", turnId: "t1" })));
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "HELLO" }]);
  });

  test("a non-boundary hook AFTER Stop does not wipe the oracle — late text still ends the turn", async () => {
    // Stop promises "X"; a `Notification` then arrives (the CLI emits several such hooks after a
    // turn) BEFORE the transcript delivers "X". The oracle must survive: with it wiped, the quiet
    // window (10ms) would end the turn EMPTY and "X" would leak into the next turn.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "X" });
      s.emit("status", { status: "ready" });
      s.emit("hook", { hook_event_name: "Notification" }); // not a boundary — must be ignored
      s.emit("hook", { hook_event_name: "FileChanged" }); // likewise
      setTimeout(() => s.emit("activity", activity({ text: "X", turnId: "t1" })), 50); // > quiet
    });
    expect(await runFakeTimed(s, { fallbackQuietMs: 10 })).toEqual([{ type: "text", text: "X" }]);
  });

  test("waits for the FULL expected text across streamed chunks, then ends", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "LINE ONE\nLINE TWO" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "LINE ONE\n", turnId: "t1" })); // partial — not yet complete
      s.emit("activity", activity({ text: "LINE TWO", turnId: "t1" })); // now the transcript matches
    });
    expect(await runFakeTimed(s)).toEqual([
      { type: "text", text: "LINE ONE\n" },
      { type: "text", text: "LINE TWO" },
    ]);
  });

  test("yields thinking/tool events; oracle ends the turn once the text arrives", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ kind: "reasoning", text: "hmm", turnId: "t1" }));
      s.emit(
        "activity",
        activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls", turnId: "t1" }),
      );
      s.emit(
        "activity",
        activity({ kind: "tool_result", toolName: "Bash", toolOutput: "a", turnId: "t1" }),
      );
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "done" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "done", turnId: "t1" }));
    });
    expect(await runFakeTimed(s)).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "tool_call", name: "Bash", input: "ls" },
      { type: "tool_result", name: "Bash", output: "a" },
      { type: "text", text: "done" },
    ]);
  });

  test("no oracle (empty Stop text) → bounded quiet-window settle after ready", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "answer", turnId: "t1" }));
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "" }); // no oracle
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "answer" }]); // quiet window
  });

  test("no-oracle: trailing content after ready RE-ARMS the quiet window (kept, then settles)", async () => {
    // With no oracle, a content event that lands after `ready` while a quiet timer is already
    // pending must clear+re-arm it (so trailing text is kept) and still settle once quiet.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "" }); // no oracle
      s.emit("status", { status: "ready" }); // arms the quiet timer
      s.emit("activity", activity({ text: "first", turnId: "t1" })); // re-arms (clears pending timer)
      s.emit("activity", activity({ text: "second", turnId: "t1" })); // re-arms again
    });
    expect(await runFakeTimed(s)).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  test("pure-tool turn with NO Stop hook at all → quiet-window settle", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit(
        "activity",
        activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls", turnId: "t1" }),
      );
      s.emit("status", { status: "ready" }); // no hook, no assistant text
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "tool_call", name: "Bash", input: "ls" }]);
  });

  test("the idle `ready` at submit does NOT end the turn before any work runs", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "ready" }); // stray pre-start ready (not-yet-started)
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "answer", turnId: "t1" }));
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "answer" }]);
  });

  test("a non-Stop hook is ignored; a Stop with null text sets no oracle (quiet settle)", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "PreToolUse" }); // not a turn boundary — ignored
      s.emit("activity", activity({ text: "answer", turnId: "t1" }));
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: null }); // null → no oracle
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "answer" }]); // quiet fallback
  });

  test("submit on an already-dead session REJECTS with session_not_running (C-API-25)", async () => {
    // No turn ever runs (no terminal STATUS arrives); the submission itself rejects because the
    // session is already terminal. The turn must PROPAGATE that typed error, not resolve to "".
    const s = drive(() => {});
    s.sendResult = Promise.reject(elwoodError("session_not_running", "session is not running"));
    await expect(runFakeTimed(s)).rejects.toMatchObject({ code: "session_not_running" });
  });

  test("submit rejecting with any OTHER error becomes the turn's failure", async () => {
    const s = drive(() => {});
    s.sendResult = Promise.reject(new Error("pty write failed"));
    await expect(runFakeTimed(s)).rejects.toThrow(/pty write failed/);
  });
});

/**
 * Unit coverage for one ergonomic turn (PRD §5.8, C-API-48/49): the turn ends
 * DETERMINISTICALLY when the transcript catches up to the Stop hook's expected text (the
 * completeness oracle), falls back to a bounded quiet window when there is no oracle, binds
 * to the turn's `turnId`, and drops post-end activity. Timeout paths live in the sibling
 * `simple-turn-timeout.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { activity, drive, run } from "./simple-turn-fakes.ts";

describe("streamTurn completeness oracle (C-API-48)", () => {
  test("ends when the transcript catches up to the Stop hook's expected text", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "HELLO" }); // oracle set
      s.emit("status", { status: "ready" }); // settles, but text not yet arrived
      // The transcript lags: the assistant text arrives AFTER ready — the turn waits for it.
      queueMicrotask(() => s.emit("activity", activity({ text: "HELLO", turnId: "t1" })));
    });
    expect(await run(s)).toEqual([{ type: "text", text: "HELLO" }]);
  });

  test("waits for the FULL expected text across streamed chunks, then ends", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "LINE ONE\nLINE TWO" });
      s.emit("status", { status: "ready" });
      s.emit("activity", activity({ text: "LINE ONE\n", turnId: "t1" })); // partial — not yet complete
      s.emit("activity", activity({ text: "LINE TWO", turnId: "t1" })); // now the transcript matches
    });
    expect(await run(s)).toEqual([
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
    expect(await run(s)).toEqual([
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
    expect(await run(s)).toEqual([{ type: "text", text: "answer" }]); // ends after the quiet window
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
    expect(await run(s)).toEqual([
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
    expect(await run(s)).toEqual([{ type: "tool_call", name: "Bash", input: "ls" }]);
  });

  test("the idle `ready` at submit does NOT end the turn before any work runs", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "ready" }); // stray pre-start ready (not-yet-started)
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "answer", turnId: "t1" }));
      s.emit("status", { status: "ready" });
    });
    expect(await run(s)).toEqual([{ type: "text", text: "answer" }]);
  });

  test("a queued PRIOR turn's activity (different turnId) never bleeds in", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "MINE", turnId: "t2" })); // binds to t2
      s.emit("activity", activity({ text: "STALE", turnId: "t1" })); // other turn
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
      s.emit("status", { status: "ready" });
    });
    expect(await run(s)).toEqual([{ type: "text", text: "MINE" }]);
  });

  test("a terminal status ends the turn at once; a stray later `ready` is ignored", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "partial", turnId: "t1" }));
      s.emit("status", { status: "exited" }); // terminal ends immediately
      s.emit("status", { status: "ready" }); // stray post-end settle: ignored
      s.emit("activity", activity({ text: "LATE", turnId: "t1" })); // dropped
    });
    expect(await run(s)).toEqual([{ type: "text", text: "partial" }]);
  });

  test("a non-Stop hook is ignored; a Stop with null text sets no oracle (quiet settle)", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("hook", { hook_event_name: "PreToolUse" }); // not a turn boundary — ignored
      s.emit("activity", activity({ text: "answer", turnId: "t1" }));
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: null }); // null → no oracle
      s.emit("status", { status: "ready" });
    });
    expect(await run(s)).toEqual([{ type: "text", text: "answer" }]); // quiet-window fallback ends it
  });
});

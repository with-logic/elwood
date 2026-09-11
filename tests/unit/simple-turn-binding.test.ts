/**
 * Unit coverage for one ergonomic turn's BINDING and termination (PRD §5.8, C-API-48): a
 * deadline-swallowed submission is replayed, the turn binds to the first tagged `turnId` and
 * drops a prior turn's activity, and a terminal status ends it at once (post-end activity is
 * dropped). Runs under fake timers so the quiet window is explicit.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activity, drive, runFakeTimed } from "./simple-turn-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("streamTurn binding and termination (C-API-48)", () => {
  test("C-API-48 replays a deadline-swallowed submission instead of returning empty", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      if (s.submissions === 1) {
        s.emit("status", { status: "ready" }); // boot repaint; no positive acceptance
        return;
      }
      s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: "go" });
      s.emit("activity", activity({ text: "accepted", turnId: "t2" }));
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "accepted" });
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "accepted" }]);
    expect(s.submissions).toBe(2);
  });

  test("a queued PRIOR turn's activity (different turnId) never bleeds in", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "MINE", turnId: "t2" })); // binds to t2
      s.emit("activity", activity({ text: "STALE", turnId: "t1" })); // other turn
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "MINE" }]);
  });

  test("binds to the FIRST tagged event even when an untagged event precedes it", async () => {
    // A leading untagged event (Claude-style) must not pin the binding to `undefined` and then
    // drop every later tagged event of the same turn; binding happens on the first tag seen.
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ kind: "reasoning", text: "untagged" })); // no turnId yet
      s.emit("activity", activity({ text: "MINE", turnId: "t2" })); // binds to t2 here
      s.emit("activity", activity({ text: "STALE", turnId: "t1" })); // another turn → dropped
      s.emit("hook", { hook_event_name: "Stop", last_assistant_message: "MINE" });
      s.emit("status", { status: "ready" });
    });
    expect(await runFakeTimed(s)).toEqual([
      { type: "thinking", text: "untagged" },
      { type: "text", text: "MINE" },
    ]);
  });

  test("a terminal status ends the turn at once; a second terminal + stray `ready` are ignored", async () => {
    const s = drive((s) => {
      s.emit("status", { status: "running" });
      s.emit("activity", activity({ text: "partial", turnId: "t1" }));
      s.emit("status", { status: "exited" }); // terminal ends immediately (end #1)
      s.emit("status", { status: "killed" }); // a SECOND terminal — end() is idempotent, ignored
      s.emit("status", { status: "ready" }); // stray post-end settle: ignored
      s.emit("activity", activity({ text: "LATE", turnId: "t1" })); // dropped
    });
    expect(await runFakeTimed(s)).toEqual([{ type: "text", text: "partial" }]);
  });
});

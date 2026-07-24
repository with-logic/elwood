/**
 * Unit coverage for one ergonomic turn (PRD §5.8, C-API-48/49): stream binds to the
 * turn's activity, ends on the post-work settle (not the idle `ready` at submit), keeps a
 * queued prior turn's events out, joins send() text with blank lines, and times out.
 */

import { describe, expect, test } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity.ts";
import type { ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { streamTurn, type TurnSession } from "../../src/core/simple/turn.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

type Emitter = TypedEmitter<ElwoodCommonEventMap>;

function activity(partial: Partial<ElwoodActivityEvent>): ElwoodActivityEvent {
  return {
    elwoodSessionId: "s1",
    agent: "claude",
    source: "transcript",
    kind: "assistant_message",
    label: "assistant",
    ...partial,
  };
}

/** A fake session whose `sendMessage` runs a scripted turn against the emitter. */
function fakeSession(emitter: Emitter, onSend: () => void): TurnSession {
  return {
    status: "ready",
    on: (event, handler) => emitter.on(event, handler),
    sendMessage: () => {
      onSend();
      return Promise.resolve();
    },
  };
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("streamTurn (C-API-48)", () => {
  test("yields a turn's text/thinking/tool events, ending on the post-work settle", async () => {
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ kind: "reasoning", text: "hmm", turnId: "t1" }));
      emitter.emit(
        "activity",
        activity({ kind: "tool_call", toolName: "Bash", toolInput: "ls", turnId: "t1" }),
      );
      emitter.emit(
        "activity",
        activity({ kind: "tool_result", toolName: "Bash", toolOutput: "a\nb", turnId: "t1" }),
      );
      emitter.emit("activity", activity({ text: "done", turnId: "t1" }));
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" }); // post-work settle
    });
    expect(await collect(streamTurn(session, "go", undefined, 5))).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "tool_call", name: "Bash", input: "ls" },
      { type: "tool_result", name: "Bash", output: "a\nb" },
      { type: "text", text: "done" },
    ]);
  });

  test("the idle `ready` at submit does NOT end the turn before any work runs", async () => {
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      // A stray `ready` before the turn starts must be ignored (not-yet-started).
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ text: "answer", turnId: "t1" }));
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    });
    expect(await collect(streamTurn(session, "go", undefined, 5))).toEqual([
      { type: "text", text: "answer" },
    ]);
  });

  test("a queued PRIOR turn's activity (different turnId) never bleeds in", async () => {
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ text: "MINE", turnId: "t2" })); // binds to t2
      emitter.emit("activity", activity({ text: "STALE", turnId: "t1" })); // other turn
      emitter.emit("activity", activity({ text: "MINE2", turnId: "t2" }));
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" });
    });
    expect(await collect(streamTurn(session, "go", undefined, 5))).toEqual([
      { type: "text", text: "MINE" },
      { type: "text", text: "MINE2" },
    ]);
  });

  test("ends without error when the turn settles via a TERMINAL status", async () => {
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ text: "partial", turnId: "t1" }));
      emitter.emit("status", { elwoodSessionId: "s1", status: "exited" }); // ends immediately
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" }); // stray post-end settle: ignored
    });
    expect(await collect(streamTurn(session, "go", undefined, 5))).toEqual([
      { type: "text", text: "partial" },
    ]);
  });

  test("trailing content within the settle grace IS included (transcript lag)", async () => {
    // The `ready` settle for a transcript-sourced turn can precede the last assistant
    // text. A content event arriving within the grace window defers the end and is kept.
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("status", { elwoodSessionId: "s1", status: "ready" }); // settle first...
      emitter.emit("activity", activity({ text: "trailing", turnId: "t1" })); // ...text lags
    });
    expect(await collect(streamTurn(session, "go", undefined, 30))).toEqual([
      { type: "text", text: "trailing" },
    ]);
  });

  test("a late activity arriving AFTER the grace has elapsed is dropped (end latched)", async () => {
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" });
      emitter.emit("activity", activity({ text: "answer", turnId: "t1" }));
      emitter.emit("status", { elwoodSessionId: "s1", status: "exited" }); // terminal: ends NOW
      emitter.emit("activity", activity({ text: "LATE", turnId: "t1" })); // after end: dropped
    });
    expect(await collect(streamTurn(session, "go", undefined, 5))).toEqual([
      { type: "text", text: "answer" },
    ]);
  });

  test("a deadline breach throws wait_timeout from the iterator", async () => {
    const emitter: Emitter = new TypedEmitter<ElwoodCommonEventMap>();
    const session = fakeSession(emitter, () => {
      emitter.emit("status", { elwoodSessionId: "s1", status: "running" }); // never settles
    });
    await expect(collect(streamTurn(session, "go", 10))).rejects.toMatchObject({
      code: "wait_timeout",
    });
  });
});

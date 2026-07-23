/**
 * Conformance coverage for Codex transcript drop/read-error accounting, the fs
 * guard, the line emitter, and the bounded terminal drain.
 * Covers PRD §7A/§5.4: each lost record (unparseable, oversized, unread_backlog)
 * or contained fs failure surfaces ONE live, content-free notice — no running
 * count, no persistence. The bounded terminal drain lives in a sibling file.
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptCursor } from "../../src/codex/transcript/cursor.ts";
import {
  type CodexDropNotice,
  CodexDropTracker,
  type CodexReadErrorNotice,
  CodexReadErrorTracker,
} from "../../src/codex/transcript/drops.ts";
import { CodexLineEmitter } from "../../src/codex/transcript/emit.ts";
import { CodexTranscriptFsGuard } from "../../src/codex/transcript/fs-guard.ts";
import type { CodexTranscriptEvent } from "../../src/codex/transcript/types.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("Codex drop + read-error tracking", () => {
  test("C-CODEX-20 each lost record surfaces one live drop notice with its cause", () => {
    const notices: CodexDropNotice[] = [];
    const tracker = new CodexDropTracker("s1", (n) => notices.push(n));
    tracker.record("/t"); // unparseable
    tracker.drop("/t", "oversized");
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/t", cause: "unparseable" },
      { elwoodSessionId: "s1", path: "/t", cause: "oversized" },
    ]);
  });

  test("C-CODEX-20 a tracker with no sink still records without throwing", () => {
    const tracker = new CodexDropTracker("s", undefined);
    expect(() => {
      tracker.record("/t");
      tracker.drop("/t", "unread_backlog");
    }).not.toThrow();
  });

  test("C-CODEX-20 read-error tracker surfaces the code and normalizes a missing/numeric code", () => {
    const errs: CodexReadErrorNotice[] = [];
    const tracker = new CodexReadErrorTracker("s", (n) => errs.push(n));
    tracker.record("/t", { code: "EISDIR" });
    tracker.record("/t", new Error("boom")); // no `.code` → UNKNOWN
    tracker.record("/t", { code: 5 }); // a NUMERIC code must NOT round-trip → UNKNOWN
    expect(errs.map((e) => e.lastErrorCode)).toEqual(["EISDIR", "UNKNOWN", "UNKNOWN"]);
    const silent = new CodexReadErrorTracker("s", undefined);
    expect(() => silent.record("/t", {})).not.toThrow();
  });
});

describe("Codex fs guard", () => {
  test("C-CODEX-20 contains a sync read failure and records it", () => {
    const errs: CodexReadErrorNotice[] = [];
    const guard = new CodexTranscriptFsGuard(new CodexReadErrorTracker("s", (n) => errs.push(n)));
    expect(guard.read("/t", () => 42)).toBe(42);
    const bad = guard.read("/t", () => {
      throw new Error("nope");
    });
    expect(bad).toBeUndefined();
    expect(errs).toHaveLength(1);
  });
});

function harness() {
  const events: CodexTranscriptEvent[] = [];
  const notices: CodexDropNotice[] = [];
  const drops = new CodexDropTracker("s", (n) => notices.push(n));
  const lines = new CodexLineEmitter("s", (e) => events.push(e), drops);
  const guard = new CodexTranscriptFsGuard(new CodexReadErrorTracker("s", undefined));
  return { events, notices, drops, lines, guard };
}

describe("Codex line emitter", () => {
  test("C-CODEX-20 emits parseable lines, skips blanks, drops malformed", () => {
    const { events, notices, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "", cursor); // empty text early-returns
    lines.emitLines("/p", `{"type":"note"}\n   \n{oops}\n`, cursor);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatchObject({ kind: "other", label: "note" });
    expect(notices.at(-1)).toMatchObject({ cause: "unparseable" });
  });

  test("C-CODEX-20 an over-length record via emitLines is one oversized drop", () => {
    const { notices, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "q".repeat(1024 * 1024 + 10), cursor);
    expect(notices.filter((n) => n.cause === "oversized")).toHaveLength(1);
  });

  test("C-CODEX-20 ENDING a discard surfaces no new drop (only the start counted)", () => {
    const { notices, lines } = harness();
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "x.jsonl"));
    lines.emitLines("/p", "q".repeat(1024 * 1024 + 10), cursor); // starts discard (one drop)
    // The next chunk ENDS the discard: no new over-length record began, so no new drop.
    lines.emitLines("/p", "tail-of-record\n", cursor);
    expect(notices.filter((n) => n.cause === "oversized")).toHaveLength(1);
  });
});

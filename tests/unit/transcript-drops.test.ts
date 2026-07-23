/**
 * Focused coverage for the transcript diagnostic trackers.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded, content-free drop and read-error
 * accounting where each observation surfaces ONE live warning — no running count,
 * no batching, no persistence.
 */

import { describe, expect, test } from "vitest";
import {
  DropTracker,
  ReadErrorTracker,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/drops.ts";

describe("C-CLAUDE-15 transcript diagnostic trackers", () => {
  test("a read error without an errno code reports the UNKNOWN fallback", () => {
    const notices: TranscriptReadErrorNotice[] = [];
    const tracker = new ReadErrorTracker("s1", (n) => notices.push(n));
    // A bare Error (no `.code`) is not an ErrnoException; the code falls back.
    tracker.record("/tmp/t.jsonl", new Error("not an errno error"));
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/tmp/t.jsonl", lastErrorCode: "UNKNOWN" },
    ]);
  });

  test("a read error with an errno code surfaces that code", () => {
    const notices: TranscriptReadErrorNotice[] = [];
    const tracker = new ReadErrorTracker("s1", (n) => notices.push(n));
    tracker.record("/tmp/t.jsonl", Object.assign(new Error("open failed"), { code: "ENOENT" }));
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/tmp/t.jsonl", lastErrorCode: "ENOENT" },
    ]);
  });

  test("each unparseable record surfaces ONE live drop warning", () => {
    // Every drop is a distinct live warning — no running count, no batching.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.record("/p");
    tracker.record("/p");
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/p", cause: "unparseable" },
      { elwoodSessionId: "s1", path: "/p", cause: "unparseable" },
    ]);
  });

  test("drop carries the given cause (e.g. an unread backlog)", () => {
    // The terminal drain accounts an unread backlog as a content-free drop with its
    // OWN cause; the notice carries that cause, never content.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.drop("/p", "unread_backlog");
    expect(notices).toEqual([{ elwoodSessionId: "s1", path: "/p", cause: "unread_backlog" }]);
  });

  test("trackers with no handler are safe no-ops", () => {
    // The `onDrop`/`onError` callbacks are optional; recording must not throw.
    const drops = new DropTracker("s1", undefined);
    const errors = new ReadErrorTracker("s1", undefined);
    expect(() => {
      drops.record("/p");
      drops.drop("/p", "oversized");
      errors.record("/p", new Error("x"));
    }).not.toThrow();
  });
});

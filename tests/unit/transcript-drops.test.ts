/**
 * Focused coverage for the rate-bounded transcript diagnostic trackers.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded, content-free drop and read-error
 * accounting, including the codeless-error fallback.
 */

import { describe, expect, test } from "vitest";
import {
  DropTracker,
  ReadErrorTracker,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/drops.ts";

describe("C-CLAUDE-15 transcript diagnostic trackers", () => {
  test("a read error without an errno code reports the UNKNOWN fallback", () => {
    const notices: TranscriptReadErrorNotice[] = [];
    const tracker = new ReadErrorTracker("s1", (n) => notices.push(n));
    // A bare Error (no `.code`) is not an ErrnoException; the code falls back.
    tracker.record("/tmp/t.jsonl", new Error("not an errno error"));
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/tmp/t.jsonl", errorCount: 1, lastErrorCode: "UNKNOWN" },
    ]);
  });

  test("trackers with no handler are safe no-ops", () => {
    // The `onDrop`/`onError` callbacks are optional; recording must not throw.
    const drops = new DropTracker("s1", undefined);
    const errors = new ReadErrorTracker("s1", undefined);
    expect(() => {
      drops.record("/p", "{ bad }");
      drops.flush();
      errors.record("/p", new Error("x"));
      errors.flush();
    }).not.toThrow();
  });
});

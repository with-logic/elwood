/**
 * Focused coverage for the transcript diagnostic trackers.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded, content-free drop and read-error
 * accounting where EVERY observation advances the in-memory running count but the
 * sink is fed only at a batch boundary (flush), so N malformed records in one chunk
 * cause a BOUNDED number of persists — not one per record (the BLOCKER fix).
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
      { elwoodSessionId: "s1", path: "/tmp/t.jsonl", errorCount: 1, lastErrorCode: "UNKNOWN" },
    ]);
  });

  test("BLOCKER: N drops in one batch persist ONCE, not once per drop", () => {
    // The tracker DECOUPLES "update running count" (in-memory, every record) from
    // "persist snapshot" (fed to the sink only on flush()). Many malformed records
    // between two flushes advance the count but produce ZERO sink calls; the single
    // flush then reports the latest aggregate. This is what keeps a 256 KiB chunk of
    // tiny malformed records from triggering thousands of session.json fsyncs.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    for (let i = 0; i < 1000; i++) tracker.record("/p", "{ bad }"); // 7 bytes each
    expect(notices).toEqual([]); // NOT one notice per record — nothing persisted yet
    tracker.flush();
    // One flush → exactly one persist carrying the full running aggregate.
    expect(notices).toEqual([
      {
        elwoodSessionId: "s1",
        path: "/p",
        droppedCount: 1000,
        droppedBytes: 7000,
        cause: "unparseable",
      },
    ]);
  });

  test("flush is idempotent when nothing changed since the last flush", () => {
    // A flush with no pending change must NOT feed the sink again — otherwise a
    // scan pass that dropped nothing would still rewrite the snapshot every tick.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.record("/p", "{ bad }");
    tracker.flush();
    tracker.flush(); // no new drop since the first flush: no second sink call
    expect(notices).toHaveLength(1);
  });

  test("flush before any drop is a no-op (no spurious empty aggregate)", () => {
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.flush();
    expect(notices).toEqual([]);
  });

  test("recordBytes carries the given cause and record count into the flushed aggregate", () => {
    // The terminal drain accounts an unread backlog as a content-free drop with its
    // OWN cause; the flushed notice carries that cause and the byte magnitude.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.recordBytes("/p", 4096, 1, "unread_backlog");
    tracker.flush();
    expect(notices).toEqual([
      {
        elwoodSessionId: "s1",
        path: "/p",
        droppedCount: 1,
        droppedBytes: 4096,
        cause: "unread_backlog",
      },
    ]);
  });

  test("the flushed cause reflects the MOST RECENT loss folded into the aggregate", () => {
    // A batch may mix causes (an unparseable record then an unread backlog); the
    // single aggregate carries the latest cause while the counts stay cumulative.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.record("/p", "{ bad }"); // cause unparseable, +1 record
    tracker.recordBytes("/p", 500, 1, "unread_backlog"); // latest cause wins
    tracker.flush();
    expect(notices).toEqual([
      {
        elwoodSessionId: "s1",
        path: "/p",
        droppedCount: 2,
        droppedBytes: 507,
        cause: "unread_backlog",
      },
    ]);
  });

  test("MAJOR: droppedCount is loss incidents — N unparseable records => N, one backlog => +1", () => {
    // `droppedCount` uniformly counts loss INCIDENTS: each unparseable record is one
    // incident, and each unread teardown backlog is exactly ONE incident (its
    // enclosed record count is unknown), never conflated. So N unparseable records
    // plus one backlog event yields N+1, and the backlog's cause is truthful.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    for (let i = 0; i < 3; i++) tracker.record("/p", "{ bad }"); // 3 unparseable incidents
    tracker.recordBytes("/p", 9000, 1, "unread_backlog"); // 1 backlog incident
    tracker.flush();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ droppedCount: 4, cause: "unread_backlog" });
    // The bytes are the true magnitude: 3×7 unparseable bytes + 9000 backlog bytes.
    expect(notices[0]!.droppedBytes).toBe(21 + 9000);
  });

  test("trackers with no handler are safe no-ops", () => {
    // The `onDrop`/`onError` callbacks are optional; recording + flushing must not throw.
    const drops = new DropTracker("s1", undefined);
    const errors = new ReadErrorTracker("s1", undefined);
    expect(() => {
      drops.record("/p", "{ bad }");
      drops.flush();
      errors.record("/p", new Error("x"));
    }).not.toThrow();
  });
});

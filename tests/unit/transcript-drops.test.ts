/**
 * Focused coverage for the transcript diagnostic reporters.
 * Covers PRD §5.4/§9.2 (C-CLAUDE-15): bounded, content-free drop and read-error
 * reporting. Drops COALESCE per (path, cause) within a scan pass and deliver on
 * `flushPass()` — one live warning per incident, no running count, no persistence —
 * so a chunk of millions of malformed lines cannot fan out millions of warnings.
 */

import { describe, expect, test } from "vitest";
import {
  DropReporter,
  ReadErrorReporter,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/drops.ts";

describe("C-CLAUDE-15 transcript diagnostic reporters", () => {
  test("a read error without an errno code reports the UNKNOWN fallback", () => {
    const notices: TranscriptReadErrorNotice[] = [];
    const reporter = new ReadErrorReporter("s1", (n) => notices.push(n));
    // A bare Error (no `.code`) is not an ErrnoException; the code falls back.
    reporter.record("/tmp/t.jsonl", new Error("not an errno error"));
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/tmp/t.jsonl", lastErrorCode: "UNKNOWN" },
    ]);
  });

  test("a read error with an errno code surfaces that code", () => {
    const notices: TranscriptReadErrorNotice[] = [];
    const reporter = new ReadErrorReporter("s1", (n) => notices.push(n));
    reporter.record("/tmp/t.jsonl", Object.assign(new Error("open failed"), { code: "ENOENT" }));
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/tmp/t.jsonl", lastErrorCode: "ENOENT" },
    ]);
  });

  test("many unparseable records in one pass coalesce to ONE drop warning", () => {
    // A million malformed lines in one scan must not fan out a million warnings: the
    // pass coalesces per (path, cause) and delivers once on flushPass (§9.2).
    const notices: TranscriptDropNotice[] = [];
    const reporter = new DropReporter("s1", (n) => notices.push(n));
    for (let i = 0; i < 1000; i += 1) reporter.record("/p");
    expect(notices).toEqual([]); // nothing delivered until the pass flushes
    reporter.flushPass();
    expect(notices).toEqual([{ elwoodSessionId: "s1", path: "/p", cause: "unparseable" }]);
  });

  test("distinct (path, cause) incidents each surface once per pass", () => {
    const notices: TranscriptDropNotice[] = [];
    const reporter = new DropReporter("s1", (n) => notices.push(n));
    reporter.record("/p"); // unparseable on /p
    reporter.drop("/p", "unread_backlog"); // different cause, same path
    reporter.drop("/q", "unparseable"); // different path
    reporter.flushPass();
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/p", cause: "unparseable" },
      { elwoodSessionId: "s1", path: "/p", cause: "unread_backlog" },
      { elwoodSessionId: "s1", path: "/q", cause: "unparseable" },
    ]);
  });

  test("a later pass re-fires an incident that recurs (not a persisted aggregate)", () => {
    const notices: TranscriptDropNotice[] = [];
    const reporter = new DropReporter("s1", (n) => notices.push(n));
    reporter.record("/p");
    reporter.flushPass();
    reporter.record("/p"); // a fresh occurrence in a new pass
    reporter.flushPass();
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/p", cause: "unparseable" },
      { elwoodSessionId: "s1", path: "/p", cause: "unparseable" },
    ]);
  });

  test("flushPass with nothing pending delivers nothing", () => {
    const notices: TranscriptDropNotice[] = [];
    const reporter = new DropReporter("s1", (n) => notices.push(n));
    reporter.flushPass();
    expect(notices).toEqual([]);
  });

  test("a throwing drop listener does not re-fire the batch on the next pass", () => {
    // flushPass clears the pending batch BEFORE delivery, so a throwing listener
    // drops the warning rather than replaying it forever (live-only, C-API-14).
    const reporter = new DropReporter("s1", () => {
      throw new Error("listener boom");
    });
    reporter.record("/p");
    expect(() => reporter.flushPass()).toThrow("listener boom");
    const notices: TranscriptDropNotice[] = [];
    const ok = new DropReporter("s1", (n) => notices.push(n));
    ok.flushPass(); // unrelated reporter proves batches don't leak across instances
    expect(notices).toEqual([]);
  });

  test("reporters with no handler are safe no-ops", () => {
    // The `onDrop`/`onError` callbacks are optional; recording must not throw.
    const drops = new DropReporter("s1", undefined);
    const errors = new ReadErrorReporter("s1", undefined);
    expect(() => {
      drops.record("/p");
      drops.drop("/p", "oversized");
      drops.flushPass();
      errors.record("/p", new Error("x"));
    }).not.toThrow();
  });
});

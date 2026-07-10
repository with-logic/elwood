/**
 * Focused coverage for the transcript diagnostic trackers.
 * Covers PRD §5.4 (C-CLAUDE-15): bounded, content-free drop and read-error
 * accounting where EVERY observation reports the updated running aggregate so
 * the persisted snapshot count stays current (event-level dedup is downstream).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DropTracker,
  ReadErrorTracker,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/drops.ts";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "elwood-drops-")), "t.jsonl");
const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

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

  test("every drop reports the updated aggregate so the snapshot count stays current", () => {
    // The tracker does NOT rate-bound the raw notice: it feeds every updated
    // aggregate to its sink. The user-visible warning EVENT is de-duplicated
    // downstream (recordSessionWarnings), but the persisted COUNT must advance on
    // each drop so a crash before finish() does not lose the accumulated total.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.record("/p", "{ bad }"); // 7 bytes
    tracker.record("/p", "{ worse }"); // 9 bytes
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/p", droppedCount: 1, droppedBytes: 7 },
      { elwoodSessionId: "s1", path: "/p", droppedCount: 2, droppedBytes: 16 },
    ]);
  });

  test("recordBytes can account a batched backlog as multiple dropped records", () => {
    // The terminal drain accounts an unread backlog as a content-free drop; the
    // record count may exceed 1 for a multi-record backlog while staying bounded.
    const notices: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (n) => notices.push(n));
    tracker.recordBytes("/p", 4096, 3);
    expect(notices).toEqual([
      { elwoodSessionId: "s1", path: "/p", droppedCount: 3, droppedBytes: 4096 },
    ]);
  });

  test("trackers with no handler are safe no-ops", () => {
    // The `onDrop`/`onError` callbacks are optional; recording must not throw.
    const drops = new DropTracker("s1", undefined);
    const errors = new ReadErrorTracker("s1", undefined);
    expect(() => {
      drops.record("/p", "{ bad }");
      errors.record("/p", new Error("x"));
    }).not.toThrow();
  });
});

describe("C-CLAUDE-15 watcher-level drop/read-error accounting", () => {
  test("Finding A: one over-length record across several chunks counts as ONE drop", () => {
    // A single un-terminated record larger than the pending cap is discarded
    // through its next newline, read across several 256 KiB chunks plus a newline
    // chunk. Each chunk reports discarded BYTES, but the dropped-RECORD count must
    // advance by exactly 1 — not once per chunk (C-CLAUDE-15).
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    writeFileSync(path, "");
    watcher.observe(path);
    // >1 MiB with no newline, then a newline + a valid record so the discard ends.
    const huge = "x".repeat(3 * 1024 * 1024);
    writeFileSync(path, `${huge}\n${JSON.stringify(assistant("after"))}\n`);
    watcher.finish();
    expect(drops.at(-1)!.droppedCount).toBe(1);
    expect(drops.at(-1)!.droppedBytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(JSON.stringify(drops)).not.toContain("x".repeat(64)); // content-free
  });

  test("Finding B: a resumed watcher seeds its drop count so the total is N+1, not 1", () => {
    // The prior session persisted droppedCount=60. A fresh watcher for the resumed
    // session is SEEDED from that snapshot, so its first post-resume drop reports 61
    // — never 1, which would erase history and violate the running-count semantics.
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      () => {},
      { onDrop: (d) => drops.push(d) },
      { drops: { droppedCount: 60, droppedBytes: 600 } },
    );
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, "{ bad }\n");
    watcher.finish();
    expect(drops.at(-1)!.droppedCount).toBe(61);
    expect(drops.at(-1)!.droppedBytes).toBeGreaterThan(600);
  });

  test("Finding B: a resumed watcher seeds its read-error count so the total is N+1", () => {
    const path = tmpFile();
    const readErrors: TranscriptReadErrorNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher(
      "s1",
      () => {},
      { onReadError: (n) => readErrors.push(n) },
      { readErrors: { errorCount: 4 } },
    );
    writeFileSync(path, "");
    watcher.observe(path);
    rmSync(path);
    mkdirSync(path); // reading a directory throws EISDIR
    watcher.scan();
    watcher.stop();
    expect(readErrors.at(-1)!.errorCount).toBe(5);
  });

  test("Finding C: a stat rejecting while LIVE routes a bounded read-error warning", async () => {
    // Complement of the terminal-latch race: when the async stat rejects and the
    // watcher is NOT finished, the contained fs error IS recorded so a real
    // rotation/removal race stays visible (C-CLAUDE-15).
    const path = tmpFile();
    const readErrors: TranscriptReadErrorNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, {
      onReadError: (n) => readErrors.push(n),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    rmSync(path); // the async stat rejects ENOENT while the watcher is still live
    await watcher.pollOnceForTests();
    watcher.stop();
    expect(readErrors).toHaveLength(1);
    expect(readErrors[0]).toMatchObject({ elwoodSessionId: "s1", path, errorCount: 1 });
  });

  test("Finding C: a stat rejecting AFTER finish() routes NO warning (terminal latch)", async () => {
    // poll() kicks off an async stat, then finish() latches the watcher terminal.
    // When the in-flight stat REJECTS after finish(), its error must NOT be
    // recorded/routed — that would emit + persist warning activity past
    // terminal:exit, breaking the permanent latch (§5.4). readFsAsync guards the
    // record on `!finished`, so the post-finish rejection is swallowed.
    const path = tmpFile();
    const readErrors: TranscriptReadErrorNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, {
      onReadError: (n) => readErrors.push(n),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    rmSync(path); // the pending stat will reject ENOENT
    const polled = watcher.pollOnceForTests(); // start the poll (awaits the stat)
    watcher.finish(); // latch terminal BEFORE the rejection lands
    await polled;
    expect(readErrors).toEqual([]);
  });
});

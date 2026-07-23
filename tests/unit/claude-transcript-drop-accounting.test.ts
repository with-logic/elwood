/**
 * Watcher-level drop/read-error accounting for the Claude transcript watcher.
 * Covers PRD §5.4 (C-CLAUDE-15): the running count advances per record in memory
 * but persists a BOUNDED number of times per slice (BLOCKER), a truncated baseline
 * recovery surfaces an unread_backlog drop (MINOR), and seeded resume totals stay
 * current across resume without going backwards.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  resetMaxRecordsForTests,
  setMaxRecordsForTests,
} from "../../src/claude/transcript/baseline.ts";
import {
  DropTracker,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../src/claude/transcript/drops.ts";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "elwood-drops-")), "t.jsonl");
const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

describe("C-CLAUDE-15 watcher-level drop/read-error accounting", () => {
  test("BLOCKER: thousands of malformed lines in one chunk persist a BOUNDED number of times", () => {
    // A single chunk holding thousands of tiny malformed records must NOT feed the
    // drop sink once per record (which would synchronously rewrite+fsync the whole
    // session.json thousands of times before the drain deadline is even rechecked).
    // The count still advances per record in memory; the sink is fed only at the
    // scan-pass boundary, so the persist count is O(passes), not O(records).
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    writeFileSync(path, "");
    watcher.observe(path);
    // ~5000 tiny malformed records, comfortably inside one 256 KiB read chunk.
    const malformed = `${Array.from({ length: 5000 }, () => "{ bad }").join("\n")}\n`;
    writeFileSync(path, malformed);
    watcher.finish();
    // The running count reflects EVERY malformed record (nothing lost)...
    expect(drops.at(-1)!.droppedCount).toBe(5000);
    // ...but the sink was fed only a bounded handful of times, NOT ~5000. A per-record
    // persist would be 5000 fsyncs; the batched flush keeps it a small constant.
    expect(drops.length).toBeLessThan(20);
  });

  test("MINOR: a truncated baseline recovery surfaces an unread_backlog drop", () => {
    // When a turn-boundary first-observe recovers a turn larger than the recovery
    // window, the earlier-in-file records fall outside it. That truncation must not
    // be silent: it is propagated as a bounded, content-free unread_backlog drop
    // (bytes only, no record text) rather than discarded (BaselineTail.truncated).
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    const user = JSON.stringify({ type: "user", message: { content: "go" } });
    const big = (i: number) => JSON.stringify(assistant(`r${i}-${"x".repeat(50 * 1024)}`));
    // A prompt behind several large records, then more records: the window won't
    // reach the prompt once the record budget is shrunk, so it truncates.
    writeFileSync(path, `${user}\n${big(1)}\n${big(2)}\n${big(3)}\n`);
    setMaxRecordsForTests(1); // force the backward scan to stop before the prompt
    try {
      watcher.observe(path, true); // turn-boundary first-observe: recover the tail
    } finally {
      resetMaxRecordsForTests();
    }
    const backlog = drops.find((d) => d.cause === "unread_backlog");
    expect(backlog).toBeDefined();
    expect(backlog!.droppedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(drops)).not.toContain("x".repeat(64)); // content-free
  });

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
    expect(drops.at(-1)!.cause).toBe("oversized"); // over-length record, not "unparseable"
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
    // terminal:exit, breaking the permanent latch (§5.4). The fs guard records
    // only while `!finished`, so the post-finish rejection is swallowed.
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

  test("C-CLAUDE-15 a throwing onDrop keeps the tracker dirty — the running total is not lost", () => {
    let failNext = true;
    const drops: TranscriptDropNotice[] = [];
    const tracker = new DropTracker("s1", (d) => {
      if (failNext) {
        failNext = false;
        throw new Error("persist boom");
      }
      drops.push(d);
    });
    tracker.recordBytes("/t", 50, 1, "oversized");
    // The sink throws — `dirty` must stay set so the total isn't silently dropped.
    expect(() => tracker.flush()).toThrow(/persist boom/);
    expect(drops).toHaveLength(0);
    // A later flush re-emits the still-pending running total.
    tracker.flush();
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ droppedCount: 1, droppedBytes: 50 });
  });
});

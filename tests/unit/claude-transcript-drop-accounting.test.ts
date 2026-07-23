/**
 * Watcher-level drop/read-error accounting for the Claude transcript watcher.
 * Covers PRD §5.4 (C-CLAUDE-15): each lost record or contained read error surfaces
 * ONE live, content-free warning (no running count, no persistence, no cross-resume
 * seed). A truncated baseline recovery surfaces an unread_backlog drop; a live stat
 * rejection routes a read-error while a post-finish rejection is swallowed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  resetMaxRecordsForTests,
  setMaxRecordsForTests,
} from "../../src/claude/transcript/baseline.ts";
import type {
  TranscriptDropNotice,
  TranscriptReadErrorNotice,
} from "../../src/claude/transcript/drops.ts";
import { ClaudeTranscriptWatcher } from "../../src/claude/transcript/index.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "elwood-drops-")), "t.jsonl");
const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

describe("C-CLAUDE-15 watcher-level drop/read-error accounting", () => {
  test("many malformed lines in one pass coalesce to ONE unparseable drop warning", () => {
    // Drop DELIVERY is bounded per scan pass (§9.2): a chunk can hold millions of
    // malformed lines, so the pass coalesces them to ONE content-free unparseable
    // warning per (path, cause) rather than fanning out one synchronous emit per line.
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, {
      onDrop: (d: TranscriptDropNotice) => drops.push(d),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    writeFileSync(path, `${Array.from({ length: 3 }, () => "{ bad }").join("\n")}\n`);
    watcher.finish();
    expect(drops.filter((d) => d.cause === "unparseable")).toEqual([
      { elwoodSessionId: "s1", path, cause: "unparseable" },
    ]);
  });

  test("MINOR: a truncated baseline recovery surfaces an unread_backlog drop", () => {
    // When a turn-boundary first-observe recovers a turn larger than the recovery
    // window, the earlier-in-file records fall outside it. That truncation must not
    // be silent: it is propagated as a bounded, content-free unread_backlog drop
    // (no record text) rather than discarded (BaselineTail.truncated).
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
    expect(JSON.stringify(drops)).not.toContain("x".repeat(64)); // content-free
  });

  test("Finding A: one over-length record across several chunks surfaces ONE drop", () => {
    // A single un-terminated record larger than the pending cap is discarded through
    // its next newline, read across several 256 KiB chunks plus a newline chunk. The
    // over-length record must surface exactly ONE oversized drop — not one per chunk.
    const path = tmpFile();
    const drops: TranscriptDropNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, { onDrop: (d) => drops.push(d) });
    writeFileSync(path, "");
    watcher.observe(path);
    // >1 MiB with no newline, then a newline + a valid record so the discard ends.
    const huge = "x".repeat(3 * 1024 * 1024);
    writeFileSync(path, `${huge}\n${JSON.stringify(assistant("after"))}\n`);
    watcher.finish();
    expect(drops.filter((d) => d.cause === "oversized")).toHaveLength(1);
    expect(JSON.stringify(drops)).not.toContain("x".repeat(64)); // content-free
  });

  test("a directory read surfaces a live read-error warning with its errno code", () => {
    const path = tmpFile();
    const readErrors: TranscriptReadErrorNotice[] = [];
    const watcher = new ClaudeTranscriptWatcher("s1", () => {}, {
      onReadError: (n) => readErrors.push(n),
    });
    writeFileSync(path, "");
    watcher.observe(path);
    rmSync(path);
    mkdirSync(path); // reading a directory throws EISDIR
    watcher.scan();
    watcher.stop();
    expect(readErrors.at(-1)!.lastErrorCode).toBe("EISDIR");
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
    expect(readErrors[0]).toMatchObject({ elwoodSessionId: "s1", path });
  });

  test("Finding C: a stat rejecting AFTER finish() routes NO warning (terminal latch)", async () => {
    // poll() kicks off an async stat, then finish() latches the watcher terminal.
    // When the in-flight stat REJECTS after finish(), its error must NOT be
    // recorded/routed — that would emit warning activity past terminal:exit,
    // breaking the permanent latch (§5.4). The fs guard records only while
    // `!finished`, so the post-finish rejection is swallowed.
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

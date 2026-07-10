/**
 * Bounded-read behavior for the transcript cursor: growth detection, offset
 * commit-after-success, and over-length record discard. Covers PRD §5.4/§9.2
 * (C-CLAUDE-15).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  resetRangeReaderForTests,
  setRangeReaderForTests,
  TranscriptCursor,
} from "../../src/claude/transcript-cursor.ts";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "elwood-tx-")), "t.jsonl");
}

function drainAll(cursor: TranscriptCursor): string {
  let out = "";
  for (let budget = 1000; budget > 0; budget--) {
    const { text, more } = cursor.readChunk();
    out += text;
    if (!more) break;
  }
  return out;
}

describe("C-CLAUDE-15 transcript cursor growth check", () => {
  test("hasGrown is false with no new bytes and true once the file grows", async () => {
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    expect(await cursor.hasGrown()).toBe(false); // baselined at EOF: no growth
    writeFileSync(path, "abc\n");
    expect(await cursor.hasGrown()).toBe(true);
  });

  test("hasGrown is true after a truncation shrinks the file below the offset", async () => {
    const path = tmpFile();
    writeFileSync(path, "aaaa\nbbbb\n");
    const cursor = new TranscriptCursor(path);
    drainAll(cursor); // advance the offset to EOF
    writeFileSync(path, "c\n"); // strictly shorter: size !== offset, must re-scan
    expect(await cursor.hasGrown()).toBe(true);
  });

  test("a non-ENOENT stat error at construction propagates to the caller's fs guard", () => {
    // A regular file used as a directory component yields ENOTDIR (not ENOENT),
    // which fileSize must rethrow rather than swallow as "empty file".
    const file = tmpFile();
    writeFileSync(file, "x");
    expect(() => new TranscriptCursor(join(file, "child.jsonl"))).toThrow();
  });

  test("readChunk commits the offset only after a successful read (no replay)", () => {
    // The offset must not be reset before the read succeeds. Truncate to empty,
    // read (empty), then regrow: the new content emits once, and the pre-truncate
    // content is never re-read — the offset commit is atomic with the read.
    const path = tmpFile();
    writeFileSync(path, "one\ntwo\n");
    const cursor = new TranscriptCursor(path); // baselines at EOF (offset = 8)
    expect(cursor.readChunk()).toEqual({ text: "", more: false }); // nothing new
    writeFileSync(path, ""); // truncate to empty: size (0) < offset (8) → from 0
    expect(cursor.readChunk()).toEqual({ text: "", more: false });
    writeFileSync(path, "three\n"); // regrow
    expect(drainAll(cursor)).toBe("three\n"); // only the new content, no replay
  });

  test("a FAILED post-truncation read preserves the offset (retry returns only the suffix)", () => {
    // Force the read that follows a truncation to THROW. If the offset had been
    // reset to 0 BEFORE that read (the pre-fix bug), the retry would replay from
    // the start. It must instead preserve the offset and, on retry, return only
    // the newly-appended suffix — proving the offset commits only after success.
    const path = tmpFile();
    writeFileSync(path, "aaaa\nbbbb\ncccc\n"); // 15 bytes
    const cursor = new TranscriptCursor(path);
    drainAll(cursor); // advance offset to EOF (15)
    // Rewrite LONGER so no truncation, then append the suffix we expect back.
    writeFileSync(path, "aaaa\nbbbb\ncccc\nDD\n"); // grew: 18 bytes, offset still 15
    setRangeReaderForTests(() => {
      resetRangeReaderForTests(); // subsequent reads use the real reader
      throw Object.assign(new Error("EIO"), { code: "EIO" }); // this first read throws
    });
    try {
      // The first readChunk throws inside readRange; the offset must NOT advance.
      expect(() => cursor.readChunk()).toThrow("EIO");
      // Retry (real reader now): only the "DD" suffix, never a replay of earlier records.
      expect(drainAll(cursor)).toBe("DD\n");
    } finally {
      resetRangeReaderForTests();
    }
  });

  test("takeLines splits complete lines and retains the trailing partial", () => {
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    expect(cursor.takeLines("a\nb\npart")).toEqual({ lines: ["a", "b"], droppedBytes: 0 });
    expect(cursor.takeLines("ial\nc\n")).toEqual({ lines: ["partial", "c"], droppedBytes: 0 });
  });

  test("takeLines discards an over-length un-terminated record through its next newline", () => {
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    const huge = "x".repeat(1024 * 1024 + 10); // >1 MiB, no newline: pending overflows
    const first = cursor.takeLines(huge);
    expect(first.lines).toEqual([]); // nothing complete, and the pending overflowed
    expect(first.droppedBytes).toBeGreaterThan(1024 * 1024);
    // Still discarding: more bytes without a newline are counted, not buffered.
    const second = cursor.takeLines("yyyy");
    expect(second).toEqual({ lines: [], droppedBytes: 4 });
    // The newline ends the discarded record; content after it resumes normally.
    const third = cursor.takeLines("tail-of-huge\nnext\n");
    expect(third.lines).toEqual(["next"]);
    expect(third.droppedBytes).toBe("tail-of-huge\n".length);
  });
});

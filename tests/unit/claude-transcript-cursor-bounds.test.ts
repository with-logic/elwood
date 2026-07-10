/**
 * Bounded-read behavior for the transcript cursor: growth detection, offset
 * commit-after-success, and over-length record discard. Covers PRD §5.4/§9.2
 * (C-CLAUDE-15).
 */

import { closeSync, mkdtempSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  resetMaxRecordsForTests,
  scanBaselineTail,
  setMaxRecordsForTests,
} from "../../src/claude/transcript/baseline.ts";
import {
  resetByteReaderForTests,
  setByteReaderForTests,
  TranscriptCursor,
} from "../../src/claude/transcript/cursor.ts";

function fileBytes(path: string): number {
  return statSync(path).size;
}

/** A real byte read that also tallies the total bytes requested (read amplification). */
function countingReader(counter: { bytes: number }) {
  return (path: string, start: number, length: number) => {
    counter.bytes += length;
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(path, "r");
    try {
      const read = readSync(fd, buf, 0, length, start);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  };
}

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
  test("needsScan is false with no new bytes and true once the file grows", async () => {
    const path = tmpFile();
    writeFileSync(path, "");
    const cursor = new TranscriptCursor(path);
    expect(await cursor.needsScan()).toBe(false); // baselined at EOF: no growth
    writeFileSync(path, "abc\n");
    expect(await cursor.needsScan()).toBe(true);
  });

  test("needsScan is true after a truncation shrinks the file below the offset", async () => {
    const path = tmpFile();
    writeFileSync(path, "aaaa\nbbbb\n");
    const cursor = new TranscriptCursor(path);
    drainAll(cursor); // advance the offset to EOF
    writeFileSync(path, "c\n"); // strictly shorter: size !== offset, must re-scan
    expect(await cursor.needsScan()).toBe(true);
  });

  test("baselineTail reads LINEAR bytes, not the quadratic expanding-window amount", () => {
    // The pre-fix baselineTail re-read the whole suffix each 64 KiB backward step,
    // so total bytes read grew ~O(n²) (≈ steps × suffix). The non-overlapping
    // block scan reads each byte at most ~once. Assert the total requested bytes
    // stays near the file size, which the old expanding-window impl would blow past.
    const path = tmpFile();
    // No user boundary within the cap → the scan walks back the full window: this
    // is the worst case for read amplification. Build ~800 KiB of assistant lines.
    const asst = (t: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
    writeFileSync(path, `${Array.from({ length: 8000 }, (_, i) => asst(`m${i}`)).join("\n")}\n`);
    const counter = { bytes: 0 };
    setByteReaderForTests(countingReader(counter));
    try {
      new TranscriptCursor(path).baselineTail();
    } finally {
      resetByteReaderForTests();
    }
    // Linear: each backward block is read once, so total ≈ the scanned span, well
    // under 2× the file. The old impl re-read the suffix each step → many× the file.
    expect(counter.bytes).toBeLessThan(fileBytes(path) * 2);
  });

  test("baselineTail stops at the record-count budget and recovers the in-window records", () => {
    // The CPU guard: even within the byte cap, a pathological many-tiny-line window
    // must not run an unbounded JSON.parse loop. With the budget shrunk below the
    // record count, the scan stops early yet still recovers the bounded in-window
    // records (never dropping the whole turn) rather than reaching the prompt.
    const path = tmpFile();
    const asst = (t: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
    const user = JSON.stringify({ type: "user", message: { content: "go" } });
    // Prompt deep enough (behind > 64 KiB of records) that the FIRST backward block
    // does not reach it; each record is large so a block holds a few of them.
    const big = (i: number) => asst(`r${i}-${"x".repeat(50 * 1024)}`);
    const tailRecords = Array.from({ length: 4 }, (_, i) => big(i)).join("\n");
    writeFileSync(path, `${user}\n${big(99)}\n${big(98)}\n${tailRecords}\n`);
    setMaxRecordsForTests(1); // stop after the first block, before the prompt block
    try {
      const tail = scanBaselineTail(path, fileBytes(path));
      expect(tail.truncated).toBe(true); // budget hit before the boundary
      // The earlier-in-file portion that fell outside the window is quantified so
      // the caller can surface it as a bounded, content-free drop (MINOR fix).
      expect(tail.unrecoveredBytes).toBeGreaterThan(0);
      expect(tail.lines.join("\n")).toContain("r3-"); // a newest in-window record kept
      expect(tail.lines.join("\n")).not.toContain('"content":"go"'); // prompt not reached
    } finally {
      resetMaxRecordsForTests();
    }
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

  test("a FAILED post-truncation read preserves the offset (no replay after regrowth)", () => {
    // The pre-fix bug reset the offset to 0 the instant a truncation was DETECTED,
    // BEFORE the read. So: drain to EOF, TRUNCATE to a shorter file, then fail the
    // read that truncation triggers. If the offset were reset to 0 here, a later
    // regrowth would replay the whole file. With the fix the offset stays put, so
    // after regrowth only the newly-appended suffix is returned.
    const path = tmpFile();
    writeFileSync(path, "aaaa\nbbbb\ncccc\n"); // 15 bytes
    const cursor = new TranscriptCursor(path);
    drainAll(cursor); // advance offset to EOF (15)
    writeFileSync(path, "XY\n"); // TRUNCATE to 3 bytes: size (3) < offset (15) → from 0
    setByteReaderForTests(() => {
      resetByteReaderForTests(); // subsequent reads use the real reader
      throw Object.assign(new Error("EIO"), { code: "EIO" }); // fail the truncation read
    });
    try {
      // The read throws; a pre-fix impl already reset the offset to 0 by now.
      expect(() => cursor.readChunk()).toThrow("EIO");
      // Regrow past the old offset. Fixed: offset still 15 → reads only "DD\n".
      // Pre-fix: offset 0 → would replay "aaaa\n...\nDD\n". Assert no replay.
      writeFileSync(path, "aaaa\nbbbb\ncccc\nDD\n"); // 18 bytes
      expect(drainAll(cursor)).toBe("DD\n");
    } finally {
      resetByteReaderForTests();
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

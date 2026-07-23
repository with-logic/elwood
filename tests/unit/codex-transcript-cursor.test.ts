/**
 * Conformance coverage for the BOUNDED Codex transcript cursor + its fs primitives.
 * Covers PRD §7A/§5.4: fixed-size chunk reads, UTF-8-safe decoding, truncation
 * restart, and the max-pending ceiling that discards over-length un-terminated
 * records with explicit discard transitions — the ported Claude bounded-cursor.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CodexTranscriptCursor } from "../../src/codex/transcript/cursor.ts";
import {
  fileSize,
  readRange,
  resetByteReaderForTests,
  setByteReaderForTests,
} from "../../src/codex/transcript/cursor-io.ts";
import { tempDirForUnit } from "./helpers.ts";

afterEach(() => resetByteReaderForTests());

describe("Codex bounded cursor-io", () => {
  test("C-CODEX-20 fileSize returns 0 for a missing file and rethrows other errors", () => {
    expect(fileSize(join(tempDirForUnit(), "nope.jsonl"))).toBe(0);
    // A NUL-byte path makes statSync throw a non-ENOENT error, which is rethrown.
    expect(() => fileSize("bad\0path")).toThrow();
  });

  test("C-CODEX-20 readRange decodes only to a complete UTF-8 boundary via the seam", () => {
    // "é" is 0xC3 0xA9; truncate after the lead byte — only complete bytes decode.
    setByteReaderForTests(() => Buffer.from([0x61, 0xc3]));
    expect(readRange("x", 0, 2)).toEqual({ text: "a", bytes: 1 });
    setByteReaderForTests(() => Buffer.from([0xc3, 0xa9]));
    expect(readRange("x", 0, 2)).toEqual({ text: "é", bytes: 2 });
  });
});

describe("Codex bounded cursor", () => {
  test("C-CODEX-20 readChunk caps at 256 KiB and streams the remainder", () => {
    // Construct the cursor on an EMPTY file (baselines at offset 0), then append a
    // > 256 KiB record so the first read is capped and a second drains the rest.
    const path = join(tempDirForUnit(), "empty.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    appendFileSync(path, `${"x".repeat(300 * 1024)}\n`);
    const first = cursor.readChunk();
    expect(Buffer.byteLength(first.text, "utf8")).toBe(256 * 1024);
    expect(first.canContinueNow).toBe(true);
    expect(cursor.readChunk().canContinueNow).toBe(false);
  });

  test("C-CODEX-20 a read that consumes ZERO bytes (incomplete UTF-8 tail) reports canContinueNow:false — no spin", () => {
    // The file grew by exactly one incomplete-code-point byte (a partial write). The
    // byte reader returns it, but completeUtf8Length is 0, so the read advances 0 bytes.
    // readChunk MUST report canContinueNow:false so the scan loop stops rather than re-reading
    // the same byte up to 16×/tick until the rest of the code point lands.
    const path = join(tempDirForUnit(), "partial.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    appendFileSync(path, Buffer.from([0xc3])); // lead byte of "é", rest not yet written
    setByteReaderForTests(() => Buffer.from([0xc3]));
    const chunk = cursor.readChunk();
    expect(chunk).toEqual({ text: "", canContinueNow: false }); // no progress, no spin
  });

  test("C-CODEX-20 readChunk restarts at 0 on truncation and reports no growth", () => {
    const path = join(tempDirForUnit(), "trunc.jsonl");
    writeFileSync(path, "aaaa\n");
    const cursor = new CodexTranscriptCursor(path);
    appendFileSync(path, "bbbb\n");
    expect(cursor.readChunk().text).toBe("bbbb\n");
    // No new bytes: an empty read that commits the current offset (the `size<=from`
    // branch), returning canContinueNow:false without a read.
    expect(cursor.readChunk()).toEqual({ text: "", canContinueNow: false });
    // Shrink below the offset: the next read restarts from 0.
    writeFileSync(path, "cc\n");
    expect(cursor.readChunk().text).toBe("cc\n");
  });

  test("C-CODEX-20 takeLines discards an over-length un-terminated record", () => {
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "e.jsonl"));
    const giant = "y".repeat(1024 * 1024 + 5);
    // No newline yet: the whole over-length buffer is discarded, a fresh drop begins.
    const started = cursor.takeLines(giant);
    expect(started.lines).toEqual([]);
    expect(started.startedOversizedDrop).toBe(true);
    // More bytes, still no newline: continuing the same record — not a new drop.
    const cont = cursor.takeLines("more-no-newline");
    expect(cont.startedOversizedDrop).toBe(false);
    // The terminating newline ends the discard and a following record is emitted.
    const ended = cursor.takeLines('tail\n{"type":"note"}\n');
    expect(ended.startedOversizedDrop).toBe(false);
    expect(ended.lines).toEqual(['{"type":"note"}']);
  });

  test("C-CODEX-20 takeLines can END one discard and START the next in one chunk", () => {
    const cursor = new CodexTranscriptCursor(join(tempDirForUnit(), "e.jsonl"));
    cursor.takeLines("z".repeat(1024 * 1024 + 1)); // start a discard
    const both = cursor.takeLines(`end\n${"w".repeat(1024 * 1024 + 1)}`);
    // Closed the prior discard AND started a fresh over-length record:
    // `startedOversizedDrop` is true for the NEW record (the prior was surfaced
    // when it started).
    expect(both.startedOversizedDrop).toBe(true);
  });

  test("C-CODEX-20 drainPending flushes then clears, remainingBytes reflects the tail", () => {
    const path = join(tempDirForUnit(), "r.jsonl");
    writeFileSync(path, "");
    const cursor = new CodexTranscriptCursor(path);
    cursor.takeLines("partial-no-newline");
    expect(cursor.drainPending()).toBe("partial-no-newline");
    expect(cursor.drainPending()).toBe("");
    appendFileSync(path, "unread-tail");
    expect(cursor.remainingBytes()).toBe("unread-tail".length);
  });

  test("C-CODEX-20 remainingBytes is 0 when the file shrank below the cursor", () => {
    const path = join(tempDirForUnit(), "shrink.jsonl");
    writeFileSync(path, "aaaaaaaa\n");
    const cursor = new CodexTranscriptCursor(path);
    cursor.readChunk(); // no new bytes; offset stays at the original EOF
    // Truncate below the offset so `size > offset` is false and remainingBytes
    // reports 0 (no negative backlog).
    writeFileSync(path, "x");
    expect(cursor.remainingBytes()).toBe(0);
  });
});

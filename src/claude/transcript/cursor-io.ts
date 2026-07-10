/**
 * Bounded filesystem primitives for the transcript cursor.
 * Implements PRD §5.4 (C-CLAUDE-15): stat and range reads used by the cursor to
 * read only NEW committed bytes, decoding to complete UTF-8 boundaries so a split
 * multibyte character is never corrupted and a full-file read never OOMs the host.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";
import { completeUtf8Length } from "../../runtime/probe.ts";

export function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function fileSize(path: string): number {
  // One stat, no exists-then-stat TOCTOU window: ENOENT means "no file yet",
  // which is size 0; any other error propagates to the caller's fs guard. The
  // errno is read through `errnoCode` (object-ness narrowed first), so a thrown
  // null/non-Error is preserved and rethrown, never replaced by a secondary
  // TypeError raised while inspecting it (C-ERR-01).
  try {
    return statSync(path).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw error;
  }
}

export type RangeRead = { text: string; bytes: number };

/** The injectable read seam: returns the RAW bytes read at `[start, start+length)`. */
export type ByteReader = (path: string, start: number, length: number) => Buffer;

function realReadBytes(path: string, start: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// Indirection so a test can force a read failure (proving the offset is committed
// only AFTER a successful read) or count read amplification. All range reads,
// forward and backward, funnel through this ONE seam.
let readBytesImpl: ByteReader = realReadBytes;
export const readBytes: ByteReader = (p, s, l) => readBytesImpl(p, s, l);

// Reads `length` bytes at `start`, decoding only to the last COMPLETE UTF-8 code
// point (a split multibyte char is left for the next read, not corrupted). Used
// for FORWARD reads where `start` is an already-committed code-point boundary.
export function readRange(path: string, start: number, length: number): RangeRead {
  const bytes = readBytes(path, start, length);
  const complete = completeUtf8Length(bytes);
  return { text: bytes.toString("utf8", 0, complete), bytes: complete };
}

/** One backward block: its decoded text and the byte offset it actually begins at. */
export type BackwardBlock = { readonly text: string; readonly start: number };

// Max continuation bytes that can lead a code point split at a block seam (a
// 4-byte code point has at most 3 continuation bytes).
const maxLeadingContinuation = 3;

// Reads the block `[start, end)` for a BACKWARD scan, decoding intact even when
// `start` splits a multibyte code point at the block seam. When `start > 0` we
// over-read up to 3 bytes before `start` so the split code point's lead byte is
// present, then drop only the raw leading bytes that belong to the code point
// straddling `start` — so no U+FFFD is ever produced at the seam (C-CLAUDE-15).
// The returned `start` is the byte offset the decoded text actually begins at,
// which the caller uses as the next step's `end` (no double-count, no gap).
export function readBackwardBlock(path: string, start: number, end: number): BackwardBlock {
  const over = Math.min(start, maxLeadingContinuation);
  const readStart = start - over;
  const bytes = readBytes(path, readStart, end - readStart);
  const skip = over === 0 ? 0 : leadingSkip(bytes, over);
  const complete = completeUtf8Length(bytes.subarray(skip));
  return { text: bytes.toString("utf8", skip, skip + complete), start: readStart + skip };
}

// Raw bytes to drop from the front of a backward block so decoding begins on a
// COMPLETE code point at (or after) the original `start`. `over` extra bytes were
// prepended so any code point straddling `start` is fully present. The original
// `start` sits at buffer index `over`; if the byte there is a UTF-8 continuation
// byte (0b10xxxxxx), the code point began earlier and straddles the seam, so skip
// forward past every continuation byte to the next code-point boundary (which may
// land after `over`). Otherwise `start` already begins a code point: drop the
// `over` pre-bytes exactly.
function leadingSkip(bytes: Buffer, over: number): number {
  let skip = over;
  while (skip < bytes.length && (bytes[skip] as number) >= 0x80 && (bytes[skip] as number) < 0xc0) {
    skip++;
  }
  return skip;
}

export function setByteReaderForTests(reader: ByteReader): void {
  readBytesImpl = reader;
}
export function resetByteReaderForTests(): void {
  readBytesImpl = realReadBytes;
}

/**
 * Bounded filesystem primitives for the Codex transcript cursor.
 * Implements PRD §7A/§5.4: a stat and a fixed-length forward range read that
 * decode only to a complete UTF-8 boundary, so the cursor reads only NEW committed
 * bytes and a full-file read never OOMs the host. Mirrors Claude's cursor-io
 * (forward path only — Codex has no backward baseline-tail scan).
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";
import { completeUtf8Length } from "../../runtime/probe.ts";

export function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function fileSize(path: string): number {
  // One stat, no exists-then-stat TOCTOU window: ENOENT means "no file yet" (size
  // 0); any other error propagates to the caller's fs guard. The errno is read via
  // `errnoCode` (object-ness narrowed first) so a thrown null/non-Error is
  // preserved and rethrown, never replaced by a secondary TypeError.
  try {
    return statSync(path).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw error;
  }
}

export type RangeRead = { readonly text: string; readonly bytes: number };

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
// only AFTER a successful read) or count read amplification.
let readBytesImpl: ByteReader = realReadBytes;
export const readBytes: ByteReader = (p, s, l) => readBytesImpl(p, s, l);

// Reads `length` bytes at `start`, decoding only to the last COMPLETE UTF-8 code
// point (a split multibyte char is left for the next read, not corrupted). `start`
// is always an already-committed code-point boundary, so no leading-byte fixup is
// needed (the forward-read invariant).
export function readRange(path: string, start: number, length: number): RangeRead {
  const bytes = readBytes(path, start, length);
  const complete = completeUtf8Length(bytes);
  return { text: bytes.toString("utf8", 0, complete), bytes: complete };
}

export function setByteReaderForTests(reader: ByteReader): void {
  readBytesImpl = reader;
}
export function resetByteReaderForTests(): void {
  readBytesImpl = realReadBytes;
}

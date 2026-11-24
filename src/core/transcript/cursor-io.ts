/**
 * Bounded filesystem primitives shared by both adapters' transcript cursors.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): a stat and a fixed-length forward range
 * read that decode only to a complete UTF-8 boundary, so a cursor reads only NEW
 * committed bytes and a full-file read never OOMs the host. Both adapters have
 * identical forward-read semantics; Claude layers a backward baseline-tail scan on
 * top of the same injectable byte seam (see claude/transcript/cursor-io.ts).
 */

import { closeSync, constants, fstatSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { errnoCode } from "../errors.ts";
import { completeUtf8Length } from "../utf8.ts";

export function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function fileSize(path: string): number {
  return observedSize(path) ?? 0;
}

/**
 * The file's size from one stat, or `undefined` when it does not exist. One stat, no
 * exists-then-stat TOCTOU window: any other error propagates to the caller's fs guard.
 * The errno is read via `errnoCode` (object-ness narrowed first) so a thrown
 * null/non-Error is preserved and rethrown, never replaced by a secondary TypeError
 * (C-ERR-01).
 */
export function observedSize(path: string): number | undefined {
  return statIfPresent(path)?.size;
}

export function statIfPresent(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export type RangeRead = { readonly text: string; readonly bytes: number };

/** The injectable read seam: returns the RAW bytes read at `[start, start+length)`. */
export type ByteReader = (path: string, start: number, length: number) => Buffer;

/** Keep the opened descriptor scoped to the callback and always close it.
 * A replacement FIFO must fail the caller's file-type check instead of blocking at open. */
export function withTranscriptFile<T>(path: string, read: (fd: number, status: Stats) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    return read(fd, fstatSync(fd));
  } finally {
    closeSync(fd);
  }
}

function realReadBytes(path: string, start: number, length: number): Buffer {
  return withTranscriptFile(path, (fd, status) => {
    if (!status.isFile()) {
      const code = status.isDirectory() ? "EISDIR" : "EINVAL";
      throw Object.assign(new Error("The transcript path is not a regular file."), { code });
    }
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  });
}

// Indirection so a test can force a read failure (proving the offset is committed
// only AFTER a successful read) or count read amplification. Forward reads and
// Claude current-turn replay both use this seam.
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

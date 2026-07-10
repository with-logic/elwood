/**
 * Bounded, per-path incremental reader for a Claude transcript JSONL file.
 * Implements PRD §5.4 (C-CLAUDE-15): reads only NEW committed records without
 * ever buffering the whole file. Resume and A→B→A path switches must not replay
 * history — a real transcript can be hundreds of MB, so a full-delta read would
 * block the event loop and OOM the host.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { completeUtf8Length } from "../runtime/probe.ts";

/** Read at most this many bytes per scan pass, so a large delta is streamed, not slurped. */
const maxChunkBytes = 256 * 1024;
/** One backward step when recovering the current turn at first observe. */
const baselineStepBytes = 64 * 1024;
/** Hard cap on how far back the baseline scan reaches, so it stays bounded. */
const baselineMaxBytes = 4 * 1024 * 1024;
/**
 * Max bytes a single un-terminated record line may buffer. A pathological record
 * with no newline (a huge tool/MCP output) would otherwise grow `pending`
 * without bound and re-concatenate quadratically. Past this the line is
 * discarded through its next newline and reported as dropped bytes.
 */
const maxPendingBytes = 1024 * 1024;

/** Outcome of a bounded read: the decoded text plus whether more remains to read. */
export type ChunkRead = { readonly text: string; readonly more: boolean };

/** Lines parsed from a chunk, plus bytes discarded from an over-length record. */
export type TakenLines = { readonly lines: readonly string[]; readonly droppedBytes: number };

/**
 * Tracks the read position for one transcript path and performs bounded reads.
 * A new cursor starts at the file's CURRENT end (its history is NOT replayed);
 * `baselineTail()` recovers just the current turn already-on-disk when the first
 * hook to carry the path is a turn-boundary hook.
 */
export class TranscriptCursor {
  readonly path: string;
  private offset: number;
  private pending = "";
  // When the current un-terminated line overflowed, we discard incoming bytes up
  // to (and including) the next newline instead of buffering them.
  private discarding = false;

  constructor(path: string) {
    this.path = path;
    this.offset = fileSize(path);
  }

  /**
   * The current (final) turn already on disk (the Stop-first edge). Scans BACKWARD
   * from EOF in NON-OVERLAPPING blocks — accumulating the tail once, not re-reading
   * the suffix each step (was O(n²)) — until the last user PROMPT record (the turn
   * boundary). Bounded by `baselineMaxBytes`; returns "" when new/empty or no
   * boundary is within the cap.
   */
  baselineTail(): string {
    const size = fileSize(this.path);
    if (size === 0) return "";
    let end = size;
    let tail = ""; // records already confirmed to be after any boundary found so far
    while (end > 0 && size - end < baselineMaxBytes) {
      const start = Math.max(0, end - baselineStepBytes);
      const block = readRange(this.path, start, end - start).text;
      const window = `${block}${tail}`;
      const boundary = lastUserBoundary(window);
      if (boundary >= 0) return afterBoundary(window, boundary);
      tail = window; // no boundary yet: carry the whole window and step further back
      end = start;
    }
    return "";
  }

  // True when the file changed size (grew OR truncated) since the last read, via
  // an ASYNC stat so an idle poll does no sync fs work on the loop (§9.2).
  async hasGrown(): Promise<boolean> {
    const size = (await stat(this.path)).size;
    return size !== this.offset;
  }

  /** Read up to `maxChunkBytes` of new content, advancing the cursor by bytes consumed. */
  readChunk(): ChunkRead {
    const size = fileSize(this.path);
    // Truncation restarts from 0, but the offset is COMMITTED only after the read
    // succeeds, so a truncate-then-read throw doesn't replay already-emitted data.
    const from = size < this.offset ? 0 : this.offset;
    if (size <= from) {
      this.offset = from;
      return { text: "", more: false };
    }
    const want = Math.min(maxChunkBytes, size - from);
    const { text, bytes } = readRange(this.path, from, want);
    // Advance by bytes actually consumed (a split code point waits), no drift.
    this.offset = from + bytes;
    return { text, more: this.offset < size };
  }

  // Split buffered text into complete lines, retaining any trailing partial. A
  // record past `maxPendingBytes` with no newline is discarded through its next
  // newline (its bytes reported) so it can't OOM or re-concat quadratically (§5.4).
  takeLines(text: string): TakenLines {
    let dropped = 0;
    let rest = text;
    if (this.discarding) {
      const nl = rest.indexOf("\n");
      if (nl === -1) return { lines: [], droppedBytes: byteLen(rest) }; // still no newline
      dropped += byteLen(rest.slice(0, nl + 1));
      this.discarding = false;
      rest = rest.slice(nl + 1);
    }
    const lines = `${this.pending}${rest}`.split(/\r?\n/);
    // `split` always yields at least one element, so pop() is a string here.
    this.pending = lines.pop() as string;
    if (byteLen(this.pending) > maxPendingBytes) {
      dropped += byteLen(this.pending); // over-length un-terminated record: discard it
      this.pending = "";
      this.discarding = true;
    }
    return { lines, droppedBytes: dropped };
  }

  /** The final buffered partial line (flushed once at teardown), then cleared. */
  drainPending(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/** Index of the last `user`-role record line in `text`, or -1 if none. */
function lastUserBoundary(text: string): number {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isUserRecord(lines[i] as string)) return i;
  }
  return -1;
}

/** The records after the boundary line — the current, possibly-just-committed turn. */
function afterBoundary(text: string, boundary: number): string {
  return text
    .split(/\r?\n/)
    .slice(boundary + 1)
    .join("\n");
}

// True only for a genuine user PROMPT — the real turn boundary. A `tool_result`
// is ALSO a `type:"user"` record but belongs to the current turn, so it is NOT a
// boundary (else committed tool activity is dropped). A prompt carries prose
// (string content or a `text` block); a pure tool_result carries only those.
function isUserRecord(line: string): boolean {
  if (!line.trim()) return false;
  try {
    const record = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (record.type !== "user") return false;
    const content = record.message?.content;
    if (typeof content === "string") return true; // string content is always prose
    if (!Array.isArray(content)) return false;
    // A prompt has at least one non-tool_result block; a pure tool_result record
    // (every block is a tool_result) is part of the current turn, not a boundary.
    return content.some((block) => (block as { type?: unknown })?.type !== "tool_result");
  } catch {
    return false;
  }
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function fileSize(path: string): number {
  // One stat, no exists-then-stat TOCTOU window: ENOENT means "no file yet",
  // which is size 0; any other error propagates to the caller's fs guard.
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/**
 * Reads `length` bytes at `start` and decodes only up to the last COMPLETE UTF-8
 * code point, returning the decoded text and the exact number of bytes it spans.
 * A multibyte character split at the requested boundary is dropped from this read
 * (its bytes are left for the next read) rather than becoming a replacement char.
 */
function readRange(path: string, start: number, length: number): { text: string; bytes: number } {
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, length, start);
    const complete = completeUtf8Length(buffer.subarray(0, read));
    return { text: buffer.toString("utf8", 0, complete), bytes: complete };
  } finally {
    closeSync(fd);
  }
}

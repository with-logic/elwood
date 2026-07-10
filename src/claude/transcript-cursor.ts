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

/** Outcome of a bounded read: the decoded text plus whether more remains to read. */
export type ChunkRead = { readonly text: string; readonly more: boolean };

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

  constructor(path: string) {
    this.path = path;
    this.offset = fileSize(path);
  }

  /**
   * The current (final) assistant turn already on disk, for the Stop-first edge
   * where the committed record landed just before the first observe. Scans
   * BACKWARD from EOF in bounded steps until the last `user`-role record (the
   * turn boundary) is found, so a resume with a long history never replays prior
   * turns AND a current turn larger than one step is not lost. Bounded by
   * `baselineMaxBytes`. Returns "" when the file is new/empty.
   */
  baselineTail(): string {
    const size = fileSize(this.path);
    if (size === 0) return "";
    let start = Math.max(0, size - baselineStepBytes);
    while (true) {
      const window = readRange(this.path, start, size - start).text;
      const boundary = lastUserBoundary(window);
      // Found the boundary, or reached the file start / the scan cap: stop.
      if (boundary >= 0) return afterBoundary(window, boundary);
      if (start === 0 || size - start >= baselineMaxBytes) return "";
      start = Math.max(0, start - baselineStepBytes);
    }
  }

  /**
   * True when the file has new bytes (or was truncated) since the last read,
   * using an ASYNC stat so an idle poll never blocks the shared event loop —
   * the common case is "no change", for which no synchronous fs work runs at
   * all (PRD §9.2). A bounded synchronous read then follows only on real growth.
   */
  async hasGrown(): Promise<boolean> {
    const size = (await stat(this.path)).size;
    return size !== this.offset;
  }

  /** Read up to `maxChunkBytes` of new content, advancing the cursor by bytes consumed. */
  readChunk(): ChunkRead {
    const size = fileSize(this.path);
    if (size < this.offset) this.offset = 0; // truncated/rotated: restart.
    if (size <= this.offset) return { text: "", more: false };
    const want = Math.min(maxChunkBytes, size - this.offset);
    const { text, bytes } = readRange(this.path, this.offset, want);
    // Advance by the bytes actually consumed (a code point split at the chunk
    // boundary is left for the next read), so the offset can never drift.
    this.offset += bytes;
    return { text, more: this.offset < size };
  }

  /** Split buffered text into complete lines, retaining any trailing partial line. */
  takeLines(text: string): readonly string[] {
    const lines = `${this.pending}${text}`.split(/\r?\n/);
    // `split` always yields at least one element, so pop() is a string here.
    this.pending = lines.pop() as string;
    return lines;
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

/**
 * True only for a genuine user PROMPT record — the real turn boundary. A Claude
 * `tool_result` is ALSO a `type: "user"` record, but it belongs to the CURRENT
 * turn (assistant tool_use → user tool_result → assistant text), so treating it
 * as the boundary would drop committed tool activity C-CLAUDE-15 requires. A
 * prompt carries prose (string content or a `text` block); a pure tool_result
 * record carries only `tool_result` blocks and is NOT a boundary.
 */
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

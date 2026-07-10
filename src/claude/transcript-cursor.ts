/**
 * Bounded, per-path incremental reader for a Claude transcript JSONL file.
 * Implements PRD §5.4 (C-CLAUDE-15): reads only NEW committed records without
 * ever buffering the whole file. Resume and A→B→A path switches must not replay
 * history — a real transcript can be hundreds of MB, so a full-delta read would
 * block the event loop and OOM the host.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** Read at most this many bytes per scan pass, so a large delta is streamed, not slurped. */
const maxChunkBytes = 256 * 1024;
/** Backward-scan window for the first observe of a pre-existing transcript (the Stop-first edge). */
const baselineTailBytes = 64 * 1024;

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
   * where the committed record landed just before the first observe. Reads a
   * bounded tail window and returns only the records AFTER the last user-role
   * record — the in-progress assistant turn — so a resume with a long history
   * does not replay prior turns. Returns "" when the file is new/empty.
   */
  baselineTail(): string {
    const size = fileSize(this.path);
    if (size === 0) return "";
    const start = Math.max(0, size - baselineTailBytes);
    return currentTurnTail(readRange(this.path, start, size - start));
  }

  /** Read up to `maxChunkBytes` of new content, advancing the cursor. */
  readChunk(): ChunkRead {
    const size = fileSize(this.path);
    if (size < this.offset) this.offset = 0; // truncated/rotated: restart.
    if (size <= this.offset) return { text: "", more: false };
    const want = Math.min(maxChunkBytes, size - this.offset);
    const text = readRange(this.path, this.offset, want);
    this.offset += Buffer.byteLength(text, "utf8");
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

/**
 * Given a tail of transcript text, keep only the lines belonging to the final
 * assistant turn: everything AFTER the last `user`-role record. A `user` record
 * marks the boundary of the previous turn, so records after it are the current,
 * possibly-just-committed assistant turn — the only history worth recovering on
 * a first observe. If no user boundary is present in the window, nothing is
 * recovered (treat it as pre-existing history, not the current turn).
 */
function currentTurnTail(tail: string): string {
  const lines = tail.split(/\r?\n/);
  let boundary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isUserRecord(lines[i] as string)) boundary = i;
  }
  if (boundary < 0) return "";
  return lines.slice(boundary + 1).join("\n");
}

function isUserRecord(line: string): boolean {
  if (!line.trim()) return false;
  try {
    return (JSON.parse(line) as { type?: unknown }).type === "user";
  } catch {
    return false;
  }
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function readRange(path: string, start: number, length: number): string {
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

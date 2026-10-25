/**
 * Bounded incremental reader for one transcript JSONL file, shared by both adapters.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): reads only NEW committed records in
 * fixed-size chunks, never the whole file — a real transcript can be hundreds of MB,
 * so a full-delta read would OOM or block the loop. A single un-terminated record is
 * buffered only up to a bounded ceiling; a record past it is discarded through its
 * next newline so a no-newline giant line can't OOM or re-concatenate quadratically.
 *
 * Both adapters share these forward-read semantics verbatim, and one existence policy
 * (§5.7, C-CLAUDE-24): until a stat has seen the file, ENOENT means "not created yet";
 * after that it is a removal that throws for the caller's fs guard. Claude extends the
 * base with a backward baseline-tail scan and an async `needsScan`.
 */

import { statSync } from "node:fs";
import { errnoCode } from "../errors.ts";
import { byteLen, fileSize, observedSize, readRange } from "./cursor-io.ts";

const maxChunkBytes = 256 * 1024; // bytes read per scan pass (a large delta streams)
// Max bytes a single un-terminated record may buffer before it is discarded through
// its next newline (a no-newline giant line can't OOM or re-concat quadratically).
const maxPendingBytes = 1024 * 1024;

/** Outcome of a bounded read: the decoded text plus whether an immediate next read
 * can make progress (canContinueNow). An incomplete UTF-8 tail leaves unread bytes
 * yet returns false: no progress is possible until the rest of the code point lands. */
export type ChunkRead = { readonly text: string; readonly canContinueNow: boolean };

/**
 * Complete lines from a chunk, plus whether this call BEGAN a new over-length
 * discard (`startedOversizedDrop`). This is an EDGE trigger: it is true only on the
 * call that starts losing a fresh oversized record, and false while an already-started
 * discard continues (including when its terminating newline is finally consumed). The
 * emitter surfaces exactly ONE live drop warning per oversized record off this edge —
 * never a running count.
 */
export type TakenLines = {
  readonly lines: readonly string[];
  readonly startedOversizedDrop: boolean;
};

/**
 * Tracks the read position for one transcript path and performs bounded reads.
 * A new cursor starts at the file's CURRENT end (its history is NOT replayed), so
 * an A→B→A path switch or a resume never replays committed activity.
 */
export class BoundedTranscriptCursor {
  readonly path: string;
  protected offset: number;
  private pending = "";
  // When the current un-terminated line overflowed, discard incoming bytes up to
  // (and including) the next newline instead of buffering them.
  private discarding = false;
  // A CLI can name its transcript before writing it, so until a stat has seen the file,
  // ENOENT means "not created yet" rather than a removal or rotation (§5.7).
  private created: boolean;

  /** Starts at the file's current end. One stat gives both that offset and whether the
   *  file exists, so the two never disagree about a file removed in between. */
  constructor(path: string) {
    const size = observedSize(path);
    this.path = path;
    this.offset = size ?? 0;
    this.created = size !== undefined;
  }

  /**
   * One live scan read. A file not created yet reads nothing; any other failure, ENOENT
   * after the file existed included, throws for the fs guard. The read is sized by this
   * same stat, so a removal can never read as a truncation and reset the cursor.
   */
  readLive(): ChunkRead {
    let size: number;
    try {
      size = this.sawSize(statSync(this.path).size);
    } catch (error) {
      this.rethrowUnlessUncreated(error);
      return { text: "", canContinueNow: false };
    }
    return this.readChunk(size);
  }

  /** Record a stat that saw the file, returning its size. */
  protected sawSize(size: number): number {
    this.created = true;
    return size;
  }

  /** A stat failure is only "not created yet" for ENOENT before any stat saw the file. */
  protected rethrowUnlessUncreated(error: unknown): void {
    if (this.created || errnoCode(error) !== "ENOENT") throw error;
  }

  /**
   * Read up to `maxChunkBytes` of new content, advancing the cursor by bytes consumed.
   * `size` comes from the caller's stat; the terminal drain's default reads a missing
   * file as empty.
   */
  readChunk(size = fileSize(this.path)): ChunkRead {
    // Truncation restarts from 0, but the offset is COMMITTED only after the read
    // succeeds, so a truncate-then-read throw doesn't replay already-emitted data.
    // The buffered partial line and any in-progress oversized discard belonged to
    // the OLD file, so both reset with the cursor.
    if (size < this.offset) {
      this.pending = "";
      this.discarding = false;
    }
    const from = size < this.offset ? 0 : this.offset;
    if (size <= from) {
      this.offset = from;
      return { text: "", canContinueNow: false };
    }
    const want = Math.min(maxChunkBytes, size - from);
    const { text, bytes } = readRange(this.path, from, want);
    // Advance by bytes actually consumed (a split code point waits), no drift.
    this.offset = from + bytes;
    // A read that consumed ZERO bytes (the window is entirely an incomplete UTF-8
    // sequence — a partial write at EOF) made no progress: report canContinueNow:false
    // so the scan/drain loop stops this pass instead of spinning on the same bytes.
    // The next tick re-reads once the rest of the code point is committed.
    const advanced = bytes > 0;
    return { text, canContinueNow: advanced && this.offset < size };
  }

  // Split buffered text into complete lines, retaining any trailing partial. A
  // record past `maxPendingBytes` with no newline is discarded through its next
  // newline so it can't OOM or re-concat quadratically. `startedOversizedDrop`
  // reports whether THIS call BEGAN a fresh over-length discard, so the emitter
  // surfaces exactly one live drop warning per over-length record (a continuation
  // is not a new drop).
  takeLines(text: string): TakenLines {
    let rest = text;
    if (this.discarding) {
      const nl = rest.indexOf("\n");
      // Still no newline: the same over-length record continues (not a new drop).
      if (nl === -1) return { lines: [], startedOversizedDrop: false };
      this.discarding = false;
      rest = rest.slice(nl + 1);
    }
    const lines = `${this.pending}${rest}`.split(/\r?\n/);
    // `split` always yields at least one element, so pop() is a string here.
    this.pending = lines.pop() as string;
    const startedNew = byteLen(this.pending) > maxPendingBytes;
    if (startedNew) {
      this.pending = ""; // over-length un-terminated record: discard it
      this.discarding = true;
    }
    return { lines, startedOversizedDrop: startedNew };
  }

  /** The final buffered partial line (flushed once at teardown), then cleared. */
  drainPending(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }

  // Unread bytes still on disk past the cursor (a truncation reads as 0). Used at
  // teardown to size the backlog left unread when the drain budget is spent, so it
  // is accounted as a content-free drop rather than read as hundreds of MiB.
  remainingBytes(): number {
    const size = fileSize(this.path);
    return size > this.offset ? size - this.offset : 0;
  }
}

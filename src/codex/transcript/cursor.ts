/**
 * Bounded incremental reader for one Codex transcript JSONL file.
 * Implements PRD §7A/§5.4: reads only NEW committed records in fixed-size chunks,
 * never the whole file — a real transcript can be hundreds of MB, so a full-delta
 * read would OOM or block the loop. A single un-terminated record is buffered only
 * up to a bounded ceiling; a record past it is discarded through its next newline
 * so a no-newline giant line can't OOM or re-concatenate quadratically.
 */

import { byteLen, fileSize, readRange } from "./cursor-io.ts";

const maxChunkBytes = 256 * 1024; // bytes read per scan pass (a large delta streams)
// Max bytes a single un-terminated record may buffer before it is discarded
// through its next newline.
const maxPendingBytes = 1024 * 1024;

/** Outcome of a bounded read: the decoded text plus whether more remains to read. */
export type ChunkRead = { readonly text: string; readonly more: boolean };

/**
 * The cursor's over-length-discard state transition across one `takeLines` call,
 * reported EXPLICITLY so the emitter never infers it from `lines`/`bytes`:
 * - `"none"`: not discarding and did not start (the common case).
 * - `"started"`: this call BEGAN a fresh over-length discard (count one lost record).
 * - `"continuing"`: this call added more bytes to a discard already in progress
 *   (count zero — the same record's continuation, not a new loss).
 * - `"ended"`: this call consumed the discarded record's terminating newline and
 *   is no longer discarding; any over-length bytes reported belong to a NEW record
 *   that also started this call (so it also counts one).
 */
export type DiscardTransition = "none" | "started" | "continuing" | "ended";

/** Complete lines from a chunk, plus over-length drop bytes and the discard transition. */
export type TakenLines = {
  readonly lines: readonly string[];
  readonly droppedBytes: number;
  readonly discard: DiscardTransition;
};

/**
 * Tracks the read position for one transcript path and performs bounded reads.
 * A new cursor starts at the file's CURRENT end (its history is NOT replayed), so
 * an A→B→A path switch or a resume never replays committed activity.
 */
export class CodexTranscriptCursor {
  readonly path: string;
  private offset: number;
  private pending = "";
  // When the current un-terminated line overflowed, discard incoming bytes up to
  // (and including) the next newline instead of buffering them.
  private discarding = false;

  constructor(path: string) {
    this.path = path;
    this.offset = fileSize(path);
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
    // A read that consumed ZERO bytes (the window is entirely an incomplete UTF-8
    // sequence — a partial write at EOF) made no progress: report `more: false` so
    // the scan/drain loop stops this pass instead of spinning on the same bytes. The
    // next tick re-reads once the rest of the code point is committed.
    const advanced = bytes > 0;
    return { text, more: advanced && this.offset < size };
  }

  // Split buffered text into complete lines, retaining any trailing partial. A
  // record past `maxPendingBytes` with no newline is discarded through its next
  // newline (its bytes reported) so it can't OOM or re-concat quadratically. The
  // returned `discard` transition is the cursor's OWN truth, so the emitter counts
  // exactly one lost record per over-length record even when one chunk both ENDS
  // one discard and STARTS the next.
  takeLines(text: string): TakenLines {
    let dropped = 0;
    let rest = text;
    const wasDiscarding = this.discarding;
    if (this.discarding) {
      const nl = rest.indexOf("\n");
      // Still no newline: the same over-length record continues (bytes only, no +1).
      if (nl === -1) return { lines: [], droppedBytes: byteLen(rest), discard: "continuing" };
      dropped += byteLen(rest.slice(0, nl + 1));
      this.discarding = false;
      rest = rest.slice(nl + 1);
    }
    const lines = `${this.pending}${rest}`.split(/\r?\n/);
    // `split` always yields at least one element, so pop() is a string here.
    this.pending = lines.pop() as string;
    const startedNew = byteLen(this.pending) > maxPendingBytes;
    if (startedNew) {
      dropped += byteLen(this.pending); // over-length un-terminated record: discard it
      this.pending = "";
      this.discarding = true;
    }
    return { lines, droppedBytes: dropped, discard: transition(wasDiscarding, startedNew) };
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

// Map (was-discarding, started-a-new-over-length-record) onto the explicit
// transition the emitter counts from. A `started` always means "this call BEGAN a
// fresh over-length record" (+1) — even when it ALSO closed a prior discard, since
// that prior record was counted when IT started. `ended` closed an in-progress
// discard with no new one (0). `continuing` is returned inline and never here.
function transition(wasDiscarding: boolean, startedNew: boolean): DiscardTransition {
  if (startedNew) return "started";
  if (wasDiscarding) return "ended";
  return "none";
}

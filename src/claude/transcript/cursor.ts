/**
 * Bounded, per-path incremental reader for a Claude transcript JSONL file.
 * Implements PRD §5.4 (C-CLAUDE-15): reads only NEW committed records, never the
 * whole file. Resume and A→B→A path switches must not replay history — a real
 * transcript can be hundreds of MB, so a full-delta read would OOM the host.
 */

import { stat } from "node:fs/promises";
import { scanBaselineTail } from "./baseline.ts";
import { byteLen, fileSize, readRange } from "./cursor-io.ts";

export { resetByteReaderForTests, setByteReaderForTests } from "./cursor-io.ts";

const maxChunkBytes = 256 * 1024; // bytes read per scan pass (a large delta streams)
// Max bytes a single un-terminated record may buffer before it is discarded
// through its next newline (a no-newline giant line can't OOM or re-concat n²).
const maxPendingBytes = 1024 * 1024;

/** Outcome of a bounded read: the decoded text plus whether an immediate next read
 * can make progress (canContinueNow). An incomplete UTF-8 tail leaves unread bytes
 * yet returns false: no progress is possible until the rest of the code point lands. */
export type ChunkRead = { readonly text: string; readonly canContinueNow: boolean };

/**
 * The cursor's over-length-discard state transition across one `takeLines` call,
 * reported EXPLICITLY so the emitter never has to infer it from `lines`/`bytes`:
 * - `"none"`: the cursor was not discarding and did not start (the common case).
 * - `"started"`: this call BEGAN a fresh over-length discard (count one lost record).
 * - `"continuing"`: this call added more bytes to a discard already in progress
 *   (count zero records — the same record's continuation, not a new loss).
 * - `"ended"`: this call consumed the discarded record's terminating newline and
 *   the cursor is no longer discarding; any over-length bytes reported belong to a
 *   NEW record that also started this call (so it also counts one).
 */
export type DiscardTransition = "none" | "started" | "continuing" | "ended";

/**
 * Lines parsed from a chunk, plus bytes discarded from an over-length record and
 * the EXPLICIT discard-state transition (so the emitter synchronizes its per-path
 * marker from the cursor's truth, never inferred from `lines.length`/`droppedBytes`).
 */
export type TakenLines = {
  readonly lines: readonly string[];
  readonly droppedBytes: number;
  readonly discard: DiscardTransition;
};

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

  // The current (final) turn already on disk (the Stop-first edge). Delegates to
  // the bounded backward scan (`scanBaselineTail`): UTF-8-seam-safe, linear, and —
  // when the turn is larger than the cap — recovering the in-window committed
  // records rather than silently dropping the whole turn (§5.4, C-CLAUDE-15).
  // Returns the joined tail text PLUS whether the scan hit its cap (`truncated`)
  // and, if so, the bytes beyond the window that were NOT recovered — so the caller
  // can surface that loss as a bounded, content-free drop instead of dropping it
  // silently (MINOR: propagate BaselineTail.truncated for drop accounting).
  baselineTail(): { text: string; truncated: boolean; droppedBytes: number } {
    const size = fileSize(this.path);
    const tail = scanBaselineTail(this.path, size);
    return {
      text: tail.lines.join("\n"),
      truncated: tail.truncated,
      droppedBytes: tail.unrecoveredBytes,
    };
  }

  // True when the file changed size (grew OR truncated) since the last read, via
  // an ASYNC stat so an idle poll does no sync fs work on the loop (§9.2).
  async needsScan(): Promise<boolean> {
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
      return { text: "", canContinueNow: false };
    }
    const want = Math.min(maxChunkBytes, size - from);
    const { text, bytes } = readRange(this.path, from, want);
    // Advance by bytes actually consumed (a split code point waits), no drift.
    this.offset = from + bytes;
    // A read that consumed ZERO bytes (the window is entirely an incomplete UTF-8
    // sequence — a partial write at EOF) made no progress: report `canContinueNow: false` so
    // the poll/drain loop stops this pass instead of spinning on the same bytes. The
    // next tick re-reads once the rest of the code point is committed.
    const advanced = bytes > 0;
    return { text, canContinueNow: advanced && this.offset < size };
  }

  // Split buffered text into complete lines, retaining any trailing partial. A
  // record past `maxPendingBytes` with no newline is discarded through its next
  // newline (its bytes reported) so it can't OOM or re-concat quadratically (§5.4).
  // The returned `discard` transition is the cursor's OWN truth (started/continuing/
  // ended/none), so the emitter counts exactly one lost record per over-length
  // record even when one chunk both ENDS one discard and STARTS the next (§5.4).
  takeLines(text: string): TakenLines {
    let dropped = 0;
    let rest = text;
    // `wasDiscarding` distinguishes "continued/ended an in-progress discard" from
    // "started a fresh one" so the caller counts each lost record exactly once.
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

  // (transition helper lives at module scope below)

  /** The final buffered partial line (flushed once at teardown), then cleared. */
  drainPending(): string {
    const rest = this.pending;
    this.pending = "";
    return rest;
  }

  // Unread bytes still on disk past the cursor (a truncation reads as 0). Used at
  // teardown to size the backlog left unread when the drain budget is spent, so
  // it is accounted as a content-free drop rather than read as hundreds of MiB.
  remainingBytes(): number {
    const size = fileSize(this.path);
    return size > this.offset ? size - this.offset : 0;
  }
}

// Map (was-discarding, started-a-new-over-length-record) onto the explicit
// transition the emitter counts from. A `started` always means "this call BEGAN a
// fresh over-length record" (+1) — even when it ALSO closed a prior discard, since
// that prior record was counted when IT started, so this call still adds exactly
// one for the new record. `ended` closed an in-progress discard with no new one
// (0). The `continuing` case is returned inline (still no newline) and never here.
function transition(wasDiscarding: boolean, startedNew: boolean): DiscardTransition {
  if (startedNew) return "started";
  if (wasDiscarding) return "ended";
  return "none";
}

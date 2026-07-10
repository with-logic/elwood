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

  // The current (final) turn already on disk (the Stop-first edge). Delegates to
  // the bounded backward scan (`scanBaselineTail`): UTF-8-seam-safe, linear, and —
  // when the turn is larger than the cap — recovering the in-window committed
  // records rather than silently dropping the whole turn (§5.4, C-CLAUDE-15).
  baselineTail(): string {
    return scanBaselineTail(this.path, fileSize(this.path)).lines.join("\n");
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

  // Unread bytes still on disk past the cursor (a truncation reads as 0). Used at
  // teardown to size the backlog left unread when the drain budget is spent, so
  // it is accounted as a content-free drop rather than read as hundreds of MiB.
  remainingBytes(): number {
    const size = fileSize(this.path);
    return size > this.offset ? size - this.offset : 0;
  }
}

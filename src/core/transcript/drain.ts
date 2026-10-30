/**
 * The bounded terminal drain both transcript watchers share: Claude's retire of a stopped
 * subagent and finish, and Codex's flush at PTY exit. Implements PRD §5.4, §5.7 and §9.2
 * (C-CLAUDE-15, C-CODEX-20).
 *
 * One chunk budget lives for a watcher's whole terminal life, so a retire never gets a fresh
 * full budget, and each call also stops at a small wall-clock slice, so no call runs a
 * hundreds-of-MiB synchronous loop. The slice can stop a transcript only after its first
 * unread chunk, for up to `lateReadsPerDrain` transcripts a call: a host too loaded to begin a
 * call within its slice still delivers what each transcript committed since the last poll, and
 * a call reads no more past its slice than one live scan reads. Whatever is still unread is a
 * content-free `unread_backlog` drop, and the partial record it cut off goes with it instead of
 * being parsed as an unparseable line. A drained transcript removed after it existed warns like
 * a live read (§5.7, C-CLAUDE-24, C-CODEX-23).
 */

import type { BoundedTranscriptCursor } from "./cursor.ts";
import type { DropReporter } from "./drops.ts";

/** A mutable chunk budget shared across every drain call across a watcher's life. */
export type ChunkBudget = { chunks: number };

/** Terminal-drain chunk budget, shared ONCE per watcher across every retire and flush. */
const drainChunkBudget = 256;
/** Wall-clock ms a single drain call may run before the leftover backlog is dropped. */
const drainSliceMs = 50;
/**
 * The transcripts a call may still read a first chunk of once its slice is spent: 16 chunks
 * (4 MiB), what one live scan reads, so a late call blocks the loop no longer than a scan.
 */
const lateReadsPerDrain = 16;

/** One shared budget for a watcher's whole terminal-drain life. */
export function newTerminalBudget(): ChunkBudget {
  return { chunks: drainChunkBudget };
}

/** The emitter calls a drain makes for a cursor of type `C`. */
export type DrainLines<C extends BoundedTranscriptCursor> = {
  /** Emits a chunk's complete lines; the cursor keeps the trailing partial. */
  emitLines(path: string, text: string, cursor: C): void;
  /** Emits one line taken as complete: a transcript's last, un-terminated record at its end. */
  emitLine(path: string, line: string): void;
};

/** The watcher collaborators a drain needs: the fs guard, emitter, and drop sink. */
export type DrainContext<C extends BoundedTranscriptCursor> = {
  readFs<T>(path: string, read: () => T): T | undefined;
  readonly lines: DrainLines<C>;
  readonly drops: DropReporter;
  /** Per-call wall-clock ms cap (defaults to `drainSliceMs`); tests may override. */
  readonly sliceMs?: number;
  /** Monotonic clock (injectable for tests); defaults to `Date.now`. */
  readonly now?: () => number;
};

/** One call's deadline, and how many first reads it may still make past it. */
type DrainSlice = { readonly deadline: number; readonly now: () => number; lateReads: number };

/** Drains `cursors` toward their ends within the shared `budget` and this call's slice. */
export function drainToBudget<C extends BoundedTranscriptCursor>(
  context: DrainContext<C>,
  cursors: readonly C[],
  budget: ChunkBudget,
): void {
  const now = context.now ?? Date.now;
  const deadline = now() + (context.sliceMs ?? drainSliceMs);
  const slice: DrainSlice = { deadline, now, lateReads: lateReadsPerDrain };
  for (const cursor of cursors) {
    const hasBacklog = readCursor(context, cursor, budget, slice);
    // The buffered partial is a whole record only at the transcript's end. With bytes still
    // unread, its rest is in the backlog, so it is lost with the backlog's own drop rather than
    // misreported as an unparseable record.
    const partial = cursor.drainPending();
    if (hasBacklog) context.drops.drop(cursor.path, "unread_backlog");
    else context.lines.emitLine(cursor.path, partial);
  }
  context.drops.flushPass(); // deliver this drain's coalesced drops (bounded fan-out)
}

// Reads one cursor toward its end within the budget and the slice. Returns whether bytes
// remained unread when either was spent (false once drained or on a contained fs failure).
function readCursor<C extends BoundedTranscriptCursor>(
  context: DrainContext<C>,
  cursor: C,
  budget: ChunkBudget,
  slice: DrainSlice,
): boolean {
  for (let first = true; budget.chunks > 0; first = false) {
    if (slice.now() >= slice.deadline) {
      if (!first || slice.lateReads === 0) break;
      slice.lateReads -= 1;
    }
    budget.chunks -= 1;
    const chunk = context.readFs(cursor.path, () => cursor.readLiveChunk());
    if (chunk === undefined) return false; // contained FS failure; nothing to account
    if (chunk.text.length > 0) context.lines.emitLines(cursor.path, chunk.text, cursor);
    if (!chunk.canContinueNow) return false;
  }
  return (context.readFs(cursor.path, () => cursor.remainingBytes()) ?? 0) > 0;
}

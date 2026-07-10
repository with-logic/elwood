/**
 * Bounded, self-yielding terminal drain for the transcript watcher (retire/finish).
 * Implements PRD §5.4/§9.2 (C-CLAUDE-15): flushing a stopped subagent (retire) or
 * the whole watcher at teardown (finish) shares ONE watcher-wide chunk budget
 * across every cursor AND every call, so aggregate terminal work is watcher-
 * bounded — a retire never gets a fresh full budget. Each call is bounded further
 * by a small wall-clock slice, so no single call runs a hundreds-of-MiB synchronous
 * loop that would stall the event loop. Any backlog still unread when the shared
 * budget OR the per-call slice is spent is accounted as a content-free drop, never
 * read in an unbounded synchronous loop, so the caller returns to the event loop
 * promptly and termination/retirement always completes in bounded work.
 */

import type { TranscriptCursor } from "./cursor.ts";
import type { DropTracker } from "./drops.ts";
import type { LineEmitter } from "./emit.ts";

/** A mutable chunk budget shared across every cursor drained across a watcher's life. */
export type ChunkBudget = { chunks: number };

/** Terminal-drain chunk budget, shared ONCE per watcher across every retire + finish. */
const drainChunkBudget = 256;
/** Wall-clock ms a single drain call may run before the leftover backlog is dropped. */
const drainSliceMs = 50;

/** One shared budget for a watcher's whole terminal-drain life (retire + finish). */
export function newTerminalBudget(): ChunkBudget {
  return { chunks: drainChunkBudget };
}

/** The watcher collaborators a drain needs: the fs guard, emitter, and drop sink. */
export type DrainContext = {
  readFs<T>(path: string, read: () => T): T | undefined;
  readonly lines: LineEmitter;
  readonly drops: DropTracker;
  /** Per-call wall-clock ms cap (defaults to `drainSliceMs`); tests may override. */
  readonly sliceMs?: number;
  /** Monotonic clock (injectable for tests); defaults to `Date.now`. */
  readonly now?: () => number;
};

// Drain the given cursors to EOF, sharing ONE chunk budget so aggregate sync work
// is watcher-bounded, and stopping at a per-call wall-clock deadline so no single
// call blocks the loop for long. A cursor left with an unread backlog when the
// budget OR the deadline is spent is accounted as a content-free drop (its size,
// not content), and the final buffered partial is flushed once.
export function drainToBudget(
  context: DrainContext,
  cursors: readonly TranscriptCursor[],
  budget: ChunkBudget,
): void {
  const now = context.now ?? Date.now;
  const deadline = now() + (context.sliceMs ?? drainSliceMs);
  for (const cursor of cursors) {
    const backlog = drainCursor(context, cursor, budget, deadline, now);
    // An unread teardown backlog is content-free data loss with its OWN cause
    // ("unread_backlog"), never conflated with an unparseable record: the bytes
    // are the true magnitude and the record count is unknown, so it contributes a
    // single loss event under a truthful cause rather than a false "unparseable"
    // cardinality (MAJOR: cause-neutral data-loss accounting, PRD §5.4).
    if (backlog > 0) context.drops.recordBytes(cursor.path, backlog, 1, "unread_backlog");
    context.lines.emitLines(cursor.path, cursor.drainPending());
  }
  // Persist the batched aggregate at most ONCE per drain call (not per record):
  // the running count advanced in memory across every emitted/dropped line above,
  // and this single flush feeds the sink at the slice boundary (BLOCKER, §9.2).
  context.drops.flush();
}

// Read one cursor to EOF within the shared budget and the per-call deadline.
// Returns bytes still unread when the budget or the deadline was spent (0 when
// fully drained), for backlog accounting.
function drainCursor(
  context: DrainContext,
  cursor: TranscriptCursor,
  budget: ChunkBudget,
  deadline: number,
  now: () => number,
): number {
  while (budget.chunks > 0 && now() < deadline) {
    budget.chunks -= 1;
    const chunk = context.readFs(cursor.path, () => cursor.readChunk());
    if (chunk === undefined) return 0; // contained FS failure; nothing to account
    if (chunk.text.length > 0) context.lines.emitLines(cursor.path, chunk.text, cursor);
    if (!chunk.more) return 0;
  }
  return context.readFs(cursor.path, () => cursor.remainingBytes()) ?? 0;
}

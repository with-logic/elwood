/**
 * Bounded, self-yielding terminal drain for the Codex transcript watcher (flush).
 * Implements PRD §7A/§5.4/§9.2: flushing at teardown drains the cursor to EOF within
 * a chunk budget AND a small wall-clock slice, so no single call runs a
 * hundreds-of-MiB synchronous loop that would stall the event loop. Any backlog
 * still unread when the budget OR the slice is spent is accounted as a content-free
 * `unread_backlog` drop, never read in an unbounded loop, so termination always
 * completes in bounded work.
 */

import type { CodexTranscriptCursor } from "./cursor.ts";
import type { CodexDropTracker } from "./drops.ts";
import type { CodexLineEmitter } from "./emit.ts";

/** A mutable chunk budget shared across every drain call across a watcher's life. */
export type ChunkBudget = { chunks: number };

/** Terminal-drain chunk budget, shared ONCE per watcher across every flush call. */
const drainChunkBudget = 256;
/** Wall-clock ms a single drain call may run before the leftover backlog is dropped. */
const drainSliceMs = 50;

/** One shared budget for a watcher's whole terminal-drain life. */
export function newTerminalBudget(): ChunkBudget {
  return { chunks: drainChunkBudget };
}

/** The watcher collaborators a drain needs: the fs guard, emitter, and drop sink. */
export type DrainContext = {
  readFs<T>(path: string, read: () => T): T | undefined;
  readonly lines: CodexLineEmitter;
  readonly drops: CodexDropTracker;
  /** Per-call wall-clock ms cap (defaults to `drainSliceMs`); tests may override. */
  readonly sliceMs?: number;
  /** Monotonic clock (injectable for tests); defaults to `Date.now`. */
  readonly now?: () => number;
};

// Drain the cursor to EOF within a chunk budget and a per-call wall-clock deadline.
// A cursor left with an unread backlog when the budget OR the deadline is spent is
// accounted as a content-free `unread_backlog` drop (its size, not content), and
// the final buffered partial is flushed once.
export function drainToBudget(
  context: DrainContext,
  cursor: CodexTranscriptCursor,
  budget: ChunkBudget,
): void {
  const now = context.now ?? Date.now;
  const deadline = now() + (context.sliceMs ?? drainSliceMs);
  const backlog = drainCursor(context, cursor, budget, deadline, now);
  // An unread teardown backlog is content-free data loss with its OWN cause: the
  // bytes are the true magnitude and the enclosed record count is unknowable, so it
  // counts as exactly ONE loss incident under a truthful cause.
  if (backlog > 0) context.drops.recordBytes(cursor.path, backlog, 1, "unread_backlog");
  context.lines.emitLine(cursor.path, cursor.drainPending());
  // Persist the batched aggregate at most ONCE per drain call (not per record).
  context.drops.flush();
}

// Read the cursor to EOF within the budget and the per-call deadline. Returns bytes
// still unread when the budget or the deadline was spent (0 when fully drained).
function drainCursor(
  context: DrainContext,
  cursor: CodexTranscriptCursor,
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

/**
 * Best-effort live observation of Claude transcript JSONL files.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results are sourced from the transcript(s) the CLI writes, so an un-sent
 * ghost-text suggestion never becomes activity. Reads are bounded and per-path;
 * pre-existing history is never replayed (see TranscriptCursor).
 */

import { TranscriptCursor } from "./cursor.ts";
import {
  DropTracker,
  ReadErrorTracker,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "./drops.ts";
import { type ClaudeTranscriptEvent, LineEmitter } from "./emit.ts";

export type { ClaudeTranscriptEvent, TranscriptDropNotice, TranscriptReadErrorNotice };

/** Poll cadence: transcript activity is not latency-critical, so this stays coarse. */
const pollMs = 500;
// Read passes per scan, shared across ALL cursors (×256 KiB ≈ 4 MiB): a huge delta
// drains across poll ticks, not one large event-loop block (§9.2). The terminal
// drain (retire/finish) uses a far larger cap so it drains a normal turn fully but
// still can't block termination on a pathological delta.
const scanChunksPerScan = 16;
const maxDrainChunks = 1024;

/** Notices the watcher forwards for observation problems (both rate-bounded). */
export type TranscriptNoticeHandlers = {
  readonly onDrop?: (notice: TranscriptDropNotice) => void;
  readonly onReadError?: (notice: TranscriptReadErrorNotice) => void;
  /** A programming error escaped the timer poll; the watcher has stopped. */
  readonly onPollError?: (error: unknown) => void;
};

export class ClaudeTranscriptWatcher {
  // One cursor per observed path so A→B→A never rewinds A to the start.
  private readonly cursors = new Map<string, TranscriptCursor>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  // A permanent terminal latch: once finished, no scan/emit/observe/poll runs.
  private finished = false;
  private readonly drops: DropTracker;
  private readonly readErrors: ReadErrorTracker;
  private readonly onPollError: ((error: unknown) => void) | undefined;
  private readonly lines: LineEmitter;

  constructor(
    elwoodSessionId: string,
    emit: (event: ClaudeTranscriptEvent) => void,
    notices: TranscriptNoticeHandlers = {},
  ) {
    this.drops = new DropTracker(elwoodSessionId, notices.onDrop);
    this.readErrors = new ReadErrorTracker(elwoodSessionId, notices.onReadError);
    this.onPollError = notices.onPollError;
    this.lines = new LineEmitter(elwoodSessionId, emit, this.drops);
  }

  // Begin watching `path`: baselines at EOF (history not replayed); only a
  // turn-boundary first-observe (recoverTail) replays the committed tail (§5.4).
  // No observation after finish — a late hook must not emit past terminal:exit.
  observe(path: string, recoverTail = false): void {
    if (this.finished || this.cursors.has(path)) return;
    const cursor = this.readFs(path, () => new TranscriptCursor(path));
    if (cursor === undefined) return;
    this.cursors.set(path, cursor);
    if (recoverTail)
      this.lines.emitLines(path, this.readFs(path, () => cursor.baselineTail()) ?? "");
    this.ensurePolling();
  }

  scan(): void {
    if (this.finished) return;
    const budget = { chunks: scanChunksPerScan };
    for (const cursor of this.cursors.values()) {
      if (budget.chunks <= 0) break; // watcher-wide budget spent; resume next tick
      this.scanCursor(cursor, budget);
    }
  }

  // Flush and retire a stopped subagent's transcript (one-shot input): drained
  // then removed from the active cursor set so it is not polled forever.
  retire(path: string): void {
    const cursor = this.cursors.get(path);
    if (!cursor || this.finished) return;
    this.drainCursor(cursor);
    this.lines.emitLines(cursor.path, cursor.drainPending());
    this.cursors.delete(path);
  }

  pollOnceForTests(): Promise<void> {
    return this.poll(); // test seam: drive one poll pass synchronously
  }

  // Idle-friendly poll: an async stat gates each cursor (no sync fs work when
  // idle, §9.2); a bounded sync read runs only on growth. Re-entrancy-guarded.
  private async poll(): Promise<void> {
    if (this.polling || this.finished) return;
    this.polling = true;
    try {
      const budget = { chunks: scanChunksPerScan }; // one budget for the whole pass
      for (const cursor of this.cursors.values()) {
        const changed = await this.readFsAsync(cursor.path, () => cursor.needsScan());
        // Re-check after the await: finish() may have run during the async stat;
        // a post-exit emit would break terminal:exit ordering (§5.4).
        if (this.finished) return;
        if (budget.chunks <= 0) break; // watcher-wide budget spent this tick
        if (changed) this.scanCursor(cursor, budget);
      }
    } finally {
      this.polling = false;
    }
  }

  // Flush buffered partials, then permanently stop. `finished` set FIRST so an
  // in-flight poll bails and later observe/scan no-op — nothing emits past
  // terminal:exit (§5.4); flushing must not prevent stop() (finally).
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      for (const cursor of this.cursors.values()) {
        this.drainCursor(cursor); // final flush drains fully, not just one budget
        this.lines.emitLines(cursor.path, cursor.drainPending());
      }
      this.drops.flush();
      this.readErrors.flush();
    } finally {
      this.stop();
    }
  }

  // Drain to EOF at teardown/retire, bounded so a pathological final delta can't
  // block termination. The cap (≈256 MiB) far exceeds any real turn (§9.2).
  private drainCursor(cursor: TranscriptCursor): void {
    let more = true;
    for (let budget = maxDrainChunks; more && budget > 0; budget--) {
      const chunk = this.readFs(cursor.path, () => cursor.readChunk());
      if (chunk === undefined) return;
      if (chunk.text.length > 0) this.lines.emitLines(cursor.path, chunk.text, cursor);
      more = chunk.more;
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private ensurePolling(): void {
    if (this.interval || this.finished) return;
    // The interval catches at its boundary: scanCursor can throw a synchronous
    // listener error AFTER the poll's await, which on the timer path would become
    // an unhandled rejection. Instead we stop the watcher and route the failure
    // to a diagnostic so a listener bug can't terminate the host.
    this.interval = setInterval(() => {
      this.poll().catch((error) => {
        this.finish();
        this.onPollError?.(error);
      });
    }, pollMs);
    this.interval.unref?.();
  }

  // Drain a cursor in bounded chunks, decrementing the SHARED per-scan budget so
  // the total sync work is bounded across ALL cursors in one pass (not per-cursor).
  // The read is contained; parse/emit run OUTSIDE the guard so a listener error is
  // never swallowed.
  private scanCursor(cursor: TranscriptCursor, budget: { chunks: number }): void {
    while (budget.chunks > 0) {
      budget.chunks -= 1;
      const chunk = this.readFs(cursor.path, () => cursor.readChunk());
      if (chunk === undefined) return; // contained FS failure; keep last offset
      if (chunk.text.length > 0) this.lines.emitLines(cursor.path, chunk.text, cursor);
      if (!chunk.more) return;
    } // budget exhausted with more to read: the next poll tick resumes here.
  }

  // Contains the removal/rotation race (never crashes the timer/hook dispatch)
  // and records a bounded diagnostic so a persistent fault is visible (§5.4).
  private readFs<T>(path: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      this.readErrors.record(path, error);
      return undefined;
    }
  }

  /** Async twin of readFs: contains and records a rejected stat during polling. */
  private async readFsAsync(path: string, read: () => Promise<boolean>): Promise<boolean> {
    try {
      return await read();
    } catch (error) {
      this.readErrors.record(path, error);
      return false;
    }
  }
}

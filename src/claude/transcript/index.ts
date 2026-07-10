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
// Max bounded read passes per cursor per scan (×256 KiB ≈ 4 MiB): a huge delta is
// drained across poll ticks, not in one 16 MiB event-loop block (PRD §9.2).
const scanChunksPerCursor = 16;

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

  /**
   * Begin watching `path`. A path seen for the first time baselines at the file's
   * current end (history is not replayed). Cursor construction shares the fs
   * guard so a first-observe race can't throw out of hook dispatch. Only a
   * turn-boundary first-observe (recoverTail) replays the already-committed tail;
   * a SessionStart/resume observe baselines at EOF and never republishes history.
   */
  observe(path: string, recoverTail = false): void {
    // No new observation after the watcher is finished — a late hook must not
    // restart polling or emit transcript activity past terminal:exit (§5.4).
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
    for (const cursor of this.cursors.values()) this.scanCursor(cursor);
  }

  /**
   * Flush and retire a stopped subagent's transcript: a `SubagentStop` path is a
   * one-shot input, so after its final read it is dropped from the active cursor
   * set and no longer statted twice a second for the whole session lifetime.
   */
  retire(path: string): void {
    const cursor = this.cursors.get(path);
    if (!cursor || this.finished) return;
    this.scanCursor(cursor);
    this.lines.emitLines(cursor.path, cursor.drainPending());
    this.cursors.delete(path);
  }

  /** Test seam: drive one poll pass synchronously (the interval calls poll()). */
  pollOnceForTests(): Promise<void> {
    return this.poll();
  }

  // Idle-friendly poll: an async stat gates each cursor (zero sync fs work when
  // idle, §9.2); a bounded sync read runs only on growth. Re-entrancy-guarded.
  private async poll(): Promise<void> {
    if (this.polling || this.finished) return;
    this.polling = true;
    try {
      for (const cursor of this.cursors.values()) {
        const changed = await this.readFsAsync(cursor.path, () => cursor.needsScan());
        // Re-check AFTER the await: finish() may have run during the async stat,
        // and a post-exit emit would violate the terminal:exit ordering (§5.4).
        if (this.finished) return;
        if (changed) this.scanCursor(cursor);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Flush any buffered partial lines across all paths, then permanently stop.
   * `finished` is set FIRST so an in-flight poll's post-await re-check bails and
   * a later observe/scan is a no-op — nothing emits past terminal:exit (§5.4).
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    // Flushing MUST NOT prevent the watcher from stopping (a listener bug in an
    // emit could otherwise leave the interval running and wedge lifecycle events).
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

  /** Drain a cursor to EOF at teardown (bounded only by per-record discarding). */
  private drainCursor(cursor: TranscriptCursor): void {
    for (;;) {
      const chunk = this.readFs(cursor.path, () => cursor.readChunk());
      if (chunk === undefined) return;
      if (chunk.text.length > 0) this.lines.emitLines(cursor.path, chunk.text, cursor);
      if (!chunk.more) return;
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

  // Drain a cursor in bounded chunks. The read is contained; parse/emit run
  // OUTSIDE the guard so a listener error is never swallowed.
  private scanCursor(cursor: TranscriptCursor): void {
    for (let budget = scanChunksPerCursor; budget > 0; budget--) {
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

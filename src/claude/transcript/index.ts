/**
 * Best-effort live observation of Claude transcript JSONL files.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results are sourced from the transcript(s) the CLI writes (no ghost-text);
 * reads are bounded, per-path, no replay.
 */

import { TranscriptCursor } from "./cursor.ts";
import type { ChunkBudget, DrainContext } from "./drain.ts";
import { drainToBudget, newTerminalBudget } from "./drain.ts";
import {
  DropTracker,
  ReadErrorTracker,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "./drops.ts";
import { type ClaudeTranscriptEvent, LineEmitter } from "./emit.ts";
import type { TranscriptNoticeHandlers, TranscriptWatcherSeed } from "./watcher-config.ts";

export type { TranscriptNoticeHandlers, TranscriptWatcherSeed } from "./watcher-config.ts";
export type { ClaudeTranscriptEvent, TranscriptDropNotice, TranscriptReadErrorNotice };

const pollMs = 500; // poll cadence: transcript activity is not latency-critical
/** Read passes per scan, shared across ALL cursors (×256 KiB ≈ 4 MiB): a huge delta drains across poll ticks, not one event-loop block (§9.2). */
const scanChunksPerScan = 16;

export class ClaudeTranscriptWatcher {
  // One cursor per observed path so A→B→A never rewinds A to the start.
  private readonly cursors = new Map<string, TranscriptCursor>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  // A permanent terminal latch: once finished, no scan/emit/observe/poll runs.
  private finished = false;
  // ONE budget shared across every retire() + finish(): terminal work is watcher-bounded (§9.2).
  private readonly terminalBudget: ChunkBudget = newTerminalBudget();
  private readonly drops: DropTracker;
  private readonly readErrors: ReadErrorTracker;
  private readonly onPollError: ((error: unknown) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly lines: LineEmitter;

  constructor(
    elwoodSessionId: string,
    emit: (event: ClaudeTranscriptEvent) => void,
    notices: TranscriptNoticeHandlers = {},
    seed: TranscriptWatcherSeed = {},
  ) {
    this.drops = new DropTracker(elwoodSessionId, notices.onDrop, seed.drops);
    this.readErrors = new ReadErrorTracker(elwoodSessionId, notices.onReadError, seed.readErrors);
    this.onPollError = notices.onPollError;
    this.pollIntervalMs = notices.pollIntervalMs ?? pollMs;
    this.lines = new LineEmitter(elwoodSessionId, emit, this.drops);
  }

  // Begin watching `path`: baselines at EOF (history not replayed); a turn-boundary
  // first-observe (recoverTail) replays the committed tail (§5.4). No observation
  // after finish — a late hook must not emit past terminal:exit.
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

  // Flush + retire a stopped subagent's transcript (one-shot): drained against the
  // SHARED terminal budget (not a fresh full one) and a wall-clock slice — bounded,
  // non-blocking; backlog past the bound drops content-free, then the cursor is gone.
  retire(path: string): void {
    const cursor = this.cursors.get(path);
    if (!cursor || this.finished) return;
    drainToBudget(this.drainContext(), [cursor], this.terminalBudget);
    this.cursors.delete(path);
  }

  pollOnceForTests(): Promise<void> {
    return this.poll(); // test seam: drive one poll pass synchronously
  }

  // Idle-friendly poll: an async stat gates each cursor (no sync fs work when idle,
  // §9.2); a bounded sync read runs only on growth. Re-entrancy-guarded.
  private async poll(): Promise<void> {
    if (this.polling || this.finished) return;
    this.polling = true;
    try {
      const budget = { chunks: scanChunksPerScan }; // one budget for the whole pass
      for (const cursor of this.cursors.values()) {
        const changed = await this.readFsAsync(cursor.path, () => cursor.needsScan());
        // Re-check after the await: finish() (post-exit emit breaks §5.4 ordering)
        // or retire() (drained+deleted this cursor) may have run during the stat.
        if (this.finished) return;
        if (this.cursors.get(cursor.path) !== cursor) continue;
        if (budget.chunks <= 0) break; // watcher-wide budget spent this tick
        if (changed) this.scanCursor(cursor, budget);
      }
    } finally {
      this.polling = false;
    }
  }

  // Flush buffered partials, then permanently stop. `finished` set FIRST so an
  // in-flight poll bails and later observe/scan/retire no-op — nothing emits past
  // terminal:exit (§5.4); flushing must not prevent stop() (finally). The drain uses
  // the shared budget's LEFTOVER, is wall-clock-slice-bounded, drops leftovers (§9.2).
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      drainToBudget(this.drainContext(), [...this.cursors.values()], this.terminalBudget);
    } finally {
      this.stop();
    }
  }

  // `readFs` is bound so the shared fs guard still contains a read failure mid-drain.
  private drainContext(): DrainContext {
    return { readFs: this.readFs.bind(this), lines: this.lines, drops: this.drops };
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private ensurePolling(): void {
    if (this.interval || this.finished) return;
    // scanCursor can throw a synchronous listener error AFTER the poll's await,
    // which on the timer path would become an unhandled rejection. The catch stops
    // the watcher and routes the failure (non-throwing recovery, chain voided).
    this.interval = setInterval(() => {
      void this.poll().catch((error) => this.recoverFromPollError(error));
    }, this.pollIntervalMs);
    this.interval.unref?.();
  }

  // Non-throwing recovery for a failed poll: finish() and the poll-error diagnostic
  // can each throw a listener error; a throw here would become a host-terminating
  // unhandled rejection, so each step is contained.
  private recoverFromPollError(error: unknown): void {
    try {
      this.finish();
    } catch {
      this.stop(); // finish() threw mid-drain: still guarantee the timer is cleared
    }
    try {
      this.onPollError?.(error);
    } catch {} // a diagnostic listener bug must not resurrect the failure
  }

  // Drain a cursor in bounded chunks against the SHARED per-scan budget (sync work
  // bounded across ALL cursors); the read is contained, parse/emit run OUTSIDE it.
  private scanCursor(cursor: TranscriptCursor, budget: ChunkBudget): void {
    while (budget.chunks > 0) {
      budget.chunks -= 1;
      const chunk = this.readFs(cursor.path, () => cursor.readChunk());
      if (chunk === undefined) return; // contained FS failure; keep last offset
      if (chunk.text.length > 0) this.lines.emitLines(cursor.path, chunk.text, cursor);
      if (!chunk.more) return;
    } // budget exhausted with more to read: the next poll tick resumes here.
  }

  // Contains the removal/rotation race (never crashes the timer/hook dispatch) and
  // records a bounded diagnostic so a persistent fault stays visible (§5.4).
  private readFs<T>(path: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      this.readErrors.record(path, error);
      return undefined;
    }
  }

  /**
   * Async twin of readFs: contains and records a rejected stat during polling.
   * A stat kicked off before finish()/teardown can reject AFTER the watcher is
   * terminal; recording/routing its warning then would emit and persist activity
   * past `terminal:exit`, breaking the permanent latch (§5.4). So the rejection is
   * only accounted while `!this.finished` — a post-finish rejected stat is
   * swallowed content-free, and poll()'s own post-await latch check still bails.
   */
  private async readFsAsync(path: string, read: () => Promise<boolean>): Promise<boolean> {
    try {
      return await read();
    } catch (error) {
      if (!this.finished) this.readErrors.record(path, error);
      return false;
    }
  }
}

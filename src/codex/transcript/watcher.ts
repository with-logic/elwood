/**
 * Best-effort live observation of Codex transcript JSONL items, bounded.
 * Implements PRD §7A and §5.4 (C-API-12): committed message/tool/reasoning items
 * are sourced from the JSONL transcript Codex writes; reads are bounded (fixed-size
 * chunks, a max-pending ceiling, a per-scan chunk budget) so a hundreds-of-MiB file
 * never OOMs or blocks the event loop, and lost committed data is accounted through
 * bounded, content-free drop notices.
 */

import { CodexTranscriptCursor } from "./cursor.ts";
import type { ChunkBudget, DrainContext } from "./drain.ts";
import { drainToBudget, newTerminalBudget } from "./drain.ts";
import { CodexDropTracker, CodexReadErrorTracker } from "./drops.ts";
import { CodexLineEmitter } from "./emit.ts";
import { CodexTranscriptFsGuard } from "./fs-guard.ts";
import type { CodexTranscriptEvent } from "./types.ts";
import type { CodexTranscriptNotices, CodexTranscriptSeed } from "./watcher-config.ts";

export type { CodexDropNotice, CodexReadErrorNotice } from "./drops.ts";
export type { CodexTranscriptNotices, CodexTranscriptSeed } from "./watcher-config.ts";

const scanMs = 250; // poll cadence: transcript activity is not latency-critical
/** Read passes per scan (×256 KiB ≈ 4 MiB): a huge delta drains across ticks, not one block. */
const scanChunksPerScan = 16;

export class CodexTranscriptWatcher {
  private cursor: CodexTranscriptCursor | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  // A permanent terminal latch: once finished, no scan/flush/observe restarts it.
  private finished = false;
  private readonly guard: CodexTranscriptFsGuard;
  private readonly drops: CodexDropTracker;
  private readonly lines: CodexLineEmitter;
  private readonly onPollError: ((error: unknown) => void) | undefined;
  // ONE budget shared across every flush() for a watcher's whole lifetime.
  private readonly terminalBudget: ChunkBudget = newTerminalBudget();
  private readonly scanSliceMs: number | undefined;

  constructor(
    elwoodSessionId: string,
    emit: (event: CodexTranscriptEvent) => void,
    notices: CodexTranscriptNotices = {},
    seed: CodexTranscriptSeed = {},
  ) {
    this.drops = new CodexDropTracker(elwoodSessionId, notices.onDrop, seed.drops);
    const readErrors = new CodexReadErrorTracker(
      elwoodSessionId,
      notices.onReadError,
      seed.readErrors,
    );
    this.guard = new CodexTranscriptFsGuard(readErrors);
    this.lines = new CodexLineEmitter(elwoodSessionId, emit, this.drops);
    this.onPollError = notices.onPollError;
    this.scanSliceMs = notices.scanIntervalMs;
  }

  // Begin watching `path`, baselining at its CURRENT end so history is NOT replayed.
  // No-op if already watching this exact path or once finished (never restart polling
  // past a terminal:exit). A switch to a new path drops the old.
  observe(path: string): void {
    if (this.finished || this.cursor?.path === path) return;
    this.stop();
    this.cursor = this.guard.read(path, () => new CodexTranscriptCursor(path));
    if (!this.cursor) return;
    // A scan() throw (a warning-state write or a throwing drop/activity listener) must
    // not escape the timer as an uncaught exception — contain it, stop, and route a
    // bounded diagnostic (non-throwing recovery), mirroring Claude's poll recovery.
    this.interval = setInterval(() => this.runScan(), this.scanSliceMs ?? scanMs);
    this.interval.unref?.();
  }

  private runScan(): void {
    try {
      this.scan();
    } catch (error) {
      this.recoverFromPollError(error);
    }
  }

  // One bounded scan pass: read up to a per-pass chunk budget of new committed bytes
  // (a large delta streams across ticks), emit complete lines, retain the partial.
  scan(): void {
    if (this.finished || !this.cursor) return;
    const budget = { chunks: scanChunksPerScan };
    while (budget.chunks > 0) {
      budget.chunks -= 1;
      const chunk = this.guard.read(this.cursor.path, () => this.cursor?.readChunk());
      if (!chunk) break; // contained FS failure or cursor gone; keep last offset
      if (chunk.text.length > 0) this.lines.emitLines(this.cursor.path, chunk.text, this.cursor);
      if (!chunk.more) break;
    } // budget exhausted with more to read: the next scan tick resumes here.
    this.drops.flush(); // ≤one persist per scan pass, not one per malformed record
  }

  // Bounded terminal flush: drain to EOF against the SHARED terminal budget and a
  // wall-clock slice, dropping any leftover backlog content-free (never an unbounded
  // synchronous loop), then flush the final partial line. No-op once finished so a
  // second finish() (PTY-exit path + runtime cleanup) cannot re-drain the backlog.
  flush(): void {
    if (this.finished || !this.cursor) return;
    drainToBudget(this.drainContext(), this.cursor, this.terminalBudget);
  }

  // Flush trailing partials, then permanently stop. Idempotent (`finished` gates a
  // second call) and terminal; `stop()` runs in `finally` so a throwing drain still
  // clears the timer (no leaked interval).
  finish(): void {
    if (this.finished) return;
    try {
      this.flush();
    } finally {
      this.finished = true;
      this.stop();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  // Non-throwing recovery for a failed scan: finish() and the diagnostic can each
  // throw a listener error (which on the timer path would terminate the host), so
  // each is contained. finish() already clears the timer in its own `finally`, so a
  // finish() throw here is simply swallowed — the interval is gone regardless.
  private recoverFromPollError(error: unknown): void {
    try {
      this.finish();
    } catch {} // finish()'s finally already ran stop(); a drain throw is contained here
    try {
      this.onPollError?.(error);
    } catch {} // a diagnostic listener bug must not resurrect the failure
  }

  private drainContext(): DrainContext {
    return { readFs: this.guard.read.bind(this.guard), lines: this.lines, drops: this.drops };
  }
}

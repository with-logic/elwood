/**
 * Best-effort live observation of Codex transcript JSONL items, bounded.
 * Implements PRD §7A and §5.4 (C-API-12): committed message/tool/reasoning items
 * are sourced from the JSONL transcript Codex writes; reads are bounded (fixed-size
 * chunks, a max-pending ceiling, a per-scan chunk budget) so a hundreds-of-MiB file
 * never OOMs or blocks the event loop, and lost committed data is surfaced through
 * bounded, content-free drop notices.
 */

import { outsideStopInput } from "../../core/stop-input.ts";
import { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import { DropReporter, ReadErrorReporter } from "../../core/transcript/drops.ts";
import type { ChunkBudget, DrainContext } from "./drain.ts";
import { drainToBudget, newTerminalBudget } from "./drain.ts";
import { CodexLineEmitter } from "./emit.ts";
import { CodexTranscriptFsGuard } from "./fs-guard.ts";
import type { CodexTranscriptEvent } from "./types.ts";
import type { CodexTranscriptNotices } from "./watcher-config.ts";

export type {
  TranscriptDropNotice as CodexDropNotice,
  TranscriptReadErrorNotice as CodexReadErrorNotice,
} from "../../core/transcript/drops.ts";
export type { CodexTranscriptNotices } from "./watcher-config.ts";

const defaultScanIntervalMs = 250; // poll cadence: transcript activity is not latency-critical
/** Read passes per scan (×256 KiB ≈ 4 MiB): a huge delta drains across ticks, not one block. */
const scanChunksPerScan = 16;

export class CodexTranscriptWatcher {
  private cursor: BoundedTranscriptCursor | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  // A permanent terminal latch: once finished, no scan/flush/observe restarts it.
  private finished = false;
  private readonly guard: CodexTranscriptFsGuard;
  private readonly drops: DropReporter;
  private readonly lines: CodexLineEmitter;
  private readonly onPollError: ((error: unknown) => void) | undefined;
  // ONE budget shared across every flush() for a watcher's whole lifetime.
  private readonly terminalBudget: ChunkBudget = newTerminalBudget();
  private readonly scanIntervalMs: number | undefined;
  // Drain-slice clock; undefined in production. See watcher-config.ts.
  private readonly now: (() => number) | undefined;

  constructor(
    elwoodSessionId: string,
    emit: (event: CodexTranscriptEvent) => void,
    notices: CodexTranscriptNotices = {},
  ) {
    this.drops = new DropReporter(elwoodSessionId, notices.onDrop);
    const readErrors = new ReadErrorReporter(elwoodSessionId, notices.onReadError);
    this.guard = new CodexTranscriptFsGuard(readErrors);
    this.lines = new CodexLineEmitter(elwoodSessionId, emit, this.drops);
    this.onPollError = notices.onPollError;
    this.scanIntervalMs = notices.scanIntervalMs;
    this.now = notices.now;
  }

  // Begin watching `path`, baselining at its CURRENT end so history is NOT replayed.
  // No-op if already watching this exact path or once finished (never restart polling
  // past a terminal:exit). A switch to a new path drops the old.
  observe(path: string): void {
    if (this.finished || this.cursor?.path === path) return;
    this.stop();
    this.cursor = this.guard.read(path, () => new BoundedTranscriptCursor(path));
    if (!this.cursor) return;
    // A scan() throw (a throwing drop/activity/warning listener) must not escape the
    // timer as an uncaught exception — contain it, stop, and route a bounded live
    // diagnostic (non-throwing recovery), mirroring Claude's poll recovery.
    this.interval = outsideStopInput(() =>
      setInterval(() => this.runScan(), this.scanIntervalMs ?? defaultScanIntervalMs),
    );
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
    const cursor = this.cursor;
    if (this.finished || !cursor) return;
    const budget = { chunks: scanChunksPerScan };
    while (budget.chunks > 0) {
      budget.chunks -= 1;
      const chunk = this.guard.read(cursor.path, () => cursor.readChunk());
      if (!chunk) break; // contained FS failure; keep last offset
      if (chunk.text.length > 0) this.lines.emitLines(cursor.path, chunk.text, cursor);
      if (!chunk.canContinueNow) break;
    } // budget exhausted with more to read: the next scan tick resumes here.
    this.drops.flushPass(); // bounded drop delivery: one warning per (path, cause) per scan
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
    return {
      readFs: this.guard.read.bind(this.guard),
      lines: this.lines,
      drops: this.drops,
      ...(this.now === undefined ? {} : { now: this.now }),
    };
  }
}

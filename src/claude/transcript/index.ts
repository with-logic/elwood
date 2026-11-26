/**
 * Best-effort live observation of Claude transcript JSONL files.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results come from the CLI transcript. Forward observation uses bounded
 * reads and supplements them with current-turn replay and initial prompt recovery.
 */

import { outsideStopInput } from "../../core/stop-input.ts";
import type { ChunkBudget, DrainContext } from "../../core/transcript/drain.ts";
import { drainToBudget, newTerminalBudget } from "../../core/transcript/drain.ts";
import { recoverFromPollError } from "../../core/transcript/poll-recovery.ts";
import { TranscriptCursor } from "./cursor.ts";
import { buildDrainContext } from "./drain-context.ts";
import {
  DropReporter,
  ReadErrorReporter,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "./drops.ts";
import { type ClaudeTranscriptEvent, LineEmitter } from "./emit.ts";
import { TranscriptFsGuard } from "./fs-guard.ts";
import { observeTranscriptBaseline } from "./observe-initial.ts";
import type { QueuedPromptsAccess } from "./queued-prompts.ts";
import type { UserPromptHookEvidence } from "./user-prompt-types.ts";
import type { TranscriptNoticeHandlers } from "./watcher-config.ts";

export type { TranscriptNoticeHandlers } from "./watcher-config.ts";
export type { ClaudeTranscriptEvent, TranscriptDropNotice, TranscriptReadErrorNotice };

const pollMs = 500; // poll cadence: transcript activity is not latency-critical
/** Read passes per scan, shared across ALL cursors (×256 KiB ≈ 4 MiB): a huge delta drains across poll ticks, not one event-loop block (§9.2). */
const scanChunksPerScan = 16;

export class ClaudeTranscriptWatcher {
  private readonly cursors = new Map<string, TranscriptCursor>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  // A permanent terminal latch: once finished, no scan/emit/observe/poll runs.
  private finished = false;
  // ONE budget shared across every retire() + finish(): terminal work is watcher-bounded (§9.2).
  private readonly terminalBudget: ChunkBudget = newTerminalBudget();
  private readonly drops: DropReporter;
  private readonly guard: TranscriptFsGuard;
  private readonly onPollError: ((error: unknown) => void) | undefined;
  private readonly pollIntervalMs: number;
  private readonly lines: LineEmitter;
  private readonly drain: DrainContext<TranscriptCursor>;
  // Test seam: run after each cursor's scan within a poll pass, so a test can drive the
  // exact race where an earlier cursor's drop is pending when finish() lands mid-pass.
  private afterScanForTests: (() => void) | undefined;

  setAfterScanForTests(hook: () => void): void {
    this.afterScanForTests = hook;
  }

  constructor(
    elwoodSessionId: string,
    emit: (event: ClaudeTranscriptEvent) => void,
    notices: TranscriptNoticeHandlers = {},
  ) {
    this.drops = new DropReporter(elwoodSessionId, notices.onDrop);
    const readErrors = new ReadErrorReporter(elwoodSessionId, notices.onReadError);
    this.guard = new TranscriptFsGuard(readErrors, () => this.finished);
    this.onPollError = notices.onPollError;
    this.pollIntervalMs = notices.pollIntervalMs ?? pollMs;
    this.lines = new LineEmitter(elwoodSessionId, emit, this.drops, notices.onUsageLimit);
    this.drain = buildDrainContext({
      guard: this.guard,
      lines: this.lines,
      drops: this.drops,
      now: notices.now,
    });
  }

  observe(path: string, recoverTail = false, turnId?: string, agentTranscript = false): void {
    if (this.finished) return;
    const cursor =
      this.cursors.get(path) ?? this.guard.read(path, () => new TranscriptCursor(path));
    if (cursor === undefined) return;
    if (agentTranscript) this.lines.subagentPaths.add(path);
    observeTranscriptBaseline(cursor, turnId, this.lines, this.guard, this.drops);
    if (this.cursors.has(path)) return;
    this.cursors.set(path, cursor);
    if (recoverTail) {
      const tail = this.guard.read(path, () => cursor.baselineTail());
      this.lines.emitLines(path, tail?.text ?? "");
      // Report unread earlier records with one content-free backlog warning (§5.4).
      if (tail?.truncated && tail.droppedBytes > 0) this.drops.drop(path, "unread_backlog");
      this.drops.flushPass(); // deliver this observe's coalesced drops
    }
    this.ensurePolling();
  }
  observeUserPromptHook(evidence: UserPromptHookEvidence): boolean {
    return this.lines.userPrompts.observeHook(evidence, this.correlationActive);
  }
  /** Messages queued during a running turn, while transcript correlation can see them. */
  queuedPrompts(): QueuedPromptsAccess | undefined {
    return this.correlationActive ? this.lines.userPrompts.queuedPrompts : undefined;
  }
  private get correlationActive(): boolean {
    return !(this.finished || this.lines.turns.correlationDisabled);
  }

  scan(): void {
    if (this.finished) return;
    const budget = { chunks: scanChunksPerScan };
    for (const cursor of this.cursors.values()) {
      if (budget.chunks <= 0) break; // watcher-wide budget spent; resume next tick
      cursor.runInitialRetry(budget);
      this.scanCursor(cursor, budget);
    }
    this.drops.flushPass(); // bounded drop delivery: one warning per (path, cause) per scan
  }

  /** Reads up to `chunks` chunks of one transcript; the poll reports its failures and drops (§6.5). */
  scanPath(path: string | undefined, chunks: number): boolean {
    const cursor = this.finished || path === undefined ? undefined : this.cursors.get(path);
    return cursor !== undefined && this.scanCursor(cursor, { chunks }, false);
  }

  // Flush + retire a stopped subagent's transcript once, against the SHARED terminal budget and a
  // wall-clock slice (bounded, non-blocking); backlog past it drops content-free, cursor gone.
  retire(path: string): void {
    const cursor = this.cursors.get(path);
    if (!cursor || this.finished) return;
    drainToBudget(this.drain, [cursor], this.terminalBudget);
    this.cursors.delete(path);
    this.lines.forget(path);
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
        const changed = await this.guard.readAsync(cursor.path, () => cursor.needsScan());
        // Re-check after the await: finish() or retire() may have run mid-stat (§5.4).
        if (this.finished) return;
        if (this.cursors.get(cursor.path) !== cursor) continue;
        if (budget.chunks <= 0) break; // watcher-wide budget spent this tick
        cursor.runInitialRetry(budget);
        if (changed) this.scanCursor(cursor, budget);
        this.afterScanForTests?.(); // test seam: drive finish() between cursors
      }
    } finally {
      // If finish ran while stat was pending, discard diagnostics after terminal:exit.
      if (this.finished) this.drops.discardPass();
      else this.drops.flushPass(); // one warning per (path, cause) per poll
      this.polling = false;
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    try {
      drainToBudget(this.drain, [...this.cursors.values()], this.terminalBudget);
    } finally {
      this.lines.userPrompts.clearUnpaired();
      this.lines.subagentPaths.clear();
      this.stop();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }
  private ensurePolling(): void {
    if (this.interval || this.finished) return;
    // A delivery failure reaching the background poll stops the watcher with a contained diagnostic.
    this.interval = outsideStopInput(() =>
      setInterval(() => {
        void this.poll().catch((error) => recoverFromPollError(this, this.onPollError, error));
      }, this.pollIntervalMs),
    );
    this.interval.unref?.();
  }

  // Drain a cursor in bounded chunks against the SHARED per-scan budget (sync work bounded across
  // ALL cursors); the read is contained, parse/emit run outside it. False unless `atRecordEnd`.
  private scanCursor(cursor: TranscriptCursor, budget: ChunkBudget, report = true): boolean {
    while (budget.chunks > 0) {
      budget.chunks -= 1;
      const chunk = this.guard.read(cursor.path, () => cursor.readLiveChunk(), report);
      if (chunk === undefined) return false; // contained FS failure; keep last offset
      if (chunk.text.length > 0) this.lines.emitLines(cursor.path, chunk.text, cursor);
      if (!chunk.canContinueNow) return cursor.atRecordEnd;
    } // budget exhausted with more to read: the next poll tick resumes here.
    return false;
  }
}

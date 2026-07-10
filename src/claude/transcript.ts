/**
 * Best-effort live observation of Claude transcript JSONL files.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results are sourced from the transcript(s) the CLI writes, so an un-sent
 * ghost-text suggestion never becomes activity. Reads are bounded and per-path;
 * pre-existing history is never replayed (see TranscriptCursor).
 */

import { TranscriptCursor } from "./transcript-cursor.ts";
import { type ClaudeTranscriptSummary, summarizeClaudeRecord } from "./transcript-summary.ts";

export type ClaudeTranscriptEvent = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly summary: ClaudeTranscriptSummary;
};

/** A bounded, non-fatal notice that some committed records could not be parsed. */
export type TranscriptDropNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly droppedCount: number;
};

export class ClaudeTranscriptWatcher {
  // One cursor per observed path so A→B→A never rewinds A to the start.
  private readonly cursors = new Map<string, TranscriptCursor>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private droppedSinceNotice = 0;
  private readonly elwoodSessionId: string;
  private readonly emit: (event: ClaudeTranscriptEvent) => void;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    emit: (event: ClaudeTranscriptEvent) => void,
    onDrop?: (notice: TranscriptDropNotice) => void,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.emit = emit;
    this.onDrop = onDrop;
  }

  /**
   * Begin watching `path`. A path seen for the first time baselines at the file's
   * current end (history is not replayed); its current-turn tail already on disk
   * is recovered once so a first-observe on a Stop hook still emits that turn.
   */
  observe(path: string): void {
    if (this.cursors.has(path)) return;
    const cursor = new TranscriptCursor(path);
    this.cursors.set(path, cursor);
    this.guard(() => this.emitLines(cursor, cursor.baselineTail()));
    this.ensurePolling();
  }

  scan(): void {
    for (const cursor of this.cursors.values()) this.guard(() => this.scanCursor(cursor));
  }

  /** Flush any buffered partial lines across all paths, then stop polling. */
  finish(): void {
    for (const cursor of this.cursors.values()) {
      this.guard(() => {
        this.scanCursor(cursor);
        this.emitLines(cursor, cursor.drainPending());
      });
    }
    this.stop();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private ensurePolling(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.scan(), 250);
    this.interval.unref?.();
  }

  /** Drain a cursor in bounded chunks so a huge delta never allocates all at once. */
  private scanCursor(cursor: TranscriptCursor): void {
    for (let guardBudget = 64; guardBudget > 0; guardBudget--) {
      const { text, more } = cursor.readChunk();
      if (text.length > 0) this.emitLines(cursor, text);
      if (!more) return;
    }
  }

  private emitLines(cursor: TranscriptCursor, text: string): void {
    if (text.length === 0) return;
    for (const line of cursor.takeLines(text)) this.emitLine(cursor.path, line);
  }

  private emitLine(path: string, line: string): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.recordDrop(path);
      return;
    }
    for (const summary of summarizeClaudeRecord(item)) {
      this.emit({ elwoodSessionId: this.elwoodSessionId, path, item, summary });
    }
  }

  private recordDrop(path: string): void {
    this.droppedSinceNotice += 1;
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      droppedCount: this.droppedSinceNotice,
    });
  }

  /**
   * Runs a scan step but contains any filesystem error: the normal transcript
   * removal/rotation race must never crash the polling timer, nor reject the
   * hook dispatch / PTY-exit callback that also calls scan()/finish().
   */
  private guard(step: () => void): void {
    try {
      step();
    } catch {
      // Expected best-effort I/O failure; the cursor keeps its last valid offset.
    }
  }
}

/** Returns undefined for a malformed line so the caller can count the drop. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort live observation of Claude transcript JSONL files.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results are sourced from the transcript(s) the CLI writes, so an un-sent
 * ghost-text suggestion never becomes activity. Reads are bounded and per-path;
 * pre-existing history is never replayed (see TranscriptCursor).
 */

import { TranscriptCursor } from "./transcript-cursor.ts";
import { type ClaudeTranscriptSummary, summarizeClaudeRecord } from "./transcript-summary.ts";

/** Poll cadence: transcript activity is not latency-critical, so this stays coarse. */
const pollMs = 500;
/** Emit a drop notice at most once per this many dropped records (rate-bounded). */
const dropNoticeEvery = 50;

export type ClaudeTranscriptEvent = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly summary: ClaudeTranscriptSummary;
};

/** A bounded, content-free notice that committed records could not be parsed. */
export type TranscriptDropNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  /** Total dropped so far this session (running count, never the raw content). */
  readonly droppedCount: number;
  /** Total bytes of the dropped lines (diagnostic magnitude, not content). */
  readonly droppedBytes: number;
};

export class ClaudeTranscriptWatcher {
  // One cursor per observed path so A→B→A never rewinds A to the start.
  private readonly cursors = new Map<string, TranscriptCursor>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private dropped = 0;
  private droppedBytes = 0;
  private notifiedAt = 0;
  private lastDropPath = "";
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
    this.emitLines(path, readFs(() => cursor.baselineTail()) ?? "");
    this.ensurePolling();
  }

  scan(): void {
    for (const cursor of this.cursors.values()) this.scanCursor(cursor);
  }

  /** Flush any buffered partial lines across all paths, then stop polling. */
  finish(): void {
    for (const cursor of this.cursors.values()) {
      this.scanCursor(cursor);
      this.emitLines(cursor.path, cursor.drainPending());
    }
    this.flushDropNotice();
    this.stop();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private ensurePolling(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.scan(), pollMs);
    this.interval.unref?.();
  }

  /**
   * Drain a cursor in bounded chunks. The filesystem read is contained (a normal
   * transcript rotation/removal race must not crash the timer or reject the hook
   * dispatch that calls scan()/finish()); parsing and emit run OUTSIDE that guard
   * so a downstream listener error is never silently swallowed.
   */
  private scanCursor(cursor: TranscriptCursor): void {
    for (let budget = 64; budget > 0; budget--) {
      const chunk = readFs(() => cursor.readChunk());
      if (chunk === undefined) return; // contained FS failure; keep last offset
      if (chunk.text.length > 0) this.emitLines(cursor.path, chunk.text, cursor);
      if (!chunk.more) return;
    }
  }

  private emitLines(path: string, text: string, cursor?: TranscriptCursor): void {
    if (text.length === 0) return;
    const lines = cursor ? cursor.takeLines(text) : takeLinesOf(text);
    for (const line of lines) this.emitLine(path, line);
  }

  private emitLine(path: string, line: string): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.recordDrop(path, line);
      return;
    }
    for (const summary of summarizeClaudeRecord(item)) {
      this.emit({ elwoodSessionId: this.elwoodSessionId, path, item, summary });
    }
  }

  private recordDrop(path: string, line: string): void {
    this.dropped += 1;
    this.droppedBytes += Buffer.byteLength(line, "utf8");
    this.lastDropPath = path;
    // Rate-bound: notify on the first drop and then only every N, not per line.
    if (this.dropped - this.notifiedAt >= dropNoticeEvery || this.notifiedAt === 0) {
      this.notifyDrop(path);
    }
  }

  /** Emit a final aggregated notice for any drops not yet reported. */
  private flushDropNotice(): void {
    if (this.dropped > this.notifiedAt) this.notifyDrop(this.lastDropPath);
  }

  private notifyDrop(path: string): void {
    this.notifiedAt = this.dropped;
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      droppedCount: this.dropped,
      droppedBytes: this.droppedBytes,
    });
  }
}

/** Runs a filesystem read, returning undefined on the expected removal/rotation race. */
function readFs<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Line splitter for text with no retained partial (baseline/pending flushes). */
function takeLinesOf(text: string): readonly string[] {
  return text.split(/\r?\n/);
}

/** Returns undefined for a malformed line so the caller can count the drop. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

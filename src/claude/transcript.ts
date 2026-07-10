/**
 * Best-effort live observation of Claude transcript JSONL files.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results are sourced from the transcript(s) the CLI writes, so an un-sent
 * ghost-text suggestion never becomes activity. Reads are bounded and per-path;
 * pre-existing history is never replayed (see TranscriptCursor).
 */

import { TranscriptCursor } from "./transcript-cursor.ts";
import { DropTracker, type TranscriptDropNotice } from "./transcript-drops.ts";
import { type ClaudeTranscriptSummary, summarizeClaudeRecord } from "./transcript-summary.ts";

export type { TranscriptDropNotice };

/** Poll cadence: transcript activity is not latency-critical, so this stays coarse. */
const pollMs = 500;

export type ClaudeTranscriptEvent = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly summary: ClaudeTranscriptSummary;
};

export class ClaudeTranscriptWatcher {
  // One cursor per observed path so A→B→A never rewinds A to the start.
  private readonly cursors = new Map<string, TranscriptCursor>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private readonly drops: DropTracker;
  private readonly elwoodSessionId: string;
  private readonly emit: (event: ClaudeTranscriptEvent) => void;

  constructor(
    elwoodSessionId: string,
    emit: (event: ClaudeTranscriptEvent) => void,
    onDrop?: (notice: TranscriptDropNotice) => void,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.emit = emit;
    this.drops = new DropTracker(elwoodSessionId, onDrop);
  }

  /**
   * Begin watching `path`. A path seen for the first time baselines at the file's
   * current end (history is not replayed); its current-turn tail already on disk
   * is recovered once so a first-observe on a Stop hook still emits that turn.
   */
  observe(path: string, recoverTail = false): void {
    if (this.cursors.has(path)) return;
    // Cursor construction reads the file size, so it shares the fs guard: a
    // rotation/removal race at first observe must not throw out of hook dispatch.
    const cursor = readFs(() => new TranscriptCursor(path));
    if (cursor === undefined) return;
    this.cursors.set(path, cursor);
    // Only a first-observe that lands on a turn-boundary hook recovers the
    // already-committed tail; a SessionStart/resume observe baselines at EOF so
    // a prior conversation's final turn is never republished.
    if (recoverTail) this.emitLines(path, readFs(() => cursor.baselineTail()) ?? "");
    this.ensurePolling();
  }

  scan(): void {
    for (const cursor of this.cursors.values()) this.scanCursor(cursor);
  }

  /**
   * Idle-friendly poll: an ASYNC stat gates each cursor so a session with no
   * new transcript bytes performs zero synchronous fs work on the shared event
   * loop (PRD §9.2). A bounded synchronous read runs only for a cursor that
   * actually grew. Re-entrancy is guarded so a slow read can't overlap the next
   * tick. The stat race is contained like every other transcript fs access.
   */
  /** Test seam: drive one poll pass synchronously (the interval calls poll()). */
  pollOnceForTests(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const cursor of this.cursors.values()) {
        const grown = await readFsAsync(() => cursor.hasGrown());
        if (grown) this.scanCursor(cursor);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Flush any buffered partial lines across all paths, then stop polling. */
  finish(): void {
    // Polling MUST stop even if flushing throws (a listener bug), so a wedged
    // watcher can't keep firing after teardown and delay later lifecycle events.
    try {
      for (const cursor of this.cursors.values()) {
        this.scanCursor(cursor);
        this.emitLines(cursor.path, cursor.drainPending());
      }
      this.drops.flush();
    } finally {
      this.stop();
    }
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private ensurePolling(): void {
    if (this.interval) return;
    // Fire-and-forget: poll() is re-entrancy-guarded and self-contains its fs
    // errors, so a rejected promise is impossible; void satisfies the linter.
    this.interval = setInterval(() => void this.poll(), pollMs);
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
      this.drops.record(path, line);
      return;
    }
    for (const summary of summarizeClaudeRecord(item)) {
      this.emit({ elwoodSessionId: this.elwoodSessionId, path, item, summary });
    }
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

/** Async twin of readFs: contains a rejected stat during idle polling as `false`. */
async function readFsAsync(read: () => Promise<boolean>): Promise<boolean> {
  try {
    return await read();
  } catch {
    return false;
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

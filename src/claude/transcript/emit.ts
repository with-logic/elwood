/**
 * Parses committed transcript lines into activity events, counting drops.
 * Implements PRD §5.4 (C-CLAUDE-15): only committed, parseable records become
 * activity; a malformed line or a discarded over-length record is counted, never
 * emitted.
 */

import type { TranscriptCursor } from "./cursor.ts";
import type { DropTracker } from "./drops.ts";
import { type ClaudeTranscriptSummary, summarizeClaudeRecord } from "./summary.ts";

export type ClaudeTranscriptEvent = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly summary: ClaudeTranscriptSummary;
};

/** Turns raw transcript text into parsed activity events for one watcher. */
export class LineEmitter {
  private readonly elwoodSessionId: string;
  private readonly emit: (event: ClaudeTranscriptEvent) => void;
  private readonly drops: DropTracker;

  constructor(id: string, emit: (event: ClaudeTranscriptEvent) => void, drops: DropTracker) {
    this.elwoodSessionId = id;
    this.emit = emit;
    this.drops = drops;
  }

  /** Emit complete lines from `text`; a cursor retains any trailing partial line. */
  emitLines(path: string, text: string, cursor?: TranscriptCursor): void {
    if (text.length === 0) return;
    if (!cursor) {
      for (const line of text.split(/\r?\n/)) this.emitLine(path, line);
      return;
    }
    const { lines, droppedBytes, discard } = cursor.takeLines(text);
    // An over-length un-terminated record was discarded, not emitted: report its
    // bytes as a drop so the truncation is visible rather than silent (§5.4). The
    // record COUNT is driven by the cursor's EXPLICIT transition, never inferred:
    // `started` began a fresh over-length record (+1) — even when the same chunk
    // ALSO closed a prior discard, so two consecutive over-length records split
    // across one chunk boundary count as TWO, not one — while `continuing`/`ended`
    // add bytes only (records=0), so one record is never counted per chunk.
    if (droppedBytes > 0)
      this.drops.accountDrop({
        path,
        bytes: droppedBytes,
        incidents: discard === "started" ? 1 : 0,
        cause: "oversized",
      });
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

/** Returns undefined for a malformed line so the caller can count the drop. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

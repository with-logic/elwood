/**
 * Parses committed transcript lines into activity events, surfacing drops live.
 * Implements PRD §5.4 (C-CLAUDE-15): only committed, parseable records become
 * activity; a malformed line or a discarded over-length record is surfaced as one
 * live drop warning, never emitted as activity.
 */

import type { TranscriptCursor } from "./cursor.ts";
import type { DropReporter } from "./drops.ts";
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
  private readonly drops: DropReporter;

  constructor(id: string, emit: (event: ClaudeTranscriptEvent) => void, drops: DropReporter) {
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
    const { lines, dropped } = cursor.takeLines(text);
    // An over-length un-terminated record was discarded, not emitted: surface one
    // live drop warning so the truncation is visible rather than silent (§5.4).
    if (dropped) this.drops.drop(path, "oversized");
    for (const line of lines) this.emitLine(path, line);
  }

  private emitLine(path: string, line: string): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.drops.record(path);
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

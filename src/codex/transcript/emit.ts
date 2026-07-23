/**
 * Parses committed Codex transcript lines into events, counting drops.
 * Implements PRD §7A/§5.4 (C-API-12): only committed, parseable records become
 * events; a malformed line or a discarded over-length record is counted through the
 * drop tracker, never emitted.
 */

import type { CodexTranscriptCursor } from "./cursor.ts";
import type { CodexDropTracker } from "./drops.ts";
import { summarizeTranscriptItem } from "./summary.ts";
import type { CodexTranscriptEvent } from "./types.ts";

/** Turns raw transcript text into parsed events for one watcher. */
export class CodexLineEmitter {
  private readonly elwoodSessionId: string;
  private readonly emit: (event: CodexTranscriptEvent) => void;
  private readonly drops: CodexDropTracker;

  constructor(id: string, emit: (event: CodexTranscriptEvent) => void, drops: CodexDropTracker) {
    this.elwoodSessionId = id;
    this.emit = emit;
    this.drops = drops;
  }

  /** Emit complete lines from `text`; the cursor retains any trailing partial line. */
  emitLines(path: string, text: string, cursor: CodexTranscriptCursor): void {
    if (text.length === 0) return;
    const { lines, droppedBytes, discard } = cursor.takeLines(text);
    // An over-length un-terminated record was discarded, not emitted: report its
    // bytes as a drop so the truncation is visible rather than silent (§5.4). The
    // record COUNT is driven by the cursor's EXPLICIT transition: `started` began a
    // fresh over-length record (+1) — even when the same chunk ALSO closed a prior
    // discard — while `continuing`/`ended` add bytes only (records=0).
    if (droppedBytes > 0)
      this.drops.recordBytes({
        path,
        bytes: droppedBytes,
        incidents: discard === "started" ? 1 : 0,
        cause: "oversized",
      });
    for (const line of lines) this.emitLine(path, line);
  }

  /** Emit a single already-complete line (the final drained partial at teardown). */
  emitLine(path: string, line: string): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.drops.record(path, line);
      return;
    }
    this.emit({
      elwoodSessionId: this.elwoodSessionId,
      path,
      item,
      summary: summarizeTranscriptItem(item),
    });
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

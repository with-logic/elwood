/**
 * Parses committed Codex transcript lines into events, reporting drops.
 * Implements PRD §7A/§5.4 (C-API-12): only committed, parseable records become
 * events; a malformed line or a discarded over-length record is reported through the
 * drop reporter as a live, count-free warning (coalesced per scan pass), never as an
 * event of its own.
 */

import type { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import type { DropReporter } from "../../core/transcript/drops.ts";
import { summarizeTranscriptItem } from "./summary.ts";
import type { CodexTranscriptEvent } from "./types.ts";

/** The replay flag is internal; raw transcript observers still receive the same event. */
export type CodexTranscriptDelivery = (event: CodexTranscriptEvent, rewound: boolean) => void;

/** Turns raw transcript text into parsed events for one watcher. */
export class CodexLineEmitter {
  private readonly elwoodSessionId: string;
  private readonly emit: CodexTranscriptDelivery;
  private readonly drops: DropReporter;

  constructor(id: string, emit: CodexTranscriptDelivery, drops: DropReporter) {
    this.elwoodSessionId = id;
    this.emit = emit;
    this.drops = drops;
  }

  /** Emit complete lines from `text`; the cursor retains any trailing partial line. */
  emitLines(path: string, text: string, cursor: BoundedTranscriptCursor): void {
    if (text.length === 0) return;
    const { lines, startedOversizedDrop } = cursor.takeLines(text);
    // An over-length un-terminated record was discarded, not emitted: surface one
    // live drop warning so the truncation is visible rather than silent (§5.4).
    if (startedOversizedDrop) this.drops.drop(path, "oversized");
    const rewound = cursor.lastReadWasReplay;
    for (const line of lines) this.publishLine(path, line, rewound);
  }

  /** Emit a single already-complete line (the final drained partial at teardown). */
  emitLine(path: string, line: string, cursor: BoundedTranscriptCursor): void {
    this.publishLine(path, line, cursor.lastReadWasReplay);
  }

  private publishLine(path: string, line: string, rewound: boolean): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.drops.record(path);
      return;
    }
    this.emit(
      {
        elwoodSessionId: this.elwoodSessionId,
        path,
        item,
        summary: summarizeTranscriptItem(item),
      },
      rewound,
    );
  }
}

/** Returns undefined for a malformed line so the caller can report the drop. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

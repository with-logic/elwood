/**
 * Parses committed transcript lines into activity events, surfacing drops live.
 * Implements PRD §5.4 (C-CLAUDE-15): only committed, parseable records become
 * activity; a malformed line or a discarded over-length record is surfaced as one
 * live drop warning, never emitted as activity.
 */

import { optional } from "../../core/optional.ts";
import type { ClaudeTokenUsage } from "../../core/stats/types.ts";
import type { TranscriptCursor } from "./cursor.ts";
import type { DropReporter } from "./drops.ts";
import { type ClaudeTranscriptSummary, summarizeClaudeRecord } from "./summary.ts";
import { ClaudeTranscriptTurns } from "./turn-identity.ts";
import { claudeTokenUsage } from "./usage.ts";
import { ClaudeUserPrompts, type RecoveredUserPrompt } from "./user-prompts.ts";

type ClaudeTranscriptFields = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly turnId?: string;
};

export type ClaudeTranscriptEvent = ClaudeTranscriptFields &
  (
    | { readonly summary: ClaudeTranscriptSummary; readonly tokenUsage?: ClaudeTokenUsage }
    | (RecoveredUserPrompt & { readonly tokenUsage?: never })
    | {
        readonly summary: { readonly kind: "other"; readonly label: "token_usage" };
        readonly tokenUsage: ClaudeTokenUsage;
      }
  );

/** Turns raw transcript text into parsed activity events for one watcher. */
export class LineEmitter {
  readonly turns = new ClaudeTranscriptTurns();
  readonly userPrompts: ClaudeUserPrompts;
  private readonly elwoodSessionId: string;
  private readonly emit: (event: ClaudeTranscriptEvent) => void;
  private readonly drops: DropReporter;

  constructor(id: string, emit: (event: ClaudeTranscriptEvent) => void, drops: DropReporter) {
    this.elwoodSessionId = id;
    this.emit = emit;
    this.drops = drops;
    this.userPrompts = new ClaudeUserPrompts((prompt) => emit({ ...prompt, elwoodSessionId: id }));
  }

  /** Emit complete lines from `text`; a cursor retains any trailing partial line. */
  emitLines(path: string, text: string, cursor?: TranscriptCursor): void {
    if (text.length === 0) return;
    if (!cursor) {
      for (const line of text.split(/\r?\n/)) this.emitLine(path, line);
      return;
    }
    const { lines, startedOversizedDrop } = cursor.takeLines(text);
    // An over-length un-terminated record was discarded, not emitted: surface one
    // live drop warning so the truncation is visible rather than silent (§5.4).
    if (startedOversizedDrop) this.drops.drop(path, "oversized");
    for (const line of lines) this.emitLine(path, line, true);
  }

  /** Emit one line taken as complete (a transcript's last, un-terminated record at its end). */
  emitLine(path: string, line: string, committed = false): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.drops.record(path);
      return;
    }
    const turnId = this.turns.observe(path, item);
    if (this.turns.correlationDisabled) this.userPrompts.clear();
    if (committed && turnId !== undefined) this.userPrompts.committed(path, turnId, item, line);
    const summaries = summarizeClaudeRecord(item);
    const tokenUsage = claudeTokenUsage(item);
    if (summaries.length === 0) {
      if (tokenUsage === undefined) return;
      this.emit({
        ...this.eventFields(path, item, turnId),
        summary: { kind: "other", label: "token_usage" },
        tokenUsage,
      });
      return;
    }
    const base = this.eventFields(path, item, turnId);
    for (const [index, summary] of summaries.entries()) {
      this.emit({
        ...base,
        summary,
        ...optional(index === 0 ? tokenUsage : undefined, "tokenUsage"),
      });
    }
  }

  private eventFields(
    path: string,
    item: unknown,
    turnId: string | undefined,
  ): ClaudeTranscriptFields {
    return {
      elwoodSessionId: this.elwoodSessionId,
      path,
      item,
      ...optional(turnId, "turnId"),
    };
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

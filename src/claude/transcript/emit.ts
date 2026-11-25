/**
 * Parses committed transcript lines into activity events, surfacing drops live.
 * Implements PRD §5.4 (C-CLAUDE-15): only committed, parseable records become
 * activity; a malformed line or a discarded over-length record is surfaced as one
 * live drop warning, never emitted as activity.
 */

import { optional } from "../../core/optional.ts";
import type { ClaudeTokenUsage } from "../../core/stats/types.ts";
import type { ClaudeUsageLimitWarning } from "../../core/warnings/transcript.ts";
import type { TranscriptCursor } from "./cursor.ts";
import type { DropReporter } from "./drops.ts";
import {
  type ClaudeDirectRecordSummary,
  claudeFinalReplyIndex,
  summarizeClaudeRecord,
} from "./summary.ts";
import { ClaudeTranscriptTurns } from "./turn-identity.ts";
import { claudeTokenUsage } from "./usage.ts";
import { claudeUsageLimitWarning } from "./usage-limit.ts";
import { ClaudeUserPrompts, type RecoveredUserPrompt } from "./user-prompts.ts";

type LineSource = "history" | "rewind" | "forward";

type ClaudeTranscriptFields = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly turnId?: string;
};

type ClaudeRecoveredPromptEvent = RecoveredUserPrompt & {
  readonly elwoodSessionId: string;
  readonly recovered: true;
  readonly item?: never;
  readonly tokenUsage?: never;
};

type ClaudeDirectEvent = ClaudeTranscriptFields & {
  readonly recovered?: never;
} & (
    | {
        readonly summary: Extract<
          ClaudeDirectRecordSummary,
          { readonly kind: "assistant_message" }
        >;
        readonly tokenUsage?: ClaudeTokenUsage;
        readonly final: true;
      }
    | {
        readonly summary: ClaudeDirectRecordSummary;
        readonly tokenUsage?: ClaudeTokenUsage;
        readonly final?: never;
      }
    | {
        readonly summary: { readonly kind: "other"; readonly label: "token_usage" };
        readonly tokenUsage: ClaudeTokenUsage;
        readonly final?: never;
      }
  );

export type ClaudeTranscriptEvent = ClaudeDirectEvent | ClaudeRecoveredPromptEvent;

/** Turns raw transcript text into parsed activity events for one watcher. */
export class LineEmitter {
  readonly turns = new ClaudeTranscriptTurns();
  readonly subagentPaths = new Set<string>();
  readonly userPrompts: ClaudeUserPrompts;
  private readonly elwoodSessionId: string;
  private readonly emit: (event: ClaudeTranscriptEvent) => void;
  private readonly drops: DropReporter;
  private readonly onUsageLimit: ((warning: ClaudeUsageLimitWarning) => void) | undefined;

  constructor(
    id: string,
    emit: (event: ClaudeTranscriptEvent) => void,
    drops: DropReporter,
    onUsageLimit?: (warning: ClaudeUsageLimitWarning) => void,
  ) {
    this.elwoodSessionId = id;
    this.emit = emit;
    this.drops = drops;
    this.onUsageLimit = onUsageLimit;
    this.userPrompts = new ClaudeUserPrompts((prompt) =>
      emit({ ...prompt, elwoodSessionId: id, recovered: true }),
    );
  }

  forget(path: string): void {
    this.turns.forget(path);
    this.userPrompts.forget(path);
    this.subagentPaths.delete(path);
  }

  /** Emit complete lines from `text`; a cursor retains any trailing partial line. */
  emitLines(path: string, text: string, cursor?: TranscriptCursor): void {
    if (text.length === 0) return;
    if (!cursor) {
      // A backward baseline tail cannot supply live prompt or usage-limit evidence.
      for (const line of text.split(/\r?\n/)) this.publishLine(path, line, "history");
      return;
    }
    const { lines, startedOversizedDrop } = cursor.takeLines(text);
    // An over-length un-terminated record was discarded, not emitted: surface one
    // live drop warning so the truncation is visible rather than silent (§5.4).
    if (startedOversizedDrop) this.drops.drop(path, "oversized");
    const source = cursor.lastReadWasReplay ? "rewind" : "forward";
    for (const line of lines) this.publishLine(path, line, source);
  }

  /** Emit one line taken as complete (a transcript's last, un-terminated record at its end). */
  emitLine(path: string, line: string, cursor?: TranscriptCursor): void {
    this.publishLine(path, line, cursor?.lastReadWasReplay ? "rewind" : "forward");
  }

  private publishLine(path: string, line: string, source: LineSource): void {
    if (!line.trim()) return;
    const item = parseLine(line);
    if (item === undefined) {
      this.drops.record(path);
      return;
    }
    const turnId = this.turns.observe(path, item);
    if (this.turns.correlationDisabled) this.userPrompts.clearUnpaired();
    if (source !== "history" && turnId !== undefined)
      this.userPrompts.observeForwardRecord(path, turnId, item);
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
    const finalReplyIndex = this.subagentPaths.has(path)
      ? -1
      : claudeFinalReplyIndex(item, summaries);
    const base = this.eventFields(path, item, turnId);
    if (source === "forward" && this.onUsageLimit && !this.subagentPaths.has(path)) {
      const usageLimitWarning = claudeUsageLimitWarning(base, summaries);
      if (usageLimitWarning) this.onUsageLimit(usageLimitWarning);
    }
    for (const [index, summary] of summaries.entries()) {
      const fields = { ...base, ...optional(index === 0 ? tokenUsage : undefined, "tokenUsage") };
      this.emit(
        summary.kind === "assistant_message" && index === finalReplyIndex
          ? { ...fields, summary, final: true }
          : { ...fields, summary },
      );
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

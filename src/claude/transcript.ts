/**
 * Best-effort live observation of the Claude transcript JSONL.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text, tool calls, and
 * tool results are sourced from the transcript the CLI writes at
 * `transcript_path`, so an un-sent ghost-text suggestion never becomes activity.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { type ClaudeTranscriptSummary, summarizeClaudeRecord } from "./transcript-summary.ts";

export type ClaudeTranscriptEvent = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly summary: ClaudeTranscriptSummary;
};

export class ClaudeTranscriptWatcher {
  private path: string | undefined;
  private offset = 0;
  private pending = "";
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly elwoodSessionId: string;
  private readonly emit: (event: ClaudeTranscriptEvent) => void;

  constructor(elwoodSessionId: string, emit: (event: ClaudeTranscriptEvent) => void) {
    this.elwoodSessionId = elwoodSessionId;
    this.emit = emit;
  }

  /** Begin watching a transcript path; a new path resets the read position. */
  observe(path: string): void {
    if (this.path === path) return;
    this.stop();
    this.path = path;
    this.offset = existsSync(path) ? statSync(path).size : 0;
    this.pending = "";
    this.interval = setInterval(() => this.scan(), 250);
    this.interval.unref?.();
  }

  scan(): void {
    if (!(this.path && existsSync(this.path))) return;
    const size = statSync(this.path).size;
    if (size < this.offset) this.offset = 0;
    const chunk = this.readNewChunk(size);
    if (chunk.length === 0) return;
    const lines = `${this.pending}${chunk}`.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (index < lines.length - 1) this.emitLine(line);
      else this.pending = line;
    }
  }

  /** Flush any buffered partial line, then read one final time on teardown. */
  finish(): void {
    this.scan();
    if (this.pending.trim()) this.emitLine(this.pending);
    this.pending = "";
    this.stop();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private emitLine(line: string): void {
    if (!(this.path && line.trim())) return;
    const item = parseLine(line);
    for (const summary of summarizeClaudeRecord(item)) {
      this.emit({ elwoodSessionId: this.elwoodSessionId, path: this.path, item, summary });
    }
  }

  private readNewChunk(size: number): string {
    if (!(this.path && size > this.offset)) return "";
    const buffer = Buffer.allocUnsafe(size - this.offset);
    const fd = openSync(this.path, "r");
    try {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      closeSync(fd);
    }
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "invalid", raw: line };
  }
}

/**
 * Best-effort live observation of Codex transcript JSONL items.
 * Implements PRD §7A and §11.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export type CodexTranscriptSummary = {
  readonly kind: "message" | "tool_call" | "tool_result" | "reasoning" | "web_search" | "other";
  readonly label: string;
  readonly text?: string;
};

export type CodexTranscriptEvent = {
  readonly elwoodSessionId: string;
  readonly path: string;
  readonly item: unknown;
  readonly summary: CodexTranscriptSummary;
};

export class CodexTranscriptWatcher {
  private path: string | undefined;
  private offset = 0;
  private pending = "";
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly elwoodSessionId: string;
  private readonly emit: (event: CodexTranscriptEvent) => void;

  constructor(elwoodSessionId: string, emit: (event: CodexTranscriptEvent) => void) {
    this.elwoodSessionId = elwoodSessionId;
    this.emit = emit;
  }

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

  flush(): void {
    this.scan();
    if (this.pending.trim()) this.emitLine(this.pending);
    this.pending = "";
  }

  finish(): void {
    this.flush();
    this.stop();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private emitLine(line: string): void {
    if (!(this.path && line.trim())) return;
    const item = parseLine(line);
    this.emit({
      elwoodSessionId: this.elwoodSessionId,
      path: this.path,
      item,
      summary: summarizeTranscriptItem(item),
    });
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

export function summarizeTranscriptItem(item: unknown): CodexTranscriptSummary {
  const payload = record(record(item)?.["payload"]);
  if (!payload) {
    return { kind: "other", label: stringValue(record(item)?.["type"]) ?? "unknown" };
  }
  const type = stringValue(payload?.["type"]);
  if (type === "web_search_end" || type === "web_search_call") return webSearch(payload);
  if (type === "function_call") return toolCall(payload);
  if (type === "custom_tool_call") return toolCall(payload);
  if (type === "function_call_output") return toolResult(payload);
  if (type === "reasoning") return { kind: "reasoning", label: "reasoning" };
  if (type === "message") return message(payload);
  if (type === "agent_message") return agentMessage(payload);
  return { kind: "other", label: type ?? stringValue(record(item)?.["type"]) ?? "unknown" };
}

function webSearch(payload: Record<string, unknown>): CodexTranscriptSummary {
  const query = stringValue(payload["query"]);
  const action = record(payload["action"]);
  const actionType = stringValue(action?.["type"]) ?? "search";
  const textValue = query ?? stringValue(action?.["url"]) ?? stringValue(action?.["pattern"]);
  return { kind: "web_search", label: actionType, ...(text(textValue) ?? {}) };
}

function toolCall(payload: Record<string, unknown>): CodexTranscriptSummary {
  const name = stringValue(payload["name"]) ?? "tool";
  return { kind: "tool_call", label: name, ...(text(payload["arguments"]) ?? {}) };
}

function toolResult(payload: Record<string, unknown>): CodexTranscriptSummary {
  const callId = stringValue(payload["call_id"]) ?? "tool";
  return { kind: "tool_result", label: callId, ...(text(payload["output"]) ?? {}) };
}

function message(payload: Record<string, unknown>): CodexTranscriptSummary {
  const role = stringValue(payload["role"]) ?? "message";
  return { kind: "message", label: role, ...(text(payload["content"]) ?? {}) };
}

function agentMessage(payload: Record<string, unknown>): CodexTranscriptSummary {
  return { kind: "message", label: "assistant", ...(text(payload["message"]) ?? {}) };
}

function text(value: unknown): { readonly text: string } | undefined {
  if (typeof value === "string") return { text: value };
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

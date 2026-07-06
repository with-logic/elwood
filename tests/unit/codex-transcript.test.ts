/**
 * Focused coverage for live Codex transcript observation.
 * Covers PRD §7A.4.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodexTranscriptWatcher, summarizeTranscriptItem } from "../../src/codex/transcript.ts";
import { tempDirForUnit } from "./helpers.ts";

describe("Codex transcript observation", () => {
  test("C-API-12 live transcript watcher emits only new JSONL items", () => {
    const path = join(tempDirForUnit(), "codex.jsonl");
    const events: unknown[] = [];
    writeFileSync(path, `${JSON.stringify(line("response_item", { type: "message" }))}\n`);
    const watcher = new CodexTranscriptWatcher("e1", (event) => events.push(event));
    watcher.observe(path);
    appendFileSync(
      path,
      [
        JSON.stringify(line("response_item", { type: "function_call", name: "exec_command" })),
        JSON.stringify(line("event_msg", { type: "web_search_end", query: "Bowie MD" })),
        "{bad json",
      ].join("\n"),
    );
    watcher.scan();
    watcher.flush();
    watcher.stop();
    expect(events).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({
        elwoodSessionId: "e1",
        summary: expect.objectContaining({ kind: "web_search", text: "Bowie MD" }),
      }),
    );
  });

  test("C-API-12 watcher handles late files, blank lines, re-observe, and truncation", () => {
    const path = join(tempDirForUnit(), "codex.jsonl");
    const events: unknown[] = [];
    const watcher = new CodexTranscriptWatcher("e2", (event) => events.push(event));
    watcher.observe(path);
    writeFileSync(path, `${JSON.stringify(line("response_item", { type: "reasoning" }))}\n\n`);
    watcher.scan();
    expect(events).toHaveLength(1);
    watcher.observe(path);
    writeFileSync(path, '{"type":"note"}\n');
    watcher.scan();
    watcher.stop();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ summary: { kind: "other", label: "note" } });
  });

  test("C-API-12 transcript summaries fall back for sparse payloads", () => {
    expect(summarizeTranscriptItem(7)).toEqual({ kind: "other", label: "unknown" });
    expect(summarizeTranscriptItem({ type: "turn_context", payload: {} })).toEqual({
      kind: "other",
      label: "turn_context",
    });
    expect(summarizeTranscriptItem({ payload: {} })).toEqual({ kind: "other", label: "unknown" });
    expect(summary({ type: "web_search_call", action: { pattern: "TODO" } })).toEqual({
      kind: "web_search",
      label: "search",
      text: "TODO",
    });
    expect(summary({ type: "web_search_call" })).toEqual({ kind: "web_search", label: "search" });
    expect(summary({ type: "function_call" }).label).toBe("tool");
    expect(summary({ type: "function_call_output" }).label).toBe("tool");
    expect(summary({ type: "message", content: ["hi"] })).toEqual({
      kind: "message",
      label: "message",
    });
    expect(summary({ type: "agent_message", message: 7 })).toEqual({
      kind: "message",
      label: "assistant",
    });
  });

  test("C-API-12 transcript summaries cover Codex-visible activity", () => {
    expect(summary({ type: "function_call", name: "exec_command" })).toMatchObject({
      kind: "tool_call",
      label: "exec_command",
    });
    expect(summary({ type: "custom_tool_call", name: "apply_patch" }).label).toBe("apply_patch");
    expect(summary({ type: "function_call_output", call_id: "call_1" }).kind).toBe("tool_result");
    expect(summary({ type: "reasoning" }).kind).toBe("reasoning");
    expect(summary({ type: "message", role: "assistant", content: "hi" })).toEqual({
      kind: "message",
      label: "assistant",
      text: "hi",
    });
    expect(summary({ type: "agent_message", message: "hello" }).text).toBe("hello");
    expect(summary({ type: "web_search_call", action: { type: "open_page", url: "u" } })).toEqual({
      kind: "web_search",
      label: "open_page",
      text: "u",
    });
    expect(summarizeTranscriptItem({ type: "session_meta" })).toEqual({
      kind: "other",
      label: "session_meta",
    });
    expect(summary({ type: "future_event" })).toEqual({ kind: "other", label: "future_event" });
  });
});

function summary(payload: Record<string, unknown>) {
  return summarizeTranscriptItem(line("response_item", payload));
}

function line(type: string, payload: Record<string, unknown>) {
  return { timestamp: "2026-05-24T00:00:00.000Z", type, payload };
}

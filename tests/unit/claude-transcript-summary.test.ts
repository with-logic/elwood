/**
 * Focused coverage for the Claude transcript record summarizer.
 * Covers PRD §5.4 (C-CLAUDE-15).
 */

import { describe, expect, test } from "vitest";
import { stringify, summarizeClaudeRecord } from "../../src/claude/transcript-summary.ts";

describe("C-CLAUDE-15 Claude transcript summarizer", () => {
  test("extracts an assistant text block as an assistant_message", () => {
    const record = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    };
    expect(summarizeClaudeRecord(record)).toEqual([
      { kind: "assistant_message", label: "assistant", text: "hello there" },
    ]);
  });

  test("extracts tool_use and tool_result blocks with ids and payloads", () => {
    const assistant = summarizeClaudeRecord({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "A" } }],
      },
    });
    expect(assistant).toEqual([
      {
        kind: "tool_call",
        label: "Read",
        toolName: "Read",
        toolUseId: "tu_1",
        toolInput: '{"path":"A"}',
      },
    ]);
    const user = summarizeClaudeRecord({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    });
    expect(user).toEqual([
      { kind: "tool_result", label: "tu_1", toolUseId: "tu_1", toolOutput: "ok" },
    ]);
  });

  test("handles string content and a plain user message", () => {
    expect(
      summarizeClaudeRecord({ type: "user", message: { role: "user", content: "hi" } }),
    ).toEqual([{ kind: "user_message", label: "user", text: "hi" }]);
  });

  test("yields nothing for non-message records or empty/unknown blocks", () => {
    expect(summarizeClaudeRecord({ type: "file-history-snapshot" })).toEqual([]);
    expect(summarizeClaudeRecord({ type: "assistant", message: { content: 42 } })).toEqual([]);
    expect(
      summarizeClaudeRecord({
        type: "assistant",
        message: { content: [{ type: "text", text: "" }, { type: "thinking" }] },
      }),
    ).toEqual([]);
    expect(summarizeClaudeRecord("not an object")).toEqual([]);
  });

  test("C-CLAUDE-15 UI-chrome records (away-summary recap, status lines) are not messages", () => {
    // Claude Code's "recap" / away-summary and its status lines are rendered TUI
    // chrome the CLI writes as system/attachment records — never a committed
    // assistant turn. They MUST NOT become an assistant_message. (Observed in a
    // real transcript as type:"system" subtype:"away_summary" + type:"attachment".)
    expect(
      summarizeClaudeRecord({
        type: "system",
        subtype: "away_summary",
        content: "recap: Goal: switch Dependabot from npm to bun. (disable recaps in /config)",
      }),
    ).toEqual([]);
    expect(summarizeClaudeRecord({ type: "system", subtype: "stop_hook_summary" })).toEqual([]);
    expect(
      summarizeClaudeRecord({ type: "attachment", content: "Brewed for 7s · 1 monitor running" }),
    ).toEqual([]);
  });

  test("defaults a nameless tool_use / anonymous tool_result label", () => {
    expect(
      summarizeClaudeRecord({
        type: "assistant",
        message: { content: [{ type: "tool_use" }] },
      }),
    ).toEqual([{ kind: "tool_call", label: "tool", toolName: "tool" }]);
    expect(
      summarizeClaudeRecord({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    ).toEqual([{ kind: "tool_result", label: "tool", toolUseId: "tool" }]);
  });

  test("falls back to String() when JSON.stringify throws (circular)", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(stringify(circular)).toBe("[object Object]");
    expect(stringify(undefined)).toBeUndefined();
  });
});

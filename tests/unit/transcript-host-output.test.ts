/** Native tool output and synthetic Claude resume records implement PRD §5.4. */
import { expect, test } from "vitest";
import { summarizeClaudeRecord } from "../../src/claude/transcript/summary.ts";
import { summarizeTranscriptItem } from "../../src/codex/transcript/index.ts";
import { toolOutputText } from "../../src/codex/transcript/summary.ts";
import { activityFromCodexTranscript } from "../../src/core/activity/index.ts";

test("C-CODEX-19 exec output omits its native envelope and preserves command text", () => {
  const output = "stdout\nScript completed\nstderr\n";
  const item = {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "exec-1",
      output: [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: output },
      ],
    },
  };
  const event = activityFromCodexTranscript({
    elwoodSessionId: "session",
    path: "/native.jsonl",
    item,
    summary: summarizeTranscriptItem(item),
  });
  expect(event).toMatchObject({ kind: "tool_result", text: output, toolOutput: output });
});

test("C-CODEX-19 classic output and empty native output preserve their contents", () => {
  const literal = "Script completed\nWall time 0.1 seconds\nOutput:\n";
  expect(toolOutputText(literal)).toBe(literal);
  expect(toolOutputText([{ type: "input_text", text: literal }])).toBe("");
  expect(toolOutputText([{ type: "input_text", text: "Script completed" }])).toBe(
    "Script completed",
  );
  expect(
    toolOutputText([
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_text", text: literal },
    ]),
  ).toBe(literal);
});

test("C-CLAUDE-15 only the synthetic no-response placeholder is filtered", () => {
  const content = [{ type: "text", text: "No response requested." }];
  expect(
    summarizeClaudeRecord({ type: "assistant", message: { model: "<synthetic>", content } }),
  ).toEqual([]);
  expect(
    summarizeClaudeRecord({ type: "assistant", message: { model: "claude-real", content } }),
  ).toEqual([{ kind: "assistant_message", label: "assistant", text: "No response requested." }]);
  expect(
    summarizeClaudeRecord({
      type: "assistant",
      message: { model: "<synthetic>", content: "No response requested." },
    }),
  ).toEqual([]);
  expect(
    summarizeClaudeRecord({
      type: "assistant",
      message: { model: "<synthetic>", content: "Something else" },
    }),
  ).toEqual([{ kind: "assistant_message", label: "assistant", text: "Something else" }]);
  expect(
    summarizeClaudeRecord({
      type: "assistant",
      message: { model: "<synthetic>", content: [...content, ...content] },
    }),
  ).toEqual([
    { kind: "assistant_message", label: "assistant", text: "No response requested." },
    { kind: "assistant_message", label: "assistant", text: "No response requested." },
  ]);
  expect(
    summarizeClaudeRecord({
      type: "assistant",
      message: {
        model: "<synthetic>",
        content: [{ type: "thinking", thinking: "real reasoning" }],
      },
    }),
  ).toEqual([{ kind: "reasoning", label: "thinking", text: "real reasoning" }]);
  expect(
    summarizeClaudeRecord({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Other text" }] },
    }),
  ).toEqual([{ kind: "assistant_message", label: "assistant", text: "Other text" }]);
});

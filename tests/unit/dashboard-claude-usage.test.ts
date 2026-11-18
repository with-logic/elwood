/** Dashboard projections from native Claude JSONL records (C-STATS-01). */
import { expect, test } from "vitest";
import { type ClaudeTranscriptEvent, LineEmitter } from "../../src/claude/transcript/emit.ts";
import { activityFromClaudeTranscript } from "../../src/core/activity/index.ts";
import { DropReporter } from "../../src/core/transcript/drops.ts";

function claude(...items: unknown[]) {
  const events: ClaudeTranscriptEvent[] = [];
  const lines = new LineEmitter(
    "s",
    (event) => events.push(event),
    new DropReporter("s", undefined),
  );
  for (const item of items) lines.emitLine("/agent.jsonl", JSON.stringify(item));
  return events.map(activityFromClaudeTranscript);
}

const text = { type: "text", text: "done" };
const usage = {
  input_tokens: 20,
  output_tokens: 10,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 15,
};
const message = { model: "claude-sonnet", id: "msg_usage", usage };

test("C-STATS-01 C-SPEED-03 Claude usage-only updates keep their transcript path and speed", () => {
  const events = claude(
    {
      type: "assistant",
      message: { ...message, content: [{ type: "thinking", thinking: "think" }, text] },
    },
    {
      type: "assistant",
      message: {
        ...message,
        content: [{ type: "redacted_thinking", data: "private" }],
        usage: { ...usage, output_tokens: 12, speed: "fast" },
      },
    },
  );
  const counts = {
    inputTokens: 65,
    outputTokens: 10,
    totalTokens: 75,
    cacheReadInputTokens: 30,
    cacheWriteInputTokens: 15,
  };
  expect(events).toMatchObject([
    { kind: "reasoning", tokenUsage: { scope: "response", responseId: "msg_usage", counts } },
    { kind: "assistant_message" },
    {
      kind: "other",
      label: "token_usage",
      transcriptPath: "/agent.jsonl",
      speed: { agent: "claude", fastMode: true, evidence: "response_usage" },
      tokenUsage: {
        scope: "response",
        responseId: "msg_usage",
        counts: { ...counts, outputTokens: 12, totalTokens: 77 },
      },
    },
  ]);
  expect(events[1]?.tokenUsage).toBeUndefined();
  expect(events[2]).not.toHaveProperty("raw");
});

test.each([
  ["synthetic message", { model: "<synthetic>" }],
  ["empty response ID", { id: "" }],
  ["whitespace response ID", { id: "   " }],
  ["null response ID", { id: null }],
  ["null usage", { usage: null }],
  ["negative input", { usage: { ...usage, input_tokens: -1 } }],
  ["negative output", { usage: { ...usage, output_tokens: -4 } }],
  ["overflowing total", { usage: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER } }],
] as const)("C-STATS-01 Claude omits usage for %s", (_name, overrides) => {
  const events = claude({
    type: "assistant",
    message: { ...message, ...overrides, content: [text] },
  });
  expect(events).toMatchObject([{ kind: "assistant_message", text: "done" }]);
  expect(events[0]).not.toHaveProperty("tokenUsage");
});

test.each([
  ["user message", { type: "user", message: { ...message, content: [] } }],
  ["empty assistant message", { type: "assistant", message: null }],
] as const)("C-STATS-01 Claude omits activity for %s", (_name, item) => {
  expect(claude(item)).toEqual([]);
});

test("C-STATS-01 Claude preserves valid usage with absent cache counters", () => {
  const [event] = claude({
    type: "assistant",
    message: { ...message, usage: { input_tokens: 2, output_tokens: 0 } },
  });
  expect(event?.tokenUsage).toEqual({
    scope: "response",
    responseId: "msg_usage",
    counts: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
  });
});

test.each([
  [
    "cache read",
    { ...usage, cache_read_input_tokens: -1 },
    { inputTokens: 35, cacheWriteInputTokens: 15, totalTokens: 45 },
  ],
  [
    "cache write",
    { ...usage, cache_creation_input_tokens: 0.5 },
    { inputTokens: 50, cacheReadInputTokens: 30, totalTokens: 60 },
  ],
] as const)("C-STATS-01 Claude omits an invalid %s counter from valid usage", (_name, usage, counts) => {
  const [event] = claude({ type: "assistant", message: { ...message, usage, content: [text] } });
  expect(event?.tokenUsage).toEqual({
    scope: "response",
    responseId: "msg_usage",
    counts: { ...counts, outputTokens: 10 },
  });
});

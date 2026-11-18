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

test("C-STATS-01 Claude publishes one usage sample per record, including usage-only updates", () => {
  const events = claude(
    {
      type: "assistant",
      message: { ...message, content: [{ type: "thinking", thinking: "think" }, text] },
    },
    { type: "assistant", message: { ...message, usage: { ...usage, output_tokens: 12 } } },
  );
  const counts = {
    inputTokens: 65,
    outputTokens: 10,
    totalTokens: 75,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 15,
  };
  expect(events).toMatchObject([
    { kind: "reasoning", tokenUsage: { scope: "response", responseId: "msg_usage", counts } },
    { kind: "assistant_message" },
    {
      kind: "other",
      label: "token_usage",
      tokenUsage: {
        scope: "response",
        responseId: "msg_usage",
        counts: { ...counts, outputTokens: 12, totalTokens: 77 },
      },
    },
  ]);
  expect(events[1]?.tokenUsage).toBeUndefined();
});

test("C-STATS-01 Claude omits synthetic, unkeyed, and malformed usage", () => {
  for (const item of [
    { type: "user", message: { ...message, content: [] } },
    { type: "assistant", message: null },
    ...[
      { model: "<synthetic>" },
      { id: "" },
      { id: null },
      { usage: null },
      { usage: { ...usage, input_tokens: -1 } },
      { usage: { ...usage, output_tokens: -4 } },
      { usage: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER } },
    ].map((overrides) => ({
      type: "assistant",
      message: { ...message, ...overrides, content: [text] },
    })),
  ]) {
    expect(claude(item).every((event) => event.tokenUsage === undefined)).toBe(true);
  }
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

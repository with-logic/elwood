/** Dashboard projections from native Codex JSONL records (C-STATS-01). */
import { expect, test } from "vitest";
import { summarizeTranscriptItem } from "../../src/codex/transcript/summary.ts";
import { activityFromCodexTranscript } from "../../src/core/activity/index.ts";

function codex(item: unknown) {
  return activityFromCodexTranscript({
    elwoodSessionId: "s",
    path: "/thread.jsonl",
    item,
    summary: summarizeTranscriptItem(item),
  });
}

function tokenCount(data: object) {
  return { type: "event_msg", payload: { type: "token_count", ...data } };
}

const total = {
  input_tokens: 240,
  output_tokens: 60,
  total_tokens: 300,
  cached_input_tokens: 100,
  cache_write_input_tokens: 10,
  reasoning_output_tokens: 30,
};

test("C-STATS-01 projects Codex native cumulative and last usage with its quota windows", () => {
  const event = codex(
    tokenCount({
      info: {
        total_token_usage: total,
        last_token_usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 },
        model_context_window: 475000,
      },
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: 34.5, window_minutes: 300, resets_at: 1795425913 },
        secondary: { used_percent: 101, resets_at: null },
        plan_type: "fixture-plan",
      },
    }),
  );
  expect(event.tokenUsage).toEqual({
    scope: "thread",
    total: {
      inputTokens: 240,
      outputTokens: 60,
      totalTokens: 300,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 10,
      reasoningOutputTokens: 30,
    },
    last: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    contextWindowTokens: 475000,
  });
  expect(event.rateLimits).toEqual({
    limitId: "codex",
    primary: {
      usedPercent: 34.5,
      remainingPercent: 65.5,
      windowMinutes: 300,
      resetsAtUnixSeconds: 1795425913,
    },
    secondary: { usedPercent: 101, remainingPercent: 0 },
  });
  expect(event.transcriptPath).toBe("/thread.jsonl");
});

test("C-STATS-01 Codex quota can arrive without usage and with only one valid window", () => {
  const event = codex(
    tokenCount({
      info: null,
      rate_limits: {
        limit_id: 123,
        primary: { used_percent: -1 },
        secondary: { used_percent: 0, window_minutes: "300", resets_at: 1.5 },
      },
    }),
  );
  expect(event.tokenUsage).toBeUndefined();
  expect(event.rateLimits).toEqual({ secondary: { usedPercent: 0, remainingPercent: 100 } });
});

test("C-STATS-01 invalid Codex counters never become a zero usage or quota reading", () => {
  for (const info of [
    null,
    {},
    { total_token_usage: { ...total, input_tokens: -1 } },
    { total_token_usage: { ...total, output_tokens: 0.2 } },
    { total_token_usage: { ...total, total_tokens: "300" } },
  ]) {
    const event = codex(
      tokenCount({ info, rate_limits: { primary: { used_percent: Number.NaN } } }),
    );
    expect(event.tokenUsage).toBeUndefined();
    expect(event.rateLimits).toBeUndefined();
  }
  const event = codex(
    tokenCount({
      info: {
        total_token_usage: { ...total, cached_input_tokens: null },
        last_token_usage: {},
        model_context_window: false,
      },
      rate_limits: null,
    }),
  );
  expect(event.tokenUsage).toEqual({
    scope: "thread",
    total: {
      inputTokens: 240,
      outputTokens: 60,
      totalTokens: 300,
      cacheWriteInputTokens: 10,
      reasoningOutputTokens: 30,
    },
  });
  expect(event.rateLimits).toBeUndefined();
  expect(
    codex({ type: "response_item", payload: { type: "token_count" } }).tokenUsage,
  ).toBeUndefined();
  expect(codex({ type: "event_msg", payload: null }).tokenUsage).toBeUndefined();
  expect(
    codex({ type: "event_msg", payload: { type: "task_complete" } }).tokenUsage,
  ).toBeUndefined();
});

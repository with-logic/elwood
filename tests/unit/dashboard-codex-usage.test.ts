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
  return {
    timestamp: "2026-11-17T07:09:22.024Z",
    type: "event_msg",
    payload: { type: "token_count", ...data },
  };
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
      cacheReadInputTokens: 100,
      cacheWriteInputTokens: 10,
      reasoningOutputTokens: 30,
    },
    last: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    contextWindowTokens: 475000,
  });
  expect(event.rateLimits).toEqual({
    limitId: "codex",
    recordedAt: "2026-11-17T07:09:22.024Z",
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
  const event = codex({
    ...tokenCount({
      info: null,
      rate_limits: {
        limit_id: 123,
        primary: { used_percent: -1 },
        secondary: { used_percent: 0, window_minutes: "300", resets_at: 1.5 },
      },
    }),
    timestamp: "invalid time",
  });
  expect(event.tokenUsage).toBeUndefined();
  expect(event.rateLimits).toEqual({ secondary: { usedPercent: 0, remainingPercent: 100 } });
});

test.each([
  ["null info", null],
  ["missing total", {}],
  ["negative input", { total_token_usage: { ...total, input_tokens: -1 } }],
  ["fractional output", { total_token_usage: { ...total, output_tokens: 0.2 } }],
  ["string total", { total_token_usage: { ...total, total_tokens: "300" } }],
] as const)("C-STATS-01 Codex omits invalid token usage for %s", (_name, info) => {
  const event = codex(tokenCount({ info, rate_limits: { primary: { used_percent: Number.NaN } } }));
  expect(event.tokenUsage).toBeUndefined();
  expect(event.rateLimits).toBeUndefined();
});

test("C-STATS-01 Codex preserves valid required counts when optional telemetry is invalid", () => {
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
});

const snapshot = tokenCount({
  info: { total_token_usage: total },
  rate_limits: { primary: { used_percent: 25 } },
});

test.each([
  ["missing payload", { ...snapshot, payload: null }],
  ["unexpected record type", { ...snapshot, type: "response_item" }],
  [
    "unexpected payload type",
    { ...snapshot, payload: { ...snapshot.payload, type: "task_complete" } },
  ],
] as const)("C-STATS-01 Codex omits telemetry for %s", (_name, item) => {
  expect(codex(item)).not.toHaveProperty("tokenUsage");
  expect(codex(item)).not.toHaveProperty("rateLimits");
});

test("C-STATS-01 existing quota records without a timestamp still report their windows", () => {
  const { payload } = tokenCount({ rate_limits: { primary: { used_percent: 25 } } });
  expect(codex({ type: "event_msg", payload }).rateLimits).toEqual({
    primary: { usedPercent: 25, remainingPercent: 75 },
  });
});

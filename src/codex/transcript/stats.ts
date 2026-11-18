/** Codex token and quota snapshots from committed token_count records (C-STATS-01). */

import { optional } from "../../core/optional.ts";
import { isFiniteNumber, isRecord } from "../../core/predicates.ts";
import { count } from "../../core/stats/fields.ts";
import type {
  CodexRateLimits,
  CodexRateLimitWindow,
  CodexTokenUsage,
  TokenCounts,
} from "../../core/stats/types.ts";

type CodexStats = {
  readonly tokenUsage?: CodexTokenUsage;
  readonly rateLimits?: CodexRateLimits;
};

export function codexStats(item: unknown): CodexStats | undefined {
  if (!isRecord(item) || item["type"] !== "event_msg") return undefined;
  const payload = item["payload"];
  if (!isRecord(payload) || payload["type"] !== "token_count") return undefined;
  return {
    ...optional(tokenUsage(payload["info"]), "tokenUsage"),
    ...optional(rateLimits(payload["rate_limits"], item["timestamp"]), "rateLimits"),
  };
}

function tokenUsage(info: unknown): CodexTokenUsage | undefined {
  if (!isRecord(info)) return undefined;
  const total = tokenCounts(info["total_token_usage"]);
  if (!total) return undefined;
  return {
    scope: "thread",
    total,
    ...optional(tokenCounts(info["last_token_usage"]), "last"),
    ...optional(count(info["model_context_window"]), "contextWindowTokens"),
  };
}

function tokenCounts(value: unknown): TokenCounts | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = count(value["input_tokens"]);
  const outputTokens = count(value["output_tokens"]);
  const totalTokens = count(value["total_tokens"]);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined)
    return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...optional(count(value["cached_input_tokens"]), "cacheReadInputTokens"),
    ...optional(count(value["cache_write_input_tokens"]), "cacheWriteInputTokens"),
    ...optional(count(value["reasoning_output_tokens"]), "reasoningOutputTokens"),
  };
}

function rateLimits(value: unknown, timestamp: unknown): CodexRateLimits | undefined {
  if (!isRecord(value)) return undefined;
  const primary = rateWindow(value["primary"]);
  const secondary = rateWindow(value["secondary"]);
  const id = value["limit_id"];
  const recordedAt =
    typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
  const identity = {
    ...optional(typeof id === "string" ? id : undefined, "limitId"),
    ...optional(recordedAt, "recordedAt"),
  };
  if (primary) return { ...identity, primary, ...optional(secondary, "secondary") };
  if (secondary) return { ...identity, secondary };
  return undefined;
}

function rateWindow(value: unknown): CodexRateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = value["used_percent"];
  if (!isFiniteNumber(usedPercent) || usedPercent < 0) return undefined;
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...optional(count(value["window_minutes"]), "windowMinutes"),
    ...optional(count(value["resets_at"]), "resetsAtUnixSeconds"),
  };
}

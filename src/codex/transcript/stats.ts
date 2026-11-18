/** Codex token and quota snapshots from committed token_count records (C-STATS-01). */
import { isFiniteNumber, isRecord } from "../../core/predicates.ts";
import { count, field } from "../../core/stats/fields.ts";
import type {
  CodexRateLimits,
  CodexRateLimitWindow,
  CodexTokenUsage,
  TokenCounts,
} from "../../core/stats/types.ts";

export function codexStats(item: unknown): {
  readonly tokenUsage?: CodexTokenUsage;
  readonly rateLimits?: CodexRateLimits;
} {
  if (!isRecord(item) || item["type"] !== "event_msg") return {};
  const payload = item["payload"];
  if (!isRecord(payload) || payload["type"] !== "token_count") return {};
  return {
    ...field("tokenUsage", tokenUsage(payload["info"])),
    ...field("rateLimits", rateLimits(payload["rate_limits"])),
  };
}

function tokenUsage(info: unknown): CodexTokenUsage | undefined {
  if (!isRecord(info)) return undefined;
  const total = tokenCounts(info["total_token_usage"]);
  if (!total) return undefined;
  return {
    scope: "thread",
    total,
    ...field("last", tokenCounts(info["last_token_usage"])),
    ...field("contextWindowTokens", count(info["model_context_window"])),
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
    ...field("cachedInputTokens", count(value["cached_input_tokens"])),
    ...field("cacheWriteInputTokens", count(value["cache_write_input_tokens"])),
    ...field("reasoningOutputTokens", count(value["reasoning_output_tokens"])),
  };
}

function rateLimits(value: unknown): CodexRateLimits | undefined {
  if (!isRecord(value)) return undefined;
  const primary = rateWindow(value["primary"]);
  const secondary = rateWindow(value["secondary"]);
  const id = value["limit_id"];
  const identity = field("limitId", typeof id === "string" ? id : undefined);
  if (primary) return { ...identity, primary, ...field("secondary", secondary) };
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
    ...field("windowMinutes", count(value["window_minutes"])),
    ...field("resetsAtUnixSeconds", count(value["resets_at"])),
  };
}

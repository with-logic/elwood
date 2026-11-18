/** Normalizes Claude assistant response usage without counting synthetic records (C-STATS-01). */
import { isRecord } from "../../core/predicates.ts";
import { count, field } from "../../core/stats/fields.ts";
import type { ClaudeTokenUsage } from "../../core/stats/types.ts";

export function claudeTokenUsage(item: unknown): ClaudeTokenUsage | undefined {
  if (!isRecord(item) || item["type"] !== "assistant") return undefined;
  const message = item["message"];
  if (!isRecord(message) || message["model"] === "<synthetic>") return undefined;
  const responseId = message["id"];
  const usage = message["usage"];
  if (typeof responseId !== "string" || responseId.length === 0 || !isRecord(usage))
    return undefined;
  const uncached = count(usage["input_tokens"]);
  const outputTokens = count(usage["output_tokens"]);
  if (uncached === undefined || outputTokens === undefined) return undefined;
  const cached = count(usage["cache_read_input_tokens"]);
  const written = count(usage["cache_creation_input_tokens"]);
  const inputTokens = uncached + (cached ?? 0) + (written ?? 0);
  const totalTokens = count(inputTokens + outputTokens);
  if (totalTokens === undefined) return undefined;
  return {
    scope: "response",
    responseId,
    counts: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...field("cachedInputTokens", cached),
      ...field("cacheWriteInputTokens", written),
    },
  };
}

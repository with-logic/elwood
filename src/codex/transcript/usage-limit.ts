/** Observe explicit quota rejections in Codex token_count records (PRD §5.4, C-API-69). */

import { optional } from "../../core/optional.ts";
import { isOneOf, isRecord } from "../../core/predicates.ts";
import { count } from "../../core/stats/fields.ts";
import type { CodexUsageLimitWarning } from "../../core/warnings/transcript.ts";
import type { CodexTranscriptEvent } from "./types.ts";

// Native RateLimitReachedType in Codex 0.171 and 0.172.
const reachedTypes = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
] as const;

export type CodexUsageLimitObservation = {
  readonly reachedType: (typeof reachedTypes)[number];
  readonly limitId?: string;
  readonly limitName?: string;
  readonly primaryResetsAtUnixSeconds?: number;
  readonly secondaryResetsAtUnixSeconds?: number;
};

const maxLimitLabelLength = 256;

function limitLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxLimitLabelLength || value.trim() === "")
    return undefined;
  return value;
}

function windowReset(value: unknown): number | undefined {
  return isRecord(value) ? count(value["resets_at"]) : undefined;
}

/** Keep one scoped rejection so repeated token counters do not repeat the notification. */
export class CodexUsageLimitObserver {
  private last: { readonly key: string; readonly limitId: string | undefined } | undefined;

  observe(item: unknown): CodexUsageLimitObservation | undefined {
    if (!isRecord(item) || item["type"] !== "event_msg") return undefined;
    const payload = item["payload"];
    if (!isRecord(payload) || payload["type"] !== "token_count") return undefined;
    const snapshot = payload["rate_limits"];
    if (!isRecord(snapshot)) return undefined;

    const reachedType = snapshot["rate_limit_reached_type"];
    const limitId = limitLabel(snapshot["limit_id"]);
    if (!isOneOf(reachedType, reachedTypes)) {
      // Codex serializes None as null. Omitted or unknown fields cannot clear an observation.
      if (reachedType === null && limitId !== undefined && this.last?.limitId === limitId)
        this.last = undefined;
      return undefined;
    }

    const observation: CodexUsageLimitObservation = {
      reachedType,
      ...optional(limitId, "limitId"),
      ...optional(limitLabel(snapshot["limit_name"]), "limitName"),
      ...optional(windowReset(snapshot["primary"]), "primaryResetsAtUnixSeconds"),
      ...optional(windowReset(snapshot["secondary"]), "secondaryResetsAtUnixSeconds"),
    };
    const key = JSON.stringify(observation);
    if (this.last?.key === key) return undefined;
    this.last = { key, limitId };
    return observation;
  }
}

const rejectionMessages = {
  rate_limit_reached: "Codex reached its rate limit.",
  workspace_owner_credits_depleted: "The Codex workspace owner is out of credits.",
  workspace_member_credits_depleted: "The Codex workspace member is out of credits.",
  workspace_owner_usage_limit_reached: "The Codex workspace owner reached a usage limit.",
  workspace_member_usage_limit_reached: "The Codex workspace member reached a usage limit.",
} satisfies Record<CodexUsageLimitObservation["reachedType"], string>;

export function codexUsageLimitWarning(
  { elwoodSessionId, path }: CodexTranscriptEvent,
  { reachedType, ...details }: CodexUsageLimitObservation,
): CodexUsageLimitWarning {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "transcript",
    code: "usage_limit_reached",
    severity: "warning",
    message: rejectionMessages[reachedType],
    transcriptPath: path,
    nativeLimitType: reachedType,
    ...details,
    raw: reachedType,
  };
}

/** Observe explicit quota rejections in Codex token_count records (PRD §5.4, C-API-69). */

import { createHash } from "node:crypto";
import { optional } from "../../core/optional.ts";
import { isOneOf, isRecord } from "../../core/predicates.ts";
import { count } from "../../core/stats/fields.ts";
import type {
  CodexUsageLimitDetails,
  CodexUsageLimitWarning,
} from "../../core/warnings/transcript.ts";
import { type RateLimitReachedType, rateLimitReachedTypes, tokenCountOf } from "./payload.ts";
import type { CodexTranscriptEvent } from "./types.ts";

export type CodexUsageLimitObservation = CodexUsageLimitDetails & {
  readonly reachedType: RateLimitReachedType;
};

const maxLimitLabelLength = 256;

function limitLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxLimitLabelLength || value.trim() === "")
    return undefined;
  return value;
}

/** Bound retained identity without conflating distinct overlength native IDs. */
function limitIdentity(raw: unknown, label: string | undefined): string | undefined {
  if (label !== undefined) return `id:${label}`;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function windowReset(value: unknown): number | undefined {
  return isRecord(value) ? count(value["resets_at"]) : undefined;
}

/** Keep one scoped rejection so repeated token counters do not repeat the notification. */
export class CodexUsageLimitObserver {
  private last: { readonly key: string; readonly identity: string | undefined } | undefined;

  observe(item: unknown): CodexUsageLimitObservation | undefined {
    const snapshot = tokenCountOf(item)?.limits;
    if (!snapshot) return undefined;
    const reachedType = snapshot["rate_limit_reached_type"];
    if (reachedType !== null && !isOneOf(reachedType, rateLimitReachedTypes)) return undefined;
    const rawLimitId = snapshot["limit_id"];
    const limitId = limitLabel(rawLimitId);
    const identity = limitIdentity(rawLimitId, limitId);
    if (reachedType === null) {
      // Null resets duplicate suppression for this identity. It is not a recovery signal.
      if (identity !== undefined && this.last?.identity === identity) this.last = undefined;
      return undefined;
    }

    const observation: CodexUsageLimitObservation = {
      reachedType,
      ...optional(limitId, "limitId"),
      ...optional(limitLabel(snapshot["limit_name"]), "limitName"),
      ...optional(windowReset(snapshot["primary"]), "primaryResetsAtUnixSeconds"),
      ...optional(windowReset(snapshot["secondary"]), "secondaryResetsAtUnixSeconds"),
    };
    const key = JSON.stringify([identity, observation]);
    if (this.last?.key === key) return undefined;
    this.last = { key, identity };
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

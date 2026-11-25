/**
 * Reads the `payload` envelope that every committed Codex transcript item carries, for
 * each reader of those items: the native question lifecycle (PRD §5.10) and the shutdown
 * wait on a turn's record (§5.7, C-LIFE-13), and native usage snapshots (§5.4).
 */

import { isRecord } from "../../core/predicates.ts";

/** The item's `payload` object, or `undefined` when the item has none. */
export function payloadOf(item: unknown): Record<string, unknown> | undefined {
  return isRecord(item) && isRecord(item["payload"]) ? item["payload"] : undefined;
}

/** Native `RateLimitReachedType` tokens in Codex 0.171 and 0.172. */
export const rateLimitReachedTypes = [
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
] as const;

export type RateLimitReachedType = (typeof rateLimitReachedTypes)[number];

/** Validate the common envelope once per reader, including the optional rate-limit object. */
export function tokenCountOf(item: unknown) {
  if (!isRecord(item) || item["type"] !== "event_msg") return undefined;
  const payload = payloadOf(item);
  if (payload?.["type"] !== "token_count") return undefined;
  const limits = payload["rate_limits"];
  return {
    info: payload["info"],
    timestamp: item["timestamp"],
    limits: isRecord(limits) ? limits : undefined,
  };
}

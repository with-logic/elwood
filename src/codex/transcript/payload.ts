/**
 * Reads the `payload` envelope that every committed Codex transcript item carries, for
 * each reader of those items: the native question lifecycle (PRD §5.10) and the shutdown
 * wait on a turn's record (§5.7, C-LIFE-13). Implements PRD §7A.3.
 */

import { isRecord } from "../../core/predicates.ts";

/** The item's `payload` object, or `undefined` when the item has none. */
export function payloadOf(item: unknown): Record<string, unknown> | undefined {
  return isRecord(item) && isRecord(item["payload"]) ? item["payload"] : undefined;
}

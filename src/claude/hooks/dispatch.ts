/**
 * Claude hook handler dispatch: the shared fail-open dispatcher bound to the
 * Claude result validator, plus block detection for `Stop`.
 * Implements PRD §6.3 and §6.4.
 */

import { createHookDispatcher } from "../../core/hook-dispatch.ts";
import { isRecord } from "../../core/predicates.ts";
import { isClaudeHookResult } from "../validate/result.ts";
import type { ClaudeHookEvent, ClaudeHookResult } from "./index.ts";

export const requestHook = createHookDispatcher<ClaudeHookEvent, ClaudeHookResult>(
  "claude",
  isClaudeHookResult,
);

/** Read block decisions from validated results or unknown activity payloads. */
export function isBlock(result: unknown): boolean {
  return isRecord(result) && result["decision"] === "block";
}

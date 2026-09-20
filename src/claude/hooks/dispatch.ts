/**
 * Claude hook handler dispatch: the shared fail-open dispatcher bound to the
 * Claude result validator, plus block detection for `Stop`.
 * Implements PRD §6.3 and §6.4.
 */

import { createHookDispatcher } from "../../core/hook-dispatch.ts";
import { isClaudeHookResult } from "../validate/result.ts";
import type { ClaudeHookEvent, ClaudeHookResult } from "./index.ts";
import { snapshotClaudeResponse } from "./response-snapshot.ts";

export const requestHook = createHookDispatcher<ClaudeHookEvent, ClaudeHookResult>(
  "claude",
  isClaudeHookResult,
  snapshotClaudeResponse,
);

export function isBlock(result: ClaudeHookResult): boolean {
  return Boolean(result && "decision" in result && result.decision === "block");
}

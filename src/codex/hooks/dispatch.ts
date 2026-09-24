/**
 * Codex hook handler dispatch: the shared fail-open dispatcher bound to the
 * Codex result validator, plus block detection for `Stop`.
 * Implements PRD §7A.2.
 */

import { createHookDispatcher } from "../../core/hook-dispatch.ts";
import type { CodexHookEvent, CodexHookResult } from "./index.ts";
import { isCodexHookResult } from "./validate.ts";

export const requestCodexHook = createHookDispatcher<CodexHookEvent, CodexHookResult>(
  "codex",
  isCodexHookResult,
);

export function isCodexBlock(result: CodexHookResult): boolean {
  return Boolean(
    result &&
      (("decision" in result && result.decision === "block") ||
        ("continue" in result && result.continue === false)),
  );
}

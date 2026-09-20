/** Adapter effort lookups for direct interactive launches (PRD §12A.9, C-CLI-25). */

import {
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  claudeReasoningEfforts,
  codexReasoningEfforts,
} from "../../core/reasoning-effort.ts";

export function claudeEffort(value: string | undefined): ClaudeReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return claudeReasoningEfforts.find((effort) => effort === value);
}

export function codexEffort(value: string | undefined): CodexReasoningEffort | undefined {
  if (value === undefined) return undefined;
  return codexReasoningEfforts.find((effort) => effort === value);
}

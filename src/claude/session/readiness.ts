/**
 * Claude's initial-readiness gate: its deadline needs a verified idle composer, and its
 * version banner drawn alone while it loads is a startup screen, not an unrecognized one
 * (PRD §5.3, §5.4, C-API-28, C-ATTN-09).
 */
import { nativeBootFrame } from "../../runtime/readiness/boot-frame.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";

/** Claude's version banner drawn alone while it loads (C-ATTN-09). */
export const claudeBootFrame = nativeBootFrame(/Claude Code v\d+\.\d+\.\d+/);

type ClaudeStartupDiagnostics = Omit<
  Parameters<typeof createStartupReadinessGate>[2],
  "nativeStartupScreen"
>;

export function createClaudeReadinessGate(
  onReady: () => void,
  resumed: boolean,
  diagnostics: ClaudeStartupDiagnostics,
) {
  return createStartupReadinessGate(onReady, resumed, {
    ...diagnostics,
    nativeStartupScreen: claudeBootFrame,
  });
}

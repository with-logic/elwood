/**
 * Claude's initial-readiness gate: its deadline needs a verified idle composer, and its
 * version banner drawn alone while it loads is a startup screen, not an unrecognized one
 * (PRD §5.3, §5.4, C-API-28, C-ATTN-11).
 */
import { createNativeBootFrameMatcher } from "../../runtime/readiness/boot-frame.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";

/** Claude's version banner drawn alone while it loads (C-ATTN-11). */
export const isClaudeBootFrame = createNativeBootFrameMatcher(/Claude Code v\d+\.\d+\.\d+/);

/** The gate tags its reports with Claude itself, so a caller cannot pass another agent. */
type ClaudeStartupDiagnostics = Omit<
  Parameters<typeof createStartupReadinessGate>[2],
  "nativeStartupScreen" | "session"
> & { readonly elwoodSessionId: string };

export function createClaudeReadinessGate(
  onReady: () => void,
  resumed: boolean,
  diagnostics: ClaudeStartupDiagnostics,
) {
  const { elwoodSessionId, ...rest } = diagnostics;
  return createStartupReadinessGate(onReady, resumed, {
    ...rest,
    session: { agent: "claude", elwoodSessionId },
    nativeStartupScreen: isClaudeBootFrame,
  });
}

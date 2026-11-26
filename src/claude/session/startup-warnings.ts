/**
 * Deliver startup diagnostics with lifetime checks: non-trust decline retries and frame
 * failure reports end once the session starts closing (PRD §5.4, §5.7; C-CLAUDE-22, C-API-72).
 */
import { isNonTrustStartupLabel } from "../../core/startup/automation.ts";
import { createSessionStartupWarningGate } from "../../core/startup/warnings.ts";
import type { SessionWarningSink } from "../../core/warnings/session.ts";

export function createClaudeStartupWarningGate(
  session: () => SessionWarningSink | undefined,
  closing: () => boolean,
  duringDelivery: (deliver: () => void) => void,
) {
  const warnings = createSessionStartupWarningGate(
    session,
    (warning) =>
      closing() &&
      ((warning.code === "startup_prompt_write_failed" &&
        isNonTrustStartupLabel("claude", warning.label)) ||
        warning.code === "frame_observer_failed"),
    duringDelivery,
  );
  return { ...warnings, duringDelivery };
}

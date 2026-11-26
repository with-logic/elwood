/** Deliver startup diagnostics with non-trust decline lifetime checks (PRD §5.7, C-CLAUDE-22). */
import { isNonTrustStartupLabel } from "../../core/startup/automation.ts";
import type { FrameWarningSink } from "../../core/startup/frame.ts";
import { createSessionStartupWarningGate } from "../../core/startup/warnings.ts";

export function createClaudeStartupWarningGate(
  session: () => FrameWarningSink | undefined,
  closing: () => boolean,
  duringDelivery: (deliver: () => void) => void,
) {
  const warnings = createSessionStartupWarningGate(
    session,
    (warning) =>
      warning.code === "startup_prompt_write_failed" &&
      isNonTrustStartupLabel("claude", warning.label) &&
      closing(),
    duringDelivery,
  );
  return { ...warnings, duringDelivery };
}

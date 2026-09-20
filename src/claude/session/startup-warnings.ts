/** Deliver startup diagnostics with browser-decline lifetime checks (PRD §5.7, C-CLAUDE-22). */
import type { FrameWarningSink } from "../../core/startup/frame.ts";
import { createSessionStartupWarningGate } from "../../core/startup/warnings.ts";

export function createClaudeStartupWarningGate(
  session: () => FrameWarningSink | undefined,
  closing: () => boolean,
  duringDelivery: (deliver: () => void) => void,
): ReturnType<typeof createSessionStartupWarningGate> {
  return createSessionStartupWarningGate(
    session,
    (warning) =>
      warning.code === "startup_prompt_write_failed" &&
      warning.label === "browser_tools" &&
      closing(),
    duringDelivery,
  );
}

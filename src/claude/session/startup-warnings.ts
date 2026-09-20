/** Deliver startup diagnostics with browser-decline lifetime checks (PRD §5.7, C-CLAUDE-22). */
import {
  createStartupWarningGate,
  deliverFrameWarnings,
  type FrameWarningSink,
} from "../../core/startup/frame.ts";

export function createClaudeStartupWarningGate(
  session: () => FrameWarningSink | undefined,
  closing: () => boolean,
  duringDelivery: (deliver: () => void) => void,
): ReturnType<typeof createStartupWarningGate> {
  return createStartupWarningGate({
    emitWarnings: (warnings) =>
      duringDelivery(() => {
        for (const warning of warnings) {
          if (
            warning.code === "startup_prompt_write_failed" &&
            warning.label === "browser_tools" &&
            closing()
          )
            continue;
          // A preceding listener can synchronously stop the session. Check again for
          // each warning, but preserve each admitted warning's paired activity.
          deliverFrameWarnings(session(), [warning]);
        }
      }),
  });
}

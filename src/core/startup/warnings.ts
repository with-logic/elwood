/** Shared reentrant startup-warning delivery and filtering (PRD §5.7, C-API-14). */
import type { ElwoodWarningEvent } from "../types.ts";
import { createStartupWarningGate, deliverFrameWarnings, type FrameWarningSink } from "./frame.ts";

export function createSessionStartupWarningGate(
  session: () => FrameWarningSink | undefined,
  suppress: (warning: ElwoodWarningEvent) => boolean,
  duringDelivery: (deliver: () => void) => void,
): ReturnType<typeof createStartupWarningGate> {
  return createStartupWarningGate({
    emitWarnings: (warnings) =>
      duringDelivery(() => {
        for (const warning of warnings) {
          // A preceding listener can stop the session. Recheck each warning while
          // preserving every admitted warning's paired activity.
          if (!suppress(warning)) deliverFrameWarnings(session(), [warning]);
        }
      }),
  });
}

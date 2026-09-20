/** Deliver startup diagnostics with update retry lifetime checks (PRD §5.7, C-CODEX-12). */

import {
  createStartupWarningGate,
  deliverFrameWarnings,
  type FrameWarningSink,
} from "../../core/startup/frame.ts";
import type { CodexPreflightWarning } from "../preflight.ts";

export function createCodexStartupWarningGate(
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
            warning.label === "update" &&
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

// Distribute the session id across warning variants (see DistributiveOmit and Claude).
type WithSessionId<W> = W extends unknown ? W & { readonly elwoodSessionId: string } : never;

export function preflightEvent(
  elwoodSessionId: string,
  warning: CodexPreflightWarning,
): WithSessionId<CodexPreflightWarning> {
  return { elwoodSessionId, ...warning };
}

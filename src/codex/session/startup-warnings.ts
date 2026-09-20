/** Deliver startup diagnostics with update retry lifetime checks (PRD §5.7, C-CODEX-12). */

import type { FrameWarningSink } from "../../core/startup/frame.ts";
import { createSessionStartupWarningGate } from "../../core/startup/warnings.ts";
import type { CodexPreflightWarning } from "../preflight.ts";

export function createCodexStartupWarningGate(
  session: () => FrameWarningSink | undefined,
  closing: () => boolean,
  duringDelivery: (deliver: () => void) => void,
): ReturnType<typeof createSessionStartupWarningGate> {
  return createSessionStartupWarningGate(
    session,
    (warning) =>
      warning.code === "startup_prompt_write_failed" && warning.label === "update" && closing(),
    duringDelivery,
  );
}

// Distribute the session id across warning variants (see DistributiveOmit and Claude).
type WithSessionId<W> = W extends unknown ? W & { readonly elwoodSessionId: string } : never;

export function preflightEvent(
  elwoodSessionId: string,
  warning: CodexPreflightWarning,
): WithSessionId<CodexPreflightWarning> {
  return { elwoodSessionId, ...warning };
}

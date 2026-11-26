/**
 * Deliver startup diagnostics with lifetime checks: update retries and frame failure reports
 * end once the session starts closing (PRD §5.4, §5.7; C-CODEX-12, C-API-72).
 */

import { createSessionStartupWarningGate } from "../../core/startup/warnings.ts";
import type { SessionWarningSink } from "../../core/warnings/session.ts";
import type { CodexPreflightWarning } from "../preflight.ts";

export function createCodexStartupWarningGate(
  session: () => SessionWarningSink | undefined,
  closing: () => boolean,
  duringDelivery: (deliver: () => void) => void,
): ReturnType<typeof createSessionStartupWarningGate> {
  return createSessionStartupWarningGate(
    session,
    (warning) =>
      closing() &&
      ((warning.code === "startup_prompt_write_failed" && warning.label === "update") ||
        warning.code === "frame_observer_failed"),
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

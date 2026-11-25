/** Deliver startup diagnostics with browser-decline lifetime checks (PRD §5.7, C-CLAUDE-22). */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import type { FrameWarningSink } from "../../core/startup/frame.ts";
import { createSessionStartupWarningGate } from "../../core/startup/warnings.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { createStartupReadinessGate } from "../../runtime/session/startup-readiness.ts";
import type { SessionRecord } from "../../state/store.ts";

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

/** A missing Claude readiness hook can release input only to the verified live composer. */
export function createClaudeReadinessGate(
  onReady: () => void,
  options: {
    readonly resumed: boolean;
    readonly record: SessionRecord;
    readonly warnGate: ReturnType<typeof createClaudeStartupWarningGate>;
    readonly emitter: {
      emit(name: "activity", event: ElwoodActivityEvent, observeRejections: true): void;
    };
    readonly configured: TrustClearance;
  },
) {
  return createStartupReadinessGate(onReady, options.resumed, {
    agent: "claude",
    elwoodSessionId: options.record.elwoodSessionId,
    configured: options.configured,
    warnings: options.warnGate,
    events: options.emitter,
  });
}

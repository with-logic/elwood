/** Report one content-free rendered-frame notification failure per live session (PRD §5.4, C-API-72). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { FrameObserverFailedWarning } from "./lifecycle.ts";
import { createOnceWhileLiveReporter, type SessionWarningSink } from "./session.ts";

/**
 * The returned callback reports; calling this only creates it. `warnings` is the session's
 * startup warning gate, so a failure before start returns is delivered after (C-API-14).
 */
export function createFrameObserverFailureReporter(
  warnings: SessionWarningSink,
  session: { readonly elwoodSessionId: string; readonly agent: ElwoodAgentKind },
  isLive: () => boolean,
): () => void {
  return createOnceWhileLiveReporter(warnings, isLive, () =>
    Object.freeze({
      elwoodSessionId: session.elwoodSessionId,
      agent: session.agent,
      source: "lifecycle",
      code: "frame_observer_failed",
      severity: "warning",
      message: "A rendered-frame notification failed.",
      raw: "frame_observer_failed",
    } satisfies FrameObserverFailedWarning),
  );
}

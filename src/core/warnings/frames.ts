/** Report one content-free rendered-frame notification failure per live session (PRD §5.4, C-API-72). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { FrameObserverFailedWarning } from "./lifecycle.ts";
import { createOnceWhileLiveReporter, type SessionWarningEmitter } from "./session.ts";

/** The returned callback reports; calling this only creates it. */
export function createFrameObserverFailureReporter(
  emitter: SessionWarningEmitter,
  session: { readonly elwoodSessionId: string; readonly agent: ElwoodAgentKind },
  isLive: () => boolean,
): () => void {
  return createOnceWhileLiveReporter(emitter, isLive, () =>
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

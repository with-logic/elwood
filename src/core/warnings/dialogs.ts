/** Report one content-free dialog observer failure per live session (PRD §5.4). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import { runContained } from "../contained.ts";
import { emitSessionWarningsWithRejectionHandling, type SessionWarningEmitter } from "./session.ts";

export type DialogObserverFailedWarning = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: "lifecycle";
  readonly code: "dialog_observer_failed";
  readonly severity: "warning";
  readonly message: "A dialog notification listener failed.";
  readonly raw: "dialog_observer_failed";
};

type DialogObserverEmitter = SessionWarningEmitter & {
  observeErrors<T>(
    onError: (error: unknown) => void,
    operation: () => T,
    retainOnOverflow: true,
  ): T;
};

export function observeDialogNotifications(
  emitter: DialogObserverEmitter,
  session: { readonly elwoodSessionId: string; readonly agent: ElwoodAgentKind },
  isLive: () => boolean,
): (deliver: () => void) => void {
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    // Deliver diagnostics outside the dialog observer scope.
    queueMicrotask(() => {
      if (!isLive()) return;
      const warning: DialogObserverFailedWarning = Object.freeze({
        elwoodSessionId: session.elwoodSessionId,
        agent: session.agent,
        source: "lifecycle",
        code: "dialog_observer_failed",
        severity: "warning",
        message: "A dialog notification listener failed.",
        raw: "dialog_observer_failed",
      });
      runContained(() => emitSessionWarningsWithRejectionHandling([warning], emitter));
    });
  };
  return (deliver) => emitter.observeErrors(report, deliver, true);
}

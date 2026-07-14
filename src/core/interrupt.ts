/**
 * Shared Escape-interrupt orchestration for adapter sessions.
 * Implements PRD §5.3, §5.7, and C-API-38.
 */

import { terminalStatuses } from "../runtime/session-status.ts";
import { elwoodError } from "./errors.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "./types.ts";

export const defaultInterruptTimeoutMs = 10_000;
/** Both adapters cancel a running turn with a bare Escape keypress. */
export const interruptKey = "\u001b";

export type InterruptEmitter = {
  on(
    event: "status",
    handler: (event: { readonly status: ElwoodSessionStatus }) => void,
  ): Unsubscribe;
};

/** Statuses with a turn (or blocking dialog) that Escape can cancel. */
const interruptibleStatuses = new Set<ElwoodSessionStatus>(["running", "blocked"]);

/**
 * Sends a single Escape to cancel an in-flight turn and resolves when the
 * session next reaches `ready`. Escape is written immediately, bypassing the
 * control queue, because an interrupt exists to stop work already in flight.
 *
 * A no-op that resolves without writing Escape when the session is not in a
 * post-readiness `running`/`blocked` state: before initial readiness the
 * `running` status is the startup bootstrap rather than a turn, and Escape at
 * an idle composer is not neutral (Claude clears staged composer text; Codex
 * arms its edit-previous-message affordance). Rejects with `interrupt_failed`
 * once `timeoutMs` elapses without a `ready` transition, and with
 * `session_not_running` if the session reaches a terminal status first. Always
 * unsubscribes from the status emitter on settle.
 */
export function sessionInterrupt(
  emitter: InterruptEmitter,
  status: () => ElwoodSessionStatus,
  everReady: () => boolean,
  sendEscape: () => Promise<void>,
  timeoutMs: number | undefined,
): Promise<void> {
  // No turn in flight: resolve without touching the terminal. This covers both
  // an idle-ready session and the pre-readiness startup window, where `running`
  // is the bootstrap status and no turn has begun.
  if (!(everReady() && interruptibleStatuses.has(status()))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offStatus();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          elwoodError("interrupt_failed", "Interrupt did not return the session to ready in time."),
        ),
      );
    }, timeoutMs ?? defaultInterruptTimeoutMs);
    const offStatus = emitter.on("status", (event) => {
      if (event.status === "ready") settle(resolve);
      if (!terminalStatuses.has(event.status)) return;
      settle(() =>
        reject(elwoodError("session_not_running", "Session ended before the interrupt completed.")),
      );
    });
    sendEscape().then(undefined, (error: unknown) => {
      settle(() => reject(error));
    });
  });
}

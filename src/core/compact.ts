/**
 * Shared /compact orchestration for adapter sessions.
 * Implements PRD §5.3, §5.7, and C-API-22.
 */

import { terminalStatuses } from "../runtime/session-status.ts";
import { elwoodError } from "./errors.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "./types.ts";

export const defaultCompactTimeoutMs = 120_000;
export const compactCommand = "/compact";
const defaultNudgeDelayMs = 3_000;

export type CompactWiring = {
  readonly submit: () => Promise<void>;
  readonly nudge: () => void;
  readonly onHookName: (handler: (name: string) => void) => Unsubscribe;
  readonly onStatus: (handler: (status: ElwoodSessionStatus) => void) => Unsubscribe;
  readonly timeoutMs: number;
  readonly nudgeDelayMs: number;
};

export type CompactEmitter = {
  on(event: "hook", handler: (event: { readonly hook_event_name: string }) => void): Unsubscribe;
  on(
    event: "status",
    handler: (event: { readonly status: ElwoodSessionStatus }) => void,
  ): Unsubscribe;
};

export function sessionCompact(
  emitter: CompactEmitter,
  submit: () => Promise<void>,
  nudge: () => void,
  timeoutMs: number | undefined,
): Promise<void> {
  const effectiveTimeoutMs = timeoutMs ?? defaultCompactTimeoutMs;
  return runCompact({
    submit,
    nudge,
    onHookName: (handler) => emitter.on("hook", (event) => handler(event.hook_event_name)),
    onStatus: (handler) => emitter.on("status", (event) => handler(event.status)),
    timeoutMs: effectiveTimeoutMs,
    // Short caller timeouts pull the popup-recovery nudge forward too.
    nudgeDelayMs: Math.min(defaultNudgeDelayMs, Math.floor(effectiveTimeoutMs / 2)),
  });
}

export function runCompact(wiring: CompactWiring): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let compactStarted = false;
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(nudgeTimer);
      offHook();
      offStatus();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(elwoodError("compact_failed", "Compaction did not report completion in time.")),
      );
    }, wiring.timeoutMs);
    const offHook = wiring.onHookName((name) => {
      if (name === "PreCompact") compactStarted = true;
      if (name === "PostCompact") settle(resolve);
    });
    const offStatus = wiring.onStatus((status) => {
      if (!terminalStatuses.has(status)) return;
      settle(() =>
        reject(elwoodError("session_not_running", "Session ended before compaction completed.")),
      );
    });
    wiring.submit().then(
      () => {
        // A slash-command popup can swallow the submitting Enter keystroke.
        // If the adapter has not acknowledged the command via PreCompact by
        // then, one extra Enter is sent; at an empty composer it is a no-op.
        nudgeTimer = setTimeout(() => {
          if (!compactStarted) wiring.nudge();
        }, wiring.nudgeDelayMs);
      },
      (error: unknown) => {
        settle(() => reject(error));
      },
    );
  });
}

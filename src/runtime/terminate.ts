/**
 * Shared PTY termination helper for graceful stop and force kill.
 * Implements PRD §5.3 and §9.4.
 */

import { elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import type { SessionReaper } from "./reap-tree.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
const defaultTimeouts: TerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };

/**
 * Signal the PTY, wait for exit, and reap the leader's process group. The reap
 * is guaranteed on EVERY exit path — normal exit, timeout, or a throwing PTY
 * operation — so a `termination_failed` outcome never leaks the descendants
 * this is meant to kill (C-LIFE-10). The reaper is one-shot and reuse-safe, so
 * a later `teardown()` reaping again is a harmless no-op (see SessionReaper).
 */
export async function terminatePty(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  reaper: SessionReaper,
  timeouts: TerminationTimeouts = defaultTimeouts,
): Promise<void> {
  let terminationError: unknown;
  try {
    const timeoutMs = signal === "SIGTERM" ? timeouts.gracefulMs : timeouts.forceMs;
    const exited = await waitForExitAfterSignal(pty, signal, timeoutMs);
    if (
      !(
        exited ||
        (signal === "SIGTERM" && (await waitForExitAfterSignal(pty, "SIGKILL", timeouts.forceMs)))
      )
    ) {
      terminationError = elwoodError("termination_failed", `PTY did not exit after ${signal}.`);
    }
  } catch (error) {
    terminationError = error;
  }
  // Reap on every path — even if the wait timed out or a PTY call threw — so a
  // termination_failed outcome never leaks the descendant tree (C-LIFE-10). The
  // ORIGINAL termination error wins: a reap failure is only surfaced when
  // termination itself succeeded, so it can't mask the real cause.
  try {
    reaper.reap();
  } catch (reapError) {
    if (terminationError === undefined) throw reapError;
  }
  if (terminationError !== undefined) throw terminationError;
}

function waitForExitAfterSignal(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      resolve(false);
    }, timeoutMs);
    try {
      unsubscribe = pty.onExit(() => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(true);
      });
      pty.kill(signal);
    } catch (error) {
      clearTimeout(timer);
      unsubscribe?.();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Shared PTY termination helper for graceful stop and force kill.
 * Implements PRD §5.3 and §9.4.
 */

import type { PtyProcess } from "../pty/types.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
const defaultTimeouts: TerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };

export async function terminatePty(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  timeouts: TerminationTimeouts = defaultTimeouts,
): Promise<void> {
  const timeoutMs = signal === "SIGTERM" ? timeouts.gracefulMs : timeouts.forceMs;
  const exited = await waitForExitAfterSignal(pty, signal, timeoutMs);
  if (!exited && signal === "SIGTERM") {
    await waitForExitAfterSignal(pty, "SIGKILL", timeouts.forceMs);
  }
}

function waitForExitAfterSignal(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = pty.onExit(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
    pty.kill(signal);
  });
}

/**
 * Shared PTY termination helper for graceful stop and force kill.
 * Implements PRD §5.3 and §9.4.
 */

import { elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import { type ProcessGroupKiller, reapProcessGroup } from "./reap-tree.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
const defaultTimeouts: TerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };

export async function terminatePty(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  timeouts: TerminationTimeouts = defaultTimeouts,
  groupKiller: ProcessGroupKiller | undefined = undefined,
): Promise<void> {
  const timeoutMs = signal === "SIGTERM" ? timeouts.gracefulMs : timeouts.forceMs;
  const exited = await waitForExitAfterSignal(pty, signal, timeoutMs);
  if (!exited && signal === "SIGTERM") {
    if (await waitForExitAfterSignal(pty, "SIGKILL", timeouts.forceMs))
      return reap(pty, groupKiller);
    throw elwoodError("termination_failed", "PTY did not exit after SIGKILL.");
  }
  if (!exited) {
    throw elwoodError("termination_failed", `PTY did not exit after ${signal}.`);
  }
  reap(pty, groupKiller);
}

/**
 * Reap the leader's process group after it exits. Group membership survives the
 * leader's exit and the reparenting of any descendant to PID 1, so a
 * CLI-spawned hook bridge left running is killed here (C-LIFE-10).
 */
export function reap(pty: PtyProcess, groupKiller: ProcessGroupKiller | undefined): void {
  if (groupKiller) reapProcessGroup(pty.pid, groupKiller);
  else reapProcessGroup(pty.pid);
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

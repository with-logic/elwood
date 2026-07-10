/**
 * Best-effort startup cleanup that preserves the original startup error.
 * Implements PRD §9.1 and §10 error stability.
 */

import type { PtyProcess } from "../pty/types.ts";
import { SessionReaper } from "./reap-tree.ts";
import { terminatePty } from "./terminate.ts";

export type StartupTerminationTimeouts = {
  readonly gracefulMs: number;
  readonly forceMs: number;
};

export type StartupCleanupResources = {
  readonly before?: () => void;
  readonly bridge?: { readonly stop: () => Promise<void> };
  readonly pty?: PtyProcess;
  readonly terminal?: { readonly dispose: () => void };
  readonly after?: () => void;
  /** Overrides the bounded PTY termination window (tests only; production defaults). */
  readonly terminationTimeouts?: StartupTerminationTimeouts;
};

// Bounded so a failed startup never hangs on an unresponsive CLI while still
// giving the leader a chance to exit gracefully before the group SIGKILL reap.
const startupTermination: StartupTerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };

export async function cleanupStartupResources(resources: StartupCleanupResources): Promise<void> {
  tryCall(resources.before);
  // Route the PTY through the SAME group-reaping primitive the normal exit path
  // uses: it signals, waits (bounded), and SIGKILLs the leader's process group on
  // EVERY path — even when the PTY signal throws — so CLI descendants (e.g. a
  // hook-bridge grandchild reparented to PID 1) cannot survive a failed startup
  // (PRD §9.1, §9.4, C-LIFE-10). A termination/reap failure stays SECONDARY: it is
  // contained here so the original startup error is the one that rejects.
  if (resources.pty)
    await reapPtyGroup(resources.pty, resources.terminationTimeouts ?? startupTermination);
  if (resources.bridge) await Promise.allSettled([resources.bridge.stop()]);
  tryCall(resources.after);
  tryCall(resources.terminal?.dispose.bind(resources.terminal));
}

async function reapPtyGroup(pty: PtyProcess, timeouts: StartupTerminationTimeouts): Promise<void> {
  try {
    await terminatePty(pty, "SIGTERM", new SessionReaper(pty.pid), timeouts);
  } catch {
    // Preserve the original startup error; a reap/termination failure is secondary.
  }
}

/**
 * Runs the post-session-construction startup steps behind ONE cleanup boundary
 * (PRD §9.1, §9.4): if `region` rejects — a disk error in a warning flush, a failed
 * startup assertion, anything — the now-live PTY, bridge, terminal, and any watcher
 * are torn down via `cleanupStartupResources` before the original error rethrows, so
 * a rejected `startClaude`/`startCodex` never leaks live resources.
 */
export async function guardStartupRegion(
  region: () => Promise<void>,
  resources: StartupCleanupResources,
): Promise<void> {
  try {
    await region();
  } catch (error) {
    await cleanupStartupResources(resources);
    throw error;
  }
}

function tryCall(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Preserve the original startup error.
  }
}

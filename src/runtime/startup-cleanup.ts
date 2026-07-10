/**
 * Best-effort startup cleanup that preserves the original startup error.
 * Implements PRD §9.1 and §10 error stability.
 */

import type { PtyProcess } from "../pty/types.ts";

export type StartupCleanupResources = {
  readonly before?: () => void;
  readonly bridge?: { readonly stop: () => Promise<void> };
  readonly pty?: PtyProcess;
  readonly terminal?: { readonly dispose: () => void };
  readonly after?: () => void;
};

export async function cleanupStartupResources(resources: StartupCleanupResources): Promise<void> {
  tryCall(resources.before);
  try {
    resources.pty?.kill("SIGTERM");
  } catch {
    // Preserve the original startup error.
  }
  if (resources.bridge) await Promise.allSettled([resources.bridge.stop()]);
  tryCall(resources.after);
  tryCall(resources.terminal?.dispose.bind(resources.terminal));
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

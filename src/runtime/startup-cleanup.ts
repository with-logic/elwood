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

function tryCall(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Preserve the original startup error.
  }
}

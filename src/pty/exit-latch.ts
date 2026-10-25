/**
 * Latches one PTY's exit from a single subscription. node-pty never replays an exit to a
 * later subscriber, so a waiter that subscribed only after the exit would sit out its
 * whole timeout. Codex's `setModel` restore (PRD §5.3, C-CODEX-14) waits on it for a
 * closing CLI to exit before restoring `config.toml`.
 */

import type { PtyProcess } from "./types.ts";

export class PtyExitLatch {
  private observed = false;
  private readonly waiters = new Set<() => void>();

  constructor(pty: Pick<PtyProcess, "onExit">) {
    pty.onExit(() => {
      this.observed = true;
      for (const wake of this.waiters) wake();
    });
  }

  /**
   * Resolves `true` once the exit is observed, or `false` after `timeoutMs`, so a stuck
   * CLI cannot hold its waiter. The pending timer does not keep the host process alive.
   */
  within(timeoutMs: number): Promise<boolean> {
    if (this.observed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (exited: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(exited);
      };
      const wake = (): void => settle(true);
      const timer = setTimeout(() => settle(false), timeoutMs);
      timer.unref();
      this.waiters.add(wake);
    });
  }
}

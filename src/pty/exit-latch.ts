/**
 * Latches one PTY's exit from a single subscription. node-pty never replays an exit to a
 * later subscriber, so a waiter that subscribed only after the exit would sit out its
 * whole timeout. Shared by termination (PRD §9.4, C-LIFE-10), which awaits a process-table
 * sweep before any SIGKILL (after a SIGTERM only when the leader outlasts it), and by
 * Codex's `setModel` restore (§5.3, C-CODEX-14), which waits for a closing CLI to exit
 * before restoring `config.toml`.
 */

import type { PtyProcess } from "./types.ts";

export class PtyExitLatch {
  private observed = false;
  private readonly waiters = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(pty: Pick<PtyProcess, "onExit">) {
    this.unsubscribe = pty.onExit(() => {
      this.observed = true;
      for (const wake of this.waiters) wake();
    });
  }

  /** Whether the exit has been observed. From then on the PTY's pid may be reused. */
  get exited(): boolean {
    return this.observed;
  }

  /**
   * Resolves `true` once the exit is observed, or `false` after `timeoutMs`, so a stuck
   * CLI cannot hold its waiter. With `unref`, the pending timer does not keep the host
   * process alive.
   */
  within(timeoutMs: number, options: { readonly unref?: boolean } = {}): Promise<boolean> {
    if (this.observed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (exited: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(exited);
      };
      const wake = (): void => settle(true);
      const timer = setTimeout(() => settle(false), timeoutMs);
      if (options.unref === true) timer.unref();
      this.waiters.add(wake);
    });
  }

  /** Drops the exit subscription; `exited` keeps what it last observed. */
  dispose(): void {
    this.unsubscribe();
  }
}

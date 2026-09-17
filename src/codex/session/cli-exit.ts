/**
 * The bounded PTY-exit barrier a closing Codex `setModel` waits on before restoring
 * `config.toml`. Split from session-instance to stay under the file-size cap.
 * Implements PRD §5.3 setModel restore and C-CODEX-14.
 */

import type { PtyProcess } from "../../pty/types.ts";

/** How long a setModel interrupted by close waits for the CLI to exit before restoring. */
export const cliExitWaitMs = 5_000;

/**
 * Latches the PTY's exit. Session status cannot stand in for it: `stopped`, `killed`, and
 * `torn_down` are recorded by the shutdown path itself and are reached even when the
 * signal did not take, so waiting on status would release the restore into a still-dying
 * Codex's final config write. (A status wait cannot express it either — it rejects on ANY
 * unmatched terminal status, which settles the gate just the same.)
 */
export class CliExitBarrier {
  private readonly pty: PtyProcess;
  /** Whether the PTY has actually exited — the only proof the CLI can no longer write. */
  private exited = false;

  constructor(pty: PtyProcess) {
    this.pty = pty;
    // Latched at construction, not read on demand: the barrier is consulted after the
    // picker settled, by which time the exit that closed the session has usually fired.
    pty.onExit(() => {
      this.exited = true;
    });
  }

  /** Resolves on the observed exit, or at `timeoutMs` so a stuck CLI cannot hold the lock. */
  wait(timeoutMs: number = cliExitWaitMs): Promise<unknown> {
    if (this.exited) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        off();
        resolve(undefined);
      };
      const off = this.pty.onExit(() => settle());
      const timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
    });
  }
}

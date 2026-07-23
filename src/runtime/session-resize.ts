/**
 * Resize helpers shared by every adapter session.
 * Implements PRD §5.3 and C-API-39/C-PTY-05: a direct resize updates both terminal
 * models, while a HELD (deferred-physical) resize leaves the live pty/terminal at
 * their bootstrap geometry until the initial-ready transition applies it. Terminal
 * size is NOT persisted — the live PTY resizes, and nothing is written to disk.
 */

import type { TerminalSize } from "../core/types.ts";
import type { PtyProcess } from "../pty/types.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";

/** Apply a resize to both terminal models; a closed fd is a no-op. */
export function applyResize(pty: PtyProcess, terminal: ElwoodTerminal, size: TerminalSize): void {
  if (pty.resize(size) === "closed") return;
  terminal.resize(size);
}

/**
 * Apply a held resize's deferred PHYSICAL geometry (PTY + terminal) at the
 * initial-ready transition. Only a genuine native PTY resize error (a real,
 * non-closed failure) is treated as "stayed at bootstrap width"; a closed fd stays a
 * silent no-op (C-API-39). Returns whether the physical resize applied.
 */
export function restoreHeldResize(
  pty: PtyProcess,
  terminal: ElwoodTerminal,
  size: TerminalSize,
): boolean {
  if (pty.resize(size) === "closed") return false;
  terminal.resize(size);
  return true;
}
